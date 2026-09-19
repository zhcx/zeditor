import { it } from 'node:test';
import assert from 'node:assert/strict';
import { prepareMarkdownPaste } from '../src/utils/markdownPaste.ts';

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
