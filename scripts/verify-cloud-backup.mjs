import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [];
page.on('pageerror', error => errors.push(error.stack));
try {
  await mkdir('test-output/cloud-backup', { recursive: true });
  // Runtime detection happens during module evaluation, as in the desktop app.
  await page.addInitScript(() => {
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => 1,
      invoke: async command => command === 'get_settings' ? {} : /list_|get_recent|font_families|pending_backup|startup_files/.test(command) ? [] : null,
    };
  });
  await page.goto(process.env.ZEDITOR_TEST_URL || 'http://127.0.0.1:1425');
  await page.locator('.menubar').waitFor();
  const modeChoice = page.getByRole('button', { name: /所见即所得.*像写文档/ });
  if (await modeChoice.count()) await modeChoice.click();
  await page.evaluate(async () => {
    const source = await (await fetch('/src/components/WebDav/WebDavHistoryDialog.tsx')).text();
    const storePath = source.match(/from ["']([^"']*appStore[.]ts[^"']*)["']/)[1];
    const webdavPath = source.match(/from ["']([^"']*webdavStore[.]ts[^"']*)["']/)[1];
    const s3Path = source.match(/from ["']([^"']*s3Store[.]ts[^"']*)["']/)[1];
    window.__appStore = (await import(storePath)).useAppStore;
    window.__cloudStores = { webdav: (await import(webdavPath)).useWebDavStore, s3: (await import(s3Path)).useS3Store };
    window.__appStore.getState().setMode('split');
    window.__cloudCalls = [];
    window.__folderChoice = 'C:/in-memory/restore-parent';
    window.__restoreFailure = null;
    window.__historyFailure = false;
    window.__legacyMode = false;
    window.__closed = 0;
    window.__fixtureVersion = { id: 'version', created_at: new Date().toISOString(), size: 32, sha256: 'a'.repeat(64), snapshot_path: '/snap.md', encoding: 'gbk', assets: [{ relative_path: '.assets/图.png', snapshot_path: '/snap/asset', size: 3, sha256: 'b'.repeat(64) }] };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => 1,
      convertFileSrc: () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yV2kAAAAASUVORK5CYII=',
      invoke: async (command, args) => {
        window.__cloudCalls.push({ command, args });
        if (command === 'plugin:dialog|open') return window.__folderChoice;
        if (command === 'plugin:dialog|save') return null;
        if (command.endsWith('_list_versions')) {
          if (window.__historyFailure) throw '云端连接失败';
          const version = { ...window.__fixtureVersion };
          if (window.__legacyMode) delete version.assets;
          return [version];
        }
        if (command.endsWith('_restore_version')) {
          if (window.__restoreFailure) throw window.__restoreFailure;
          return { path: `C:/in-memory/restored-${command.startsWith('s3') ? 's3' : 'webdav'}/原文.md`, encoding: 'gbk', asset_count: 1, legacy_document_only: false };
        }
        if (command === 'read_text_document') return { content: '# 恢复文稿\n\n![图](.assets/图.png)', encoding: 'gbk', fileVersion: { size: 32, sha256: 'restored' } };
        if (command === 'resolve_media_sources') return args.sources.map(source => `C:/in-memory/restored/.assets/${source.split('/').pop()}`);
        if (command.endsWith('_download_version')) return { filename: '旧版本.md', content: '旧版本', data_base64: btoa('legacy'), sha256: 'legacy', size: 6 };
        if (command === 'decode_text_document') return { content: '旧版本内容', encoding: 'utf-8' };
        if (command === 'get_recent_folders' || command === 'list_recovery_snapshots' || command === 'find_wiki_backlinks') return [];
        if (command.startsWith('plugin:event|')) return 1;
        return null;
      },
    };
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const reactDom = await import('/node_modules/.vite/deps/react-dom_client.js');
    const createRoot = reactDom.createRoot || reactDom.default.createRoot;
    const { WebDavHistoryDialog } = await import('/src/components/WebDav/WebDavHistoryDialog.tsx');
    const host = document.createElement('div');
    host.id = 'cloud-fixture';
    host.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:999999;padding:20px';
    document.body.append(host);
    window.__fixtureRoot = createRoot(host);
    window.__renderHistory = provider => {
      window.__fixtureRoot.render(React.createElement(WebDavHistoryDialog, {
        key: provider + window.__legacyMode + window.__historyFailure,
        open: true, mode: 'current', provider, settings: { enabled: true }, currentDocumentId: 'doc', onClose: () => window.__closed++,
      }));
    };
    window.__renderHistory('webdav');
  });
  const fixture = page.locator('#cloud-fixture');
  await fixture.getByText('完整备份 · 1 个附件').waitFor();
  // Cancellation must never invoke the restore command or write files.
  await page.evaluate(() => { window.__folderChoice = null; window.__cloudCalls = []; });
  await fixture.getByRole('button', { name: '恢复到新文件夹' }).click();
  await page.waitForFunction(() => window.__cloudCalls.some(c => c.command === 'plugin:dialog|open'));
  assert.equal(await page.evaluate(() => window.__cloudCalls.some(c => c.command.endsWith('_restore_version'))), false);
  // Verified restore opens exact resulting path using persisted encoding.
  await page.evaluate(() => { window.__folderChoice = 'C:/in-memory/parent'; window.__cloudCalls = []; });
  await fixture.getByRole('button', { name: '打开', exact: true }).click();
  await page.waitForFunction(() => window.__closed === 1);
  const webdav = await page.evaluate(() => ({ calls: window.__cloudCalls, currentFile: window.__appStore.getState().currentFile, tab: window.__appStore.getState().tabs.find(t => t.path === window.__appStore.getState().currentFile) }));
  assert.equal(webdav.currentFile, 'C:/in-memory/restored-webdav/原文.md');
  assert.equal(webdav.tab.encoding, 'gbk');
  assert.deepEqual(webdav.calls.find(c => c.command === 'read_text_document').args, { path: webdav.currentFile, encoding: 'gbk' });
  assert.ok(webdav.calls.find(c => c.command === 'webdav_restore_version'));
  await page.waitForFunction(() => [...document.querySelectorAll('.preview-document img')].some(img => img.complete && img.naturalWidth > 0)).catch(async failure => {
    console.log(JSON.stringify(await page.evaluate(() => ({ errors: [], mode: window.__appStore.getState().mode, content: window.__appStore.getState().content, previews: [...document.querySelectorAll('.preview-document')].map(node => node.outerHTML), calls: window.__cloudCalls })), null, 2));
    throw failure;
  });
  assert.ok(await page.evaluate(() => window.__cloudCalls.some(c => c.command === 'resolve_media_sources' && c.args.documentPath === 'C:/in-memory/restored-webdav/原文.md' && c.args.sources.some(source => decodeURI(source) === '.assets/图.png'))));
  // S3 must use its own command; restore-only keeps document unopened.
  await page.evaluate(() => { window.__cloudCalls = []; window.__renderHistory('s3'); });
  await fixture.getByText('完整备份 · 1 个附件').waitFor();
  await fixture.getByRole('button', { name: '恢复到新文件夹' }).click();
  await fixture.getByText('已恢复：C:/in-memory/restored-s3/原文.md').waitFor();
  assert.ok(await page.evaluate(() => window.__cloudCalls.some(c => c.command === 's3_restore_version')));
  assert.equal(await page.evaluate(() => window.__cloudCalls.some(c => c.command === 'read_text_document')), false);
  // Incomplete resource manifest must surface error, stay open, and never open a file.
  await page.evaluate(() => { window.__restoreFailure = '附件清单与文档引用不一致，恢复已停止'; window.__cloudCalls = []; });
  await fixture.getByRole('button', { name: '打开', exact: true }).click();
  await fixture.getByText('附件清单与文档引用不一致，恢复已停止').waitFor();
  assert.equal(await page.evaluate(() => window.__closed), 1);
  assert.equal(await page.evaluate(() => window.__cloudCalls.some(c => c.command === 'read_text_document')), false);
  // Legacy versions remain document-only, use byte decoder and no restore command.
  await page.evaluate(() => { window.__restoreFailure = null; window.__legacyMode = true; window.__cloudCalls = []; window.__renderHistory('webdav'); });
  await fixture.getByText('旧版：仅文档', { exact: true }).waitFor();
  await fixture.getByRole('button', { name: '打开', exact: true }).click();
  await page.waitForFunction(() => window.__closed === 2);
  assert.equal(await page.evaluate(() => window.__cloudCalls.some(c => c.command.endsWith('_restore_version'))), false);
  assert.ok(await page.evaluate(() => window.__appStore.getState().tabs.some(t => t.title === '旧版本.md' && t.content === '旧版本内容' && t.modified)));
  // Server errors are visible and stale versions cannot be used after failed loads.
  await page.evaluate(() => { window.__historyFailure = true; window.__legacyMode = false; window.__renderHistory('s3'); });
  await fixture.getByText('云端连接失败').waitFor();
  assert.equal(await fixture.locator('.webdav-version-row').count(), 0);
  await page.screenshot({ path: 'test-output/cloud-backup/browser-history-error.png' });
  if (errors.length) console.log(JSON.stringify({ errors, calls: await page.evaluate(() => window.__cloudCalls) }));
  assert.deepEqual(errors, []);
  const result = { directoryCancellation: 'passed', webdavRestoreOpenPathAndEncoding: 'passed', restoredRelativeImageDisplay: 'passed', s3RestoreOnly: 'passed', incompleteManifestError: 'passed', legacyByteOpen: 'passed', failedHistoryClearsStaleVersions: 'passed', pageErrors: errors };
  await writeFile('test-output/cloud-backup/browser-results.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
