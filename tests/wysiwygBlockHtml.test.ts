import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createBlockHtmlRenderer } from '../src/utils/wysiwyg/blockHtml.ts';

it('reuses rendered blocks and includes the block kind in the cache key', () => {
  let calls = 0;
  const render = createBlockHtmlRenderer(source => `${++calls}:${source}`, 3);
  assert.equal(render('paragraph', '正文'), '1:正文');
  assert.equal(render('paragraph', '正文'), '1:正文');
  assert.equal(render('heading', '正文'), '2:正文');
  assert.equal(calls, 2);
});

it('evicts only the least recently used block at capacity', () => {
  let calls = 0;
  const render = createBlockHtmlRenderer(source => `${++calls}:${source}`, 3);
  const first = render('paragraph', '一');
  render('paragraph', '二');
  const third = render('paragraph', '三');
  assert.equal(render('paragraph', '一'), first, '最近访问的块继续保留');
  render('paragraph', '四');
  assert.equal(render('paragraph', '三'), third, '达到上限不能清空其它缓存');
  assert.equal(render('paragraph', '一'), first);
  assert.equal(render('paragraph', '二'), '5:二', '只淘汰最久未使用的块');
});
