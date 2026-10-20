import assert from 'node:assert/strict';
import test from 'node:test';
import * as recoveryUtilities from '../src/utils/recovery.ts';
import { createRecoverySnapshot, restoreRecoverySnapshot } from '../src/utils/recovery.ts';

test('recovery snapshots include only non-empty unsaved documents', () => {
  assert.equal(createRecoverySnapshot({ id: 'saved', title: 'saved.md', path: 'saved.md', content: 'saved', modified: false }), null);
  assert.equal(createRecoverySnapshot({ id: 'empty', title: '未命名', path: null, content: '', modified: false }), null);
  assert.deepEqual(
    createRecoverySnapshot({ id: 'draft', title: '未命名', path: null, content: '草稿正文', modified: true }, 123),
    { id: 'draft', title: '未命名', path: null, content: '草稿正文', encoding: 'utf-8', updatedAt: 123 },
  );
});

test('a named document snapshot retains its disk path and encoding', () => {
  assert.deepEqual(
    createRecoverySnapshot({ id: 'tab-a', title: '笔记.md', path: 'C:\\notes\\笔记.md', content: '未保存内容', modified: true, encoding: 'gb18030' }, 456),
    { id: 'tab-a', title: '笔记.md', path: 'C:\\notes\\笔记.md', content: '未保存内容', encoding: 'gb18030', updatedAt: 456 },
  );
});

test('restoring a snapshot creates a new dirty tab while preserving its recovery identity', () => {
  const restored = restoreRecoverySnapshot({
    id: 'source-tab',
    title: '笔记.md',
    path: 'C:\\notes\\笔记.md',
    content: '恢复内容',
    encoding: 'utf-8',
    updatedAt: 789,
  }, 'restored-tab');

  assert.deepEqual(restored, {
    id: 'restored-tab',
    recoveryId: 'source-tab',
    title: '笔记.md',
    path: null,
    content: '恢复内容',
    encoding: 'utf-8',
    modified: true,
  });
});

test('recovery snapshots retain the file baseline while a merge is pending', () => {
  const fileVersion = { size: 14, sha256: 'baseline-hash' };
  const snapshot = createRecoverySnapshot({
    id: 'tab-b',
    title: 'draft.md',
    path: 'C:\\notes\\draft.md',
    content: 'manual merge in progress',
    modified: true,
    fileVersion,
    externalChangePending: true,
  }, 1000);

  assert.deepEqual(snapshot?.fileVersion, fileVersion);
  assert.equal(snapshot?.externalChangePending, true);
  const restored = restoreRecoverySnapshot(snapshot!, 'new-tab');
  assert.deepEqual(restored.fileVersion, fileVersion);
  assert.equal(restored.externalChangePending, true);
});

test('clearing a named document still preserves the unsaved empty buffer', () => {
  const snapshot = createRecoverySnapshot({ id: 'empty-edit', title: 'note.md', path: 'C:/note.md', content: '', modified: true }, 1234);
  assert.equal(snapshot?.content, '');
  assert.equal(snapshot?.path, 'C:/note.md');
});

test('a legacy named recovery without a disk fingerprint must require Save As before it can write', () => {
  const restored = restoreRecoverySnapshot({ id: 'legacy', title: 'note.md', path: 'C:/note.md', content: '旧草稿内容', encoding: 'utf-8', updatedAt: 123 }, 'new');
  assert.equal(restored.path, null);
  assert.equal(restored.modified, true);
  assert.equal(restored.content, '旧草稿内容');
  assert.equal(restored.recoveryId, 'legacy');
});

test('recovery scheduling selects only meaningful changed tabs across many open drafts', () => {
  const before = Array.from({ length: 6 }, (_, index) => ({ id: `draft-${index}`, title: '草稿', path: null, content: `内容${index}`, modified: true }));
  const select = (recoveryUtilities as typeof recoveryUtilities & { changedRecoveryTabs: (next: typeof before, previous: typeof before) => typeof before }).changedRecoveryTabs;
  assert.equal(typeof select, 'function');
  assert.deepEqual(select(before.map(tab => ({ ...tab })), before), []);
  const next = before.map((tab, index) => index === 4 ? { ...tab, content: '新修改' } : tab);
  assert.deepEqual(select(next, before).map(tab => tab.id), ['draft-4']);
  assert.deepEqual(select([{ ...before[0], content: '' }], before).map(tab => tab.id), ['draft-0']);
});
