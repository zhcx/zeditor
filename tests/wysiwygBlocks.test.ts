import { it } from 'node:test';
import assert from 'node:assert/strict';
import { splitMarkdownDocument, replaceBlockSource, splitEditableMarkdownDocument, replaceEditableBlockSource } from '../src/utils/wysiwyg/blocks.ts';

it('projects eight ordinary source lines into independent editable blocks without changing source', () => {
  for (const eol of ['\n', '\r\n']) {
    const lines = Array.from({ length: 8 }, (_, index) => `正文${index + 1}`);
    const source = [...lines, '', '', '后段甲', '后段乙'].join(eol);
    const document = splitEditableMarkdownDocument(source);
    assert.equal(document.source, source);
    assert.deepEqual(document.blocks.slice(0, 8).map(block => block.source.replace(/(?:\r\n|\n|\r)+$/, '')), lines);
    assert.deepEqual(document.blocks.map(block => block.startLine), [1, 2, 3, 4, 5, 6, 7, 8, 11, 12]);
    for (const block of document.blocks) assert.equal(source.slice(block.offset, block.offset + block.length), block.source);
    const edited = replaceEditableBlockSource(document, document.blocks[3], '只改第四行');
    assert.equal(edited.source, source.replace('正文4', '只改第四行'));
    assert.deepEqual(edited, splitEditableMarkdownDocument(edited.source));
  }
});

it('keeps cross-line inline syntax and Markdown structures intact in the editing projection', () => {
  for (const source of ['**跨行\n加粗**', '[跨行\n链接](https://example.com)', '`跨行\n代码`', '<em>跨行\n文字</em>', '前\\\n后', '前  \n后', '- 项目甲\n- 项目乙', '> 引用甲\n> 引用乙', '```\n代码甲\n代码乙\n```', '| 甲 | 乙 |\n| --- | --- |\n| a | b |']) {
    const document = splitEditableMarkdownDocument(source);
    assert.equal(document.blocks.length, 1, source);
    assert.equal(document.blocks[0].source, source);
  }
});

it('rechecks neighboring line projections when editing closes cross-line formatting', () => {
  const document = splitEditableMarkdownDocument('**前行\n后行');
  assert.equal(document.blocks.length, 2);
  const next = replaceEditableBlockSource(document, document.blocks[1], '后行**');
  assert.deepEqual(next, splitEditableMarkdownDocument('**前行\n后行**'));
});

it('keeps editable trailing and inter-paragraph lines in the owning paragraph', () => {
  for (const eol of ['\n', '\r\n', '\r']) {
    const source = `前${eol}${eol}后${eol}${eol}`;
    const document = splitEditableMarkdownDocument(source);
    assert.deepEqual(document.blocks.map(block => block.source), [`前${eol}`, `后${eol}${eol}`]);
    for (const block of document.blocks) assert.equal(source.slice(block.offset, block.offset + block.length), block.source);
    const first = document.blocks[0];
    const updated = replaceEditableBlockSource(document, first, `前改${eol}`);
    assert.equal(updated.source, `前改${eol}${eol}后${eol}${eol}`);
    assert.deepEqual(updated.blocks, splitEditableMarkdownDocument(updated.source).blocks);
  }
});

it('keeps blank documents and the line after a heading editable at their real source offsets', () => {
  assert.deepEqual(splitEditableMarkdownDocument('\n\n').blocks.map(block => [block.offset, block.source]), [[0, '\n\n']]);
  const document = splitEditableMarkdownDocument('# 标题\n');
  assert.deepEqual(document.blocks.map(block => [block.offset, block.source]), [[0, '# 标题'], [5, '']]);
  const leading = splitEditableMarkdownDocument('\n\n正文').blocks[0];
  assert.deepEqual([leading.source, leading.startLine, leading.endLine], ['\n', 1, 2]);
});

it('indexes block offsets, lengths and line numbers', () => {
  const document = splitMarkdownDocument('# 标题\n\n段落\n');
  assert.equal(document.blocks.length, 2);
  assert.deepEqual(
    document.blocks.map(({ kind, startLine, endLine, offset, length, source }) => ({ kind, startLine, endLine, offset, length, source })),
    [
      { kind: 'heading', startLine: 1, endLine: 1, offset: 0, length: 4, source: '# 标题' },
      { kind: 'paragraph', startLine: 3, endLine: 3, offset: 6, length: 2, source: '段落' },
    ],
  );
});

it('keeps every block source aligned with the document text', () => {
  const source = '前言\n\n## 小标题\n\n- 一项\n- 二项\n\n> 引用第一行\n> 引用第二行\n\n| a | b |\n| - | - |\n| 1 | 2 |\n';
  const document = splitMarkdownDocument(source);
  for (const block of document.blocks) {
    assert.equal(source.slice(block.offset, block.offset + block.length), block.source);
  }
  // 块与块之间只允许存在空白
  let cursor = 0;
  for (const block of document.blocks) {
    assert.match(source.slice(cursor, block.offset), /^\s*$/);
    cursor = block.offset + block.length;
  }
  assert.match(source.slice(cursor), /^\s*$/);
});

it('treats fenced code as a single block', () => {
  const document = splitMarkdownDocument('```ts\n# 不是标题\n- 不是列表\n```\n后记\n');
  assert.deepEqual(document.blocks.map(block => block.kind), ['fence', 'paragraph']);
  assert.equal(document.blocks[0].source, '```ts\n# 不是标题\n- 不是列表\n```');
  assert.equal(document.blocks[0].editable, false);
});

it('groups nested lists and blockquotes into one block each', () => {
  const document = splitMarkdownDocument('- 一\n  - 一之一\n- 二\n\n> 引用\n>\n> 第二段\n');
  assert.deepEqual(document.blocks.map(block => block.kind), ['list', 'blockquote']);
  assert.equal(document.blocks[0].editable, true);
  assert.equal(document.blocks[1].editable, true);
});

it('handles CRLF documents', () => {
  const document = splitMarkdownDocument('# 标题\r\n\r\n段落\r\n');
  assert.equal(document.eol, '\r\n');
  assert.deepEqual(document.blocks.map(block => [block.startLine, block.offset, block.length]), [[1, 0, 4], [3, 8, 2]]);
  assert.equal(document.blocks[1].source, '段落');
});

it('handles documents without a trailing newline and empty documents', () => {
  const document = splitMarkdownDocument('# 只有标题');
  assert.equal(document.blocks.length, 1);
  assert.equal(document.blocks[0].source, '# 只有标题');
  assert.equal(document.source, '# 只有标题');
  const empty = splitMarkdownDocument('');
  assert.deepEqual(empty.blocks.map(({ kind, offset, length, source, editable }) => ({ kind, offset, length, source, editable })), [
    { kind: 'paragraph', offset: 0, length: 0, source: '', editable: true },
  ]);

  const blankLines = splitMarkdownDocument('\n\n');
  assert.deepEqual(blankLines.blocks.map(({ kind, offset, length }) => ({ kind, offset, length })), [
    { kind: 'paragraph', offset: 0, length: 0 },
    { kind: 'paragraph', offset: 2, length: 0 },
  ]);

  const trailingParagraph = splitMarkdownDocument('正文\n\n');
  assert.deepEqual(trailingParagraph.blocks.map(({ kind, offset, length }) => ({ kind, offset, length })), [
    { kind: 'paragraph', offset: 0, length: 2 },
    { kind: 'paragraph', offset: 4, length: 0 },
  ]);
});

it('leaves trailing blank lines outside a list block so the caret can land there', () => {
  // 列表 token 会把块尾空行算进自己的范围；若直接采信，块后的空段落就合成不出来，
  // 「在下方插入段落」和空块退块都会把光标丢在无法落脚的位置。
  // 修正后：列表与段落一致——`\n\n` 之后的空行属于块后间隙，会合出一个空段落。
  const withCaretTarget = splitMarkdownDocument('- 一项\n\n');
  assert.deepEqual(
    withCaretTarget.blocks.map(({ kind, offset, length, source }) => ({ kind, offset, length, source })),
    [
      { kind: 'list', offset: 0, length: 4, source: '- 一项' },
      { kind: 'paragraph', offset: 6, length: 0, source: '' },
    ],
  );

  // 多出来的空行同样落在块后，不会堆进列表里。
  const extraBlank = splitMarkdownDocument('- 一项\n\n\n');
  assert.deepEqual(extraBlank.blocks.map(({ kind, offset, length }) => ({ kind, offset, length })), [
    { kind: 'list', offset: 0, length: 4 },
    { kind: 'paragraph', offset: 6, length: 0 },
  ]);

  // 只有一个换行时和段落一样：它只是行结束符，不是空行。
  for (const source of ['- 一项', '- 一项\n']) {
    const document = splitMarkdownDocument(source);
    assert.deepEqual(
      document.blocks.map(({ kind, offset, length }) => ({ kind, offset, length })),
      [{ kind: 'list', offset: 0, length: 4 }],
      `源码 ${JSON.stringify(source)} 不应凭空多出空段落`,
    );
  }

  // 列表后面本来就有内容时，间隔不受影响。
  const followed = splitMarkdownDocument('- 一项\n\n下一段');
  assert.deepEqual(followed.blocks.map(({ kind, offset, length }) => ({ kind, offset, length })), [
    { kind: 'list', offset: 0, length: 4 },
    { kind: 'paragraph', offset: 6, length: 3 },
  ]);

  // 引用/标题原本就不会吞空行，行为保持不变。
  assert.deepEqual(
    splitMarkdownDocument('> 引用\n\n').blocks.map(({ kind, offset, length }) => ({ kind, offset, length })),
    [
      { kind: 'blockquote', offset: 0, length: 4 },
      { kind: 'paragraph', offset: 6, length: 0 },
    ],
  );
});

it('keeps the in-place block update identical to a full reparse', () => {
  // 输入普通文字/行内标记时 replaceBlockSource 走局部更新（不重新解析全文），
  // 结果必须与全文重新分块逐字段一致，否则后续输入会写到错误偏移。
  const source = '# 标题\n\n段落一\n\n- 列表甲\n- 列表乙\n\n> 引用第一行\n> 引用第二行\n\n| a | b |\n| - | - |\n| 1 | 2 |\n';
  const document = splitMarkdownDocument(source);
  const edits: Array<[number, string]> = [
    [1, '段落一改'],
    [2, '- 列表甲改\\n- 列表乙'],
    [3, '> 引用第一行改\\n> 引用第二行'],
    [4, '| a | b |\\n| - | - |\\n| 1 | 3 |'],
  ];
  for (const [index, nextSource] of edits) {
    const next = replaceBlockSource(document, document.blocks[index], nextSource);
    const expected = splitMarkdownDocument(next.source);
    assert.deepEqual(next.blocks, expected.blocks, nextSource);
    assert.equal(next.source, expected.source);
  }
});

it('falls back to a full reparse when the block structure changes', () => {
  const document = splitMarkdownDocument('标题\n\n正文');
  for (const [index, nextSource] of [[0, '# 标题'], [1, '- 正文'], [0, '标题\\n\\n新段落']] as Array<[number, string]>) {
    const next = replaceBlockSource(document, document.blocks[index], nextSource);
    assert.deepEqual(next.blocks, splitMarkdownDocument(next.source).blocks, nextSource);
  }
});

it('reparses neighboring blocks when a same-kind edit changes their Markdown boundaries', () => {
  const cases: Array<[string, number, string]> = [
    ['- a\n\n+ b', 0, '+ a'],
    ['1. a\n\n- b', 0, '- a'],
    ['a\n***', 1, '---'],
    ['```js\nx\n```\n\nafter', 0, '```js\nx'],
    ['<pre>x</pre>\n\nafter', 0, '<pre>x'],
    ['- a\n\nb', 1, '  b'],
  ];
  for (const [source, index, replacement] of cases) {
    const document = splitMarkdownDocument(source);
    const next = replaceBlockSource(document, document.blocks[index], replacement);
    assert.deepEqual(next, splitMarkdownDocument(next.source), JSON.stringify({ source, index, replacement }));
  }
});

it('recalculates empty caret blocks when paragraph content is removed', () => {
  for (const source of ['a\n\n\nb', 'a\n# heading', '# heading\nb', 'a\n\nb\n\n']) {
    const document = splitMarkdownDocument(source);
    const index = document.blocks.findIndex(block => block.kind === 'paragraph');
    const next = replaceBlockSource(document, document.blocks[index], '');
    assert.deepEqual(next, splitMarkdownDocument(next.source), JSON.stringify(source));
  }
  const document = splitMarkdownDocument('a\n\n\nb');
  const next = replaceBlockSource(document, document.blocks[1], '');
  assert.deepEqual(next, splitMarkdownDocument(next.source));
});

it('updates the document EOL when the replaced block changes the only CRLF sequence', () => {
  for (const [source, replacement] of [['a\nb', 'x\r\ny'], ['a\r\nb', 'x\ny']]) {
    const document = splitMarkdownDocument(source);
    const next = replaceBlockSource(document, document.blocks[0], replacement);
    assert.deepEqual(next, splitMarkdownDocument(next.source));
  }
});

it('keeps ordinary text edits local without rebuilding unaffected blocks', () => {
  for (const [source, replacement] of [['first\n\nsecond', 'first changed'], ['# heading\n\nbody', '# heading changed'], ['first\ncontinued\n\nsecond', 'first changed\ncontinued']]) {
    const document = splitMarkdownDocument(source);
    const next = replaceBlockSource(document, document.blocks[0], replacement);
    assert.deepEqual(next, splitMarkdownDocument(next.source));
    assert.equal(next.blocks[1].source, document.blocks[1].source);
    // A real local edit keeps the unchanged prefix block rather than parsing it again.
    const editedLast = replaceBlockSource(document, document.blocks[1], 'second changed');
    assert.equal(editedLast.blocks[0], document.blocks[0]);
  }
});

it('replaces one block source without touching the rest of the document', () => {
  const document = splitMarkdownDocument('# 标题\n\n段落一\n\n段落二\n');
  const target = document.blocks[1];
  const next = replaceBlockSource(document, target, '改写后的段落');
  assert.equal(next.source, '# 标题\n\n改写后的段落\n\n段落二\n');
  assert.equal(next.blocks[1].source, '改写后的段落');
  assert.equal(next.blocks[2].source, '段落二');
  assert.equal(next.blocks[2].startLine, 5);
});

it('keeps media and display math blocks read-only', () => {
  const document = splitMarkdownDocument('@[video](demo.mp4)\n\n$$\nE = mc^2\n$$\n\n普通段落\n');
  assert.deepEqual(document.blocks.map(block => [block.kind, block.editable]), [
    ['paragraph', false],
    ['paragraph', false],
    ['paragraph', true],
  ]);
});

it('keeps multi-line footnote definition indentation safe behind block source editing', () => {
  for (const content of ['[^n]: first\n    continued', '[^n]: first\n\n\tcontinued']) {
    const definition = splitMarkdownDocument(content).blocks[0];
    assert.equal(definition.editable, false);
    assert.equal(definition.source, content);
  }
});

it('keeps structures the inline serializer cannot round-trip read-only', () => {
  const source = [
    '- 普通项',
    '- 带代码的项',
    '  ```ts',
    '  const a = 1;',
    '  ```',
    '',
    '> 纯段落引用',
    '',
    '> 引用里的列表',
    '> - 项',
    '',
    '```ts',
    'const b = 2;',
    '```',
  ].join('\n') + '\n';
  const document = splitMarkdownDocument(source);
  assert.deepEqual(document.blocks.map(block => [block.kind, block.editable]), [
    ['list', false],
    ['blockquote', true],
    ['blockquote', true],
    ['fence', false],
  ]);
});

it('keeps CRLF intact when a block is replaced', () => {
  const document = splitMarkdownDocument('第一段\r\n\r\n第二段\r\n');
  const next = replaceBlockSource(document, document.blocks[0], '改过的第一段');
  assert.equal(next.source, '改过的第一段\r\n\r\n第二段\r\n');
});

it('protects nested block structures that the serializer cannot round-trip', () => {
  for (const source of [
    '> ```ts\n> const x = 1;\n> ```',
    '- 项\n\n      indented code',
    '> 内容\n>\n> ---',
  ]) {
    const block = splitMarkdownDocument(source).blocks[0];
    assert.equal(block.editable, false, source);
    assert.equal(block.source, source);
  }
  for (const source of ['> 单层引用\n>\n> 第二段', '> > 嵌套引用', '- 项\n  > 子引用', '- 项\n\n  # 子标题', '- 项\n\n  另一段', '- 甲\n  - 子项\n- 乙', '- 甲\n\n- 乙']) {
    assert.equal(splitMarkdownDocument(source).blocks[0].editable, true, source);
  }
});

it('keeps editable empty paragraphs before and between nonempty blocks', () => {
  const source = '\n\n第一段\n\n\n\n第二段';
  const document = splitMarkdownDocument(source);
  assert.deepEqual(document.blocks.map(block => [block.source, block.offset]), [
    ['', 0], ['第一段', 2], ['', 7], ['第二段', 9],
  ]);
  const next = replaceBlockSource(document, document.blocks[2], '新段落');
  assert.equal(next.source, '\n\n第一段\n\n新段落\n\n第二段');
});

it('indexes every empty caret block correctly in large LF, CRLF and CR documents', () => {
  for (const eol of ['\n', '\r\n', '\r']) {
    const source = eol.repeat(4) + Array.from({ length: 200 }, (_, index) => `段落 ${index}${eol.repeat(4)}`).join('');
    const document = splitMarkdownDocument(source);
    for (const block of document.blocks) {
      const expectedLine = source.slice(0, block.offset).split(/\r\n|\n|\r/).length;
      assert.equal(block.startLine, expectedLine);
      assert.equal(source.slice(block.offset, block.offset + block.length), block.source);
    }
    assert.equal(document.blocks.at(-1)?.startLine, 805);
  }
});

it('preserves reference definitions that do not produce rendered tokens', () => {
  const source = '[ref]: https://example.com\n\n';
  const document = splitMarkdownDocument(source);
  assert.equal(document.blocks[0].editable, false);
  assert.equal(document.blocks[0].source, '[ref]: https://example.com');
  assert.equal(document.blocks[1].offset, source.length);
  assert.equal(replaceBlockSource(document, document.blocks[1], '正文').source, source + '正文');
  assert.equal(splitMarkdownDocument('正文\n\n[ref]: https://example.com\n').blocks.length, 1);
});
