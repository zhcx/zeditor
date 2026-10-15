import { it } from 'node:test';
import assert from 'node:assert/strict';
import { lineAtOffset, lineNumberAt, offsetOfLine, computeLineStarts, countLines } from '../src/utils/wysiwyg/textLines.ts';
import { createUndoStack } from '../src/utils/wysiwyg/undoStack.ts';
import { splitMarkdownDocument, removeBlockFromSource } from '../src/utils/wysiwyg/blocks.ts';

it('computes line starts for LF and CRLF documents', () => {
  assert.deepEqual(computeLineStarts('a\nbb\nccc'), [0, 2, 5]);
  assert.deepEqual(computeLineStarts('a\r\nbb\r\nccc'), [0, 3, 7]);
  assert.deepEqual(computeLineStarts(''), [0]);
});

it('maps offsets to lines and back', () => {
  const source = 'a\nbb\nccc';
  assert.equal(lineNumberAt(source, 0), 1);
  assert.equal(lineNumberAt(source, 1), 1);
  assert.equal(lineNumberAt(source, 2), 2);
  assert.equal(lineNumberAt(source, 5), 3);
  assert.deepEqual(lineAtOffset(source, 3), { from: 2, to: 4, number: 2, text: 'bb' });
  assert.equal(offsetOfLine(source, 3), 5);
  assert.deepEqual(lineAtOffset(source, 99), { from: 5, to: 8, number: 3, text: 'ccc' });
  assert.equal(countLines('a\nbb\nccc'), 3);
  assert.equal(countLines(''), 1);
});

it('coalesces rapid typing into one undo step but keeps structural edits separate', () => {
  const stack = createUndoStack(10);
  stack.push({ source: 'a', caret: 1, timestamp: 1000 }, { coalesce: true });
  stack.push({ source: 'ab', caret: 2, timestamp: 1100 }, { coalesce: true });
  stack.push({ source: 'abc', caret: 3, timestamp: 1200 }, { coalesce: true });
  assert.equal(stack.size(), 1);
  stack.push({ source: 'abcX', caret: 4, timestamp: 2000 }, { coalesce: true });
  assert.equal(stack.size(), 2);
  stack.push({ source: '- abc', caret: 5, timestamp: 2100 }, { coalesce: false });
  assert.equal(stack.size(), 3);
});

it('undoes and redoes in order', () => {
  const stack = createUndoStack(10);
  stack.push({ source: 'a', caret: 1, timestamp: 1000 }, { coalesce: false });
  stack.push({ source: 'ab', caret: 2, timestamp: 2000 }, { coalesce: false });
  const first = stack.undo({ source: 'abc', caret: 3, timestamp: 3000 });
  assert.deepEqual(first, { source: 'ab', caret: 2, timestamp: 2000 });
  const second = stack.undo({ source: 'ab', caret: 2, timestamp: 3100 });
  assert.deepEqual(second, { source: 'a', caret: 1, timestamp: 1000 });
  assert.equal(stack.undo({ source: 'a', caret: 1, timestamp: 3200 }), null);
  // 重做返回的快照内容来自「撤销时记录的当前状态」（时间戳是记录时刻，不影响行为）。
  assert.deepEqual(stack.redo({ source: 'a', caret: 1, timestamp: 3300 }), { source: 'ab', caret: 2, timestamp: 3100 });
});

it('drops the oldest snapshots beyond the limit', () => {
  const stack = createUndoStack(2);
  stack.push({ source: 'a', caret: 0, timestamp: 1 }, { coalesce: false });
  stack.push({ source: 'b', caret: 0, timestamp: 2 }, { coalesce: false });
  stack.push({ source: 'c', caret: 0, timestamp: 3 }, { coalesce: false });
  assert.equal(stack.size(), 2);
  assert.deepEqual(stack.undo({ source: 'd', caret: 0, timestamp: 4 }), { source: 'c', caret: 0, timestamp: 3 });
});

it('removes a block together with one side of the separating blank lines', () => {
  const document = splitMarkdownDocument('第一段\n\n第二段\n\n第三段\n');
  assert.equal(removeBlockFromSource(document, 1).source, '第一段\n\n第三段\n');
  assert.equal(removeBlockFromSource(document, 2).source, '第一段\n\n第二段\n');
  assert.equal(removeBlockFromSource(document, 0).source, '第二段\n\n第三段\n');
});
