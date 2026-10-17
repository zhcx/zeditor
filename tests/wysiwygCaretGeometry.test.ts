import { it } from 'node:test';
import assert from 'node:assert/strict';
import { isVisualLineEdge } from '../src/components/Wysiwyg/caretGeometry.ts';

it('uses actual visual lines rather than source offsets for vertical navigation', () => {
  const lines = [{ top: 10, bottom: 30 }, { top: 34, bottom: 54 }, { top: 58, bottom: 78 }];
  assert.equal(isVisualLineEdge({ top: 11, bottom: 29 }, lines, 'up'), true);
  assert.equal(isVisualLineEdge({ top: 35, bottom: 53 }, lines, 'up'), false);
  assert.equal(isVisualLineEdge({ top: 35, bottom: 53 }, lines, 'down'), false);
  assert.equal(isVisualLineEdge({ top: 59, bottom: 77 }, lines, 'down'), true);
  assert.equal(isVisualLineEdge({ top: 10, bottom: 30 }, [], 'down'), null);
});
