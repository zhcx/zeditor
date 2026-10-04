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
