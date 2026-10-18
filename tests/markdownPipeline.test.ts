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

it('preserves custom fence languages even when syntax highlighting is unavailable', () => {
  const html = renderMarkdownSource('```my-custom-language\nexample <value>\n```\n');
  assert.match(html, /<code class="language-my-custom-language">/);
  assert.match(html, /example &lt;value&gt;/);
});

it('escapes language names before putting them in a code class', () => {
  const html = renderMarkdownSource('```vendor"demo\nexample\n```\n');
  assert.match(html, /<code class="language-vendor&quot;demo">/);
  assert.doesNotMatch(html, /class="language-vendor"demo"/);
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

it('keeps the source tex on rendered formulas', () => {
  const inlineHtml = renderMarkdownSource('体积 $V = a^3$ 计算\n');
  assert.match(inlineHtml, /data-tex="V = a\^3"/);

  const blockHtml = renderMarkdownSource('$$\nE = mc^2\n$$\n');
  assert.match(blockHtml, /class="katex-block"[^>]*data-tex=/);
});

it('renders Obsidian wiki links as clickable elements outside code', () => {
  const html = renderMarkdownSource('看 [[笔记#标题|别名]] 与 [[另一篇]]');
  assert.match(html, /<span class="wiki-link" role="link" tabindex="0" data-wiki-target="笔记" data-wiki-anchor="标题">别名<\/span>/);
  assert.match(html, /data-wiki-target="另一篇">另一篇<\/span>/);

  // 行内代码与围栏代码里的方括号是字面文本。
  const code = renderMarkdownSource('`[[笔记]]`\n\n```\n[[笔记]]\n```\n');
  assert.doesNotMatch(code, /wiki-link/);
});

it('escapes wiki link attributes before rendering', () => {
  const html = renderMarkdownSource('[[a"b|标题]]');
  assert.match(html, /data-wiki-target="a&quot;b"/);
  assert.doesNotMatch(html, /data-wiki-target="a"b"/);
});

it('renders footnote references with their definition content', () => {
  const html = renderMarkdownSource('正文[^1]。\n\n[^1]: 脚注内容 **重点**\n');
  assert.match(html, /<sup class="footnote-ref" role="doc-noteref" tabindex="0" data-footnote-name="1" data-footnote-content="脚注内容 \*\*重点\*\*">\[1\]<\/sup>/);
  // 定义行保持原文，不转成第二个引用。
  assert.match(html, /\[\^1\]: 脚注内容/);
});

it('marks unresolved footnotes and leaves inline code alone', () => {
  const html = renderMarkdownSource('正文[^缺失]\n\n`[^缺失]`\n');
  assert.match(html, /class="footnote-ref is-unresolved"/);
  assert.equal((html.match(/footnote-ref/g) ?? []).length, 1);
});

it('keeps single-word footnote definitions visible instead of turning references into ordinary links', () => {
  const html = renderMarkdownSource('正文[^n]。\n\n[^n]: 定义');
  assert.match(html, /data-footnote-name="n" data-footnote-content="定义"/);
  assert.match(html, /\[\^n\]: 定义/);
  assert.doesNotMatch(html, /<a href="定义"/);
  assert.match(renderMarkdownSource('[普通][id]\n\n[id]: https://example.com'), /<a href="https:\/\/example.com">普通<\/a>/);
});

it('stores the original footnote Markdown before math and media preprocessing', () => {
  const html = renderMarkdownSource('引用[^m]\n\n[^m]: $x$ & "原文"');
  assert.match(html, /data-footnote-content="\$x\$ &amp; &quot;原文&quot;"/);
});

it('keeps definition name punctuation literal before formatting its body', () => {
  const html = renderMarkdownSource('[^my*note*]: **正文**');
  assert.match(html, /\[\^my\*note\*\]: <strong>正文<\/strong>/);
});
