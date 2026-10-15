import { it } from 'node:test';
import assert from 'node:assert/strict';
import { elementNode, textNode, type InlineNode } from '../src/utils/wysiwyg/inlineNodes.ts';
import { serializeBlockMarkdown } from '../src/utils/wysiwyg/blockSerialize.ts';

const p = (...children: InlineNode[]) => elementNode('p', {}, children);
const li = (...children: InlineNode[]) => elementNode('li', {}, children);
const ul = (...children: InlineNode[]) => elementNode('ul', {}, children);
const strong = (...children: InlineNode[]) => elementNode('strong', {}, children);
const checkbox = (checked: boolean) => elementNode('input', { type: 'checkbox', ...(checked ? { checked: 'true' } : {}) }, []);

it('serializes a paragraph and reports its content offset', () => {
  const result = serializeBlockMarkdown('paragraph', [textNode('一段文字')]);
  assert.equal(result.markdown, '一段文字');
  assert.deepEqual(result.containers, [{ path: [], contentOffset: 0, escapeLineStart: true }]);
});

it('serializes headings with the matching level, keeping inline formatting', () => {
  const result = serializeBlockMarkdown('heading', [elementNode('h2', {}, [textNode('标题 '), strong(textNode('重点'))])]);
  assert.equal(result.markdown, '## 标题 **重点**');
  assert.deepEqual(result.containers, [{ path: [0], contentOffset: 3, escapeLineStart: false }]);
});

it('lets freshly typed block markers pass through when editing', () => {
  // 不带选项：`# ` 按字面量转义（用于「块外内容原样输出」的场景）
  assert.equal(serializeBlockMarkdown('paragraph', [textNode('# 标题')]).markdown, '\\# 标题');
  // 带选项：用户刚敲出的标记保留为语法，交给重新解析决定块类型
  const editing = serializeBlockMarkdown('paragraph', [textNode('# 标题')], { allowBlockMarkers: true });
  assert.equal(editing.markdown, '# 标题');
  assert.equal(editing.containers[0].escapeLineStart, false);
  // 标记不成立时仍然转义（`#标题` 没有空格，不是标题）
  assert.equal(
    serializeBlockMarkdown('paragraph', [textNode('#标题')], { allowBlockMarkers: true }).markdown,
    '\\#标题',
  );
});

it('serializes blockquotes line by line with quote markers', () => {
  const result = serializeBlockMarkdown('blockquote', [
    p(textNode('第一段')),
    p(textNode('第二段')),
  ]);
  assert.equal(result.markdown, '> 第一段\n>\n> 第二段');
  assert.deepEqual(result.containers, [
    { path: [0], contentOffset: 2, escapeLineStart: false },
    { path: [1], contentOffset: 10, escapeLineStart: false },
  ]);
});

it('serializes nested lists with two-space indentation and task markers', () => {
  const result = serializeBlockMarkdown('list', [
    ul(
      li(textNode('一'), ul(li(textNode('一之一')))),
      li(textNode('二')),
    ),
  ]);
  assert.equal(result.markdown, '- 一\n  - 一之一\n- 二');
});

it('serializes ordered lists with sequential numbers', () => {
  const result = serializeBlockMarkdown('list', [elementNode('ol', {}, [li(textNode('甲')), li(textNode('乙'))])]);
  assert.equal(result.markdown, '1. 甲\n2. 乙');
});

it('serializes task items from the checkbox state', () => {
  const result = serializeBlockMarkdown('list', [ul(
    li(checkbox(true), textNode('已完成')),
    li(checkbox(false), textNode('待办')),
  )]);
  assert.equal(result.markdown, '- [x] 已完成\n- [ ] 待办');
});

it('refuses to serialize block types that are not editable in place', () => {
  assert.throws(() => serializeBlockMarkdown('fence', []), /不支持就地编辑/);
});

it('ignores renderer whitespace outside the paragraph and keeps the DOM path', () => {
  const result = serializeBlockMarkdown('paragraph', [textNode('\n'), p(textNode('正文')), textNode('\n')]);
  assert.equal(result.markdown, '正文');
  assert.deepEqual(result.containers, [{ path: [1], contentOffset: 0, escapeLineStart: true }]);
});

it('unwraps the rendered blockquote without dropping its content', () => {
  const result = serializeBlockMarkdown('blockquote', [
    elementNode('blockquote', {}, [textNode('\n'), p(textNode('引用正文')), textNode('\n')]),
    textNode('\n'),
  ]);
  assert.equal(result.markdown, '> 引用正文');
  assert.deepEqual(result.containers, [{ path: [0, 1], contentOffset: 2, escapeLineStart: false }]);
});

it('serializes editable table cells through renderer wrappers with alignment and escaped pipes', () => {
  const nodes = [elementNode('div', { class: 'table-resize-wrap' }, [elementNode('table', {}, [
    elementNode('thead', {}, [elementNode('tr', {}, [elementNode('th', { style: 'text-align:center' }, [textNode('标题')]), elementNode('th', {}, [textNode('B')])])]),
    elementNode('tbody', {}, [elementNode('tr', {}, [elementNode('td', {}, [textNode('a|b')]), elementNode('td', {}, [strong(textNode('重点'))])])]),
  ])])];
  const result = serializeBlockMarkdown('table', nodes);
  assert.equal(result.markdown, '| 标题 | B |\n| :---: | --- |\n| a\\|b | **重点** |');
  assert.equal(result.containers.length, 4);
  assert.deepEqual(result.containers[0].path, [0, 0, 0, 0, 0]);
  assert.equal(result.containers[2].escapePipes, true);
});
