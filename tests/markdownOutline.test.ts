import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOutlineDetectionKey,
  parseMarkdownHeadings,
  selectActiveDocumentContent,
  shouldAutoRevealOutline,
} from '../src/utils/markdownOutline.ts';

test('parses ATX and Setext headings with source line numbers', () => {
  const headings = parseMarkdownHeadings('\uFEFF# 第一章\n\n第二章\n------\n\n### 第三节 ###');

  assert.deepEqual(headings, [
    { level: 1, text: '第一章', line: 1 },
    { level: 2, text: '第二章', line: 3 },
    { level: 3, text: '第三节', line: 6 },
  ]);
});

test('does not include heading-like text inside fenced code blocks', () => {
  const headings = parseMarkdownHeadings('# 正文标题\n\n```markdown\n# 示例标题\n伪标题\n===\n```\n\n## 结尾');

  assert.deepEqual(headings, [
    { level: 1, text: '正文标题', line: 1 },
    { level: 2, text: '结尾', line: 9 },
  ]);
});

test('带内容的围栏行不能关闭代码块并泄漏伪标题', () => {
  const source = '```markdown\n```not-a-close\n# 代码中的标题\n```\n# 正文';
  assert.deepEqual(parseMarkdownHeadings(source), [{ level: 1, text: '正文', line: 5 }]);
});

test('反引号信息串含反引号时不作为代码围栏', () => {
  assert.deepEqual(parseMarkdownHeadings('```bad`info\n# 正文'), [{ level: 1, text: '正文', line: 2 }]);
});

test('does not fabricate Setext headings out of list items, quotes or table rows', () => {
  // 这些行后面的 `---` 在解析器里是分隔线、表格分隔行或普通文本，不是 Setext 下划线。
  // 大纲曾把它们当成 H2 列出来，与正文渲染结果对不上（正文里根本没有标题）。
  for (const source of ['- 列表项\n---\n', '> 引用\n---\n', '| a |\n---\n', '1. 有序项\n---\n', '---\n---\n', '[ref]: https://example.com\n---\n']) {
    assert.deepEqual(parseMarkdownHeadings(source), [], `源码 ${JSON.stringify(source)} 不应产生标题`);
  }
});

test('keeps real Setext headings and ATX headings working', () => {
  assert.deepEqual(parseMarkdownHeadings('标题\n===\n\n小标题\n---\n\n# ATX\n'), [
    { level: 1, text: '标题', line: 1 },
    { level: 2, text: '小标题', line: 4 },
    { level: 1, text: 'ATX', line: 7 },
  ]);
  // 缩进行是段落的延续，仍然可以被下一行定级（与解析器一致）。
  assert.deepEqual(parseMarkdownHeadings('  缩进段落\n---\n'), [{ level: 2, text: '缩进段落', line: 1 }]);
  assert.deepEqual(parseMarkdownHeadings('   缩进段落\n---\n'), [{ level: 2, text: '缩进段落', line: 1 }]);
});

test('uses the active opened file content for the outline', () => {
  const tabs = [
    { id: 'first', content: '# 第一个文件' },
    { id: 'second', content: '# 当前文件' },
  ];

  assert.equal(selectActiveDocumentContent(tabs, 'second', '# 旧的全局内容'), '# 当前文件');
  assert.equal(selectActiveDocumentContent(tabs, 'missing', '# 回退内容'), '# 回退内容');
});

test('automatically reveals an outline when headings first appear in a document', () => {
  const emptyKey = createOutlineDetectionKey('document-a', false);
  const headingKey = createOutlineDetectionKey('document-a', true);

  assert.equal(shouldAutoRevealOutline(emptyKey, headingKey, true, false), true);
  assert.equal(shouldAutoRevealOutline(headingKey, headingKey, true, false), false);
  assert.equal(shouldAutoRevealOutline(null, createOutlineDetectionKey('document-b', false), false, false), false);
});
