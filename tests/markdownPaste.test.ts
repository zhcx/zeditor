import { it } from 'node:test';
import assert from 'node:assert/strict';
import { inlinePasteMarkdown, prepareMarkdownPaste } from '../src/utils/markdownPaste.ts';

it('keeps formatted inline paste inside the existing paragraph', () => {
  assert.equal(prepareMarkdownPaste('**bold**\n', 'beforeafter', 6, 6), '**bold**');
});

it('separates block paste on both sides of a selection', () => {
  assert.equal(prepareMarkdownPaste('## title\n', 'beforeSELECTafter', 6, 12), '\n\n## title\n\n');
  assert.equal(prepareMarkdownPaste('- task\n', 'a\nb', 2, 2), '\n- task\n\n');
  assert.equal(prepareMarkdownPaste('## title\n', 'a\n\nb', 3, 3), '## title\n\n');
  assert.equal(prepareMarkdownPaste('## title\n', '', 0, 0), '## title');
  assert.equal(prepareMarkdownPaste('## title\n', 'a\r\n\r\nb', 5, 5), '## title\n\n');
});

it('keeps a single paragraph on the inline paste path', () => {
  assert.equal(inlinePasteMarkdown('**bold**'), '**bold**');
  assert.equal(inlinePasteMarkdown('\n\n**bold**\n\n'), '**bold**');
  assert.equal(inlinePasteMarkdown('第一行\n第二行'), '第一行\n第二行');
  assert.equal(inlinePasteMarkdown('a\r\nb'), 'a\nb');
  // 行首的 * 只有后跟空格/制表符才是列表标记。
  assert.equal(inlinePasteMarkdown('*em* text'), '*em* text');
});

it('rejects block-level paste from the inline path', () => {
  for (const text of ['', '   ', 'a\n\nb', '# 标题', '- 列表', '1. 列表', '> 引用', '```ts\ncode\n```', '| a | b |', '---']) {
    assert.equal(inlinePasteMarkdown(text), null, JSON.stringify(text));
  }
});
