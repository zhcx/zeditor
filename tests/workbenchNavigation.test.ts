import test from 'node:test';
import assert from 'node:assert/strict';
import * as navigation from '../src/utils/workbenchNavigation.ts';

test('文档搜索同时匹配名称和路径，多个关键词必须全部匹配', () => {
  const documents = [
    { id: 'a', title: '计划.md', path: 'C:\\Work\\Notes\\计划.md' },
    { id: 'b', title: '计划草稿.md', path: null },
    { id: 'c', title: 'Guide.md', path: '/projects/docs/Guide.md' },
  ];
  assert.deepEqual(navigation.filterOpenDocuments(documents, 'work 计划'), [documents[0]]);
  assert.deepEqual(navigation.filterOpenDocuments(documents, 'DOCS guide'), [documents[2]]);
  assert.deepEqual(navigation.filterOpenDocuments(documents, 'notes/计划'), [documents[0]]);
  assert.deepEqual(navigation.filterOpenDocuments(documents, '  '), documents);
  assert.deepEqual(navigation.filterOpenDocuments(documents, '不存在'), []);
});

test('标签方向键循环切换，Home 和 End 定位首尾', () => {
  const ids = ['first', 'middle', 'last'];
  assert.equal(navigation.getAdjacentTabId(ids, 'middle', 'ArrowRight'), 'last');
  assert.equal(navigation.getAdjacentTabId(ids, 'first', 'ArrowLeft'), 'last');
  assert.equal(navigation.getAdjacentTabId(ids, 'last', 'ArrowRight'), 'first');
  assert.equal(navigation.getAdjacentTabId(ids, 'middle', 'Home'), 'first');
  assert.equal(navigation.getAdjacentTabId(ids, 'first', 'End'), 'last');
  assert.equal(navigation.getAdjacentTabId([], 'first', 'ArrowRight'), null);
  assert.equal(navigation.getAdjacentTabId(ids, 'missing', 'ArrowRight'), null);
  assert.equal(navigation.getAdjacentTabId(ids, 'first', 'Enter'), null);
});

test('工具栏按实际宽度显示连续按钮，给更多命令预留空间', () => {
  assert.equal(navigation.fitToolbarButtons([45, 60, 80], 200, 36), 3);
  assert.equal(navigation.fitToolbarButtons([45, 60, 80], 180, 36), 2);
  assert.equal(navigation.fitToolbarButtons([45, 120, 25], 150, 36), 1);
  assert.equal(navigation.fitToolbarButtons([45, 60], 50, 36), 0);
  assert.equal(navigation.fitToolbarButtons([45, 60], 105, 36), 2);
  assert.equal(navigation.fitToolbarButtons([], 200, 36), 0);
});
