import { it } from 'node:test';
import assert from 'node:assert/strict';
import { markdownIndentGuides } from '../src/utils/markdownIndentGuides.ts';

it('uses nested list structure rather than spaces in ordinary paragraphs', () => {
  const source = [...Array.from({ length: 8 }, (_, index) => `正文${index + 1}`), '', '', ' ase二', ' asdf asdf'].join('\n');
  assert.deepEqual(markdownIndentGuides(source), []);
  assert.deepEqual(markdownIndentGuides('普通文字\n  缩进文字\n\n    缩进代码'), []);
  assert.deepEqual(markdownIndentGuides('```md\n- 列表\n  - 不是实际子项\n```'), []);
});

it('bounds each guide to the real children of its parent list', () => {
  const lines = ['- 父项', '  - 子项甲', '    - 孙项', '  - 子项乙', '- 同级项', '', '  普通文字'];
  for (const eol of ['\n', '\r\n']) {
    assert.deepEqual(markdownIndentGuides(lines.join(eol)), [
      { startLine: 2, endLine: 4, column: 1, depth: 1 },
      { startLine: 3, endLine: 3, column: 3, depth: 2 },
    ]);
  }
});

it('handles ordered and quoted lists and trims trailing blank lines', () => {
  assert.deepEqual(markdownIndentGuides('10. 父项\n    - 子项\n\n独立正文'), [
    { startLine: 2, endLine: 2, column: 1, depth: 1 },
  ]);
  assert.deepEqual(markdownIndentGuides('> - 父项\n>   - 子项'), [
    { startLine: 2, endLine: 2, column: 3, depth: 1 },
  ]);
});
