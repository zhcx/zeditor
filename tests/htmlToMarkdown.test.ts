import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities, getAttr, htmlToMarkdown, shouldConvertHtmlToMarkdown } from '../src/utils/htmlToMarkdown.ts';

it('decodes entities once and supports supplementary Unicode', () => {
  assert.equal(decodeEntities('&amp;lt; &#x1F600; &#128512; &#x110000;'), '&lt; 😀 😀 �');
  assert.equal(htmlToMarkdown('<h2>&lt;tag&gt; &amp;lt;</h2>'), '## <tag> &lt;\n');
  assert.equal(htmlToMarkdown('<ul><li>&lt;tag&gt;</li></ul>'), '- <tag>\n');
});

it('does not confuse data attributes with real attributes', () => {
  assert.equal(getAttr('data-src="wrong" src="right"', 'src'), 'right');
});

it('preserves code blank lines, highlighted spans and backtick delimiters', () => {
  assert.equal(htmlToMarkdown('<pre><code><span>one</span>\n\n\n```\n&amp;lt;</code></pre>'),
    '````\none\n\n\n```\n&lt;\n````\n');
  assert.equal(htmlToMarkdown('<p><code>``x``</code></p>'), '``` ``x`` ```\n');
  assert.equal(htmlToMarkdown('<p>\uE0000\uE001 <code>x</code></p>'), '\uE0000\uE001 `x`\n');
});

it('retains same-type nested lists and their siblings', () => {
  assert.equal(htmlToMarkdown('<ul><li>parent<ul><li>child<ul><li>leaf</li></ul></li></ul></li><li>next</li></ul>'),
    '- parent\n  - child\n    - leaf\n- next\n');
});

it('preserves nested quotes and table cell separators', () => {
  assert.match(htmlToMarkdown('<blockquote>outer<blockquote>inner</blockquote>end</blockquote>'), /> > inner/);
  assert.equal(htmlToMarkdown('<table><tr><th>A</th></tr><tr><td>x|y<br>z</td></tr></table>'),
    '| A |\n| --- |\n| x\\|y<br>z |\n');
});

it('preserves emphasis inside links and table cells', () => {
  assert.equal(htmlToMarkdown('<a href="https://example.com"><strong>link</strong></a>'), '[**link**](https://example.com)\n');
  assert.match(htmlToMarkdown('<table><tr><th>Title</th></tr><tr><td><em>value</em></td></tr></table>'), /\| \*value\* \|/);
  assert.equal(htmlToMarkdown('<pre>line1<br>line2</pre>'), '```\nline1\nline2\n```\n');
});

describe('htmlToMarkdown', () => {
  it('converts headings, emphasis and links', () => {
    const md = htmlToMarkdown(
      '<h1>标题</h1><p>正文 <strong>加粗</strong> 与 <a href="https://example.com">链接</a></p>',
    );
    assert.equal(md, '# 标题\n\n正文 **加粗** 与 [链接](https://example.com)\n');
  });

  it('converts task list items with checkbox state', () => {
    const md = htmlToMarkdown(
      '<ul><li><input type="checkbox" checked> 完成</li><li><input type="checkbox"> 未完成</li></ul>',
    );
    assert.equal(md, '- [x] 完成\n- [ ] 未完成\n');
  });

  it('converts nested ordered and unordered lists', () => {
    const md = htmlToMarkdown('<ol><li>一<ul><li>子项</li></ul></li><li>二</li></ol>');
    assert.equal(md, '1. 一\n   - 子项\n2. 二\n');
  });

  it('converts tables with header alignment', () => {
    const md = htmlToMarkdown(
      '<table><thead><tr><th style="text-align:center">名称</th><th align="right">数量</th></tr></thead><tbody><tr><td>A</td><td>1</td></tr></tbody></table>',
    );
    assert.equal(md, '| 名称 | 数量 |\n| :---: | ---: |\n| A | 1 |\n');
  });

  it('converts tables whose header row only uses th cells', () => {
    const md = htmlToMarkdown(
      '<table><tr><th>名称</th><th>数量</th></tr><tr><td>A</td><td>1</td></tr></table>',
    );
    assert.equal(md, '| 名称 | 数量 |\n| --- | --- |\n| A | 1 |\n');
  });

  it('converts fenced code blocks, inline code, images and quotes', () => {
    const md = htmlToMarkdown(
      '<pre><code class="language-js">const a = 1;</code></pre><p>行内 <code>x &lt; y</code></p><blockquote>引用第一行<br>第二行</blockquote>',
    );
    assert.match(md, /```js\nconst a = 1;\n```/);
    assert.match(md, /行内 `x < y`/);
    assert.match(md, /> 引用第一行\n> 第二行/);

    const withImage = htmlToMarkdown('<p>图片：<img src="https://a.com/b.png" alt="预览"></p>');
    assert.match(withImage, /!\[预览\]\(https:\/\/a\.com\/b\.png\)/);
  });

  it('removes scripts, styles, comments and decodes entities', () => {
    const md = htmlToMarkdown(
      '<div>正文<script>alert(1)</script><!--c--><style>.a{}</style><p>段落&nbsp;文本&amp;更多</p></div>',
    );
    assert.equal(md, '正文\n\n段落 文本&更多\n');
    assert.doesNotMatch(md, /alert|\.a\{|<!--/);
  });
});

describe('shouldConvertHtmlToMarkdown', () => {
  it('converts rich html that adds markdown structure', () => {
    assert.equal(shouldConvertHtmlToMarkdown('<h2>标题</h2><p>a</p>', '标题 a'), true);
    assert.equal(
      shouldConvertHtmlToMarkdown(
        '<table><tr><th>名称</th><th>数量</th></tr><tr><td>A</td><td>1</td></tr></table>',
        '名称 数量 A 1',
      ),
      true,
    );
    assert.equal(
      shouldConvertHtmlToMarkdown('<p>参考 <a href="https://example.com/a?b=1">文档</a> 与 <em>斜体</em></p>', '参考 文档 与 斜体'),
      true,
    );
  });

  it('skips html that carries no markdown semantics', () => {
    assert.equal(shouldConvertHtmlToMarkdown('<p>纯文本</p>', '纯文本'), false);
    assert.equal(shouldConvertHtmlToMarkdown('<span>纯文本</span>', '纯文本'), false);
    assert.equal(shouldConvertHtmlToMarkdown('', ''), false);
  });

  it('skips plain text that is itself html source', () => {
    assert.equal(
      shouldConvertHtmlToMarkdown('<p>&lt;div&gt;code&lt;/div&gt;</p>', '<div>code</div>'),
      false,
    );
  });
});
