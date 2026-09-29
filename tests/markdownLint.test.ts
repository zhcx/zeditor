import test from 'node:test';
import assert from 'node:assert/strict';
import { lintMarkdown } from '../src/utils/markdownLint.ts';

test('E04：标题 # 后缺少空格，给出可应用的修复', () => {
  const source = '##没有空格的标题\n\n# 正常标题';
  const issues = lintMarkdown(source);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].ruleId, 'E04');
  assert.equal(issues[0].severity, 'error');
  assert.equal(issues[0].fixable, true);
  assert.equal(source.slice(issues[0].from, issues[0].to), '##没有空格的标题');
  assert.equal(issues[0].suggestion, '## 没有空格的标题');
});

test('E03：反向链接 (文字)[地址] 可一键转正', () => {
  const source = '请看 (示例)[https://example.com] 与 (本地)[./doc.md]';
  const issues = lintMarkdown(source).filter((issue) => issue.ruleId === 'E03');
  assert.equal(issues.length, 2);
  assert.equal(source.slice(issues[0].from, issues[0].to), '(示例)[https://example.com]');
  assert.equal(issues[0].suggestion, '[示例](https://example.com)');
  assert.equal(issues[1].suggestion, '[本地](./doc.md)');

  // 纯数字下标不是链接：数组取值等写法不误报
  assert.equal(lintMarkdown('计算 (bar)[0] 的结果').filter((issue) => issue.ruleId === 'E03').length, 0);
});

test('E05：强调标记内侧有空星号空格，数字运算不误报', () => {
  const source = '这是 * 重要 * 的说明，以及 ** 加粗 ** 文本';
  const issues = lintMarkdown(source).filter((issue) => issue.ruleId === 'E05');
  assert.equal(issues.length, 2);
  assert.equal(source.slice(issues[0].from, issues[0].to), '* 重要 *');
  assert.equal(issues[0].suggestion, '*重要*');
  assert.equal(issues[1].suggestion, '**加粗**');

  assert.equal(lintMarkdown('计算 2 * 3 * 4 的结果').filter((issue) => issue.ruleId === 'E05').length, 0);
  assert.equal(lintMarkdown('正常的 *斜体* 与 **粗体**').filter((issue) => issue.ruleId === 'E05').length, 0);
});

test('E06：未闭合围栏代码块只提示，围栏内的内容不参与检查', () => {
  const unclosed = lintMarkdown('```js\nconst a = 1;\n');
  assert.equal(unclosed.length, 1);
  assert.equal(unclosed[0].ruleId, 'E06');
  assert.equal(unclosed[0].fixable, false);
  assert.equal(unclosed[0].suggestion, '```js');

  const fenced = lintMarkdown('```\n##不是标题\n[text]()\n```\n\n# 真标题');
  assert.equal(fenced.filter((issue) => issue.ruleId === 'E06').length, 0);
  assert.equal(fenced.filter((issue) => issue.ruleId === 'E04').length, 0);
  assert.equal(fenced.filter((issue) => issue.ruleId === 'E08').length, 0);
});

test('E02：表格列数与表头不一致，少列可补、多列只提示', () => {
  const source = '| 名称 | 数量 |\n| --- | --- |\n| 苹果 |\n| 香蕉 | 3 | 多 |';
  const issues = lintMarkdown(source).filter((issue) => issue.ruleId === 'E02');
  assert.equal(issues.length, 2);

  assert.equal(issues[0].fixable, true);
  assert.equal(issues[0].suggestion, '| 苹果 |  |');
  assert.equal(issues[1].fixable, false);
  assert.match(issues[1].message, /多于表头/);
});

test('W01：标题层级跳级（全文模式），选区模式跳过', () => {
  const source = '# 一\n\n### 跳级\n\n## 正常\n\n#### 又跳';
  const issues = lintMarkdown(source).filter((issue) => issue.ruleId === 'W01');
  assert.equal(issues.length, 2);
  assert.match(issues[0].message, /H1 跳到 H3/);
  assert.match(issues[1].message, /H2 跳到 H4/);
  assert.equal(issues.every((issue) => issue.fixable === false), true);

  assert.equal(lintMarkdown(source, { partial: true }).filter((issue) => issue.ruleId === 'W01').length, 0);
});

test('W04：内部锚点必须匹配标题 slug', () => {
  // 注意：「第一章 简介」会命中章节号锚点规则（id 为 "1"），这里用普通标题验证 slug 匹配
  const source = '# 项目简介\n\n[好链接](#项目简介)\n\n[坏链接](#不存在)';
  const issues = lintMarkdown(source).filter((issue) => issue.ruleId === 'W04');
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /#不存在/);
  assert.equal(issues[0].fixable, false);
});

test('E01 / E07 / W03：链接引用定义的缺失、重复与未使用', () => {
  const source = [
    '[使用的引用][used]',
    '',
    '[缺失的引用][missing]',
    '',
    '[used]: https://a.com',
    '',
    '[used]: https://b.com',
    '',
    '[unused]: https://c.com',
  ].join('\n');
  const issues = lintMarkdown(source);
  const byRule = (ruleId: string) => issues.filter((issue) => issue.ruleId === ruleId);

  assert.equal(byRule('E01').length, 1);
  assert.match(byRule('E01')[0].message, /missing/);
  assert.equal(byRule('E07').length, 1);
  assert.match(byRule('E07')[0].message, /used/);
  assert.equal(byRule('W03').length, 1);
  assert.match(byRule('W03')[0].message, /unused/);
});

test('W02 / E08 / W05：图片 alt、空链接地址与空链接文字', () => {
  const source = '![](a.png)\n\n[文字]()\n\n[](https://b.com)';
  const issues = lintMarkdown(source);
  assert.equal(issues.filter((issue) => issue.ruleId === 'W02').length, 1);
  assert.equal(issues.filter((issue) => issue.ruleId === 'E08').length, 1);
  assert.equal(issues.filter((issue) => issue.ruleId === 'W05').length, 1);
  // report-only：建议与原文一致，面板据此隐藏「应用」按钮
  assert.equal(issues.every((issue) => issue.fixable === false), true);
  issues.forEach((issue) => {
    assert.equal(issue.suggestion, source.slice(issue.from, issue.to));
  });
});

test('行内代码 span 中的“问题”全部跳过', () => {
  const source = '`##不是标题` 和 `* 不是强调 *` 与 `![](x.png)`';
  assert.deepEqual(lintMarkdown(source), []);
});

test('偏移使用 UTF-16 单位（与 Monaco 一致）', () => {
  const source = '😀\n\n##标题';
  const issues = lintMarkdown(source).filter((issue) => issue.ruleId === 'E04');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].from, 4);
  assert.equal(source.slice(issues[0].from, issues[0].to), '##标题');
});

test('健康文档与空文档返回空列表', () => {
  assert.deepEqual(lintMarkdown(''), []);
  assert.deepEqual(lintMarkdown('# 正常文档\n\n[链接](https://example.com)'), []);
});

test('选区（partial）模式保留行内规则、跳过上下文规则', () => {
  const source = '##标题\n\n[文字]()\n\n### 三级';
  const issues = lintMarkdown(source, { partial: true });
  assert.equal(issues.filter((issue) => issue.ruleId === 'E04').length, 1);
  assert.equal(issues.filter((issue) => issue.ruleId === 'E08').length, 1);
  assert.equal(issues.filter((issue) => issue.ruleId === 'W01').length, 0);
});

test('结果按文档偏移排序且规则编号稳定', () => {
  const source = '##标题\n\n[文字]()\n\n* 重点 *';
  const issues = lintMarkdown(source);
  assert.deepEqual(issues.map((issue) => issue.ruleId), ['E04', 'E08', 'E05']);
  for (let index = 1; index < issues.length; index += 1) {
    assert.ok(issues[index].from >= issues[index - 1].from, '结果应按 from 升序排列');
  }
});
