import assert from 'node:assert/strict';
import test from 'node:test';
import { reduceWebDavStatus } from '../src/utils/webdavState.ts';

test('maps queued syncing success and error events to status-bar state', () => {
  const queued = reduceWebDavStatus(undefined, {
    document_id: 'a',
    local_path: 'note.md',
    phase: 'queued',
    timestamp: '2026-08-19T14:00:00Z',
  });
  assert.equal(queued.phase, 'queued');

  const syncing = reduceWebDavStatus(queued, {
    document_id: 'a',
    local_path: 'note.md',
    phase: 'syncing',
    timestamp: '2026-08-19T14:00:01Z',
  });
  assert.equal(syncing.phase, 'syncing');

  const success = reduceWebDavStatus(syncing, {
    document_id: 'a',
    local_path: 'note.md',
    phase: 'success',
    timestamp: '2026-08-19T14:00:02Z',
  });
  assert.equal(success.phase, 'success');
  assert.equal(success.last_success_at, '2026-08-19T14:00:02Z');
});

test('ignores a stale event from a different document when selecting current status', () => {
  const current = { document_id: 'current', phase: 'idle', error: '', last_success_at: '' };
  const next = reduceWebDavStatus(current, {
    document_id: 'other',
    local_path: 'other.md',
    phase: 'error',
    timestamp: '2026-08-19T14:00:00Z',
    error: 'offline',
  });
  assert.equal(next.document_id, 'current');
});

test('error event caps sanitized message at 240 characters', () => {
  const current = { document_id: 'a', phase: 'idle', error: '', last_success_at: '' };
  const next = reduceWebDavStatus(current, {
    document_id: 'a',
    local_path: 'note.md',
    phase: 'error',
    timestamp: '2026-08-19T14:00:00Z',
    error: 'x'.repeat(400),
  });
  assert.ok(next.error.length <= 240);
});

test('webdav store contract exposes status labels and retry', () => {
  const store = readFileSync(new URL('../src/stores/webdavStore.ts', import.meta.url), 'utf8');
  assert.match(store, /webdav_retry_pending/);
  assert.match(store, /listen<WebDavSyncEvent>\('webdav-sync-status'/);
});

test('successful local save enqueues WebDAV without awaiting cloud completion', () => {
  const source = readFileSync(new URL('../src/stores/appStore.ts', import.meta.url), 'utf8');
  const saveTab = source.match(/saveTab:\s*async[\s\S]*?\r?\n\s*},\r?\n\r?\n\s*saveFile:/)?.[0] || '';
  assert.match(saveTab, /await invoke\('save_file_content'/);
  assert.match(saveTab, /void invoke\('webdav_enqueue_backup'/);
  assert.ok(saveTab.indexOf('save_file_content') < saveTab.indexOf('webdav_enqueue_backup'));
});

test('startup initializes WebDAV after settings load', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  // 设置载入后取一份快照，用它初始化云端同步并按持久化的编辑模式切换视图。
  assert.match(app, /const store = useAppStore\.getState\(\);/);
  assert.match(app, /useWebDavStore\.getState\(\)\.initialize\(store\.settings\.webdav\)/);
  assert.match(app, /useS3Store\.getState\(\)\.initialize\(store\.settings\.s3\)/);
});

test('s3 store contract uses s3 commands and filters provider events', () => {
  const store = readFileSync(new URL('../src/stores/s3Store.ts', import.meta.url), 'utf8');
  assert.match(store, /s3_retry_pending/);
  assert.match(store, /s3_list_documents/);
  assert.match(store, /s3_list_versions/);
  assert.match(store, /s3_download_version/);
  assert.match(store, /payload\.provider !== 's3'/);
  assert.match(store, /listen<WebDavSyncEvent>\('webdav-sync-status'/);
});

test('webdav store filters out s3 provider events', () => {
  const store = readFileSync(new URL('../src/stores/webdavStore.ts', import.meta.url), 'utf8');
  assert.match(store, /payload\.provider !== 'webdav'/);
});

test('status bar exposes all WebDAV phases and current history', () => {
  const status = readFileSync(new URL('../src/components/WebDav/WebDavStatusItem.tsx', import.meta.url), 'utf8');
  const labels = readFileSync(new URL('../src/utils/webdavState.ts', import.meta.url), 'utf8');
  const sources = status + labels;
  for (const label of ['未启用', '等待同步', '正在同步', '已同步', '同步失败']) {
    assert.match(sources, new RegExp(label));
  }
  // 面板通过 viewAllBackups 打开全局历史弹窗，不直接调用 loadVersions
  assert.match(status, /viewAllBackups/);
  assert.match(status, /WebDavHistoryDialog/);
  assert.match(status, /retry/);
  assert.match(status, /panelOpen/);
});

import { readFileSync } from 'node:fs';
