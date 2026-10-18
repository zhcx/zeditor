import test from 'node:test';
import assert from 'node:assert/strict';
import * as display from '../src/utils/editorDisplay.ts';

test('wheel width changes by two percent per step and clamps without treating 102 as legacy pixels', () => {
  const change = display.lineWidthAfterWheel;
  assert.equal(change?.(80, 1), 82);
  assert.equal(change?.(80, -1), 78);
  assert.equal(change?.(100, 1), 100);
  assert.equal(change?.(40, -1), 40);
  assert.equal(change?.(80, 100), 100);
});

test('small touchpad deltas accumulate and wheel line/page units are normalized', () => {
  const take = display.createLineWidthWheelAccumulator?.();
  assert.equal(take?.(-20, 0), 0);
  assert.equal(take?.(-20, 0), 0);
  assert.equal(take?.(-60, 0), 1);
  assert.equal(take?.(3, 1), -1);
  assert.equal(take?.(1, 2), -1);
});
