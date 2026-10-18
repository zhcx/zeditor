import test from 'node:test';
import assert from 'node:assert/strict';
import { BLOCK_INSERT_ITEMS, BLOCK_RETYPE_ITEMS, blockInsertion } from '../src/utils/wysiwyg/blockMenu.ts';
import { splitMarkdownDocument } from '../src/utils/wysiwyg/blocks.ts';
import { WysiwygSession } from '../src/components/Wysiwyg/wysiwygSession.ts';

test('block templates have valid selection ranges and include all exposed heading/list targets', () => {
  for (const item of BLOCK_INSERT_ITEMS) {
    const insertion = blockInsertion(item.kind);
    assert.ok((insertion.selectionStart ?? 0) <= insertion.text.length, item.kind);
    assert.ok((insertion.selectionEnd ?? 0) <= insertion.text.length, item.kind);
  }
  for (const target of BLOCK_RETYPE_ITEMS) assert.ok(BLOCK_INSERT_ITEMS.some(item => item.kind === target.target));
});

test('inserting a list or quote keeps the following paragraph separate and preserves CRLF', () => {
  for (const kind of ['task', 'ordered', 'quote', 'heading6', 'code', 'table', 'math'] as const) {
    const session = new WysiwygSession('前段\r\n\r\n后段', { onSourceChange() {}, insertClipboardImage: async () => false });
    const insertion = blockInsertion(kind);
    assert.equal(session.insertBlockAfter(0, insertion.text, insertion.selectionStart, insertion.selectionEnd), true);
    const document = splitMarkdownDocument(session.getSource());
    assert.equal(document.blocks.at(-1)?.source, '后段', kind);
    assert.ok(!/(?<!\r)\n/.test(document.source), kind);
    assert.equal(session.handleUndo(), true);
    assert.equal(session.getSource(), '前段\r\n\r\n后段');
  }
});

test('new tasks render a checkbox and new math renders a single block before editing', () => {
  assert.equal(blockInsertion('task').text, '- [ ] 待办事项');
  const math = splitMarkdownDocument(blockInsertion('math').text);
  assert.equal(math.blocks.length, 1);
  assert.equal(math.blocks[0].source, '$$\nx^2\n$$');
});
