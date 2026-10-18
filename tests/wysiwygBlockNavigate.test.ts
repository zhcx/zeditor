import { it } from 'node:test';
import assert from 'node:assert/strict';
import { WysiwygSession } from '../src/components/Wysiwyg/wysiwygSession.ts';
import { splitMarkdownDocument } from '../src/utils/wysiwyg/blocks.ts';

interface FakeText {
  nodeType: number;
  textContent: string;
  parentNode: unknown;
  parentElement: unknown;
}

/**
 * 跨块方向键需要「光标停在块内任意位置」，而记录退格/删除用法的共享夹具只会把光标
 * 报在块尾，所以这里另建一个可以把光标设在指定块、指定偏移的夹具。
 */
function navigationFixture(source: string) {
  const blocks = splitMarkdownDocument(source).blocks;
  const elements = new Map<number, HTMLElement>();
  const hidden = new Set<number>();
  const texts = new Map<number, FakeText>();
  const caret = { index: 0, offset: 0 };
  const placed: Array<{ index: number; offset: number }> = [];

  const selection = {
    rangeCount: 1,
    getRangeAt: () => {
      const entry = texts.get(caret.index);
      return { startContainer: entry, startOffset: caret.offset, collapsed: true };
    },
    removeAllRanges() {},
    addRange(range: { startContainer: unknown; startOffset: number }) {
      for (const [index, entry] of texts) {
        if (entry === range.startContainer) placed.push({ index, offset: range.startOffset });
      }
    },
  };

  const createRange = () => ({
    startContainer: null as unknown,
    startOffset: 0,
    collapsed: true,
    setStart(node: unknown, offset: number) {
      this.startContainer = node;
      this.startOffset = offset;
    },
    setEnd() {},
    collapse(value: boolean) {
      this.collapsed = value;
    },
  });

  const document = { getSelection: () => selection, createRange, activeElement: undefined };

  blocks.forEach((block, index) => {
    const entry: FakeText = { nodeType: 3, textContent: block.source, parentNode: null, parentElement: null };
    const host = {
      nodeType: 1,
      childNodes: [entry],
      dataset: { blockIndex: String(index) },
      ownerDocument: document,
      contains: (node: unknown) => node === host || node === entry,
      closest: (selector: string) => (selector.includes('data-block-index') ? host : null),
      focus: () => {},
    };
    entry.parentNode = host;
    entry.parentElement = host;
    elements.set(index, host as unknown as HTMLElement);
    texts.set(index, entry);
  });

  const surface = { ownerDocument: document } as unknown as HTMLElement;
  const session = new WysiwygSession(source, {
    onSourceChange: () => {},
    insertClipboardImage: async () => false,
  });
  const revealed: number[] = [];
  session.setAccessors({
    getSurface: () => surface,
    getBlockElement: index => hidden.has(index) ? null : elements.get(index) ?? null,
    isBlockHidden: index => hidden.has(index),
    revealBlock: index => {
      if (!hidden.delete(index)) return false;
      revealed.push(index);
      return true;
    },
  });

  return {
    session,
    placed,
    hideBlock: (index: number) => hidden.add(index),
    revealed,
    kindAt: (index: number) => blocks[index]?.kind,
    setCaret: (index: number, offset: number) => {
      caret.index = index;
      caret.offset = offset;
    },
  };
}

it('moves the caret into the next block when the down arrow leaves a block', () => {
  const fixture = navigationFixture('前段甲\n\n后段乙');
  fixture.setCaret(0, 3);
  assert.equal(fixture.session.handleArrow(0, 'down'), true);
  assert.deepEqual(fixture.placed, [{ index: 1, offset: 0 }]);
});

it('arrow navigation crosses omitted folded blocks in either direction', () => {
  const fixture = navigationFixture('前段甲\n\n隐藏正文\n\n后段乙');
  fixture.hideBlock(1);
  fixture.setCaret(0, 3);
  assert.equal(fixture.session.handleArrow(0, 'down'), true);
  assert.deepEqual(fixture.placed, [{ index: 2, offset: 0 }]);
  fixture.setCaret(2, 0);
  assert.equal(fixture.session.handleArrow(2, 'up'), true);
  assert.deepEqual(fixture.placed.at(-1), { index: 0, offset: 3 });
});

it('programmatic selection reveals folded targets before restoring the caret', () => {
  const fixture = navigationFixture('前段甲\n\n隐藏正文\n\n后段乙');
  fixture.hideBlock(1);
  fixture.session.setSelectionOffsets(5);
  assert.deepEqual(fixture.revealed, [1]);
  assert.deepEqual(fixture.placed, []);
  fixture.session.restoreCaretAfterRender();
  assert.deepEqual(fixture.placed, [{ index: 1, offset: 0 }]);
});

it('moves the caret into the previous block when the up arrow leaves a block', () => {
  const fixture = navigationFixture('前段甲\n\n后段乙');
  fixture.setCaret(1, 0);
  assert.equal(fixture.session.handleArrow(1, 'up'), true);
  assert.deepEqual(fixture.placed, [{ index: 0, offset: 3 }]);
});

it('mirrors the horizontal arrows onto the same block boundaries', () => {
  const forward = navigationFixture('前段甲\n\n后段乙');
  forward.setCaret(0, 3);
  assert.equal(forward.session.handleArrow(0, 'right'), true);
  assert.deepEqual(forward.placed, [{ index: 1, offset: 0 }]);

  const backward = navigationFixture('前段甲\n\n后段乙');
  backward.setCaret(1, 0);
  assert.equal(backward.session.handleArrow(1, 'left'), true);
  assert.deepEqual(backward.placed, [{ index: 0, offset: 3 }]);
});

it('leaves the caret inside the block while it still has room to move', () => {
  const fixture = navigationFixture('前段甲\n\n后段乙');
  fixture.setCaret(0, 1);
  assert.equal(fixture.session.handleArrow(0, 'down'), false);
  assert.equal(fixture.session.handleArrow(0, 'right'), false);
  fixture.setCaret(1, 2);
  assert.equal(fixture.session.handleArrow(1, 'up'), false);
  assert.equal(fixture.session.handleArrow(1, 'left'), false);
  assert.deepEqual(fixture.placed, []);
});

it('does not wrap around at the document edges', () => {
  const fixture = navigationFixture('前段甲\n\n后段乙');
  fixture.setCaret(0, 0);
  assert.equal(fixture.session.handleArrow(0, 'up'), false);
  fixture.setCaret(1, 3);
  assert.equal(fixture.session.handleArrow(1, 'down'), false);
  assert.deepEqual(fixture.placed, []);
});

it('skips blocks that own their own interaction surface', () => {
  // 表格、围栏、分隔线不能落光标，方向键要越过它们找下一个可编辑块。
  const fixture = navigationFixture('前段甲\n\n```\nconst a = 1;\n```\n\n后段乙');
  assert.equal(fixture.kindAt(1), 'fence');
  fixture.setCaret(0, 3);
  assert.equal(fixture.session.handleArrow(0, 'down'), true);
  assert.deepEqual(fixture.placed, [{ index: 2, offset: 0 }]);
});

it('lands after the block prefix when entering a heading or a list', () => {
  const heading = navigationFixture('前段甲\n\n## 标题');
  heading.setCaret(0, 3);
  assert.equal(heading.session.handleArrow(0, 'down'), true);
  assert.deepEqual(heading.placed, [{ index: 1, offset: 3 }]);

  const list = navigationFixture('前段甲\n\n- 一项');
  list.setCaret(0, 3);
  assert.equal(list.session.handleArrow(0, 'down'), true);
  assert.deepEqual(list.placed, [{ index: 1, offset: 2 }]);
});

it('never takes the arrow from a block that is edited in its own surface', () => {
  const fixture = navigationFixture('| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n\n后段乙');
  fixture.setCaret(0, 0);
  assert.equal(fixture.session.handleArrow(0, 'up'), false);
  assert.equal(fixture.session.handleArrow(0, 'down'), false);
  assert.deepEqual(fixture.placed, []);
});
