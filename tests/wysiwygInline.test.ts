import { it } from 'node:test';
import assert from 'node:assert/strict';
import { elementNode, textNode, type InlineNode } from '../src/utils/wysiwyg/inlineNodes.ts';
import { emitInlineMarkdown, serializeInlineNodes } from '../src/utils/wysiwyg/inlineSerialize.ts';

const bold = (...children: InlineNode[]) => elementNode('strong', {}, children);
const italic = (...children: InlineNode[]) => elementNode('em', {}, children);
const strike = (...children: InlineNode[]) => elementNode('del', {}, children);
const code = (text: string) => elementNode('code', {}, [textNode(text)]);
const link = (href: string, ...children: InlineNode[]) => elementNode('a', { href }, children);
const image = (src: string, alt = '', attrs: Record<string, string> = {}) => elementNode('img', { src, alt, ...attrs }, []);
const math = (tex: string) => elementNode('span', { class: 'zeditor-math', 'data-tex': tex }, [textNode(tex)]);
const lineBreak = () => elementNode('br', {}, []);

it('omits the caret placeholder in an otherwise empty editable container', () => {
  assert.equal(serializeInlineNodes([elementNode('br', { 'data-wysiwyg-placeholder': 'true' }, [])]), '');
  assert.equal(serializeInlineNodes([lineBreak()]), '\n');
});

it('preserves underline, superscript, subscript and highlight toolbar formatting', () => {
  for (const tag of ['u', 'sup', 'sub', 'mark']) {
    assert.equal(serializeInlineNodes([elementNode(tag, {}, [textNode('格式')])]), `<${tag}>格式</${tag}>`);
  }
});

it('serializes plain text with required escapes', () => {
  assert.equal(serializeInlineNodes([textNode('2 * 3 = 6')]), '2 \\* 3 = 6');
  assert.equal(serializeInlineNodes([textNode('a_b [c] `d` ~e~ $f$ \\g')]), 'a\\_b \\[c\\] \\`d\\` \\~e\\~ \\$f\\$ \\\\g');
});

it('escapes line-leading characters only at the start of a line', () => {
  assert.equal(serializeInlineNodes([textNode('# 不是标题')]), '\\# 不是标题');
  assert.equal(serializeInlineNodes([textNode('# 不是标题')], { escapeLineStart: false }), '# 不是标题');
  assert.equal(serializeInlineNodes([textNode('第一行'), lineBreak(), textNode('- 不是列表')]), '第一行\n\\- 不是列表');
});

it('serializes emphasis, strikethrough and inline code', () => {
  assert.equal(serializeInlineNodes([bold(textNode('粗'))]), '**粗**');
  assert.equal(serializeInlineNodes([italic(textNode('斜'))]), '*斜*');
  assert.equal(serializeInlineNodes([strike(textNode('删'))]), '~~删~~');
  assert.equal(serializeInlineNodes([bold(italic(textNode('又粗又斜')))]), '***又粗又斜***');
  assert.equal(serializeInlineNodes([code('a = 1')]), '`a = 1`');
  assert.equal(serializeInlineNodes([code('a`b')]), '``a`b``');
  assert.equal(serializeInlineNodes([code('`x`')]), '`` `x` ``');
});

it('drops empty inline elements instead of emitting empty markers', () => {
  assert.equal(serializeInlineNodes([bold(textNode('')), textNode('留下')]), '留下');
});

it('serializes links, images and inline math', () => {
  assert.equal(serializeInlineNodes([link('https://a.dev', textNode('站点'))]), '[站点](https://a.dev)');
  assert.equal(serializeInlineNodes([image('a.png', '图', { width: '320' })]), '![图](a.png){width=320}');
  assert.equal(serializeInlineNodes([textNode('面积 '), math('S = a^2')]), '面积 $S = a^2$');
});

it('ignores non-inline islands such as checkboxes, nested lists and figures', () => {
  const nodes: InlineNode[] = [
    elementNode('input', { type: 'checkbox', checked: 'true' }, []),
    textNode('任务文本'),
    elementNode('ul', {}, [elementNode('li', {}, [textNode('嵌套项')])]),
    elementNode('figure', { class: 'media-embed' }, [elementNode('video', {}, [])]),
  ];
  assert.equal(serializeInlineNodes(nodes), '任务文本');
});

it('reports the markdown offset of every piece it emits', () => {
  const pieces = emitInlineMarkdown([textNode('a'), bold(textNode('b')), textNode('c')]);
  assert.deepEqual(pieces.map(piece => piece.text), ['a', '**', 'b', '**', 'c']);
  assert.deepEqual(pieces.map(piece => piece.path), [[0], [1], [1, 0], [1], [2]]);
  assert.deepEqual(pieces.map(piece => piece.kind), ['text', 'syntax', 'text', 'syntax', 'text']);
});

it('writes the original image source back, not the resolved asset url', () => {
  const resolved = elementNode('img', { src: 'asset://localhost/D%3A/a.png', alt: '图', 'data-md-src': './a.png' }, []);
  assert.equal(serializeInlineNodes([resolved]), '![图](./a.png)');
});

it('escapes pipes inside table cells, including code spans and link text', () => {
  // 回归：单元格里的行内代码含竖线时，写回会被当成列分隔符，表格多出一列。
  assert.equal(serializeInlineNodes([code('a|b')], { escapePipes: true }), '`a\\|b`');
  assert.equal(serializeInlineNodes([textNode('前|后')], { escapePipes: true }), '前\\|后');
  assert.equal(
    serializeInlineNodes([elementNode('img', { src: 'a|b.png', alt: '图|注' }, [])], { escapePipes: true }),
    '![图\\|注](a\\|b.png)',
  );
  // 不开启时行为不变（普通段落里的竖线不需要转义）
  assert.equal(serializeInlineNodes([code('a|b')]), '`a|b`');
  assert.equal(serializeInlineNodes([textNode('前|后')]), '前|后');
});

it('round-trips wiki links through the rendered span', () => {
  const wiki = (target: string, anchor: string | null, text: string) => elementNode('span', {
    class: 'wiki-link',
    'data-wiki-target': target,
    ...(anchor ? { 'data-wiki-anchor': anchor } : {}),
  }, [textNode(text)]);

  assert.equal(serializeInlineNodes([wiki('笔记', null, '笔记')]), '[[笔记]]');
  assert.equal(serializeInlineNodes([wiki('笔记', '标题', '笔记 > 标题')]), '[[笔记#标题]]');
  // 就地修改显示文字后作为别名写回。
  assert.equal(serializeInlineNodes([wiki('笔记', null, '别称')]), '[[笔记|别称]]');
});

it('round-trips footnote references through the rendered sup', () => {
  const footnote = (name: string) => elementNode('sup', {
    class: 'footnote-ref',
    'data-footnote-name': name,
  }, [textNode(`[${name}]`)]);

  assert.equal(serializeInlineNodes([textNode('正文'), footnote('1')]), '正文[^1]');
});
