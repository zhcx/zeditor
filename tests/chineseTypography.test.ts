import test from 'node:test';
import assert from 'node:assert/strict';
import { formatChineseTypography, DEFAULT_TYPOGRAPHY_RULES } from '../src/utils/chineseTypography.ts';

test('formats Chinese spacing and punctuation without changing technical numbers', () => {
  const source = '学习Python编程,共100个! 版本v1.2.3,时间12:30。';
  assert.equal(formatChineseTypography(source).content, '学习 Python 编程，共 100 个！ 版本 v1.2.3,时间 12:30。');
});

test('individual rules can be disabled and formatting is idempotent', () => {
  const source = '中文ABC,数字１２３。';
  const rules = { ...DEFAULT_TYPOGRAPHY_RULES, spacing: false, punctuation: false };
  assert.equal(formatChineseTypography(source, rules).content, '中文ABC,数字123。');
  const formatted = formatChineseTypography(source).content;
  assert.equal(formatChineseTypography(formatted).content, formatted);
});

test('protects links, images, inline code, math, URLs and HTML', () => {
  const protectedParts = ['[中文ABC](https://example.com/a(b))', '![图片ABC](a.png)', '[[中文ABC]]', '`中文ABC`', '$中文ABC$', '<span title="中文ABC">', 'https://example.com/中文ABC'];
  const source = `正文ABC ${protectedParts.join(' ')} 中文DEF`;
  const result = formatChineseTypography(source).content;
  for (const part of protectedParts) assert.ok(result.includes(part), part);
  assert.ok(result.startsWith('正文 ABC '));
  assert.ok(result.endsWith(' 中文 DEF'));
});

test('protects frontmatter, fenced and indented code, block math and reference definitions', () => {
  const source = '---\ntitle: 中文ABC\n---\n正文ABC\n```js\n中文ABC\n```\n    中文ABC\n$$\n中文ABC\n$$\n[ref]: https://example.com/中文ABC\n结束DEF';
  assert.equal(formatChineseTypography(source).content, source.replace('正文ABC', '正文 ABC').replace('结束DEF', '结束 DEF'));
});

test('selection is evaluated against the entire document so partial protected syntax stays intact', () => {
  const source = '开始ABC `代码DEF` 最后GHI';
  const from = source.indexOf('代码');
  const to = source.length;
  assert.equal(formatChineseTypography(source, DEFAULT_TYPOGRAPHY_RULES, { from, to }).content, '开始ABC `代码DEF` 最后 GHI');
});

test('unclosed protected syntax fails closed without changing later text', () => {
  const source = '正文ABC\n```js\n中文DEF\n结束GHI';
  assert.equal(formatChineseTypography(source).content, '正文 ABC\n```js\n中文DEF\n结束GHI');
});

test('protects HTML code and alternative TeX delimiters, including multiline display math', () => {
  const source = '前文ABC <code>中文DEF</code> \\(中文GHI\\)\n\\[\n中文JKL\n\\]\n后文MNO';
  assert.equal(formatChineseTypography(source).content, '前文 ABC <code>中文DEF</code> \\(中文GHI\\)\n\\[\n中文JKL\n\\]\n后文 MNO');
});

test('protects HTML links and bare email addresses as complete links', () => {
  const source = '链接ABC <a href="https://example.com">中文DEF</a> 中文GHI 邮箱中文ABC@example.com 结束JKL';
  assert.equal(formatChineseTypography(source).content, '链接 ABC <a href="https://example.com">中文DEF</a> 中文 GHI 邮箱中文ABC@example.com 结束 JKL');
});

test('protects indented code nested inside block quotes and list items', () => {
  const lines = [
    '>     const 中文ABC = "中文DEF";',
    '> 引用正文ABC',
    '> -     引用列表里的代码 中文ABC',
    '',
    '    普通缩进代码 中文ABC',
    '    - 缩进列表 中文ABC',
    '',
    '- 列表ABC',
    '      -    列表内代码 中文ABC',
    '',
    '末尾DEF',
  ];
  const source = lines.join('\n');
  const expected = lines
    .join('\n')
    .replace('> 引用正文ABC', '> 引用正文 ABC')
    .replace('- 列表ABC', '- 列表 ABC')
    .replace('末尾DEF', '末尾 DEF');
  assert.equal(formatChineseTypography(source).content, expected);
});

test('protects multiline HTML tags together with their attributes', () => {
  const lines = [
    '<img',
    '  src=".assets/图片ABC.png"',
    '  alt="图片ABC">',
    '',
    '中文ABC',
    '',
    '<video',
    '  src="图片ABC.mp4"',
    '  poster="封面ABC.png"></video>',
    '',
    '<source\n  media="(min-width: 图片ABCpx)"\n  srcset="图ABC.png">',
    '',
    '中文DEF',
  ];
  const source = lines.join('\n');
  const expected = lines
    .join('\n')
    .replace('中文ABC', '中文 ABC')
    .replace('中文DEF', '中文 DEF');
  assert.equal(formatChineseTypography(source).content, expected);
});

test('does not treat prose comparison signs as tags', () => {
  const source = '正文ABC < 5 且 3 > 2 结束DEF';
  assert.equal(formatChineseTypography(source).content, '正文 ABC < 5 且 3 > 2 结束 DEF');
});

test('unclosed link scanning stays linear in input size', () => {
  const source = '[中文ABC\n'.repeat(16000);
  const started = performance.now();
  const result = formatChineseTypography(source);
  const elapsed = performance.now() - started;
  assert.equal(result.content, source);
  assert.ok(elapsed < 1000, `formatting ${source.length} chars took ${Math.round(elapsed)} ms`);
});

test('protects MathML and preserves Windows line endings', () => {
  const source = '开始ABC\r\n<math><mtext>中文DEF</mtext></math>\r\n结束GHI';
  assert.equal(formatChineseTypography(source).content, '开始 ABC\r\n<math><mtext>中文DEF</mtext></math>\r\n结束 GHI');
});

test('preserves multiline math inside quote and list containers', () => {
  for (const prefix of ['> ', '> > ', '- ']) {
    const source = `正文ABC\n\n${prefix}$$\n${prefix}\\text{中文ABC}\n${prefix}$$\n\n末尾DEF`;
    assert.equal(formatChineseTypography(source).content, source.replace('正文ABC', '正文 ABC').replace('末尾DEF', '末尾 DEF'));
  }
});

test('dense inline code and math do not repeatedly scan the entire line', () => {
  for (const token of ['`中文ABC` ', '$中文ABC$ ']) {
    const source = token.repeat(16000) + '正文DEF';
    const started = performance.now();
    assert.equal(formatChineseTypography(source).content, token.repeat(16000) + '正文 DEF');
    assert.ok(performance.now() - started < 1000, `dense inline syntax took too long: ${token}`);
  }
});
