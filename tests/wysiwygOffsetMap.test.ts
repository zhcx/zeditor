import { it } from 'node:test';
import assert from 'node:assert/strict';
import { elementNode, textNode, type InlineNode } from '../src/utils/wysiwyg/inlineNodes.ts';
import { serializeBlockMarkdown } from '../src/utils/wysiwyg/blockSerialize.ts';
import { blockOffsetFromPoint, pointFromBlockOffset } from '../src/utils/wysiwyg/offsetMap.ts';

const p = (...children: InlineNode[]) => elementNode('p', {}, children);
const strong = (...children: InlineNode[]) => elementNode('strong', {}, children);

it('maps a caret inside wrapped text to the markdown offset', () => {
  const nodes = [textNode('前 '), strong(textNode('重点')), textNode(' 后')];
  const block = serializeBlockMarkdown('paragraph', nodes);
  assert.equal(block.markdown, '前 **重点** 后');
  // 「重点」第 2 个字后方 → '前 ' (2) + '**' (2) + 2 = 6
  assert.equal(blockOffsetFromPoint(block, { nodes, path: [] }, { path: [1, 0], offset: 2 }), 6);
});

it('snaps offsets that fall inside a marker to the nearest text position', () => {
  const nodes = [strong(textNode('重点')), textNode('后')];
  const block = serializeBlockMarkdown('paragraph', nodes);
  assert.equal(block.markdown, '**重点**后');
  // 3 落在内容中间 → 强元素内第 1 个字之后
  assert.deepEqual(pointFromBlockOffset(block, { nodes, path: [] }, 3), { path: [0, 0], offset: 1 });
  // 4 / 5 落在闭合 '**' 内部 → 吸附到内容末尾
  assert.deepEqual(pointFromBlockOffset(block, { nodes, path: [] }, 4), { path: [0, 0], offset: 2 });
  assert.deepEqual(pointFromBlockOffset(block, { nodes, path: [] }, 5), { path: [0, 0], offset: 2 });
  // 6 恰好越过标记 → 落在后续文本的起点
  assert.deepEqual(pointFromBlockOffset(block, { nodes, path: [] }, 6), { path: [1], offset: 0 });
});

it('round-trips offsets that land inside text content', () => {
  const nodes = [textNode('a'), strong(textNode('bb')), textNode('cc')];
  const block = serializeBlockMarkdown('paragraph', nodes);
  assert.equal(block.markdown, 'a**bb**cc');
  // 'a'(0) '**'(1-2) 'bb'(3-4) '**'(5-6) 'cc'(7-8)
  for (const offset of [1, 3, 4, 7, 8]) {
    const point = pointFromBlockOffset(block, { nodes, path: [] }, offset);
    assert.ok(point, `offset ${offset} 应能映射到 DOM 位置`);
    assert.equal(blockOffsetFromPoint(block, { nodes, path: [] }, point!), offset, `offset ${offset} 应能原样往返`);
  }
});

it('maps offsets inside a blockquote paragraph with the quote marker offset', () => {
  const nodes = [p(textNode('第一段')), p(textNode('第二段'))];
  const block = serializeBlockMarkdown('blockquote', nodes);
  assert.equal(block.markdown, '> 第一段\n>\n> 第二段');
  const container = { nodes: [textNode('第二段')], path: [1] };
  // '> 第一段' (5) + '\n>' (2) + '> ' (2) + 1 = 10
  assert.equal(blockOffsetFromPoint(block, container, { path: [0], offset: 0 }), 10);
  assert.equal(blockOffsetFromPoint(block, container, { path: [0], offset: 2 }), 12);
});

it('returns null when the container path is unknown', () => {
  const nodes = [textNode('文字')];
  const block = serializeBlockMarkdown('paragraph', nodes);
  assert.equal(blockOffsetFromPoint(block, { nodes, path: [9] }, { path: [0], offset: 1 }), null);
  assert.equal(pointFromBlockOffset(block, { nodes, path: [9] }, 1), null);
});

it('maps the empty paragraph caret to and from its block offset', () => {
  const nodes: InlineNode[] = [];
  const block = serializeBlockMarkdown('paragraph', nodes);
  const container = { nodes, path: [] };
  const point = { path: [], offset: 0 };

  assert.equal(blockOffsetFromPoint(block, container, point), 0);
  assert.deepEqual(pointFromBlockOffset(block, container, 0), point);
  assert.equal(blockOffsetFromPoint(block, container, { path: [0], offset: 0 }), 0);
});
