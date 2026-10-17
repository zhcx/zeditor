import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
const output = process.env.CODE_PREVIEW_OUTPUT || 'test-output/code-language-preview';
mkdirSync(output, { recursive: true });
const results = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.ZEDITOR_TEST_URL || 'http://127.0.0.1:5199/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('.mode-chooser-card').filter({ hasText: '源码对照' }).click();
  await page.waitForSelector('.monaco-editor');
  await page.waitForSelector('#boot-splash', { state: 'detached' });
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const source = '# 代码预览\n\n```bash\npi --version\n```\n\n```javascript\nconst message = "Hello";\n```\n\n```my-custom-language\ncustom <value>\n```\n\n```\nplain text\n```\n\n正文 `inline code`。';
  await page.evaluate(async source => (await import('/src/stores/appStore.ts')).useAppStore.getState().addTab({ title: '代码语言提示.md', content: source }), source);
  await page.waitForFunction(() => document.querySelectorAll('.preview-document pre > code').length === 4);
  const test = async (name, run) => {
    try { await run(); results.push({ name, pass: true }); console.log(`PASS ${name}`); }
    catch (error) { results.push({ name, pass: false, error: error.message }); console.log(`FAIL ${name}: ${error.message}`); }
  };
  await test('source preview labels known, custom and unspecified languages', async () => {
    assert.deepEqual(await page.locator('.preview-document .preview-code-language').allTextContents(), ['bash', 'javascript', 'my-custom-language', '纯文本']);
    assert.equal(await page.locator('.preview-document p .preview-code-language').count(), 0);
    assert.deepEqual(await page.locator('.preview-document pre > code').allTextContents(), ['pi --version\n', 'const message = "Hello";\n', 'custom <value>\n', 'plain text\n']);
  });
  await page.screenshot({ path: `${output}/source-preview.png` });
  await page.locator('.preview-document pre').first().screenshot({ path: `${output}/code-language-detail.png` });
  await test('reading preview keeps labels in a compact header and adapts to theme', async () => {
    await page.evaluate(async () => (await import('/src/stores/appStore.ts')).useAppStore.getState().setMode('immersive'));
    await page.waitForSelector('.immersive-preview pre > code');
    assert.equal(await page.locator('.immersive-preview .preview-code-language').count(), 4);
    const box = await page.locator('.preview-code-language').first().boundingBox();
    assert.ok(box.height >= 20 && box.height <= 40, `header height ${box.height}`);
    await page.evaluate(async () => (await import('/src/themes/apply.ts')).applyThemeToDocument('vscode-light'));
    await frame();
    await page.screenshot({ path: `${output}/reading-light.png` });
    assert.ok(await page.locator('.preview-code-language').first().isVisible());
  });
  await test('WYSIWYG keeps one language control without duplicate preview labels', async () => {
    await page.evaluate(async () => (await import('/src/stores/appStore.ts')).useAppStore.getState().setMode('wysiwyg'));
    await page.waitForFunction(() => document.querySelectorAll('.wysiwyg-code-toolbar select').length === 4);
    assert.equal(await page.locator('.wysiwyg-document .preview-code-language').count(), 0);
    assert.equal(await page.locator('.wysiwyg-code-toolbar select').first().inputValue(), 'bash');
  });
  await test('labels do not change document content', async () => {
    assert.equal(await page.evaluate(async () => (await import('/src/stores/appStore.ts')).useAppStore.getState().editorView.getValue()), source);
    assert.deepEqual(errors, []);
  });
  writeFileSync(`${output}/results.json`, JSON.stringify(results, null, 2));
} finally { await browser.close(); }
if (results.some(result => !result.pass)) process.exitCode = 1;
