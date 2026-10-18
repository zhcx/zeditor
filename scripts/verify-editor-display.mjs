import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// 隔离浏览器，仅创建内存文档；沿用已有 Playwright，不增加项目依赖。
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const results = [];
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const state = async fn => page.evaluate(async expression => {
  return new Function('s', `return (${expression})(s)`)(window.__displayStore.getState());
}, fn.toString());
const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const openSettings = async () => {
  await state(s => { s.setSettingsTab('editor'); s.setSettingsOpen(true); });
  await page.locator('input[aria-label="行宽"]').waitFor();
  // 面板有入场缩放动画，原生鼠标坐标须在几何稳定后采样。
  await page.locator('input[aria-label="行宽"]').click({ trial: true });
};
const readWidth = () => page.locator('input[aria-label="行宽"]').evaluate(input => ({
  value: Number(input.value), output: input.closest('.setting-range-item').querySelector('output').value,
}));
try {
  await mkdir('test-output', { recursive: true });
  await page.goto(process.env.ZEDITOR_TEST_URL || 'http://127.0.0.1:1425');
  await page.locator('.open-editor-row').first().waitFor();
  await page.evaluate(async () => {
    const source = await (await fetch('/src/App.tsx')).text();
    window.__displayStore = (await import(source.match(/from ["']([^"']*appStore[.]ts[^"']*)["']/)[1])).useAppStore;
  });
  await state(s => {
    s.setSettings({ ...s.settings, editor: { ...s.settings.editor, mode: 'split' } });
    s.setMode('split');
    s.addTab({ title: '显示回归.md', content: '# 标题\n\n' + '这是用于验证行宽的长段落。'.repeat(80) + '\n\n## 子节\n\n正文\n\n- 一级\n  - 二级\n    - 三级\n\n# 结尾\n\n正文' });
  });
  await page.locator('.monaco-editor').waitFor();
  await openSettings();
  const slider = page.locator('input[aria-label="行宽"]');
  await slider.focus();
  await page.keyboard.press('ArrowLeft');
  const moved = await readWidth();
  // 输入事件之后读数和原生滑块必须一致；旧实现只改读数，React 会把滑块重置。
  assert.equal(moved.output, `${moved.value}${moved.output.endsWith('%') ? '%' : 'px'}`, JSON.stringify(moved));
  results.push({ name: 'keyboard thumb follows displayed value', pass: true });
  assert.equal(await slider.getAttribute('min'), '40');
  assert.equal(await slider.getAttribute('max'), '100');
  await page.keyboard.press('End');
  await frames();
  const geometry = selector => page.locator(selector).evaluate(node => ({
    width: node.getBoundingClientRect().width, available: node.parentElement.clientWidth,
  }));
  const nearPercent = (box, percent) => assert.ok(Math.abs(box.width - box.available * percent / 100) < 2, JSON.stringify({ box, percent }));
  nearPercent(await geometry('.monaco-document-card'), 100);
  await page.evaluate(async () => {
    const useAppStore = window.__displayStore;
    window.__displayCommits = 0;
    window.__unsubscribeDisplay = useAppStore.subscribe((s, before) => {
      if (s.settings.editor.line_width !== before.settings.editor.line_width) window.__displayCommits++;
    });
  });
  const bounds = await slider.boundingBox();
  const x = percent => bounds.x + 9 + (bounds.width - 18) * (percent - 40) / 60;
  await page.mouse.move(x(100), bounds.y + bounds.height / 2);
  await page.mouse.down();
  const samples = [];
  for (const percent of [90, 80, 70, 60, 50, 40]) {
    await page.mouse.move(x(percent), bounds.y + bounds.height / 2, { steps: 3 });
    await frames();
    const sample = await readWidth();
    assert.equal(sample.output, `${sample.value}%`);
    assert.ok(Math.abs(sample.value - percent) <= 1, JSON.stringify(sample));
    nearPercent(await geometry('.monaco-document-card'), sample.value);
    assert.equal(await state(s => s.settings.editor.line_width), 100, 'drag should preview without saving');
    samples.push(sample.value);
  }
  await page.mouse.up();
  await frames();
  assert.equal(await state(s => s.settings.editor.line_width), 40);
  await slider.blur();
  assert.equal(await page.evaluate(() => window.__displayCommits), 1, 'pointerup plus blur saves once');
  nearPercent(await geometry('.monaco-document-card'), 40);
  nearPercent(await geometry('.preview-pane .preview-document'), 40);
  results.push({ name: 'source and preview follow real drag without rebound; one save', samples, pass: true });
  await page.keyboard.press('Escape');
  await page.locator('.settings-panel').waitFor({ state: 'detached' });
  await page.waitForFunction(() => Math.abs(document.querySelector('.monaco-editor').getBoundingClientRect().width - document.querySelector('.monaco-document-card').getBoundingClientRect().width) < 2);
  const original = await state(s => ({ id: s.activeTabId, source: s.editorView.getValue() }));
  await page.locator('.status-view-state').click();
  await page.locator('.wysiwyg-document').waitFor();
  nearPercent(await geometry('.wysiwyg-document'), 40);
  await openSettings();
  await slider.focus();
  await page.keyboard.press('End');
  await frames();
  nearPercent(await geometry('.wysiwyg-document'), 100);
  await page.keyboard.press('Home');
  await frames();
  nearPercent(await geometry('.wysiwyg-document'), 40);
  await page.keyboard.press('Escape');
  await page.locator('.settings-panel').waitFor({ state: 'detached' });
  results.push({ name: 'WYSIWYG responds at both slider endpoints and survives settings close', pass: true });
  await page.locator('.wysiwyg-fold-toggle').first().click();
  assert.equal(await state(s => s.editorView.getValue()), original.source);
  const otherId = await state(s => s.addTab({ title: '同名标题.md', content: '# 标题\n\n另一文档的正文' }));
  await page.waitForFunction(() => document.querySelector('.wysiwyg-document')?.textContent.includes('另一文档'));
  assert.equal(await page.locator('.wysiwyg-fold-toggle').first().getAttribute('aria-expanded'), 'true');
  await page.evaluate(id => window.__displayStore.getState().setActiveTab(id), original.id);
  await page.waitForFunction(() => document.querySelector('.wysiwyg-fold-toggle')?.getAttribute('aria-expanded') === 'false');
  assert.equal(await state(s => s.editorView.getValue()), original.source);
  results.push({ name: 'heading folds are isolated per tab and preserve source', otherId, pass: true });
  await page.locator('.wysiwyg-fold-toggle').first().click();
  const parentItem = page.locator('.wysiwyg-block[data-block-kind="list"] li').first();
  await parentItem.scrollIntoViewIfNeeded();
  const itemBox = await parentItem.boundingBox();
  await page.mouse.click(itemBox.x - 10, itemBox.y + 8);
  await page.waitForFunction(() => document.querySelector('.wysiwyg-block li.is-folded'));
  assert.equal(await parentItem.locator(':scope > ul').isVisible(), false);
  await state(s => { s.setSettings({ ...s.settings, editor: { ...s.settings.editor, fold_indentation: false } }); });
  await frames();
  assert.equal(await parentItem.locator(':scope > ul').isVisible(), true);
  assert.equal(await state(s => s.editorView.getValue()), original.source);
  results.push({ name: 'disabling indentation folding reveals children without changing source', pass: true });
  await openSettings();
  await slider.focus();
  await page.keyboard.press('End');
  await frames();
  const cancelBounds = await slider.boundingBox();
  await page.mouse.move(cancelBounds.x + cancelBounds.width - 9, cancelBounds.y + 12);
  await page.mouse.down();
  await page.mouse.move(cancelBounds.x + 9 + (cancelBounds.width - 18) / 3, cancelBounds.y + 12);
  await frames();
  nearPercent(await geometry('.wysiwyg-document'), 60);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.locator('.settings-panel').waitFor({ state: 'detached' });
  await frames();
  nearPercent(await geometry('.wysiwyg-document'), 100);
  assert.equal(await state(s => s.settings.editor.line_width), 100);
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-line-width-dragging')), false);
  results.push({ name: 'Escape during drag removes pending preview and keeps last saved width', pass: true });
  await state(s => { s.setSettings({ ...s.settings, editor: { ...s.settings.editor, line_width: 65 } }); });
  await frames();
  const sizes = [];
  for (const width of [960, 1440, 2560]) {
    await page.setViewportSize({ width, height: 960 });
    await frames();
    const box = await geometry('.wysiwyg-document');
    nearPercent(box, 65);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    sizes.push({ viewport: width, ...box });
  }
  await state(s => { s.setSettings({ ...s.settings, editor: { ...s.settings.editor, readable_line_length: false } }); });
  await frames();
  nearPercent(await geometry('.wysiwyg-document'), 100);
  await page.locator('.status-view-state').click();
  await page.locator('.monaco-editor').waitFor();
  await frames();
  nearPercent(await geometry('.monaco-document-card'), 100);
  nearPercent(await geometry('.preview-pane .preview-document'), 100);
  results.push({ name: 'responsive at narrow and wide sizes; disabling restores full width in both modes', sizes, pass: true });
  await state(s => {
    s.setMode('wysiwyg');
    s.addTab({ title: '折叠编辑.md', content: '# Head\n\nBody\n\n# Next\n\nNext body' });
  });
  await page.locator('.wysiwyg-fold-toggle').first().click();
  await state(s => { s.editorView.setSelection(6); s.editorView.focus(); });
  await page.keyboard.press('ArrowDown');
  assert.ok(await state(s => s.editorView.getSelection().from >= s.editorView.getValue().indexOf('# Next')), 'ArrowDown crosses folded body');
  await state(s => { s.editorView.setSelection(6); s.editorView.focus(); });
  await page.keyboard.press('Enter');
  await frames();
  await page.keyboard.insertText('Typed');
  assert.equal(await state(s => s.editorView.getValue()), '# Head\n\nTyped\n\nBody\n\n# Next\n\nNext body');
  await page.locator('.wysiwyg-fold-toggle').first().click();
  const bodyOffset = await state(s => { const offset = s.editorView.getValue().indexOf('Body'); s.editorView.setSelection(offset); s.editorView.revealOffset(offset); return offset; });
  await frames();
  assert.equal(await page.locator('.wysiwyg-fold-toggle').first().getAttribute('aria-expanded'), 'true');
  assert.equal(await state(s => s.editorView.getSelection().from), bodyOffset);
  results.push({ name: 'arrows cross folded sections and Enter restores caret into the visible new paragraph', pass: true });
  await page.setViewportSize({ width: 1440, height: 960 });
  await state(s => {
    s.setSettings({ ...s.settings, editor: { ...s.settings.editor, readable_line_length: true, line_width: 100 } });
    s.setMode('wysiwyg');
    s.addTab({ title: '长文档拖动.md', content: Array.from({ length: 300 }, (_, i) => `第 ${i} 段。` + '用于验证长文档调节行宽时的输入响应。'.repeat(8)).join('\n\n') });
  });
  await page.waitForFunction(() => document.querySelectorAll('.wysiwyg-block').length >= 300);
  for (const mode of ['wysiwyg', 'split']) {
    await page.evaluate(mode => {
      const s = window.__displayStore.getState();
      s.setSettings({ ...s.settings, editor: { ...s.settings.editor, line_width: 100 } });
      s.setMode(mode);
    }, mode);
    await page.locator(mode === 'wysiwyg' ? '.wysiwyg-document' : '.monaco-editor').waitFor();
    await openSettings();
    await page.evaluate(() => {
      window.__dragStats = { frames: [], longTasks: [], running: true };
      let before = performance.now();
      const sample = now => {
        if (!window.__dragStats.running) return;
        window.__dragStats.frames.push(now - before); before = now;
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      window.__dragObserver = new PerformanceObserver(list => window.__dragStats.longTasks.push(...list.getEntries().map(entry => entry.duration)));
      window.__dragObserver.observe({ type: 'longtask' });
    });
    const perfBox = await slider.boundingBox();
    await page.mouse.move(perfBox.x + perfBox.width - 9, perfBox.y + 12);
    await page.mouse.down();
    for (let i = 0; i <= 40; i++) {
      const progress = Math.abs(20 - i) / 20;
      await page.mouse.move(perfBox.x + 9 + (perfBox.width - 18) * progress, perfBox.y + 12);
    }
    await page.mouse.move(perfBox.x + 9 + (perfBox.width - 18) * 25 / 60, perfBox.y + 12);
    await frames();
    const finalBeforeUp = await readWidth();
    await page.mouse.up();
    await frames();
    const performanceStats = await page.evaluate(() => {
      window.__dragStats.running = false;
      window.__dragObserver.disconnect();
      const frames = window.__dragStats.frames.slice(2).sort((a, b) => a - b);
      return { frames: frames.length, p95FrameMs: frames[Math.floor(frames.length * .95)], maxFrameMs: frames.at(-1), longTasks: window.__dragStats.longTasks };
    });
    assert.equal((await readWidth()).value, 65, JSON.stringify({ finalBeforeUp, bounds: perfBox }));
    assert.equal(await state(s => s.settings.editor.line_width), 65);
    assert.ok(performanceStats.p95FrameMs < 50, JSON.stringify(performanceStats));
    results.push({ name: '300-paragraph real mouse drag performance', mode, ...performanceStats, pass: true });
    await page.keyboard.press('Escape');
    if (mode === 'split') await page.waitForFunction(() => Math.abs(document.querySelector('.monaco-editor').getBoundingClientRect().width - document.querySelector('.monaco-document-card').getBoundingClientRect().width) < 2);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(results, null, 2));
} finally {
  await page.screenshot({ path: 'test-output/editor-display.png' }).catch(() => {});
  await writeFile('test-output/editor-display-results.json', JSON.stringify({ results, errors }, null, 2));
  await browser.close();
}
