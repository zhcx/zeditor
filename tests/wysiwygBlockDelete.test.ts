import { it } from 'node:test';
import assert from 'node:assert/strict';
import { WysiwygSession } from '../src/components/Wysiwyg/wysiwygSession.ts';
import { splitMarkdownDocument } from '../src/utils/wysiwyg/blocks.ts';

interface FakeText { nodeType: number; textContent: string; parentNode: unknown; parentElement: unknown }

/**
 * 多块固件：每块一个宿主元素、一张「块文本」映射，选区落在指定块内。
 *
 * 会话同时读两种东西——块的 DOM 文本（序列化用）和宿主元素（焦点、选区块），
 * 因此单个共享元素无法表达「块 A 的 DOM 与块 B 的 DOM 不同」。
 */
function multiBlockFixture(source: string, caretIndex: number) {
  const persisted: string[] = [];
  const focusCalls: number[] = [];
  const elements = new Map<number, HTMLElement>();
  const texts = new Map<number, FakeText>();

  // 最小 Range/Selection 替身：会话只用到 setStart/setEnd/collapse 与容器的 ownerDocument。
  const createRange = () => ({
    startContainer: null as unknown, startOffset: 0, collapsed: true,
    setStart(node: unknown, offset: number) { this.startContainer = node; this.startOffset = offset; },
    setEnd() { /* 折叠选区不设终点 */ },
    collapse(value: boolean) { this.collapsed = value; },
  });
  const selection = {
    rangeCount: 1,
    getRangeAt: () => {
      const entry = texts.get(caretIndex);
      return { startContainer: entry, startOffset: entry?.textContent.length ?? 0, collapsed: true };
    },
    removeAllRanges() { /* 替身不需要维护选区栈 */ },
    addRange() { /* 同上 */ },
  };
  const document = { getSelection: () => selection, createRange, activeElement: undefined };

  for (const [index, block] of splitMarkdownDocument(source).blocks.entries()) {
    const entry: FakeText = { nodeType: 3, textContent: block.source, parentNode: null, parentElement: null };
    const host = {
      nodeType: 1,
      childNodes: [entry],
      dataset: { blockIndex: String(index) },
      ownerDocument: document,
      contains: (node: unknown) => node === host || node === entry,
      // 只有块宿主参与偏移映射；contenteditable 查找返回 null，焦点只由会话显式调用。
      closest: (selector: string) => (selector.includes('data-block-index') ? host : null),
      focus: () => { focusCalls.push(index); },
    };
    entry.parentNode = host;
    entry.parentElement = host;
    texts.set(index, entry);
    elements.set(index, host as unknown as HTMLElement);
  }

  const surface = { ownerDocument: document } as unknown as HTMLElement;
  const session = new WysiwygSession(source, {
    onSourceChange: text => persisted.push(text),
    insertClipboardImage: async () => false,
  });
  session.setAccessors({
    getSurface: () => surface,
    getBlockElement: index => elements.get(index) ?? null,
  });
  return { session, persisted, focusCalls, setText: (index: number, text: string) => { const entry = texts.get(index); if (entry) entry.textContent = text; } };
}

it('absorbs the next paragraph on forward delete at the end of a block', () => {
  const fixture = multiBlockFixture('一\n\n二', 0);
  assert.equal(fixture.session.handleDelete(0), true);
  assert.equal(fixture.session.getSource(), '一二');
  assert.equal(fixture.session.getCaretOffset(), 1, '光标停在拼接处');
});

it('keeps the current block prefix when absorbing a paragraph', () => {
  const fixture = multiBlockFixture('## 标题\n\n正文', 0);
  assert.equal(fixture.session.handleDelete(0), true);
  assert.equal(fixture.session.getSource(), '## 标题正文');
});

it('refuses to absorb a block that carries its own prefix', () => {
  const fixture = multiBlockFixture('前段\n\n- 列表', 0);
  assert.equal(fixture.session.handleDelete(0), false);
  assert.equal(fixture.session.getSource(), '前段\n\n- 列表', '带前缀的块不能被硬拼');
});

it('deletes an empty block instead of merging when it has no content', () => {
  const fixture = multiBlockFixture('一\n\n\n\n二', 1);
  assert.equal(fixture.session.handleDelete(1), true);
  assert.equal(fixture.session.getSource(), '一\n\n二');
  assert.equal(fixture.session.getCaretOffset(), 3);
});

it('does nothing when the caret is not at the end of the block', () => {
  const fixture = multiBlockFixture('一二\n\n三', 1);
  assert.equal(fixture.session.handleDelete(0), false, '块内 Delete 交回浏览器');
  assert.equal(fixture.session.getSource(), '一二\n\n三');
});

it('does not touch a table, which owns its own delete behaviour', () => {
  const table = '| a | b |\n| --- | --- |\n| 1 | 2 |';
  const fixture = multiBlockFixture(table, 0);
  assert.equal(fixture.session.handleDelete(0), false, '表格单元内的 Delete 交回浏览器');
  assert.equal(fixture.session.getSource(), table);
});

it('does not record an undo step when a block refuses to split', () => {
  const table = '| a | b |\n| --- | --- |\n| 1 | 2 |';
  const fixture = multiBlockFixture(table, 0);
  // 表格按光标拆行会碎成段落 + 列表项，必须拒绝，并且不留空的撤销步骤。
  assert.equal(fixture.session.handleEnter(0), false);
  assert.equal(fixture.session.getSource(), table);
  fixture.session.handleUndo();
  assert.equal(fixture.session.getSource(), table, '无效回车不产生撤销历史');
});

it('does not steal focus back when the user moves to another block', () => {
  // 先制造「普通输入已写回」的状态：此时 skipRenderIndex 指向该块，失焦才会走规范化。
  const withTarget = multiBlockFixture('一段文字\n\n另一段', 0);
  withTarget.setText(0, '一段文字呀');
  withTarget.session.handleInput(0);
  withTarget.session.flushWriteBack();
  // 失焦时焦点已交给别的元素：重渲染不能把焦点抢回离开的块。
  withTarget.session.normalizeBlock(0, { nodeType: 1 } as unknown as Node);
  withTarget.session.restoreCaretAfterRender();
  assert.deepEqual(withTarget.focusCalls, [], '用户主动点走的焦点必须保留');

  const withoutTarget = multiBlockFixture('一段文字\n\n另一段', 0);
  withoutTarget.setText(0, '一段文字呀');
  withoutTarget.session.handleInput(0);
  withoutTarget.session.flushWriteBack();
  // relatedTarget 为空说明宿主被重渲染移除，此时必须把焦点恢复回来。
  withoutTarget.session.normalizeBlock(0, null);
  withoutTarget.session.restoreCaretAfterRender();
  assert.deepEqual(withoutTarget.focusCalls, [0], '宿主被移除后仍要恢复焦点');
});
