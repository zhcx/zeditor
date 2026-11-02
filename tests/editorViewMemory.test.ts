import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditorViewMemory } from '../src/utils/editorViewMemory.ts';

test('preserves separate scroll positions by document and editing surface', () => {
  const memory = createEditorViewMemory();
  memory.capture('a', 'source', { from: 20, to: 24, scrollTop: 300 });
  memory.capture('a', 'wysiwyg', { from: 40, to: 40, scrollTop: 800 });
  memory.capture('b', 'wysiwyg', { from: 5, to: 5, scrollTop: 50 });
  assert.equal(memory.peek('a', 'source')?.scrollTop, 300);
  assert.equal(memory.peek('a', 'wysiwyg')?.scrollTop, 800);
  assert.equal(memory.peek('b', 'wysiwyg')?.scrollTop, 50);
  memory.delete('a');
  assert.equal(memory.peek('a', 'source'), undefined);
});

test('an explicit mode change follows the current caret and is consumed once', () => {
  const memory = createEditorViewMemory();
  memory.capture('a', 'wysiwyg', { from: 10, to: 10, scrollTop: 200 });
  memory.capture('a', 'source', { from: 70, to: 73, scrollTop: 900 });
  memory.follow('a', 'source', 'wysiwyg');
  assert.deepEqual(memory.peek('a', 'wysiwyg'), { from: 70, to: 73, scrollTop: 900, followCaret: true });
  memory.consume('a', 'wysiwyg');
  assert.equal(memory.peek('a', 'wysiwyg')?.scrollTop, 200);
  assert.equal(memory.peek('a', 'wysiwyg')?.followCaret, false);
});

test('a first visit to another surface follows the last known caret', () => {
  const memory = createEditorViewMemory();
  memory.capture('a', 'wysiwyg', { from: 15, to: 18, scrollTop: 400 });
  assert.deepEqual(memory.peek('a', 'source'), { from: 15, to: 18, scrollTop: 400, followCaret: true });
});
