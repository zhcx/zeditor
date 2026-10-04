import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('desktop close requests inspect all tabs and only destroy after the close guard allows it', async () => {
  const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const titleBarSource = await readFile(new URL('../src/components/TitleBar/TitleBar.tsx', import.meta.url), 'utf8');
  const capabilities = JSON.parse(await readFile(new URL('../src-tauri/capabilities/default.json', import.meta.url), 'utf8'));

  assert.match(source, /onCloseRequested/);
  assert.match(source, /event\.preventDefault\(\)/);
  assert.match(source, /guardWindowClose\(useAppStore\.getState\(\)\.tabs/);
  assert.match(source, /<UnsavedChangesDialog/);
  assert.match(source, /<TitleBar\s+onRequestClose=\{requestAppClose\}/);
  assert.doesNotMatch(source, /askToSave:[\s\S]*?return ask\(/);
  assert.match(titleBarSource, /onRequestClose/);
  assert.doesNotMatch(titleBarSource, /getCurrentWindow\(\)\.close\(\)/);
  assert.match(source, /result === 'close'[\s\S]*?\.destroy\(\)/);
  assert.match(source, /catch \(error\)[\s\S]*?invoke\('exit_application'\)/);
  assert.ok(capabilities.permissions.includes('core:window:allow-destroy'));
});

test('closing a dirty tab uses the themed dialog instead of a native ask dialog', async () => {
  const source = await readFile(new URL('../src/components/TabsBar/TabsBar.tsx', import.meta.url), 'utf8');
  const hook = await readFile(new URL('../src/hooks/useTabClose.ts', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /import \{ ask,/);
  assert.doesNotMatch(source, /await ask\(/);
  assert.match(source, /<UnsavedChangesDialog/);
  assert.match(source, /useTabClose\(\)/);
  assert.match(hook, /saveTab\(tab\.id,/);
});

test('tab-specific save persists the selected tab content', async () => {
  const source = await readFile(new URL('../src/stores/appStore.ts', import.meta.url), 'utf8');

  assert.match(source, /saveTab:\s*async\s*\(tabId, path\)/);
  assert.match(source, /save_file_content[\s\S]*?content:\s*tab\.content/);
});
