import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getAlignedScrollTop, getMirroredScrollTop, getSyncedScrollTop, getViewportRatio, syncScrollPosition, type ScrollViewport } from '../src/utils/scrollSync.ts';

function viewport(top: number, height: number, clientHeight: number) {
  let currentTop = top;
  const value: ScrollViewport = {
    getScrollTop: () => currentTop,
    getScrollHeight: () => height,
    getClientHeight: () => clientHeight,
    setScrollTop: (nextTop) => { currentTop = nextTop; },
  };
  return { value, get top() { return currentTop; } };
}

test('synchronizes scroll position through viewport APIs', () => {
  const source = viewport(200, 1000, 200);
  const target = viewport(0, 2000, 400);

  syncScrollPosition(source.value, target.value);

  assert.equal(target.top, 400);
});

test('keeps a non-scrollable target at the top', () => {
  const source = viewport(300, 1000, 400);
  const target = viewport(30, 400, 400);

  syncScrollPosition(source.value, target.value);

  assert.equal(target.top, 0);
});

test('uses document anchors to keep the same section aligned', () => {
  const source = viewport(100, 1000, 200);
  const target = viewport(0, 2000, 400);

  syncScrollPosition(source.value, target.value, [
    { sourceTop: 0, targetTop: 0 },
    { sourceTop: 200, targetTop: 600 },
    { sourceTop: 800, targetTop: 1600 },
  ]);

  assert.equal(target.top, 300);
});

test('always maps the current source bottom to the current target bottom', () => {
  const source = viewport(800, 1000, 200);
  const target = viewport(0, 2400, 400);

  syncScrollPosition(source.value, target.value, [
    { sourceTop: 0, targetTop: 0 },
    { sourceTop: 700, targetTop: 1500 },
  ]);

  assert.equal(target.top, 2000);
});

test('uses cached scroll ranges without reading layout dimensions', () => {
  const source: ScrollViewport = {
    getScrollTop: () => 400,
    getScrollHeight: () => { throw new Error('source layout read'); },
    getClientHeight: () => { throw new Error('source layout read'); },
    setScrollTop: () => undefined,
  };
  const target: ScrollViewport = {
    getScrollTop: () => 0,
    getScrollHeight: () => { throw new Error('target layout read'); },
    getClientHeight: () => { throw new Error('target layout read'); },
    setScrollTop: () => undefined,
  };

  assert.equal(getSyncedScrollTop(source, target, [], { sourceMax: 800, targetMax: 1600 }), 800);
});

test('clamps line alignment at scroll boundaries so the opposite pane can compensate', () => {
  assert.equal(getAlignedScrollTop(68, 824, 924, 1000), 0);
  assert.equal(getAlignedScrollTop(68, 824, 892, 1000), 0);
  assert.equal(getAlignedScrollTop(68, 1400, 500, 800), 800);
  assert.equal(getAlignedScrollTop(68, 700, 500, 800), 268);
});

test('mirrors the clicked line ratio into the opposite pane', () => {
  // 点击处位于编辑器视口 40% 处（内容 500，滚动 100，视口高 1000）。
  const ratio = getViewportRatio(500, 100, 1000);
  assert.equal(ratio, 0.4);

  // 预览中对应块的文档坐标 2000、视口高 800 → 滚到 2000 - 0.4 × 800 = 1680。
  assert.equal(getMirroredScrollTop(2000, ratio, 800, 5000), 1680);
});

test('mirrored alignment keeps a breathing offset when the source line is at the very top', () => {
  assert.equal(getViewportRatio(100, 100, 1000), 0);
  assert.equal(getMirroredScrollTop(2000, 0, 800, 5000), 1976);
});

test('mirrored alignment clamps to the scrollable range', () => {
  assert.equal(getMirroredScrollTop(10, 0, 800, 5000), 0);
  assert.equal(getMirroredScrollTop(9000, 1, 800, 5000), 5000);
});

test('mirrored alignment tolerates an unmeasurable viewport', () => {
  assert.equal(getViewportRatio(500, 100, 0), 0);
  assert.equal(getMirroredScrollTop(500, 0.5, 0, 1000), 476);
  assert.equal(getMirroredScrollTop(500, 0.5, 0, 0), 0);
});

test('reveal jumps are wired through mirrored alignment rather than a fixed top offset', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /getViewportRatio\(/);
  assert.match(app, /getMirroredScrollTop\(/);
  // 回归守卫：曾经的 REVEAL_TOP_OFFSET 会把点击位置一律顶到窗格上沿。
  assert.doesNotMatch(app, /REVEAL_TOP_OFFSET/);
});
