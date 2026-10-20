// Production UI timing only: addTab receives memory content; no disk read/IPC.
// rAF readiness is a paint-opportunity proxy, not a browser Paint Timing entry.
// PLAYWRIGHT_MODULE_PATH=... ZEDITOR_TEST_URL=http://127.0.0.1:5199
// node scripts/benchmark-document-render.mjs --output test-output/reliability/document-render-before.json
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { splitMarkdownDocument } from '../src/utils/wysiwyg/blocks.ts';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const outputIndex = process.argv.indexOf('--output');
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : 'test-output/reliability/document-render-before.json';
assert.ok(output && !output.startsWith('--'), '--output needs a file path');
const assets = await readdir('dist/assets');
const storeFile = assets.find(file => /^appStore-.*\.js$/.test(file));
assert.ok(storeFile, 'Production appStore chunk was not found');
const storeURL = `/assets/${storeFile}`;
const assetHash = createHash('sha256').update(await readFile(`dist/assets/${storeFile}`)).digest('hex');
const iterations = Number(process.env.DOCUMENT_RENDER_ITERATIONS || 3);
const warmups = process.env.DOCUMENT_RENDER_WARMUPS === undefined ? 1 : Number(process.env.DOCUMENT_RENDER_WARMUPS);
const samples = [];
for (const kind of ['paragraphs', 'mixed-tables']) {
  for (const kibibytes of [100, 500]) {
    const name = `${kind}-${kibibytes}KiB`;
    const parts = [];
    let bytes = 0;
    for (let index = 0; bytes < kibibytes * 1024; index += 1) {
      const part = kind === 'paragraphs'
        ? `第${index}段 中文正文用于检查编辑器打开后的渲染时延，保留标点与混合 English 123。**重点内容** [来源](https://example.com)。继续阅读这一段测试材料，确认长文完整呈现。\n\n`
        : `## 章节 ${index}\n\n中文正文 **重点**，English 与数值 ${index}。\n\n| 名称 | 数量 | 状态 |\n| :-- | --: | :-- |\n| 中文项目 ${index} | ${index} | 完成 |\n| 附件 & 转义 | 2 | 待核 |\n\n\`\`\`js\nconst value = ${index};\n\`\`\`\n\n`;
      parts.push(part);
      bytes += Buffer.byteLength(part);
    }
    const endMarker = `ZEDITOR_RENDER_END_${name}`;
    const body = parts.join('') + endMarker;
    samples.push({ name, kind, body, endMarker });
  }
}
const report = { node: process.version, platform: process.platform, browser: '', url: process.env.ZEDITOR_TEST_URL || 'http://127.0.0.1:5199/',
  storeFile, assetHash, iterations, warmups, timingScope: 'In-memory addTab to rAF-observed editor/DOM readiness; excludes filesystem, IPC, startup and CPU profiling',
  timeoutMs: 30000, results: [] };
const persist = async () => { await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2)); };
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
report.browser = browser.version();
try {
  for (const mode of ['split', 'wysiwyg']) {
    if (process.env.DOCUMENT_RENDER_MODE && mode !== process.env.DOCUMENT_RENDER_MODE) continue;
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(report.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.locator('.mode-chooser-card').filter({ hasText: mode === 'split' ? '源码对照' : '所见即所得' }).click();
    await page.waitForFunction(async storeURL => {
      const module = await import(storeURL);
      const store = Object.values(module).find(value => typeof value === 'function' && typeof value.getState === 'function' && 'activeTabId' in value.getState());
      return Boolean(store?.getState().editorView);
    }, storeURL);
    await page.waitForSelector('#boot-splash', { state: 'detached' });
    const cdp = process.env.DOCUMENT_RENDER_PROFILE ? await page.context().newCDPSession(page) : null;
    for (const sample of samples) {
      if (process.env.DOCUMENT_RENDER_SAMPLE && sample.name !== process.env.DOCUMENT_RENDER_SAMPLE) continue;
      if (cdp) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.start'); }
      const runs = [];
      for (let run = 0; run < warmups + iterations; run += 1) {
        const title = `渲染测量 ${mode} ${sample.name} ${run}`;
        const text = `# ${title}\n\n${sample.body}`;
        const totalBlocks = splitMarkdownDocument(text).blocks.length;
        const measurement = await page.evaluate(async ({ mode, text, title, storeURL, totalBlocks, endMarker, timeoutMs }) => {
          const module = await import(storeURL);
          const store = Object.values(module).find(value => typeof value === 'function' && typeof value.getState === 'function' && 'activeTabId' in value.getState());
          const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
          await nextFrame(); await nextFrame();
          const start = performance.now();
          const id = store.getState().addTab({ title: '内存渲染测量.md', content: text, modified: false });
          let firstPaintMs = null;
          let maxFrameMs = 0;
          let previous = start;
          let frames = 0;
          let renderedBlocks = 0;
          let editorExactText = false;
          let fullyRendered = false;
          let newDocumentVisible = false;
          while (performance.now() - start < timeoutMs) {
            await nextFrame();
            const now = performance.now();
            maxFrameMs = Math.max(maxFrameMs, now - previous); previous = now; frames += 1;
            editorExactText = store.getState().activeTabId === id && store.getState().editorView?.getValue() === text;
            const root = document.querySelector(mode === 'split' ? '.preview-document' : '.wysiwyg-surface');
            newDocumentVisible = root?.querySelector('h1')?.textContent === title;
            renderedBlocks = document.querySelectorAll('.wysiwyg-block').length;
            const firstReady = editorExactText && newDocumentVisible && (mode === 'split' || renderedBlocks > 0);
            if (firstReady && firstPaintMs === null) firstPaintMs = now - start;
            fullyRendered = firstReady && (mode === 'split' ? root.textContent.includes(endMarker) : renderedBlocks === totalBlocks && root.textContent.includes(endMarker));
            if (fullyRendered) break;
          }
          await nextFrame();
          const fullyRenderedMs = fullyRendered ? performance.now() - start : null;
          const result = { firstPaintMs, fullyRenderedMs, maxFrameMs, frames, renderedBlocks, totalBlocks, editorExactText,
            fullyRendered, timedOut: !fullyRendered, newDocumentVisible };
          store.getState().closeTab(id);
          await nextFrame(); await nextFrame();
          return result;
        }, { mode, text, title, storeURL, totalBlocks, endMarker: sample.endMarker, timeoutMs: report.timeoutMs });
        assert.equal(measurement.editorExactText, true, `${mode}/${sample.name}: changed editor text`);
        if (run >= warmups) runs.push(measurement);
        console.log(JSON.stringify({ mode, name: sample.name, run, warmup: run < warmups, ...measurement }));
      }
      const median = key => {
        const values = runs.map(run => run[key]).filter(value => value !== null).sort((a, b) => a - b);
        return values.length ? Number(values[Math.floor(values.length / 2)].toFixed(2)) : null;
      };
      report.results.push({ mode, name: sample.name, utf8Bytes: Buffer.byteLength(`# 渲染测量 ${mode} ${sample.name} 0\n\n${sample.body}`),
        medianFirstPaintMs: median('firstPaintMs'), medianFullyRenderedMs: median('fullyRenderedMs'), runs, errors: [...errors] });
      await persist();
      if (cdp) {
        const { profile } = await cdp.send('Profiler.stop');
        await writeFile(`${dirname(output)}/${mode}-${sample.name}-cpu.json`, JSON.stringify(profile));
      }
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
} finally { await persist(); await browser.close(); }
