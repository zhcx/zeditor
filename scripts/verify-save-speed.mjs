import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await mkdir('test-output/save-speed', { recursive: true });
  await page.goto(process.env.ZEDITOR_TEST_URL || 'http://127.0.0.1:5199/');
  await page.locator('.mode-chooser-card').filter({ hasText: '所见即所得' }).click();
  await page.locator('.wysiwyg-block').first().waitFor();
  await page.evaluate(async () => {
    const app = await (await fetch('/src/App.tsx')).text();
    window.__saveStore = (await import(app.match(/from ["']([^"']*appStore[.]ts[^"']*)["']/)[1])).useAppStore;
    const ai = (await import(app.match(/from ["']([^"']*aiStore[.]ts[^"']*)["']/)[1])).useAIStore;
    window.__saveProbe = { calls: [], aiRequests: 0, started: 0, dialogs: [], writes: [] };
    ai.setState({ suggestFilename: () => { window.__saveProbe.aiRequests++; return new Promise(() => {}); } });
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => 1,
      invoke: async (command, args) => {
        const probe = window.__saveProbe;
        probe.calls.push(command);
        if (command === 'plugin:dialog|save') {
          probe.dialogs.push({ elapsedMs: performance.now() - probe.started, defaultPath: args.options.defaultPath });
          if (probe.cancelNext) { probe.cancelNext = false; return null; }
          return `C:/save-probe/note-${probe.dialogs.length}.md`;
        }
        if (command === 'save_file_content_checked') {
          probe.writes.push(structuredClone(args));
          return { status: 'saved', fileVersion: { size: args.content.length, sha256: 'test' }, current: null };
        }
        if (command === 'ai_request') { probe.aiRequests++; return new Promise(() => {}); }
        if (command.startsWith('plugin:event|')) return 1;
        if (/get_recent|update_recent|list_|read_folder|take_pending_open|find_wiki_backlinks/.test(command)) return [];
        return null;
      },
    };
    const s = window.__saveStore.getState();
    s.setSettings({ ...s.settings, ai: { ...s.settings.ai, enabled: true, api_key: 'test', auto_suggest: false, auto_proofread: false } });
  });
  await page.locator('.wysiwyg-block').first().click();
  await page.keyboard.insertText('新文件即时保存');
  await page.evaluate(() => { window.__saveProbe.started = performance.now(); });
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => window.__saveProbe.writes.length === 1, null, { timeout: 1500 });
  let probe = await page.evaluate(() => window.__saveProbe);
  assert.equal(probe.aiRequests, 0);
  assert.equal(probe.dialogs[0].defaultPath, '新文件即时保存.md');
  assert.equal(probe.writes[0].content, '新文件即时保存');
  assert.ok(probe.dialogs[0].elapsedMs < 1000, JSON.stringify(probe.dialogs));
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => window.__saveProbe.writes.length === 2);
  probe = await page.evaluate(() => window.__saveProbe);
  assert.equal(probe.dialogs.length, 1, 'an existing file saves without choosing a path');
  await page.evaluate(() => { window.__saveProbe.started = performance.now(); });
  await page.keyboard.press('Control+Shift+s');
  await page.waitForFunction(() => window.__saveProbe.writes.length === 3);
  probe = await page.evaluate(() => window.__saveProbe);
  assert.equal(probe.dialogs[1].defaultPath, 'C:/save-probe/note-1.md');
  assert.equal(probe.aiRequests, 0);
  const closingId = await page.evaluate(() => window.__saveStore.getState().addTab({ content: '# 关闭时保存', modified: true }));
  await page.locator('.tab.active .tab-close').first().click();
  const closeSave = page.locator('.unsaved-action-button.primary');
  await closeSave.waitFor();
  await page.evaluate(() => { window.__saveProbe.started = performance.now(); });
  await closeSave.click();
  await page.waitForFunction(id => !window.__saveStore.getState().tabs.some(tab => tab.id === id), closingId);
  probe = await page.evaluate(() => window.__saveProbe);
  assert.equal(probe.writes.length, 4);
  assert.equal(probe.dialogs[2].defaultPath, '关闭时保存.md');
  const cancelledId = await page.evaluate(() => {
    window.__saveProbe.cancelNext = true;
    return window.__saveStore.getState().addTab({ content: '# 取消保存保留原稿', modified: true });
  });
  await page.locator('.wysiwyg-block').first().waitFor();
  await page.evaluate(() => { window.__saveProbe.started = performance.now(); });
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => window.__saveProbe.dialogs.length === 4);
  const cancelled = await page.evaluate(id => window.__saveStore.getState().tabs.find(tab => tab.id === id), cancelledId);
  assert.equal(cancelled.path, null);
  assert.equal(cancelled.modified, true);
  assert.equal(cancelled.content, '# 取消保存保留原稿');
  probe = await page.evaluate(() => window.__saveProbe);
  assert.equal(probe.writes.length, 4);
  assert.equal(probe.aiRequests, 0);
  assert.deepEqual(errors, []);
  const result = { dialogRequests: probe.dialogs, aiRequests: probe.aiRequests, successfulWrites: probe.writes.length, errors };
  await writeFile('test-output/save-speed/results.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await page.screenshot({ path: 'test-output/save-speed/last-state.png' }).catch(() => {});
  await browser.close();
}
