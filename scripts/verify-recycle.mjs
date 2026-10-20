// Actual sidebar entry + dialog in an isolated browser. All filesystem IPC is mocked.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
const results = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(process.env.ZEDITOR_TEST_URL || 'http://127.0.0.1:1425');
  await page.locator('.menubar').waitFor();
  await page.evaluate(async () => {
    const appSource = await (await fetch('/src/App.tsx')).text();
    const { useAppStore } = await import(appSource.match(/from ["']([^"']*appStore[.]ts[^"']*)["']/)[1]);
    window.__recycleStore = useAppStore;
    window.__recycleCalls = [];
    window.__recycleEntries = [
      { id: 'conflict', name: '重名文稿.md', originalPath: 'C:/notes/重名文稿.md', deletedAt: Date.now(), isDirectory: false, location: 'app', canRestore: true, available: true, note: '' },
      { id: 'success', name: '可恢复文稿.md', originalPath: 'C:/notes/可恢复文稿.md', deletedAt: Date.now(), isDirectory: false, location: 'system', canRestore: true, available: true, note: '' },
      { id: 'cleared', name: '已清理.md', originalPath: 'C:/notes/已清理.md', deletedAt: Date.now(), isDirectory: false, location: 'system', canRestore: false, available: false, note: '回收站已清理' },
    ];
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => 1,
      invoke: async (command, args) => {
        window.__recycleCalls.push({ command, args });
        if (command === 'list_recycled_items') return structuredClone(window.__recycleEntries);
        if (command === 'restore_recycled_item') {
          if (args.id === 'conflict') throw '目标已存在，已取消恢复，不会覆盖已有内容';
          window.__recycleEntries = window.__recycleEntries.filter(value => value.id !== args.id);
          return 'C:/notes/可恢复文稿.md';
        }
        if (command === 'read_folder' || command === 'get_recent_folders' || command === 'list_recovery_snapshots') return [];
        if (command === 'get_file_version') return { sha256: 'mock', len: 0 };
        return null;
      },
    };
    useAppStore.getState().setMode('split');
    useAppStore.getState().setSidebarVisible(true);
    useAppStore.getState().addTab({ title: '回收站走查.md', content: '# 回收站走查', modified: false });
  });
  const entry = page.getByRole('button', { name: '回收站与恢复', exact: true });
  await entry.click();
  const dialog = page.getByRole('dialog', { name: '回收站与文件恢复' });
  await dialog.waitFor();
  await dialog.locator('.recycle-item').first().waitFor();
  assert.equal(await dialog.locator('.recycle-item').count(), 3);
  assert.equal(await dialog.getByRole('button', { name: '已不可恢复' }).isDisabled(), true);
  results.push({ name: 'actual sidebar entry loads app/system/cleared records', pass: true });
  const close = dialog.getByRole('button', { name: '关闭回收站' });
  assert.equal(await close.evaluate(node => document.activeElement === node), true);
  await page.keyboard.press('Shift+Tab');
  assert.equal(await dialog.getByRole('button', { name: '刷新记录' }).evaluate(node => document.activeElement === node), true);
  await page.keyboard.press('Tab');
  assert.equal(await close.evaluate(node => document.activeElement === node), true);
  results.push({ name: 'initial focus and forward/backward focus wrap stay in modal', pass: true });

  await dialog.locator('.recycle-item').filter({ hasText: '重名文稿.md' }).getByRole('button', { name: '恢复到原位置' }).click();
  await dialog.getByRole('alert').filter({ hasText: '目标已存在' }).waitFor();
  assert.equal(await dialog.locator('.recycle-item').count(), 3);
  let calls = await page.evaluate(() => window.__recycleCalls);
  assert.equal(calls.filter(value => value.command === 'restore_recycled_item').length, 1);
  assert.deepEqual(calls.find(value => value.command === 'restore_recycled_item').args, { id: 'conflict' });
  assert.equal(calls.some(value => /save_file|write_file|delete_fs/.test(value.command)), false);
  results.push({ name: 'conflict message leaves all records and sends no overwrite request', pass: true });

  const listsBefore = calls.filter(value => value.command === 'list_recycled_items').length;
  await dialog.locator('.recycle-item').filter({ hasText: '可恢复文稿.md' }).getByRole('button', { name: '恢复到原位置' }).click();
  await dialog.locator('.recycle-success').filter({ hasText: '已恢复' }).waitFor();
  await page.waitForFunction(() => window.__recycleCalls.filter(value => value.command === 'list_recycled_items').length >= 2);
  assert.equal(await dialog.locator('.recycle-item').count(), 2);
  calls = await page.evaluate(() => window.__recycleCalls);
  assert.ok(calls.filter(value => value.command === 'list_recycled_items').length > listsBefore);
  assert.ok(calls.some(value => value.command === 'read_folder' && value.args.path === 'C:/notes'));
  results.push({ name: 'successful restore refreshes parent workspace and recycle records', pass: true });

  await page.keyboard.press('Tab');
  const postRestoreFocus = await page.evaluate(() => ({
    insideModal: !!document.activeElement?.closest('.recycle-dialog'),
    text: document.activeElement?.textContent?.slice(0, 100),
    tag: document.activeElement?.tagName,
  }));
  results.push({ name: 'focus stays in modal after restored row disappears', pass: postRestoreFocus.insideModal, observed: postRestoreFocus });

  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await entry.evaluate(node => document.activeElement === node), true);
  results.push({ name: 'Escape closes modal and returns focus to sidebar entry', pass: true });
  await entry.click();
  await page.getByRole('dialog', { name: '回收站与文件恢复' }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: '回收站与文件恢复' }).waitFor({ state: 'detached' });
  results.push({ name: 'dialog reopens and closes cleanly', pass: true });
  assert.deepEqual(errors, []);
  await mkdir('test-output/recycle', { recursive: true });
  await writeFile('test-output/recycle/browser-results.json', JSON.stringify({ results, errors, calls: calls.filter(value => /recycl|read_folder/.test(value.command)) }, null, 2));
  console.log(JSON.stringify({ results, errors }, null, 2));
  if (results.some(value => !value.pass)) process.exitCode = 1;
} finally { await browser.close(); }
