import { it } from 'node:test';
import assert from 'node:assert/strict';
import {
  arrowLeavesBlock,
  contentStartOffset,
  exitEmptyItem,
  hasTrailingEmptyQuoteLine,
  mergeBlocks,
  mergeForward,
  setHeadingLevel,
  splitBlock,
  stripBlockPrefix,
  adjustListIndent,
} from '../src/utils/wysiwyg/blockOps.ts';
import { splitMarkdownDocument } from '../src/utils/wysiwyg/blocks.ts';

it('reports where the block content starts', () => {
  assert.equal(contentStartOffset('# 标题', 'heading'), 2);
  assert.equal(contentStartOffset('- [x] 任务', 'list'), 6);
  assert.equal(contentStartOffset('2. 第二项', 'list'), 3);
  assert.equal(contentStartOffset('> 引用文本', 'blockquote'), 2);
  assert.equal(contentStartOffset('普通段落', 'paragraph'), 0);
});

it('splits paragraphs, headings, quotes and list items on Enter', () => {
  assert.deepEqual(splitBlock({ source: '前半后半', kind: 'paragraph', caret: 2 }), {
    head: '前半',
    tail: '后半',
    separator: '\n\n',
  });
  assert.deepEqual(splitBlock({ source: '## 标题', kind: 'heading', caret: 7 }), {
    head: '## 标题',
    tail: '',
    separator: '\n\n',
  });
  assert.deepEqual(splitBlock({ source: '- 一项', kind: 'list', caret: 4 }), {
    head: '- 一项',
    tail: '- ',
    separator: '\n',
  });
  assert.deepEqual(splitBlock({ source: '3. 第三项', kind: 'list', caret: 6 }), {
    head: '3. 第三项',
    tail: '4. ',
    separator: '\n',
  });
  // 引用必须用「空引用行」分隔：单换行的 `> a\n> b` 在 CommonMark 里是同一个段落里的
  // 软换行，显示成一个空格，用户会觉得回车没反应。
  assert.deepEqual(splitBlock({ source: '> 引用', kind: 'blockquote', caret: 4 }), {
    head: '> 引用',
    tail: '> ',
    separator: '\n>\n',
  });
});

it('breaks a quote into two quote paragraphs, not one soft-wrapped line', () => {
  const result = splitBlock({ source: '> 第一段', kind: 'blockquote', caret: 5 });
  assert.ok(result);
  const joined = result.head + result.separator + result.tail;
  assert.equal(joined, '> 第一段\n>\n> ');
  const blocks = splitMarkdownDocument(joined).blocks;
  assert.deepEqual(blocks.map(block => block.kind), ['blockquote']);
  // 分隔符里必须出现空引用行，否则两段会落在同一个引用段落里。
  assert.match(blocks[0].source, /\n>\n/);
});

it('keeps the quote marker of nested quotes when splitting', () => {
  const result = splitBlock({ source: '> > 深', kind: 'blockquote', caret: 5 });
  assert.ok(result);
  assert.equal(result.tail, '> > ');
  assert.equal(splitMarkdownDocument(result.head + result.separator + result.tail).blocks[0].kind, 'blockquote');
});

it('detects the trailing empty quote line that markdown-it does not render', () => {
  // 回车拆出的新引用段落是空的：markdown-it 不生成 <p>，DOM 里没有落点，
  // 外壳据此补一个空段落节点。
  const result = splitBlock({ source: '> 第一段', kind: 'blockquote', caret: 5 });
  assert.ok(result);
  assert.equal(hasTrailingEmptyQuoteLine(result.head + result.separator + result.tail), true);
  // 有内容的引用行不需要补节点。
  assert.equal(hasTrailingEmptyQuoteLine('> 第一段\n>\n> 第二段'), false);
  assert.equal(hasTrailingEmptyQuoteLine('> 单行引用'), false);
  // 块里的换行还可能是引用内部的空行，只有末行才算。
  assert.equal(hasTrailingEmptyQuoteLine('>'), true);
  assert.equal(hasTrailingEmptyQuoteLine('>   '), true);
  // 末尾换行只是行结束符，后面没有空的引用行。
  assert.equal(hasTrailingEmptyQuoteLine('> a\n'), false);
  assert.equal(hasTrailingEmptyQuoteLine('> a\n>'), true);
  assert.equal(hasTrailingEmptyQuoteLine('> a\n> '), true);
});

it('refuses to split blocks that own their own interaction surface', () => {
  // 表格源码拆开后的第二半会被解析成 `- ` 列表项，整张表就此损坏。
  assert.equal(splitBlock({ source: '| a | b |\n| --- | --- |\n| 1 | 2 |', kind: 'table', caret: 14 }), null);
  assert.equal(splitBlock({ source: '```js\na\n```', kind: 'fence', caret: 8 }), null);
  assert.equal(splitBlock({ source: '---', kind: 'hr', caret: 1 }), null);
  assert.equal(splitBlock({ source: '<div>x</div>', kind: 'html', caret: 5 }), null);
});

it('strips the block prefix to fall back to a paragraph', () => {
  assert.deepEqual(stripBlockPrefix('## 标题', 'heading'), { source: '标题', caret: 0 });
  assert.deepEqual(stripBlockPrefix('- [ ] 任务', 'list'), { source: '任务', caret: 0 });
  assert.deepEqual(stripBlockPrefix('> 引用', 'blockquote'), { source: '引用', caret: 0 });
  assert.equal(stripBlockPrefix('普通段落', 'paragraph'), null);
});

it('merges two paragraphs at the junction', () => {
  assert.deepEqual(mergeBlocks('前一段', '后一段'), { source: '前一段后一段', caret: 3 });
  assert.equal(mergeBlocks('- 列表', '段落'), null);
  // 表格行与围栏拼进段落会被重新解析成表格 / 代码块，吞掉两侧正文。
  assert.equal(mergeBlocks('前一段', '| a |'), null);
  assert.equal(mergeBlocks('前一段', '```js'), null);
});

it('absorbs only plain paragraphs on forward delete', () => {
  assert.deepEqual(mergeForward('前一段', '后一段'), { source: '前一段后一段', caret: 3 });
  // 当前块自己的前缀保留，所以标题、列表项、引用都能吞掉下一段正文。
  assert.deepEqual(mergeForward('## 标题', '正文'), { source: '## 标题正文', caret: 5 });
  assert.deepEqual(mergeForward('- 一项', '续写'), { source: '- 一项续写', caret: 4 });
  // 被吸收块带前缀时不能硬拼：前缀会变成正文里的符号。
  assert.equal(mergeForward('前一段', '- 列表'), null);
  assert.equal(mergeForward('前一段', '# 标题'), null);
  assert.equal(mergeForward('前一段', '> 引用'), null);
  assert.equal(mergeForward('前一段', '| a |'), null);
  assert.equal(mergeForward('前一段', '```'), null);
});

it('changes heading level and clears it with level 0', () => {
  assert.deepEqual(setHeadingLevel('标题', 'paragraph', 3), { source: '### 标题', caret: 4 });
  assert.deepEqual(setHeadingLevel('### 标题', 'heading', 0), { source: '标题', caret: 0 });
  assert.deepEqual(setHeadingLevel('# 标题', 'heading', 2), { source: '## 标题', caret: 3 });
});

it('refuses to retitle blocks that own their own interaction surface', () => {
  // 表格源码没有块前缀，加上 `# ` 之后整张表会重新解析成标题 + 段落。
  assert.equal(setHeadingLevel('| a |\n| --- |\n| 1 |', 'table', 1), null);
  assert.equal(setHeadingLevel('```js\na\n```', 'fence', 2), null);
  assert.equal(setHeadingLevel('---', 'hr', 1), null);
  assert.equal(setHeadingLevel('<div>a</div>', 'html', 1), null);
  // 正文类块不受影响。
  assert.deepEqual(setHeadingLevel('引用', 'blockquote', 1), { source: '# 引用', caret: 2 });
});

it('indents and outdents list items', () => {
  assert.deepEqual(adjustListIndent('- 一项', 'list', 'indent'), { source: '  - 一项', caret: 4 });
  assert.deepEqual(adjustListIndent('  - 一项', 'list', 'outdent'), { source: '- 一项', caret: 2 });
  assert.equal(adjustListIndent('- 一项', 'list', 'outdent'), null);
  assert.equal(adjustListIndent('段落', 'paragraph', 'indent'), null);
});

it('exits an empty list item or quote line instead of stacking another one', () => {
  // 只标注记的空块：直接降级成段落，源码不再含块标记。
  assert.deepEqual(exitEmptyItem({ source: '- ', kind: 'list', caret: 2 }), { source: '', caret: 0 });
  assert.deepEqual(exitEmptyItem({ source: '1. ', kind: 'list', caret: 3 }), { source: '', caret: 0 });
  assert.deepEqual(exitEmptyItem({ source: '- [ ] ', kind: 'list', caret: 6 }), { source: '', caret: 0 });
  assert.deepEqual(exitEmptyItem({ source: '> ', kind: 'blockquote', caret: 2 }), { source: '', caret: 0 });
  // 空项前的正文保留，空行把新段落与列表/引用分开，光标落在新段落。
  assert.deepEqual(exitEmptyItem({ source: '- 甲\n- ', kind: 'list', caret: 6 }), { source: '- 甲\n\n', caret: 5 });
  assert.deepEqual(exitEmptyItem({ source: '> 甲\n> ', kind: 'blockquote', caret: 6 }), { source: '> 甲\n\n', caret: 5 });
  assert.deepEqual(exitEmptyItem({ source: '- 甲\n  - ', kind: 'list', caret: 8 }), { source: '- 甲\n\n', caret: 5 });
});

it('keeps stacking items when the empty item is not the last line', () => {
  // 列表中间的空项不能把列表劈成两半，交回普通拆行。
  assert.equal(exitEmptyItem({ source: '- 甲\n- \n- 乙', kind: 'list', caret: 6 }), null);
  assert.equal(exitEmptyItem({ source: '> 甲\n> \n> 乙', kind: 'blockquote', caret: 6 }), null);
  // 有内容的行不是空块。
  assert.equal(exitEmptyItem({ source: '- 甲', kind: 'list', caret: 3 }), null);
  assert.equal(exitEmptyItem({ source: '> 甲', kind: 'blockquote', caret: 3 }), null);
  // 只处理列表与引用，段落与标题走普通拆行。
  assert.equal(exitEmptyItem({ source: '', kind: 'paragraph', caret: 0 }), null);
  assert.equal(exitEmptyItem({ source: '## ', kind: 'heading', caret: 3 }), null);
});

it('lets the arrow keys leave a block only from its content boundary', () => {
  // 块内的行间移动交回浏览器：文件里的软换行与行首前缀都由原生行为处理得更准。
  assert.equal(arrowLeavesBlock({ kind: 'paragraph', markdown: '前段甲', caret: 1, direction: 'left' }), false);
  assert.equal(arrowLeavesBlock({ kind: 'paragraph', markdown: '前段甲', caret: 1, direction: 'up' }), false);
  assert.equal(arrowLeavesBlock({ kind: 'paragraph', markdown: '前段甲', caret: 1, direction: 'down' }), false);
  assert.equal(arrowLeavesBlock({ kind: 'paragraph', markdown: '前段甲', caret: 1, direction: 'right' }), false);
  // 贴边界时可以跨块：左/上看内容开头，右/下看内容末尾。
  assert.equal(arrowLeavesBlock({ kind: 'paragraph', markdown: '前段甲', caret: 0, direction: 'left' }), true);
  assert.equal(arrowLeavesBlock({ kind: 'paragraph', markdown: '前段甲', caret: 0, direction: 'up' }), true);
  assert.equal(arrowLeavesBlock({ kind: 'paragraph', markdown: '前段甲', caret: 3, direction: 'right' }), true);
  assert.equal(arrowLeavesBlock({ kind: 'paragraph', markdown: '前段甲', caret: 3, direction: 'down' }), true);
  // 空块：开头就是末尾，四个方向都能离开。
  assert.equal(arrowLeavesBlock({ kind: 'paragraph', markdown: '', caret: 0, direction: 'up' }), true);
  assert.equal(arrowLeavesBlock({ kind: 'paragraph', markdown: '', caret: 0, direction: 'down' }), true);
});

it('treats the whole block prefix as the block start', () => {
  // 前缀区间（含 `# ` 内部）都还在块开头：往左/往上离开时才和 isCaretAtBlockStart 一致。
  assert.equal(arrowLeavesBlock({ kind: 'heading', markdown: '# 标题', caret: 2, direction: 'up' }), true);
  assert.equal(arrowLeavesBlock({ kind: 'heading', markdown: '# 标题', caret: 1, direction: 'up' }), true);
  assert.equal(arrowLeavesBlock({ kind: 'heading', markdown: '# 标题', caret: 3, direction: 'up' }), false);
  assert.equal(arrowLeavesBlock({ kind: 'list', markdown: '- 一项', caret: 2, direction: 'left' }), true);
  assert.equal(arrowLeavesBlock({ kind: 'list', markdown: '- 一项', caret: 3, direction: 'left' }), false);
  assert.equal(arrowLeavesBlock({ kind: 'blockquote', markdown: '> 引用', caret: 2, direction: 'up' }), true);
  assert.equal(arrowLeavesBlock({ kind: 'blockquote', markdown: '> 引用', caret: 3, direction: 'up' }), false);
  // 末尾侧不看前缀，整段源码长度就是边界。
  assert.equal(arrowLeavesBlock({ kind: 'heading', markdown: '# 标题', caret: 4, direction: 'down' }), true);
  assert.equal(arrowLeavesBlock({ kind: 'heading', markdown: '# 标题', caret: 3, direction: 'down' }), false);
});
