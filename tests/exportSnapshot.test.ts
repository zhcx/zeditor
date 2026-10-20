import assert from 'node:assert/strict';
import test from 'node:test';
import { captureExportSnapshot } from '../src/utils/exportSnapshot.ts';

test('export flushes pending edits before capturing content and document identity', () => {
  const tab = { id: 'a', title: '中文.md', path: 'C:/中文.md', content: '旧内容' };
  const state = { activeTabId: 'a', tabs: [tab], content: tab.content, editorView: {
    flushPendingEdits: () => { tab.content = '最后输入的内容'; state.content = tab.content; },
  } };
  const snapshot = captureExportSnapshot(() => state);
  assert.deepEqual(snapshot, { tabId: 'a', title: '中文', path: 'C:/中文.md', content: '最后输入的内容' });
  tab.content = '导出对话框打开后又修改';
  state.activeTabId = 'b';
  assert.equal(snapshot.content, '最后输入的内容');
  assert.equal(snapshot.path, 'C:/中文.md');
});

test('unsaved text can be exported without borrowing another tab path', () => {
  const snapshot = captureExportSnapshot(() => ({ activeTabId: 'draft', tabs: [{ id: 'draft', title: '草稿', path: null, content: '草稿内容' }], content: '草稿内容', editorView: null }));
  assert.equal(snapshot.path, null);
  assert.equal(snapshot.content, '草稿内容');
});
