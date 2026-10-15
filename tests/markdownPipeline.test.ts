import { it } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdownSource } from '../src/utils/markdownPipeline.ts';

it('writes source line anchors on block tokens', () => {
  const html = renderMarkdownSource('# 标题\n\n段落\n');
  assert.match(html, /<h1 data-source-line="1">/);
  assert.match(html, /<p data-source-line="3">/);
});

it('keeps fenced code away from math and languages intact', () => {
  const html = renderMarkdownSource('```javascript\nconst price = "$5";\n```\n');
  assert.match(html, /<code class="language-javascript">/);
  assert.match(html, /\$5/);
  assert.doesNotMatch(html, /class="katex"/);
});

it('renders inline math with katex', () => {
  const html = renderMarkdownSource('体积 $V = a^3$ 计算\n');
  assert.match(html, /class="katex"/);
});

it('turns media directives into placeholders for the enhancer pass', () => {
  const html = renderMarkdownSource('@[video](demo.mp4)\n');
  assert.match(html, /data-zeditor-media-src="demo\.mp4"/);
  assert.match(html, /data-zeditor-media-kind="video"/);
});

it('maps image size attributes onto the img tag', () => {
  const html = renderMarkdownSource('![图](a.png){width=320}\n');
  assert.match(html, /width="320"/);
});
