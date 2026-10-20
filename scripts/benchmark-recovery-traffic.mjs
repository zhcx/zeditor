// Runs the actual recovery subscription in an isolated browser; IPC stays in memory.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
try {
  const page = await browser.newPage();
  page.on('pageerror', error => console.error(error.message));
  await page.goto(process.env.ZEDITOR_TEST_URL || 'http://127.0.0.1:1425');
  await page.locator('.menubar').waitFor();
  await page.waitForTimeout(1200);
  await page.evaluate(async () => {
    const source = await (await fetch('/src/App.tsx')).text();
    const { useAppStore } = await import(source.match(/from ["']([^"']*appStore[.]ts[^"']*)["']/)[1]);
    window.__recoveryBenchStore = useAppStore;
    useAppStore.getState().setMode('split');
    window.__recoveryCalls = [];
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => 1,
      invoke: async (command, args) => {
        if (command === 'save_recovery_snapshot') window.__recoveryCalls.push(structuredClone(args.snapshot));
        if (/list_|get_recent|read_folder|take_pending_open/.test(command)) return [];
        if (command.startsWith('plugin:event|')) return 1;
        return null;
      },
    };
    useAppStore.setState({ recoveryLoaded: true });
    for (let index = 0; index < 6; index++) useAppStore.getState().addTab({ title: `草稿 ${index}`, content: '中文 English 😀\n'.repeat(2000), modified: true });
  });
  await page.waitForFunction(() => window.__recoveryCalls.length >= 6).catch(async error => {
    console.log(await page.evaluate(() => ({ calls: window.__recoveryCalls, loaded: window.__recoveryBenchStore.getState().recoveryLoaded, tabs: window.__recoveryBenchStore.getState().tabs.map(({ id, modified }) => ({ id, modified })), body: document.body.textContent.slice(0, 200) })));
    throw error;
  });
  await page.waitForTimeout(200);
  const baseline = await page.evaluate(() => {
    const initialWrites = window.__recoveryCalls.length;
    window.__recoveryCalls = [];
    window.__recoveryBenchStore.getState().setContent('仅修改当前草稿\n' + '中文 English 😀\n'.repeat(2000));
    return { initialWrites };
  });
  await page.waitForTimeout(1300);
  const result = await page.evaluate(() => ({
    writesAfterOneEdit: window.__recoveryCalls.length,
    transferredUtf8Bytes: window.__recoveryCalls.reduce((total, snapshot) => total + new TextEncoder().encode(JSON.stringify(snapshot)).length, 0),
    latestEditPreserved: window.__recoveryCalls.some(snapshot => snapshot.content.startsWith('仅修改当前草稿')),
  }));
  assert.equal(result.latestEditPreserved, true);
  const output = process.env.RECOVERY_BENCH_OUTPUT || 'test-output/reliability/recovery-traffic.json';
  await mkdir(output.slice(0, output.lastIndexOf('/')), { recursive: true });
  await writeFile(output, JSON.stringify({ ...baseline, ...result, scope: 'actual React subscription; in-memory IPC' }, null, 2));
  console.log(JSON.stringify({ ...baseline, ...result }));
} finally { await browser.close(); }
