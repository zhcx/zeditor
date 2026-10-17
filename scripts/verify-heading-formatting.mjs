import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
const output = process.env.HEADING_TEST_OUTPUT || 'test-output/heading-formatting';
mkdirSync(output, { recursive: true });
const results = [];
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.ZEDITOR_TEST_URL || 'http://127.0.0.1:5199/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('.mode-chooser-card').filter({ hasText: '源码对照' }).click();
  await page.waitForSelector('.monaco-editor');
  await page.waitForSelector('#boot-splash', { state: 'detached' });
  const app = (fn, arg) => page.evaluate(async ({ fn, arg }) => (0, eval)(`(${fn})`)((await import('/src/stores/appStore.ts')).useAppStore, arg), { fn: fn.toString(), arg });
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const test = async (name, run) => {
    if (process.env.HEADING_TEST_FILTER && !name.includes(process.env.HEADING_TEST_FILTER)) return;
    try { await run(); results.push({ name, pass: true }); console.log(`PASS ${name}`); }
    catch (error) { results.push({ name, pass: false, error: error.message }); console.log(`FAIL ${name}: ${error.message}`); await page.keyboard.press('Escape'); }
  };
  const prepare = async (mode, source, from, to, pinned = false) => {
    await page.keyboard.press('Escape');
    await app((store, { mode, source, pinned }) => {
      const state = store.getState();
      state.setSettings({ ...state.settings, editor: { ...state.settings.editor, pin_toolbar: pinned } });
      state.setMode(mode);
      state.addTab({ title: '标题格式验证.md', content: source });
    }, { mode, source, pinned });
    await page.waitForFunction(async ({ source, mode }) => {
      const editor = (await import('/src/stores/appStore.ts')).useAppStore.getState().editorView;
      return editor?.getValue() === source && (mode === 'wysiwyg'
        ? editor.scrollDOM.classList.contains('wysiwyg-surface') : Boolean(editor.scrollDOM.closest('.monaco-host')));
    }, { source, mode });
    await frame();
    await app((store, selection) => { const editor = store.getState().editorView; editor.focus(); editor.setSelection(selection.from, selection.to); }, { from, to });
    await frame();
  };
  const chooseHeading = async (level, entry = 'floating') => {
    if (entry === 'context') {
      const position = await app(store => { const editor = store.getState().editorView; return editor.coordsAtPos(editor.getSelection().from + 1); });
      await page.mouse.click(position.x + 2, position.bottom - 5, { button: 'right' });
      await page.locator('.editor-context-menu').getByRole('menuitem', { name: /^标题/ }).hover();
      await page.locator('.editor-context-submenu').getByRole('menuitem', { name: `${level} 级标题` }).click();
      return;
    }
    const host = entry === 'pinned' ? page.locator('.editor-pane-toolbar, .immersive-writing-toolbar').first() : page.locator('.selection-toolbar').first();
    await host.getByRole('button', { name: /标题/ }).click();
    const names = ['一级标题', '二级标题', '三级标题', '四级标题', '五级标题', '六级标题'];
    await page.locator('.toolbar-menu').getByRole('menuitem', { name: names[level - 1], exact: true }).click();
  };
  const getSource = () => app(store => store.getState().editorView.getValue());
  for (const mode of ['split', 'wysiwyg', 'zen']) {
    await test(`${mode}: selected text becomes heading without an empty heading or extra newline`, async () => {
      const source = '前段\n\n需要转换的文字\n\n后段';
      const from = source.indexOf('需要');
      await prepare(mode, source, from, from + '需要转换的文字'.length);
      await chooseHeading(2);
      await frame();
      const expected = '前段\n\n## 需要转换的文字\n\n后段';
      assert.equal(await getSource(), expected);
      if (mode !== 'zen') {
        const heading = page.locator(mode === 'wysiwyg' ? '.wysiwyg-block h2' : '.preview-document h2');
        assert.equal(await heading.innerText(), '需要转换的文字');
      }
      assert.equal(await app(store => { const editor = store.getState().editorView; const selection = editor.getSelection(); return editor.getText(selection.from, selection.to); }), '需要转换的文字');
      await app(store => { store.getState().editorView.focus(); store.getState().editorView.undo(); });
      await page.waitForFunction(async source => (await import('/src/stores/appStore.ts')).useAppStore.getState().editorView.getValue() === source, source);
      await app(store => store.getState().editorView.redo());
      await page.waitForFunction(async source => (await import('/src/stores/appStore.ts')).useAppStore.getState().editorView.getValue() === source, expected);
    });
    await test(`${mode}: partial selection formats the existing line and keeps all text`, async () => {
      const source = '句首需要转换的文字句尾';
      await prepare(mode, source, 2, 9);
      await chooseHeading(3);
      await frame();
      assert.equal(await getSource(), `### ${source}`);
    });
    await test(`${mode}: context heading formats every selected nonempty line`, async () => {
      const source = '第一段\n\n第二段\n\n第三段';
      await prepare(mode, source, 0, source.indexOf('第三段'));
      await chooseHeading(2, 'context');
      await frame();
      assert.equal(await getSource(), '## 第一段\n\n## 第二段\n\n第三段');
    });
    await test(`${mode}: pinned toolbar changes existing heading level`, async () => {
      const source = '# 原有标题\n\n正文';
      await prepare(mode, source, 2, 6, true);
      await chooseHeading(4, 'pinned');
      await frame();
      assert.equal(await getSource(), '#### 原有标题\n\n正文');
    });
  }
  await page.screenshot({ path: `${output}/heading-result.png` });
  results.push({ name: 'no uncaught page errors', pass: errors.length === 0, errors });
  writeFileSync(`${output}/results.json`, JSON.stringify(results, null, 2));
} finally { await browser.close(); }
if (results.some(result => !result.pass)) process.exitCode = 1;
