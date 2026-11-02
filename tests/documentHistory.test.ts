import test from 'node:test';
import assert from 'node:assert/strict';
import { createUndoStack } from '../src/utils/wysiwyg/undoStack.ts';
import { documentHistory } from '../src/utils/documentHistory.ts';

test('history belongs to each document and is discarded when it closes', () => {
  const first = documentHistory.get('history-test-a');
  first.push({ source: 'before', caret: 3, timestamp: 1 }, { coalesce: false });
  assert.equal(documentHistory.get('history-test-b').canUndo(), false);
  assert.equal(documentHistory.get('history-test-a'), first);
  documentHistory.delete('history-test-a');
  assert.equal(documentHistory.get('history-test-a').canUndo(), false);
  documentHistory.delete('history-test-a');
  documentHistory.delete('history-test-b');
});

test('a mode boundary separates rapid typing without discarding redo', () => {
  const stack = createUndoStack();
  stack.push({ source: 'a', caret: 1, timestamp: 1000 }, { coalesce: true });
  stack.boundary();
  stack.push({ source: 'ab', caret: 2, timestamp: 1100 }, { coalesce: true });
  assert.equal(stack.undo({ source: 'abc', caret: 3, timestamp: 1200 })?.source, 'ab');
  stack.boundary();
  assert.equal(stack.redo({ source: 'ab', caret: 2, timestamp: 1300 })?.source, 'abc');
});

test('history keeps the most recent snapshot when its size budget is exceeded', () => {
  const stack = createUndoStack(200, 8);
  stack.push({ source: '123456', caret: 0, timestamp: 1 }, { coalesce: false });
  stack.push({ source: 'abcdef', caret: 0, timestamp: 2 }, { coalesce: false });
  assert.equal(stack.size(), 1);
  assert.equal(stack.undo({ source: 'abcdefg', caret: 0, timestamp: 3 })?.source, 'abcdef');
});

test('a new edit after undo invalidates the abandoned redo branch', () => {
  const stack = createUndoStack();
  stack.push({ source: 'a', caret: 0, timestamp: 1 }, { coalesce: false });
  assert.equal(stack.undo({ source: 'ab', caret: 0, timestamp: 2 })?.source, 'a');
  stack.boundary();
  stack.push({ source: 'a', caret: 0, timestamp: 3 }, { coalesce: false });
  assert.equal(stack.redo({ source: 'ac', caret: 0, timestamp: 4 }), null);
});
