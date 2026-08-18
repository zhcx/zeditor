import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareMarkdownSource } from '../src/utils/markdownExtensions.ts';

test('removes frontmatter from the rendered body and renders numeric footnotes', () => {
  const source = [
    '---',
    'title: Paper',
    '---',
    '',
    'Claim[^1].',
    '',
    '[^1]: Source note',
  ].join('\n');

  const renderedSource = prepareMarkdownSource(source);

  assert.doesNotMatch(renderedSource, /title: Paper/);
  assert.match(renderedSource, /zeditor-footnote-ref/);
  assert.match(renderedSource, /id="zeditor-footnote-1"/);
  assert.match(renderedSource, /Source note/);
  assert.doesNotMatch(renderedSource, /^\[\^1\]:/m);
});

test('renders extended review and research references as safe data attributes', () => {
  const source = [
    '[term](explain%20this|mode=tip|style=teal)',
    '[old](new%20word|mode=revision|advice=<script>alert</script>)',
    '[record](movie.md|mode=supertag)',
    '[highlight](paper.pdf|mode=pdf-card|annotation=abc)',
  ].join('\n');

  const renderedSource = prepareMarkdownSource(source);

  assert.match(renderedSource, /class="zeditor-mark zeditor-tip"/);
  assert.match(renderedSource, /data-style="teal"/);
  assert.match(renderedSource, /class="zeditor-mark zeditor-revision"/);
  assert.doesNotMatch(renderedSource, /<script>/i);
  assert.match(renderedSource, /data-mode="supertag"/);
  assert.match(renderedSource, /data-annotation="abc"/);
});
