import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDocumentRevision,
  isPathWithinScope,
  mcpError,
} from '../src/utils/mcpTools.ts';

test('document revision changes with content and survives round trips', () => {
  const a = computeDocumentRevision('# 标题\n\n正文');
  assert.match(a, /^\d+:[0-9a-f]{1,8}$/);
  assert.equal(a, computeDocumentRevision('# 标题\n\n正文'));
  assert.notEqual(a, computeDocumentRevision('# 标题\n\n正文。'));
  assert.notEqual(a, computeDocumentRevision('# 标题\n\n正文 '));
});

test('path scope accepts workspace roots and open document directories', () => {
  const roots = ['D:\\notes', 'd:\\work\\proj', 'C:/src/repo'];
  assert.equal(isPathWithinScope('D:\\notes\\a.md', roots), true);
  assert.equal(isPathWithinScope('d:\\notes\\sub\\b.md', roots), true);
  assert.equal(isPathWithinScope('d:\\work\\proj\\c.md', roots), true);
  assert.equal(isPathWithinScope('C:\\src\\repo\\d.md', roots), true);
  // 大小写与分隔符不敏感。
  assert.equal(isPathWithinScope('d:/NOTES/e.md', roots), true);
});

test('path scope rejects paths outside roots and lookalike prefixes', () => {
  const roots = ['D:\\notes', 'C:\\'];
  assert.equal(isPathWithinScope('D:\\other\\a.md', roots), false);
  // 前缀相似但不是子目录：D:\notes2 不在 D:\notes 内。
  assert.equal(isPathWithinScope('D:\\notes2\\a.md', roots), false);
  assert.equal(isPathWithinScope('E:\\notes\\a.md', roots), false);
  assert.equal(isPathWithinScope('web://dir/a.md', roots), false);
  assert.equal(isPathWithinScope('', roots), false);
  // 盘符根：C:\ 范围内的文件允许。
  assert.equal(isPathWithinScope('C:\\Windows\\x.md', roots), true);
});

test('mcpError builds a structured domain error envelope', () => {
  assert.deepEqual(mcpError('STALE', 'changed', { current_revision: 'r1' }), {
    error: 'STALE',
    message: 'changed',
    current_revision: 'r1',
  });
});
