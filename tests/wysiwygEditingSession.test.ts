import { it } from 'node:test';
import assert from 'node:assert/strict';
import { WysiwygSession } from '../src/components/Wysiwyg/wysiwygSession.ts';
import { createWysiwygController } from '../src/components/Wysiwyg/WysiwygController.ts';

function editingFixture(source = '原文') {
  let domText = source;
  const persisted: string[] = [];
  const text = { nodeType: 3, get textContent() { return domText; }, parentNode: null as unknown, parentElement: null as unknown };
  const host = {
    nodeType: 1, childNodes: [text], dataset: { blockIndex: '0' },
    contains: (node: unknown) => node === host || node === text,
    closest: () => host,
  };
  text.parentNode = host;
  text.parentElement = host;
  const element = host as unknown as HTMLElement;
  const surface = { ownerDocument: { getSelection: () => ({
    rangeCount: 1,
    getRangeAt: () => ({ startContainer: text, startOffset: domText.length, collapsed: true }),
  }) } } as unknown as HTMLElement;
  const session = new WysiwygSession(source, {
    onSourceChange: text => persisted.push(text),
    insertClipboardImage: async () => false,
  });
  session.setAccessors({ getSurface: () => surface, getBlockElement: () => element });
  const controller = createWysiwygController({
    session, getScrollDOM: () => null, getCaretRange: () => null, focus: () => undefined,
  });
  return { session, controller, persisted, setText: (text: string) => { domText = text; } };
}

it('writes IME text when the final input event precedes compositionend', async () => {
  const fixture = editingFixture();
  fixture.session.markComposing(true, 0);
  fixture.setText('中文，符号！');
  fixture.session.handleInput(0);
  assert.deepEqual(fixture.persisted, []);
  fixture.session.markComposing(false, 0);
  // 没有额外的 input 事件：compositionend 必须自行安排写回。
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(fixture.session.getSource(), '中文，符号！');
  assert.deepEqual(fixture.persisted, ['中文，符号！']);
  assert.equal(fixture.session.getSnapshot().skipRenderIndex, 0);
  assert.equal(fixture.session.getSnapshot().renderRevision, 0, '普通输入保留当前 DOM');
});

it('flushes the visible composition before switching away', () => {
  const fixture = editingFixture();
  fixture.session.markComposing(true, 0);
  fixture.setText('尚在组合的文字');
  fixture.session.handleInput(0);
  fixture.controller.flushPendingEdits?.();
  assert.equal(fixture.session.getSource(), '尚在组合的文字');
});

it('returns and persists the latest DOM text before the debounce expires', () => {
  const fixture = editingFixture('');
  fixture.setText('abc*[]中文');
  fixture.session.handleInput(0);
  assert.equal(fixture.controller.getValue(), 'abc\\*\\[\\]中文');
  assert.deepEqual(fixture.persisted, ['abc\\*\\[\\]中文']);
});

it('undoes Enter without also removing the typing that preceded it', () => {
  const fixture = editingFixture();
  fixture.setText('原文XYZ');
  fixture.session.handleInput(0);
  assert.equal(fixture.session.handleEnter(0), true);
  assert.equal(fixture.session.getSource(), '原文XYZ\n\n');
  assert.equal(fixture.session.getSnapshot().renderRevision, 1, '结构变化重新生成 DOM');
  fixture.session.handleUndo();
  assert.equal(fixture.session.getSource(), '原文XYZ');
  fixture.session.handleUndo();
  assert.equal(fixture.session.getSource(), '原文');
});

it('continues a newly typed list even before the input debounce fires', () => {
  const fixture = editingFixture('');
  fixture.setText('- item');
  fixture.session.handleInput(0);
  fixture.session.handleEnter(0);
  assert.equal(fixture.session.getSource(), '- item\n- ');
  assert.equal(fixture.session.getCaretOffset(), '- item\n- '.length);
});

it('constructs toolbar transactions without applying them twice', () => {
  const fixture = editingFixture('abc');
  const transaction = fixture.controller.state.update({ changes: { from: 0, to: 3, insert: '**abc**' } });
  assert.equal(fixture.session.getSource(), 'abc');
  fixture.controller.dispatch(transaction);
  assert.equal(fixture.session.getSource(), '**abc**');
});

it('queues the full requested selection until the replacement DOM has rendered', () => {
  const fixture = editingFixture('abc');
  fixture.controller.replaceRange(0, 3, '**abc**', { from: 2, to: 5 });
  assert.deepEqual(fixture.session.getSelectionOffsets(), { from: 2, to: 5 });
  fixture.session.setAccessors({ getSurface: () => null, getBlockElement: () => null });
  fixture.controller.revealOffset(0);
  assert.deepEqual(fixture.session.getSelectionOffsets(), { from: 2, to: 5 }, '滚动定位不能覆盖查找命中的完整选区');
});

it('moves and duplicates blocks without losing neighboring source and supports undo', () => {
  const fixture = editingFixture('一\n\n二\n\n三');
  fixture.session.moveBlock(2, 0);
  assert.equal(fixture.session.getSource(), '三\n\n一\n\n二');
  fixture.session.duplicateBlock(1);
  assert.equal(fixture.session.getSource(), '三\n\n一\n\n一\n\n二');
  fixture.session.handleUndo();
  assert.equal(fixture.session.getSource(), '三\n\n一\n\n二');
});

it('persists code text and language changes immediately', () => {
  const fixture = editingFixture('```js\nx\n```');
  fixture.session.writeCodeBlock(0, 'const 中文 = 1;');
  assert.equal(fixture.session.getSource(), '```js\nconst 中文 = 1;\n```');
  fixture.session.writeCodeBlock(0, 'print("中文")', 'python');
  assert.equal(fixture.session.getSource(), '```python\nprint("中文")\n```');
});
