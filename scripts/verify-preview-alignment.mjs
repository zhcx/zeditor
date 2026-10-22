import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// 沿用已有 Playwright，隔离浏览器内输入测试文稿，不读写用户文档。
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 960 } });
const results = [];
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
try {
  await mkdir('test-output/preview-alignment', { recursive: true });
  await page.goto(process.env.ZEDITOR_TEST_URL || 'http://127.0.0.1:5199/');
  await page.locator('.mode-chooser-card').filter({ hasText: '所见即所得' }).click();
  await page.locator('.wysiwyg-block').first().click();
  const lines = Array.from({ length: 8 }, (_, i) => `第${i + 1}行：编辑内容与预览对齐`);
  for (const [index, text] of lines.entries()) {
    if (index) await page.keyboard.press('Enter');
    await page.keyboard.insertText(text);
  }
  await page.locator('.status-view-state').click();
  await page.locator('.monaco-editor').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.preview-source-line').length === 8);
  for (const { fontSize, lineHeight } of [
    { fontSize: 14, lineHeight: 1.4 },
    { fontSize: 17, lineHeight: 1.45 },
    { fontSize: 12, lineHeight: 1.65 },
  ]) {
    await page.evaluate(async ({ fontSize, lineHeight }) => {
      const { useAppStore } = await import('/src/stores/appStore.ts');
      const s = useAppStore.getState();
      s.setSettings({ ...s.settings, appearance: { ...s.settings.appearance, font_size: fontSize, line_height: lineHeight } });
      const editor = s.editorView;
      editor.setSelection(editor.line(7).from);
      editor.focus();
      await document.fonts.ready;
    }, { fontSize, lineHeight });
    await frames();
    const geometry = await page.evaluate(() => {
      const bounds = node => {
        const range = document.createRange();
        // Monaco 的外层 span 包含整行盒，比较文字需取真正的文本节点。
        const text = document.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode();
        range.selectNodeContents(text || node);
        const rect = range.getBoundingClientRect();
        return { top: rect.top, height: rect.height };
      };
      const source = Array.from(document.querySelectorAll('.view-lines .view-line'), bounds);
      const preview = Array.from(document.querySelectorAll('.preview-source-line'), bounds);
      const metrics = selector => {
        const node = document.querySelector(selector);
        const style = getComputedStyle(node);
        return { top: node.getBoundingClientRect().top, font: style.font, lineHeight: style.lineHeight, paddingTop: style.paddingTop, marginTop: style.marginTop, verticalAlign: style.verticalAlign };
      };
      return {
        source, preview,
        surfaces: Object.fromEntries(['.monaco-host', '.view-lines', '.view-line', '.preview-card', '.preview-document', '.preview-document p', '.preview-source-line'].map(selector => [selector, metrics(selector)])),
        offsets: source.map((rect, i) => preview[i].top - rect.top),
        previewLineHeight: parseFloat(getComputedStyle(document.querySelector('.preview-document p')).lineHeight),
      };
    });
    results.push({ fontSize, lineHeight, ...geometry });
    assert.equal(geometry.source.length, 8);
    assert.equal(geometry.previewLineHeight, Math.round(fontSize * lineHeight), JSON.stringify(geometry));
    assert.ok(geometry.offsets.every(offset => Math.abs(offset) <= 1), JSON.stringify(geometry));
  }
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/stores/appStore.ts');
    useAppStore.getState().setSettingsTab('appearance');
    useAppStore.getState().setSettingsOpen(true);
  });
  const fontSizeSlider = page.getByRole('slider', { name: '字号', exact: true });
  await fontSizeSlider.focus();
  await page.keyboard.press('ArrowRight');
  await frames();
  const previewHeight = () => page.evaluate(() => ({
    source: parseFloat(getComputedStyle(document.querySelector('.view-line')).lineHeight),
    preview: parseFloat(getComputedStyle(document.querySelector('.preview-document p')).lineHeight),
  }));
  assert.deepEqual(await previewHeight(), { source: 21, preview: 21 });
  await page.keyboard.press('Escape');
  await page.locator('.settings-panel').waitFor({ state: 'hidden' });
  await frames();
  assert.deepEqual(await previewHeight(), { source: 20, preview: 20 });
  results.push({ name: 'font-size slider preview and cancel keep the same line height', pass: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ results, errors }, null, 2));
} finally {
  await page.screenshot({ path: 'test-output/preview-alignment/alignment.png' }).catch(() => {});
  await writeFile('test-output/preview-alignment/results.json', JSON.stringify({ results, errors }, null, 2));
  await browser.close();
}
