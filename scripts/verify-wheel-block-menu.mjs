import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const results = [];
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const state = fn => page.evaluate(expression => new Function('s', `return (${expression})(s)`)(window.__wheelStore.getState()), fn.toString());
const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const source = () => state(s => s.editorView.getValue());
const doc = async content => {
  await page.evaluate(text => window.__wheelStore.getState().addTab({ title: '菜单回归.md', path: `web://tests/${Math.random()}.md`, content: text }), content);
  await page.waitForFunction(text => window.__wheelStore.getState().editorView?.getValue() === text && document.querySelector('.wysiwyg-block'), content);
};
const openMenu = async submenu => {
  const handle = page.locator('.wysiwyg-block-handle').first();
  await handle.scrollIntoViewIfNeeded();
  await handle.click({ force: true });
  const main = page.getByRole('menu', { name: '块操作', exact: true });
  assert.deepEqual((await main.locator(':scope > .editor-context-menu-group > button').allTextContents()).map(text => text.replace('›', '').trim()), ['转换为', '在下方插入']);
  await main.locator('.editor-context-menu-group > button').filter({ hasText: submenu }).click();
  return page.getByRole('menu', { name: submenu, exact: true });
};
try {
  await mkdir('test-output', { recursive: true });
  await page.goto(process.env.ZEDITOR_TEST_URL || 'http://127.0.0.1:1425');
  await page.locator('.open-editor-row').first().waitFor();
  await page.evaluate(async () => {
    const text = await (await fetch('/src/App.tsx')).text();
    window.__wheelStore = (await import(text.match(/from ["']([^"']*appStore[.]ts[^"']*)["']/)[1])).useAppStore;
  });
  await state(s => { s.setSettings({ ...s.settings, editor: { ...s.settings.editor, mode: 'wysiwyg', line_width: 80 } }); s.setMode('wysiwyg'); });
  await doc('回归正文\n\n后段');
  for (const mode of ['wysiwyg', 'split']) {
    await page.evaluate(mode => window.__wheelStore.getState().setMode(mode), mode);
    const area = page.locator(mode === 'wysiwyg' ? '.wysiwyg-surface' : '.monaco-document-card');
    await area.waitFor();
    await area.hover();
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -100);
    await page.waitForFunction(() => document.querySelector('.line-width-hint')?.textContent.includes('82%'));
    await page.keyboard.up('Control');
    await page.waitForFunction(() => window.__wheelStore.getState().settings.editor.line_width === 82);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, 100);
    await page.keyboard.up('Control');
    await page.waitForFunction(() => window.__wheelStore.getState().settings.editor.line_width === 80);
    assert.equal(await source(), '回归正文\n\n后段');
    results.push({ name: 'native Ctrl+wheel changes width both ways without changing text', mode, pass: true });
  }
  await state(s => s.setMode('wysiwyg'));
  await page.locator('.wysiwyg-surface').waitFor();
  await page.evaluate(() => {
    window.__wheelSaves = 0;
    window.__wheelStore.subscribe((s, before) => { if (s.settings.editor.line_width !== before.settings.editor.line_width) window.__wheelSaves++; });
    const target = document.querySelector('.wysiwyg-surface');
    for (let i = 0; i < 5; i++) target.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100 }));
  });
  await page.waitForFunction(() => window.__wheelStore.getState().settings.editor.line_width === 90);
  assert.equal(await page.evaluate(() => window.__wheelSaves), 1);
  await state(s => { s.setSettingsTab('editor'); s.setSettingsOpen(true); });
  const slider = page.locator('input[aria-label="行宽"]');
  await slider.waitFor();
  assert.equal(await slider.inputValue(), '90');
  await slider.dispatchEvent('wheel', { ctrlKey: true, deltaY: -100 });
  await page.keyboard.press('Escape');
  assert.equal(await state(s => s.settings.editor.line_width), 90);
  results.push({ name: 'wheel gesture saves once, settings stay synchronized and exclude wheel shortcut', pass: true });

  for (const [label, expected] of [['4 级标题', '#### 待转换'], ['5 级标题', '##### 待转换'], ['6 级标题', '###### 待转换'], ['任务列表', '- [ ] 待转换'], ['代码块', '```\n待转换\n```'], ['公式块', '$$\n待转换\n$$']]) {
    await doc('待转换');
    const menu = await openMenu('转换为');
    await menu.getByRole('menuitem', { name: label, exact: true }).click();
    await page.waitForFunction(text => window.__wheelStore.getState().editorView?.getValue() === text, expected);
    await state(s => s.editorView.undo());
    assert.equal(await source(), '待转换');
    results.push({ name: 'convert with undo', label, pass: true });
  }
  for (const [label, needle] of [['6 级标题', '###### '], ['任务列表', '- [ ] '], ['有序列表', '1. '], ['引用', '> '], ['代码块', '```'], ['公式块', '$$'], ['表格', '| 列 1'], ['音频', '@[audio]'], ['折叠内容', '<details>'], ['流程图', '```mermaid'], ['思维导图', '```markmap']]) {
    await doc('前段\n\n后段');
    const menu = await openMenu('在下方插入');
    await menu.getByRole('menuitem', { name: label, exact: true }).click();
    const inserted = await source();
    assert.ok(inserted.startsWith('前段\n\n') && inserted.endsWith('\n\n后段'), inserted);
    assert.ok(inserted.includes(needle), inserted);
    await state(s => s.editorView.undo());
    assert.equal(await source(), '前段\n\n后段');
    results.push({ name: 'insert below first block with undo and unchanged following text', label, pass: true });
  }
  for (const [label, typed, expected] of [
    ['任务列表', 'Typed', '- [ ] Typed'],
    ['公式块', 'x+y', '$$\nx+y\n$$'],
    ['视频', 'https://example.com/video.mp4', '@[video](https://example.com/video.mp4)'],
    ['注释', 'note', '<!-- note -->'],
  ]) {
    await doc('前段\n\n后段');
    const menu = await openMenu('在下方插入');
    await menu.getByRole('menuitem', { name: label, exact: true }).click();
    if (label !== '任务列表') await page.locator('.wysiwyg-source-editor').waitFor();
    await frames();
    await page.keyboard.insertText(typed);
    if (label !== '任务列表') await page.keyboard.press('Control+Enter');
    const text = await source();
    assert.equal(text.replace(/\n{3,}/g, '\n\n'), `前段\n\n${expected}\n\n后段`);
    assert.ok(text.endsWith('\n\n后段'), text);
    results.push({ name: 'new block accepts immediate typing in its editing surface', label, pass: true });
  }
  await doc('前段\n\n后段');
  let imageMenu = await openMenu('在下方插入');
  await imageMenu.getByRole('menuitem', { name: '图片', exact: true }).click();
  await page.locator('.image-modal').getByRole('button', { name: '关闭', exact: true }).click();
  assert.equal(await source(), '前段\n\n后段');
  imageMenu = await openMenu('在下方插入');
  await imageMenu.getByRole('menuitem', { name: '图片', exact: true }).click();
  // 仅模拟桌面文件选择/复制的返回值，不读取本机文件；其余 UI 和源码插入走真实路径。
  await page.evaluate(() => {
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async command => command === 'plugin:dialog|open' ? 'C:/fake/picture.png'
        : command === 'import_image_asset' ? { fileName: 'picture.png', relativePath: '.assets/picture.png', absolutePath: 'C:/fake/.assets/picture.png', size: 10 }
        : [],
      convertFileSrc: () => 'about:blank',
    };
  });
  await page.locator('.image-modal').getByRole('button', { name: /^本地图片 复制/ }).click();
  await page.locator('.image-modal').waitFor({ state: 'detached' });
  assert.match(await source(), /^前段\n\n!\[picture\]\(\.assets\/picture.png\)\n\n+后段$/);
  await page.evaluate(() => { delete window.__TAURI_INTERNALS__; });
  results.push({ name: 'image cancel leaves document unchanged and local import inserts below selected block', pass: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(results, null, 2));
} finally {
  await page.screenshot({ path: 'test-output/wheel-block-menu.png' }).catch(() => {});
  await writeFile('test-output/wheel-block-menu-results.json', JSON.stringify({ results, errors }, null, 2));
  await browser.close();
}
