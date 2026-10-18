import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownFoldingRanges } from '../src/utils/markdownFolding.ts';

test('folds a heading section up to the next heading of the same level', () => {
  const lines = ['# 一', '', '正文', '', '## 一之一', '细节', '', '## 一之二', '细节'];
  // 一级标题吞并下属的二级标题，二级标题只到下一个二级标题之前。
  assert.deepEqual(markdownFoldingRanges(lines, { headings: true, indentation: false }), [
    { start: 1, end: 9 },
    { start: 5, end: 6 },
    { start: 8, end: 9 },
  ]);
});

test('trailing blank lines are returned to the gap between sections', () => {
  const lines = ['# 标题', '正文', '', '', '# 下一个', '正文'];
  assert.deepEqual(markdownFoldingRanges(lines, { headings: true, indentation: false }), [
    { start: 1, end: 2 },
    { start: 5, end: 6 },
  ]);
});

test('headings inside fenced code blocks are not fold anchors', () => {
  const lines = ['```md', '# 不是标题', '```', '', '# 真标题', '正文'];
  assert.deepEqual(markdownFoldingRanges(lines, { headings: true, indentation: false }), [
    { start: 5, end: 6 },
  ]);
});

test('indentation folding keeps the parent item as its visible anchor', () => {
  const lines = ['- 一', '  - 一之一', '    - 一之一之一', '- 二'];
  assert.deepEqual(markdownFoldingRanges(lines, { headings: false, indentation: true }), [
    { start: 1, end: 3 },
    { start: 2, end: 3 },
  ]);
});

test('a single child item can be folded from its parent', () => {
  assert.deepEqual(markdownFoldingRanges(['- parent', '  - child', '- next'], { headings: false }), [
    { start: 1, end: 2 },
  ]);
});

test('sibling lists get separate ranges and fenced headings are not anchors', () => {
  assert.deepEqual(markdownFoldingRanges(['- one', '  - child', '', '- two', '  - child', '```', '# code', '```'], { headings: false }), [
    { start: 1, end: 2 },
    { start: 4, end: 5 },
  ]);
});

test('blank lines inside an indented block do not end the fold', () => {
  const lines = ['  item', '', '  next', 'done'];
  assert.deepEqual(markdownFoldingRanges(lines, { headings: false, indentation: true }), [
    { start: 1, end: 3 },
  ]);
});

test('both switches off produce no ranges', () => {
  assert.deepEqual(markdownFoldingRanges(['# 标题', '正文'], { headings: false, indentation: false }), []);
});
