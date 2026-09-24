import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findInlineTargetAt,
  findFootnoteDefinition,
  formatLinkMarkdown,
  formatWikiLinkMarkdown,
  formatFootnoteReference,
  isOpenableUrl,
} from '../src/utils/inlineTargets.ts';

test('识别链接并给出 label 与 url 区间', () => {
  const value = '参见 [VMark 文档](https://vmark.app) 了解详情';
  const offset = value.indexOf('vmark.app') + 3;
  const target = findInlineTargetAt(value, offset);
  assert.ok(target);
  assert.equal(target.kind, 'link');
  assert.equal(target.label?.text, 'VMark 文档');
  assert.equal(target.url?.text, 'https://vmark.app');
  assert.equal(value.slice(target.from, target.to), '[VMark 文档](https://vmark.app)');
  // 字段区间必须精确切出原文。
  assert.equal(value.slice(target.label.from, target.label.to), 'VMark 文档');
  assert.equal(value.slice(target.url.from, target.url.to), 'https://vmark.app');
});

test('光标停在闭合括号后一格仍命中链接', () => {
  const value = '[文本](url)';
  const target = findInlineTargetAt(value, value.length);
  assert.ok(target);
  assert.equal(target.kind, 'link');
});

test('图片与链接区分：![ 不算普通链接', () => {
  const value = '![截图](.assets/shot.png "标题"){width=320}';
  const target = findInlineTargetAt(value, value.indexOf('shot.png'));
  assert.ok(target);
  assert.equal(target.kind, 'image');
  assert.equal(target.alt?.text, '截图');
  assert.equal(target.src?.text, '.assets/shot.png');
  assert.equal(target.title, '标题');
  assert.equal(target.attrs, '{width=320}');
  assert.equal(value.slice(target.src.from, target.src.to), '.assets/shot.png');
});

test('转义的 \\[ 与行内代码内不触发链接弹窗', () => {
  assert.equal(findInlineTargetAt('这是 \\[伪链接](url) 写法', '这是 \\[伪链接](url)'.indexOf('伪')), null);
  const code = '前文 `不为 [文本](url) 建弹窗` 后文';
  assert.equal(findInlineTargetAt(code, code.indexOf('(url)')), null);
});

test('代码围栏内的链接被忽略，围栏外正常', () => {
  const value = '```\n[a](b)\n```\n[c](d)\n';
  assert.equal(findInlineTargetAt(value, value.indexOf('(b)')), null);
  const inside = findInlineTargetAt(value, value.indexOf('(d)'));
  assert.ok(inside);
  assert.equal(inside.kind, 'link');
});

test('块级公式可跨行，光标在公式任意位置命中', () => {
  const value = '前文\n$$\nE = mc^2\n$$\n后文';
  const offset = value.indexOf('mc^2');
  const target = findInlineTargetAt(value, offset);
  assert.ok(target);
  assert.equal(target.kind, 'math');
  assert.equal(target.display, true);
  assert.equal(target.latex, '\nE = mc^2\n');
  assert.equal(value.slice(target.from, target.to).startsWith('$$'), true);
  assert.equal(value.slice(target.from, target.to).endsWith('$$'), true);
});

test('行内公式 $…$ 命中且不误伤 $$', () => {
  const value = '能量 $E = mc^2$ 很有名';
  const target = findInlineTargetAt(value, value.indexOf('mc'));
  assert.ok(target);
  assert.equal(target.kind, 'math');
  assert.equal(target.display, false);
  assert.equal(target.latex, 'E = mc^2');
  // $$ 定界符本身属于块级公式匹配。
  const block = findInlineTargetAt('$$x$$', 3);
  assert.ok(block);
  assert.equal(block.kind, 'math');
  assert.equal(block.display, true);
});

test('wiki 链接支持别名并精确定位目标区间', () => {
  const value = '见 [[notes/卡片|卡片笔记]] 一节';
  const target = findInlineTargetAt(value, value.indexOf('卡片笔记'));
  assert.ok(target);
  assert.equal(target.kind, 'wikilink');
  assert.equal(target.target?.text, 'notes/卡片');
  assert.equal(target.label?.text, '卡片笔记');
  assert.equal(value.slice(target.target.from, target.target.to), 'notes/卡片');
});

test('脚注引用自动关联脚注定义', () => {
  const value = '正文[^1] 继续\n\n[^1]: 这是脚注内容';
  const target = findInlineTargetAt(value, value.indexOf('^1]'));
  assert.ok(target);
  assert.equal(target.kind, 'footnote');
  assert.equal(target.name, '1');
  assert.ok(target.definition);
  assert.equal(target.definition.text, '这是脚注内容');
  assert.equal(value.slice(target.definition.from, target.definition.to), '[^1]: 这是脚注内容');
});

test('脚注定义内容处不弹引用弹窗（源码模式直接编辑）', () => {
  const value = '[^1]: 定义行';
  // 点击定义文本是普通编辑，不算引用；点击 `[^1]` 标记本身才弹窗。
  assert.equal(findInlineTargetAt(value, value.indexOf('定义')), null);
  const marker = findInlineTargetAt(value, 2);
  assert.ok(marker);
  assert.equal(marker.kind, 'footnote');
  assert.equal(marker.raw, '[^1]');
  assert.ok(marker.definition);
  assert.equal(marker.definition.text, '定义行');
});

test('普通文本与空偏移返回 null', () => {
  assert.equal(findInlineTargetAt('普通中文文本', 3), null);
  assert.equal(findInlineTargetAt('', 0), null);
});

test('findFootnoteDefinition 独立可用且跳过围栏', () => {
  assert.equal(findFootnoteDefinition('```[^x]: 不算\n```', 'x'), null);
  const found = findFootnoteDefinition('前\n   [^note]: 缩进定义', 'note');
  assert.ok(found);
  assert.equal(found.text, '缩进定义');
});

test('重建函数与 URL 判定', () => {
  assert.equal(formatLinkMarkdown('文本', 'https://a.b/c'), '[文本](https://a.b/c)');
  // 含空格的 URL 用尖括号包裹。
  assert.equal(formatLinkMarkdown('文本', '/path with space.md'), '[文本](</path with space.md>)');
  assert.equal(formatWikiLinkMarkdown('a.md'), '[[a.md]]');
  assert.equal(formatWikiLinkMarkdown('a.md', '别名'), '[[a.md|别名]]');
  assert.equal(formatFootnoteReference('note'), '[^note]');
  assert.equal(isOpenableUrl('https://x.dev'), true);
  assert.equal(isOpenableUrl('./local.md'), false);
  assert.equal(isOpenableUrl('#标题'), false);
});
