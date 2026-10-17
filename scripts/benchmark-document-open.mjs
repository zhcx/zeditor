import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { splitMarkdownDocument } from '../src/utils/wysiwyg/blocks.ts';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
const output = process.env.DOCUMENT_BENCH_OUTPUT || 'test-output/document-open';
mkdirSync(output, { recursive: true });
const samples = [
  ['handoff', readFileSync('docs/wysiwyg-handoff-2026-10-17-r2.md', 'utf8')],
  ['paragraphs-260', Array.from({ length: 260 }, (_, i) => `段落 ${i} 中文 English **重点** [链接](https://example.com)。`).join('\n\n')],
  ['tables-code-120', Array.from({ length: 120 }, (_, i) => `## 章节 ${i}\n\n中文 Markdown 段落 ${i} **重点**。\n\n| 名称 | 值 |\n| --- | --- |\n| 项目 ${i} | ${i} |\n\n\`\`\`js\nconst value = ${i};\n\`\`\``).join('\n\n')],
];
const results = [];
const storeURL = process.env.DOCUMENT_BENCH_PRODUCTION === '1'
  ? `/assets/${readdirSync('dist/assets').find(file => /^appStore-.*\.js$/.test(file))}` : '/src/stores/appStore.ts';
try {
  for (const mode of ['split', 'wysiwyg']) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(process.env.ZEDITOR_TEST_URL || 'http://127.0.0.1:5199/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.locator('.mode-chooser-card').filter({ hasText: mode === 'split' ? '源码对照' : '所见即所得' }).click();
    await page.waitForFunction(async storeURL => {
      const module = await import(storeURL);
      const store = Object.values(module).find(value => typeof value === 'function' && typeof value.getState === 'function' && 'activeTabId' in value.getState());
      return Boolean(store?.getState().editorView);
    }, storeURL);
    await page.waitForSelector('#boot-splash', { state: 'detached' });
    const cdp = await page.context().newCDPSession(page);
    for (const [name, body] of samples) {
      const title = `性能验证 ${name}`;
      const text = `# ${title}\n\n${body}`;
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.start');
      const measurement = await page.evaluate(async ({ mode, text, title, storeURL, totalBlocks }) => {
        const module = await import(storeURL);
        const useAppStore = Object.values(module).find(value => typeof value === 'function' && typeof value.getState === 'function' && 'activeTabId' in value.getState());
        const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
        await nextFrame();
        let previewMutated = false;
        const preview = document.querySelector('.preview-document');
        const observer = new MutationObserver(() => { previewMutated = true; });
        if (preview) observer.observe(preview, { childList: true });
        const start = performance.now();
        const id = useAppStore.getState().addTab({ title: '对照性能测试.md', content: text });
        let firstPaintMs = null;
        let previous = start;
        const intervals = [];
        for (let i = 0; i < 600; i++) {
          await nextFrame();
          const now = performance.now();
          intervals.push(now - previous);
          previous = now;
          const editorReady = useAppStore.getState().activeTabId === id && useAppStore.getState().editorView?.getValue() === text;
          const count = document.querySelectorAll('.wysiwyg-block').length;
          const newPreviewReady = previewMutated && document.querySelector('.preview-document h1')?.textContent === title;
          const firstReady = editorReady && (mode === 'split' ? newPreviewReady : count > 0);
          if (firstReady && firstPaintMs === null) firstPaintMs = now - start;
          const fullReady = editorReady && (mode === 'split'
            ? newPreviewReady
            : count === totalBlocks);
          if (fullReady && firstPaintMs !== null) {
            await nextFrame();
            observer.disconnect();
            return { totalBlocks, firstPaintMs, completeMs: performance.now() - start, maxFrameMs: Math.max(...intervals), frames: intervals.length,
              renderedBlocks: count, sourceIntact: useAppStore.getState().editorView.getValue() === text };
          }
        }
        throw new Error(`Document never completed: ${mode}`);
      }, { mode, text, title, storeURL, totalBlocks: splitMarkdownDocument(text).blocks.length });
      const { profile } = await cdp.send('Profiler.stop');
      writeFileSync(`${output}/${mode}-${name}-profile.json`, JSON.stringify(profile));
      const hits = new Map();
      const nodes = new Map(profile.nodes.map(node => [node.id, node]));
      for (let i = 0; i < profile.samples.length; i++) {
        const call = nodes.get(profile.samples[i])?.callFrame;
        const label = `${call?.functionName || '(anonymous)'} ${call?.url?.split('/').slice(-2).join('/')} ${call?.lineNumber}`;
        hits.set(label, (hits.get(label) || 0) + (profile.timeDeltas[i] || 0) / 1000);
      }
      results.push({ mode, name, ...measurement, topSelfMs: [...hits].sort((a, b) => b[1] - a[1]).slice(0, 10) });
      console.log(JSON.stringify({ mode, name, ...measurement }));
      assert.equal(measurement.sourceIntact, true);
    }
    await page.getByRole('button', { name: 'AI 对话', exact: true }).click();
    await page.waitForSelector('.chatbot-divider');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const divider = await page.locator('.chatbot-divider').boundingBox();
    const startX = divider.x + divider.width / 2;
    await page.mouse.move(startX, divider.y + 100);
    await page.mouse.down();
    await page.evaluate(() => {
      window.__dragFrames = [];
      window.__lastDragFrame = performance.now();
      const tick = now => { window.__dragFrames.push(now - window.__lastDragFrame); window.__lastDragFrame = now; window.__dragFrame = requestAnimationFrame(tick); };
      window.__dragFrame = requestAnimationFrame(tick);
    });
    for (let step = 1; step <= 20; step++) {
      await page.mouse.move(startX - step * 5, divider.y + 100);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    }
    await page.mouse.up();
    const drag = await page.evaluate(() => {
      cancelAnimationFrame(window.__dragFrame);
      const samples = window.__dragFrames.slice(1).sort((a, b) => a - b);
      return { samples: samples.length, p95FrameMs: samples[Math.floor(samples.length * 0.95)], maxFrameMs: samples.at(-1) };
    });
    const after = await page.locator('.chatbot-divider').boundingBox();
    assert.ok(Math.abs(after.x + after.width / 2 - startX + 100) <= 2, `${mode}: AI divider drift`);
    results.push({ mode, name: 'ai-drag', ...drag });
    console.log(JSON.stringify({ mode, name: 'ai-drag', ...drag }));
    await page.screenshot({ path: `${output}/${mode}-workspace.png` });
    assert.deepEqual(errors, []);
    await page.close();
  }
  writeFileSync(`${output}/results.json`, JSON.stringify(results, null, 2));
} finally { await browser.close(); }
