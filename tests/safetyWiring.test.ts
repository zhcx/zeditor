import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

test('desktop startup loads recovery snapshots before presenting the recovery UI', async () => {
  const app = await read('../src/App.tsx');
  const store = await read('../src/stores/appStore.ts');
  const native = await read('../src-tauri/src/main.rs');
  assert.match(app, /await loadRecoverySnapshots\(\)/);
  assert.match(app, /const showRecoveryDialog = settingsLoaded && recoveryLoaded && recoverySnapshots\.length > 0/);
  assert.match(app, /createRecoverySnapshot\(tab\)/);
  assert.match(app, /window\.setTimeout\(\(\) => \{[\s\S]*?persistRecoverySnapshot\(snapshot\)/);
  assert.match(store, /invoke<RecoverySnapshot\[]>\('list_recovery_snapshots'\)/);
  assert.match(native, /recovery::list_recovery_snapshots/);
  assert.match(native, /recovery::save_recovery_snapshot/);
  assert.match(native, /recovery::delete_recovery_snapshot/);
});

test('discarding or saving a tab removes its recovery snapshot', async () => {
  const guard = await read('../src/utils/windowCloseGuard.ts');
  const store = await read('../src/stores/appStore.ts');
  const app = await read('../src/App.tsx');
  assert.match(guard, /await dependencies\.discardTabs\?\.\(modifiedTabs\.map\(tab => tab\.id\)\)/);
  assert.match(app, /discardTabs: async tabIds =>/);
  assert.match(store, /await get\(\)\.deleteRecoverySnapshot\(latest\.recoveryId \|\| latest\.id\)/);
  assert.match(store, /closingTab\.recoveryId \|\| closingTab\.id/);
});

test('checked saves compare the disk version before replacing file bytes', async () => {
  const commands = await read('../src-tauri/src/commands.rs');
  const versions = await read('../src-tauri/src/file_version.rs');
  const store = await read('../src/stores/appStore.ts');
  const app = await read('../src/App.tsx');
  assert.match(commands, /pub async fn save_file_content_checked/);
  assert.match(commands, /write_file_bytes_atomic_if_unchanged/);
  assert.match(commands, /if !expected\.matches_bytes\(&current\)/);
  assert.match(commands, /let _save_guard = save_lock\.lock\(\)\.await/);
  assert.match(versions, /write_file_bytes_atomic_if_unchanged\(path, bytes, expected\)/);
  assert.match(store, /invoke<CheckedSaveResult>\('save_file_content_checked'/);
  assert.match(store, /if \(outcome\.status === 'conflict'\)/);
  assert.match(app, /if \(tab\.modified && tab\.path && !tab\.externalChangePending\)/);
  assert.match(app, /document\.addEventListener\('visibilitychange', checkActiveVersion\)/);
});
