// Real Windows Tauri/WebView2 + filesystem verification. Requires the isolated
// validation identifier from scripts/fixtures/tauri-validation.conf.json.
// Only file chooser/message UI is intercepted; all document commands stay native.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import sharp from 'sharp';

assert.equal(process.platform, 'win32', 'This fixture verifies Windows WebView2');
const identifier = 'com.zeditor.validation20261020';
const executable = resolve(process.env.ZEDITOR_VALIDATION_EXE || 'src-tauri/target/debug/zeditor.exe');
assert.ok((await readFile(executable)).includes(Buffer.from(identifier)), 'Refusing to launch a production-profile binary');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const output = resolve('test-output/reliability/desktop');
const fixtures = join(output, `fixtures-${randomUUID()}`);
await mkdir(join(fixtures, '.assets'), { recursive: true });
const files = await readdir('dist/assets');
const storeURL = `/assets/${files.find(name => /^appStore-.*\.js$/.test(name))}`;
const report = { scope: 'actual isolated Windows Tauri process and native IPC; local HTTP fixture for cloud; chooser UI intercepted', identifier, fixtures, cases: [], pageErrors: [] };
let application, browser, page, configurationDirectory;
let slowExportServer;
let activeExportBrowserPids = [];
const wait = ms => new Promise(done => setTimeout(done, ms));
async function until(condition, message, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await condition()) return; await wait(100); }
  throw Error(message);
}
const native = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const inStore = (fn, arg) => page.evaluate(`(${fn.toString()})(window.__validationStore, ${JSON.stringify(arg ?? null)})`);
async function snapshots() {
  try { return JSON.parse(await readFile(join(configurationDirectory, 'recovery-snapshots.json'), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function launch() {
  const port = 19229;
  application = spawn(executable, [], { windowsHide: true, env: { ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
  } });
  application.on('error', error => { report.launchError = error.message; });
  application.stderr.on('data', data => { report.nativeStderr = `${report.nativeStderr || ''}${data}`.slice(-4000); });
  await until(async () => { try { const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) }); return response.ok; } catch { return false; } }, 'WebView2 debugging endpoint did not start', 60000);
  assert.equal(application.exitCode, null, 'Validation instance exited before attaching');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  await until(() => browser.contexts()[0]?.pages().some(candidate => candidate.url().includes('tauri.localhost')), 'Native app page not found');
  page = browser.contexts()[0].pages().find(candidate => candidate.url().includes('tauri.localhost'));
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.lastConsoleError = message.text(); });
  page.setDefaultTimeout(15000);
  await page.locator('.menubar').waitFor({ timeout: 45000 });
  configurationDirectory = await native('plugin:path|resolve_directory', { directory: 13 });
  assert.equal(configurationDirectory.replaceAll('\\', '/').split('/').filter(Boolean).at(-1), identifier, 'Native configuration must be isolated');
  await page.evaluate(async storeURL => {
    const module = await import(storeURL);
    window.__validationStore = Object.values(module).find(value => typeof value === 'function' && typeof value.getState === 'function' && 'activeTabId' in value.getState());
    const store = window.__validationStore;
    const settings = { ...store.getState().settings, editor: { ...store.getState().settings.editor, mode: 'split', auto_save_interval: 0 }, ai: { ...store.getState().settings.ai, enabled: false }, agent: { ...store.getState().settings.agent, enabled: false }, webdav: { ...store.getState().settings.webdav, enabled: false }, s3: { ...store.getState().settings.s3, enabled: false } };
    await store.getState().saveSettings(settings);
    store.getState().setMode('split');
  }, storeURL);
  await page.waitForFunction(() => Boolean(window.__validationStore.getState().editorView) && window.__validationStore.getState().recoveryLoaded);
}
async function terminate(force = false) {
  const child = application;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (force) child.kill('SIGKILL');
  else void native('plugin:window|close', { label: null }).catch(() => {});
  await until(() => child.exitCode !== null || child.signalCode !== null, 'Owned validation process did not exit', 15000);
  if (!force) assert.equal(child.exitCode, 0);
  await browser?.close().catch(() => {});
  browser = null;
  await wait(600);
}

// Disposable WebDAV over loopback: native backend performs real HTTP requests.
const remote = new Map();
const server = createServer(async (request, response) => {
  const key = request.url;
  if (request.method === 'MKCOL') { response.writeHead(201).end(); return; }
  if (request.method === 'PROPFIND') { response.writeHead(207).end(); return; }
  if (request.method === 'PUT') { const parts = []; for await (const part of request) parts.push(part); remote.set(key, Buffer.concat(parts)); response.writeHead(201).end(); return; }
  if (request.method === 'DELETE') { remote.delete(key); response.writeHead(204).end(); return; }
  if (remote.has(key)) { response.writeHead(200).end(remote.get(key)); return; }
  response.writeHead(404).end();
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
try {
  await launch();
  if (!process.env.ZEDITOR_DESKTOP_PDF_EXIT_ONLY) {
  for (const snapshot of await native('list_recovery_snapshots')) await native('delete_recovery_snapshot', { id: snapshot.id });
  await inStore(store => { store.setState({ recoverySnapshots: [], fileConflict: null }); });
  const namedPath = join(fixtures, '中文 原稿.md');
  const original = '# 磁盘原文\n\n中文 English 😀';
  const pendingNamed = '# 未保存的已有文稿\n\n保留标点与最后输入。';
  const pendingDraft = '# 未命名草稿\n\n恢复后应逐字一致。';
  const legacyPath = join(fixtures, '旧版本原稿.md');
  const legacyText = '缺少文件指纹的历史草稿';
  await writeFile(legacyPath, '此文件已有其他人的修改');
  await writeFile(namedPath, original);
  await inStore(async (store, arg) => { await store.getState().openFile(arg.path); store.getState().setContent(arg.content); store.getState().addTab({ title: '异常退出草稿', content: arg.draft, modified: true }); }, { path: namedPath, content: pendingNamed, draft: pendingDraft });
  await until(async () => { const all = await snapshots(); return all.some(item => item.content === pendingNamed) && all.some(item => item.content === pendingDraft); }, 'Durable recovery snapshots were not written');
  await native('save_recovery_snapshot', { snapshot: { id: `legacy-${randomUUID()}`, title: '旧版本原稿.md', path: legacyPath, content: legacyText, encoding: 'utf-8', updatedAt: Date.now() } });
  await terminate(true);
  await launch();
  await page.getByRole('dialog', { name: '恢复未保存内容' }).waitFor();
  for (const content of [pendingNamed, pendingDraft, legacyText]) {
    const id = await inStore((store, content) => store.getState().recoverySnapshots.find(item => item.content === content)?.id, content);
    assert.ok(id, 'Missing exact recovery content after forced process termination');
    const tabId = await inStore((store, id) => store.getState().restoreSavedRecoverySnapshot(id), id);
    if (content === legacyText) assert.equal(await inStore((store, tabId) => store.getState().tabs.find(tab => tab.id === tabId).path, tabId), null);
  }
  assert.equal(await readFile(namedPath, 'utf8'), original, 'Recovery must not overwrite disk');
  const draftPath = join(fixtures, '草稿恢复后保存.md');
  const legacyCopy = join(fixtures, '历史草稿另存副本.md');
  await inStore(async (store, arg) => {
    for (const tab of [...store.getState().tabs]) {
      if (tab.content === arg.named) await store.getState().saveTab(tab.id, arg.path);
      if (tab.content === arg.draft) await store.getState().saveTab(tab.id, arg.draftPath);
      if (tab.content === arg.legacyText) await store.getState().saveTab(tab.id, arg.legacyCopy);
    }
  }, { named: pendingNamed, draft: pendingDraft, path: namedPath, draftPath, legacyText, legacyCopy });
  assert.equal(await readFile(namedPath, 'utf8'), pendingNamed);
  assert.equal(await readFile(draftPath, 'utf8'), pendingDraft);
  assert.equal(await readFile(legacyPath, 'utf8'), '此文件已有其他人的修改');
  assert.equal(await readFile(legacyCopy, 'utf8'), legacyText);
  await until(async () => (await snapshots()).length === 0, 'Saved recovery snapshots were not cleared');
  await terminate();
  await launch();
  assert.equal(await page.getByRole('dialog', { name: '恢复未保存内容' }).count(), 0);
  report.cases.push({ name: 'forced exit restores unnamed and named edits exactly; recovery never overwrites disk; saved normal exit stays clean', pass: true });

  await inStore(async (store, path) => { await store.getState().openFile(path); store.getState().setContent('手动保存本地版本'); }, namedPath);
  await writeFile(namedPath, '第二进程修改的磁盘版本');
  await inStore(async (store, path) => { const tab = store.getState().getActiveTab(); await store.getState().saveTab(tab.id, path); }, namedPath);
  assert.equal(await readFile(namedPath, 'utf8'), '第二进程修改的磁盘版本');
  assert.equal(await inStore(store => store.getState().content), '手动保存本地版本');
  await writeFile(namedPath, '冲突窗口打开后再次修改');
  await page.getByRole('button', { name: '重新载入磁盘版本', exact: true }).click();
  await page.waitForFunction(() => window.__validationStore.getState().content === '冲突窗口打开后再次修改');
  await inStore(async store => { const settings = store.getState().settings; await store.getState().saveSettings({ ...settings, editor: { ...settings.editor, auto_save_interval: 1000 } }); store.getState().setContent('自动保存本地版本'); });
  await writeFile(namedPath, '自动保存前外部改稿');
  await page.getByRole('alertdialog', { name: '文件在其他位置已更改' }).waitFor({ timeout: 8000 });
  assert.equal(await readFile(namedPath, 'utf8'), '自动保存前外部改稿');
  assert.equal(await inStore(store => store.getState().content), '自动保存本地版本');
  await inStore(async store => { await store.getState().reloadExternalFile(); const settings = store.getState().settings; await store.getState().saveSettings({ ...settings, editor: { ...settings.editor, auto_save_interval: 0 } }); });
  report.cases.push({ name: 'real second-process writes survive manual and automatic saves; reload reads latest bytes', pass: true });

  if (!process.env.ZEDITOR_DESKTOP_SKIP_RECYCLE) {
  await native('read_folder', { path: fixtures });
  const deletedPath = join(fixtures, '回收恢复验证.md');
  await writeFile(deletedPath, '回收站还原内容 😀');
  const entry = await native('delete_fs_item', { path: deletedPath });
  assert.equal(entry.location, 'system');
  assert.equal(entry.canRestore, true);
  await writeFile(deletedPath, '已有同名内容');
  await assert.rejects(native('restore_recycled_item', { id: entry.id }), /同名|覆盖/);
  assert.equal(await readFile(deletedPath, 'utf8'), '已有同名内容');
  // Move only this freshly created disposable collision fixture.
  const { rename } = await import('node:fs/promises');
  await rename(deletedPath, join(fixtures, '同名内容保留.md'));
  await native('restore_recycled_item', { id: entry.id });
  assert.equal(await readFile(deletedPath, 'utf8'), '回收站还原内容 😀');
  report.cases.push({ name: 'actual Windows recycle/restore preserves a conflicting same-name file and supports retry', pass: true });
  } else {
    report.skipped = ['system recycle/restore: system confirmation UI; previous complete native run retained in desktop-run.log'];
  }

  const image = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#247a64' } }).png().toBuffer();
  const imagePath = join(fixtures, '.assets', '中文 图.png');
  await writeFile(imagePath, image);
  const cloudPath = join(fixtures, '图文备份.md');
  for (const name of ['clip#1.mp4', 'clip%20v1.mp4', 'clip v1.mp4']) {
    const path = join(fixtures, '.assets', name);
    await writeFile(path, `exact ${name}`);
    const imported = await native('import_media_asset', { documentPath: namedPath, sourcePath: path });
    const resolved = await native('resolve_media_sources', { documentPath: namedPath, sources: [imported.relativePath] });
    assert.equal(await readFile(resolved[0], 'utf8'), `exact ${name}`);
  }
  const uriResolved = await native('resolve_media_sources', { documentPath: namedPath, sources: ['.assets/clip%20v1.mp4', '.assets/clip%2520v1.mp4'], urlEncoded: true });
  assert.equal(await readFile(uriResolved[0], 'utf8'), 'exact clip v1.mp4');
  assert.equal(await readFile(uriResolved[1], 'utf8'), 'exact clip%20v1.mp4');
  const absoluteUri = imagePath.replaceAll('\\', '/').replace('中文 图.png', '%E4%B8%AD%E6%96%87%20%E5%9B%BE.png');
  const absoluteResolved = await native('resolve_media_sources', { documentPath: namedPath, sources: [absoluteUri], urlEncoded: true });
  assert.deepEqual(await readFile(absoluteResolved[0]), image);
  report.cases.push({ name: 'native import/resolve preserves literal hash and percent names; renderer URLs resolve exact distinct files', pass: true });
  const cloudText = '# 图文完整恢复\n\n中文图文 😀\n\n![图](<.assets/中文 图.png>)';
  await writeFile(cloudPath, cloudText);
  const cloudSettings = { enabled: true, server_url: `http://127.0.0.1:${server.address().port}`, username: 'fixture', password: 'fixture', remote_root: '/Zeditor' };
  const queued = await native('webdav_enqueue_backup', { request: { local_path: cloudPath, workspace_roots: [fixtures], encoding: 'utf-8' }, settings: cloudSettings });
  const documentId = queued.document.document_id;
  assert.ok(documentId, 'Native backup result must contain its document identity');
  let versions;
  await until(async () => { versions = await native('webdav_list_versions', { documentId, settings: cloudSettings }); return versions.length > 0; }, 'Native WebDAV upload did not publish a version');
  const restored = await native('webdav_restore_version', { documentId, versionId: versions[0].id, destinationDir: fixtures, settings: cloudSettings });
  assert.equal(await readFile(restored.path, 'utf8'), cloudText);
  assert.deepEqual(await readFile(join(resolve(restored.path, '..'), '.assets', '中文 图.png')), image);
  await new Promise(done => server.close(done));
  await inStore(async (store, path) => { await store.getState().openFile(path); }, restored.path);
  await page.waitForFunction(() => [...document.querySelectorAll('.preview-document img')].some(img => img.complete && img.naturalWidth === 32), null, { timeout: 15000 }).catch(async error => {
    report.restoredImageDiagnostic = await page.evaluate(() => [...document.querySelectorAll('.preview-document img')].map(image => ({ src: image.src, complete: image.complete, width: image.naturalWidth })));
    report.restoredPath = restored.path;
    report.nativeResolvedImages = await native('resolve_media_sources', { documentPath: restored.path, sources: ['.assets/中文 图.png'] });
    throw error;
  });
  report.cases.push({ name: 'native WebDAV HTTP upload/restore preserves text and image hashes; restored image renders after server stops', pass: true });

  const exportPaths = { html: join(fixtures, '准确导出.html'), pdf: join(fixtures, '准确导出.pdf'), word: join(fixtures, '准确导出.docx') };
  await page.evaluate(paths => {
    window.__validationExportPaths = paths;
    // Native Tauri internals are read-only. Intercept only chooser/message
    // transport responses, preserving the real native backend for every file operation.
    const nativeFetch = window.fetch.bind(window);
    window.__validationExportMessages = [];
    window.__validationChooserCalls = 0;
    window.fetch = async (input, options) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      const command = decodeURIComponent(url.pathname.slice(1));
      if (url.hostname === 'ipc.localhost' && command === 'plugin:dialog|save') {
        window.__validationChooserCalls++;
        return new Response(JSON.stringify(paths[window.__validationExportFormat]), { status: 200, headers: { 'Tauri-Response': 'ok', 'Content-Type': 'application/json' } });
      }
      if (url.hostname === 'ipc.localhost' && command === 'plugin:dialog|message') {
        window.__validationExportMessages.push(JSON.parse(options.body));
        return new Response('null', { status: 200, headers: { 'Tauri-Response': 'ok', 'Content-Type': 'application/json' } });
      }
      return nativeFetch(input, options);
    };
  }, exportPaths);
  await inStore(store => store.getState().setMode('wysiwyg'));
  await page.locator('.wysiwyg-block[data-block-kind="paragraph"][contenteditable="true"]').first().waitFor();
  for (const format of ['word', 'html', 'pdf']) {
    const start = performance.now();
    await page.evaluate(format => {
      window.__validationExportFormat = format;
      if (format === 'word') {
        const host = document.querySelector('.wysiwyg-block[data-block-kind="paragraph"][contenteditable="true"]');
        host.textContent = '导出前最后输入的中文内容';
        host.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '导出前最后输入的中文内容' }));
      }
      window.dispatchEvent(new CustomEvent('zeditor-export-request', { detail: { format } }));
    }, format);
    await until(async () => { try { return (await readFile(exportPaths[format])).length > 10; } catch { return false; } }, `Native ${format} export did not write its output`, format === 'pdf' ? 60000 : 15000).catch(async error => {
      report.exportDiagnostic = await page.evaluate(() => ({ chooserCalls: window.__validationChooserCalls, messages: window.__validationExportMessages }));
      throw error;
    });
    (report.exportElapsedMs ||= {})[format] = Math.round(performance.now() - start);
  }
  const word = await JSZip.loadAsync(await readFile(exportPaths.word), { checkCRC32: true });
  assert.ok((await word.file('word/document.xml').async('string')).includes('图文完整恢复'));
  assert.ok((await word.file('word/document.xml').async('string')).includes('导出前最后输入的中文内容'));
  const media = Object.keys(word.files).filter(name => name.startsWith('word/media/') && !word.files[name].dir);
  assert.equal(media.length, 1);
  assert.deepEqual(await word.file(media[0]).async('nodebuffer'), image);
  assert.ok((await readFile(exportPaths.html, 'utf8')).includes('图文完整恢复'));
  assert.ok((await readFile(exportPaths.html, 'utf8')).includes('导出前最后输入的中文内容'));
  assert.ok((await readFile(exportPaths.html, 'utf8')).includes(`data:image/png;base64,${image.toString('base64')}`));
  assert.equal((await readFile(exportPaths.pdf)).subarray(0, 4).toString(), '%PDF');
  const pdfChildren = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', `$rows=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${application.pid}" | Where-Object { $_.CommandLine -match 'rust-headless-chrome-profile' } | ForEach-Object { $_.ProcessId }); ConvertTo-Json -InputObject $rows -Compress`], { windowsHide: true, encoding: 'utf8' }));
  report.pdfBrowserProcesses = pdfChildren;
  assert.ok(pdfChildren.length > 0, 'Expected an owned native PDF browser');
  report.cases.push({ name: 'actual native DOCX/HTML/PDF export writes valid files; DOCX embeds exact original image bytes', pass: true, paths: exportPaths });

  await inStore(store => { store.getState().addTab({ title: '明确丢弃的草稿', content: '不得在明确丢弃后再次恢复', modified: true }); });
  await until(async () => (await snapshots()).some(item => item.content === '不得在明确丢弃后再次恢复'), 'Discard test snapshot was not durable');
  void native('plugin:window|close', { label: null }).catch(() => {});
  await page.getByRole('button', { name: '不保存', exact: true }).click();
  await until(() => application.exitCode !== null, 'Normal discard did not exit');
  await until(() => pdfChildren.every(pid => { try { process.kill(pid, 0); return false; } catch { return true; } }), 'Native PDF browser leaked after normal application exit');
  await browser.close().catch(() => {}); browser = null;
  await wait(600);
  await launch();
  assert.equal((await snapshots()).length, 0);
  assert.equal(await page.getByRole('dialog', { name: '恢复未保存内容' }).count(), 0);
  report.cases.push({ name: 'normal explicit discard removes durable draft and does not reappear on restart', pass: true });
  report.cases.push({ name: 'normal application exit releases its owned PDF browser process', pass: true });
  }
  let slowImageRequested = false;
  slowExportServer = createServer(() => { slowImageRequested = true; });
  await new Promise(done => slowExportServer.listen(0, '127.0.0.1', done));
  await page.evaluate(({ port, outputPath }) => {
    window.__activePdfResult = 'pending';
    void window.__TAURI_INTERNALS__.invoke('export_pdf_direct', {
      htmlBody: `<h1>退出中的导出</h1><img src="http://127.0.0.1:${port}/slow.png">`,
      outputPath, settings: window.__validationStore.getState().settings.export, options: null, filePath: null,
    }).then(() => { window.__activePdfResult = 'finished'; }).catch(error => { window.__activePdfResult = String(error); });
  }, { port: slowExportServer.address().port, outputPath: join(fixtures, '退出中的导出.pdf') });
  await until(() => slowImageRequested, 'PDF export did not start loading the blocking fixture image', 30000);
  assert.equal(await page.evaluate(() => window.__activePdfResult), 'pending');
  activeExportBrowserPids = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', `$rows=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${application.pid}" | Where-Object { $_.CommandLine -match 'rust-headless-chrome-profile' } | ForEach-Object { $_.ProcessId }); ConvertTo-Json -InputObject $rows -Compress`], { windowsHide: true, encoding: 'utf8' }));
  assert.ok(activeExportBrowserPids.length > 0);
  await terminate();
  await until(() => activeExportBrowserPids.every(pid => { try { process.kill(pid, 0); return false; } catch { return true; } }), 'PDF browser leaked when application exited during an active export', 5000);
  report.cases.push({ name: 'application exit during active PDF export releases its owned browser process', pass: true });
  assert.deepEqual(report.pageErrors, []);
  assert.ok(!/Content Security Policy/.test(report.lastConsoleError || ''), 'Native IPC must not be blocked by CSP');
} catch (error) {
  report.failure = String(error.stack || error);
  if (page && !page.isClosed()) await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  if (application?.exitCode === null) application.kill('SIGKILL');
  await browser?.close().catch(() => {});
  if (server.listening) await new Promise(done => server.close(done));
  if (slowExportServer?.listening) { slowExportServer.closeAllConnections(); await new Promise(done => slowExportServer.close(done)); }
  for (const pid of activeExportBrowserPids) { try { process.kill(pid); } catch { /* Already exited. Only owned fixture PIDs are considered. */ } }
  await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
