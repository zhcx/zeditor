import { it } from 'node:test';
import assert from 'node:assert/strict';
import { splitMarkdownDocument, replaceBlockSource } from '../src/utils/wysiwyg/blocks.ts';

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
  assert.deepEqual(splitMarkdownDocument('').blocks, []);
  assert.deepEqual(splitMarkdownDocument('\n\n').blocks, []);
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
    ['blockquote', false],
    ['fence', false],
  ]);
});

it('keeps CRLF intact when a block is replaced', () => {
  const document = splitMarkdownDocument('第一段\r\n\r\n第二段\r\n');
  const next = replaceBlockSource(document, document.blocks[0], '改过的第一段');
  assert.equal(next.source, '改过的第一段\r\n\r\n第二段\r\n');
});
