import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LINE_WIDTH,
  LINE_WIDTH_MAX,
  LINE_WIDTH_MIN,
  normalizeLineWidth,
  resolveEditorDisplay,
} from '../src/utils/editorDisplay.ts';

test('display settings default to the Obsidian-like layout', () => {
  const display = resolveEditorDisplay({});
  assert.equal(display.readableLineLength, true);
  assert.equal(display.lineWidth, DEFAULT_LINE_WIDTH);
  assert.equal(display.foldHeadings, true);
  assert.equal(display.foldIndentation, true);
  assert.equal(display.indentGuides, true);
  assert.equal(display.showViewStateButton, true);
});

test('display settings honour explicit opt-outs', () => {
  const display = resolveEditorDisplay({
    readable_line_length: false,
    fold_headings: false,
    fold_indentation: false,
    indent_guides: false,
    show_view_state_button: false,
  });
  assert.equal(display.readableLineLength, false);
  assert.equal(display.foldHeadings, false);
  assert.equal(display.foldIndentation, false);
  assert.equal(display.indentGuides, false);
  assert.equal(display.showViewStateButton, false);
});

test('line width is a percentage clamped and rounded to whole percent', () => {
  assert.equal(normalizeLineWidth(undefined), DEFAULT_LINE_WIDTH);
  assert.equal(normalizeLineWidth(Number.NaN), DEFAULT_LINE_WIDTH);
  assert.equal(normalizeLineWidth(10), LINE_WIDTH_MIN);
  assert.equal(normalizeLineWidth(100), LINE_WIDTH_MAX);
  assert.equal(normalizeLineWidth(78.6), 79);
  assert.equal(normalizeLineWidth(Number.POSITIVE_INFINITY), DEFAULT_LINE_WIDTH);
});

test('line width spans 40–100 percent of each editor pane', () => {
  assert.equal(DEFAULT_LINE_WIDTH, 80);
  assert.equal(LINE_WIDTH_MIN, 40);
  assert.equal(LINE_WIDTH_MAX, 100);
});

test('legacy pixel widths migrate to the responsive default', () => {
  for (const pixels of [480, 780, 1400, 2400]) {
    assert.equal(resolveEditorDisplay({ line_width: pixels }).lineWidth, 80);
  }
});
