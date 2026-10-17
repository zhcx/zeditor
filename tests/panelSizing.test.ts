import assert from 'node:assert/strict';
import test from 'node:test';

// 动态导入让缺失实现表现为明确的断言失败。
const sizing = await import('../src/utils/panelSizing.ts').catch(() => ({})) as {
  resizeFromPointer?: (initial: number, startX: number, clientX: number, direction: number, min: number, max: number) => number;
  fitPanelWidths?: (available: number, widths: number[], minimumDocument: number) => number[];
};

test('dragging uses pointer delta so grabbing either edge never jumps', () => {
  assert.equal(sizing.resizeFromPointer?.(250, 309, 309, 1, 150, 900), 250);
  assert.equal(sizing.resizeFromPointer?.(250, 309, 374, 1, 150, 900), 315);
  assert.equal(sizing.resizeFromPointer?.(340, 900, 810, -1, 180, 1200), 430);
});

test('drag limits leave room for documents and allow reversing after clamping', () => {
  assert.equal(sizing.resizeFromPointer?.(340, 900, -500, -1, 180, 700), 700);
  assert.equal(sizing.resizeFromPointer?.(340, 900, 900, -1, 180, 700), 340);
  assert.equal(sizing.resizeFromPointer?.(250, 309, -500, 1, 150, 900), 150);
});

test('panel widths preserve user choice when the window has room', () => {
  assert.deepEqual(sizing.fitPanelWidths?.(1500, [315, 280, 430], 240), [315, 280, 430]);
});

test('narrow windows proportionally fit auxiliary panels without starving the document', () => {
  const fitted = sizing.fitPanelWidths?.(600, [300, 200, 400], 240);
  assert.deepEqual(fitted, [120, 80, 160]);
  assert.deepEqual(sizing.fitPanelWidths?.(120, [250, 340], 240), [0, 0]);
  assert.deepEqual(sizing.fitPanelWidths?.(900, [], 240), []);
});
