// Browser regression for editing history, tab isolation and mode transitions.
// PLAYWRIGHT_MODULE_PATH may point to an existing Playwright installation.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(process.env.ZEDITOR_TEST_URL || 'http://127.0.0.1:1425/');
  await page.locator('.mode-chooser-card').filter({ hasText: '源码对照' }).click();
  await page.waitForFunction(async () => Boolean((await import('/src/stores/appStore.ts')).useAppStore.getState().editorView));
  await page.evaluate(async () => { window.__historyStore = (await import('/src/stores/appStore.ts')).useAppStore; });
  const state = (fn, arg) => page.evaluate(fn, arg);
  const setMode = async mode => {
    await state(mode => window.__historyStore.getState().setMode(mode), mode);
    await page.waitForSelector(mode === 'wysiwyg' ? '.wysiwyg-surface' : '.monaco-editor');
    await page.waitForFunction(mode => window.__historyStore.getState().mode === mode && Boolean(window.__historyStore.getState().editorView), mode);
  };
  // Keep the controller as the source of truth, as toolbars and AI do.
  const edit = text => page.evaluate(text => {
    const editor = window.__historyStore.getState().editorView;
    const end = editor.getValue().length;
    editor.replaceRange(end, end, text, { from: end + text.length, to: end + text.length });
  }, text);
  const text = () => state(() => window.__historyStore.getState().editorView.getValue());
  const action = name => state(name => window.__historyStore.getState().editorView[name](), name);
  const addTab = content => page.evaluate(content => window.__historyStore.getState().addTab({ content, modified: true }), content);

  await addTab('初始');
  await page.waitForFunction(() => window.__historyStore.getState().editorView?.getValue() === '初始');
  await edit('甲');
  await setMode('wysiwyg');
  assert.equal(await text(), '初始甲', 'switch must preserve content');
  await action('undo');
  assert.equal(await text(), '初始', 'undo crosses source → WYSIWYG');
  await action('redo');
  assert.equal(await text(), '初始甲', 'redo crosses source → WYSIWYG');
  await edit('乙');
  await setMode('split');
  assert.equal(await text(), '初始甲乙');
  await action('undo');
  assert.equal(await text(), '初始甲', 'undo crosses WYSIWYG → source');
  await action('undo');
  assert.equal(await text(), '初始', 'undo continues through earlier mode');
  await action('redo');
  await action('redo');
  assert.equal(await text(), '初始甲乙', 'redo continues across both modes');

  const longText = Array.from({ length: 160 }, (_, index) => `第 ${index} 段：用于测试切换后阅读位置。`).join('\n\n');
  const longTab = await addTab(longText);
  await page.waitForFunction(id => window.__historyStore.getState().activeTabId === id && window.__historyStore.getState().editorView?.getValue().includes('第 159 段'), longTab);
  const target = longText.indexOf('第 80 段');
  await state(offset => {
    const editor = window.__historyStore.getState().editorView;
    editor.setSelection(offset);
    editor.revealOffset(offset);
  }, target);
  await setMode('wysiwyg');
  assert.equal(await state(() => window.__historyStore.getState().editorView.getSelection().from), target, 'mode switch follows the source caret');
  await page.waitForFunction(() => document.querySelector('.wysiwyg-surface').scrollTop > 0);
  await page.locator('.wysiwyg-surface').evaluate(element => { element.scrollTop = Math.floor(element.scrollHeight * 0.65); });
  const readingTop = await page.locator('.wysiwyg-surface').evaluate(element => element.scrollTop);
  await addTab('另一个标签');
  await page.waitForFunction(() => window.__historyStore.getState().editorView?.getValue() === '另一个标签');
  await state(id => window.__historyStore.getState().setActiveTab(id), longTab);
  await page.waitForFunction(id => window.__historyStore.getState().activeTabId === id && window.__historyStore.getState().editorView?.getValue().includes('第 159 段'), longTab);
  await page.waitForFunction(expected => Math.abs(document.querySelector('.wysiwyg-surface').scrollTop - expected) < 80, readingTop, { timeout: 10000 });

  // Switch back from a visual selection and follow the same source location.
  const visualOffset = longText.indexOf('第 120 段');
  await state(offset => {
    const editor = window.__historyStore.getState().editorView;
    editor.setSelection(offset);
    editor.revealOffset(offset);
  }, visualOffset);
  await setMode('split');
  await page.waitForFunction(offset => window.__historyStore.getState().editorView?.getSelection().from === offset, visualOffset);
  assert.ok(await state(() => window.__historyStore.getState().editorView.getScrollTop()) > 0, 'source view follows the visual caret');
  await state(() => window.__historyStore.getState().editorView.setScrollTop(1100));
  const sourceReadingTop = await state(() => window.__historyStore.getState().editorView.getScrollTop());
  await addTab('源码里的另一个标签');
  await page.waitForFunction(() => window.__historyStore.getState().editorView?.getValue() === '源码里的另一个标签');
  await state(id => window.__historyStore.getState().setActiveTab(id), longTab);
  await page.waitForFunction(expected => Math.abs(window.__historyStore.getState().editorView.getScrollTop() - expected) < 40, sourceReadingTop);

  // Exercise actual keyboard input and shortcut handlers, including a pending
  // WYSIWYG write that has not yet reached its 250 ms debounce.
  await addTab('键盘');
  await page.waitForFunction(() => window.__historyStore.getState().editorView?.getValue() === '键盘');
  await state(() => { const editor = window.__historyStore.getState().editorView; editor.setSelection(2); editor.focus(); });
  await page.keyboard.insertText('A');
  await setMode('wysiwyg');
  assert.equal(await text(), '键盘A');
  await state(() => window.__historyStore.getState().editorView.focus());
  await page.keyboard.press('Control+z');
  assert.equal(await text(), '键盘', 'keyboard undo crosses into the previous mode');
  await page.keyboard.press('Control+Shift+z');
  assert.equal(await text(), '键盘A', 'keyboard redo restores the previous mode edit');
  await page.keyboard.insertText('B');
  await setMode('split');
  assert.equal(await text(), '键盘AB', 'pending visual input survives an immediate mode switch');
  await state(() => window.__historyStore.getState().editorView.focus());
  await page.keyboard.press('Control+z');
  assert.equal(await text(), '键盘A', 'source keyboard undo restores visual input');
  await page.keyboard.press('Control+y');
  assert.equal(await text(), '键盘AB', 'source keyboard redo restores visual input');
  await page.keyboard.press('Control+z');
  await setMode('wysiwyg');
  await state(() => window.__historyStore.getState().editorView.focus());
  await page.keyboard.insertText('C');
  await setMode('split');
  await page.keyboard.press('Control+y');
  assert.equal(await text(), '键盘AC', 'redo must not replace a newly edited branch');

  // Windows 习惯的 Ctrl+Y 在可视化正文里也必须能重做：浏览器没有原生可重做项时
  // 不一定派发 beforeinput(historyRedo)，所以编辑器要显式接管这个组合键。
  await addTab('重做');
  await page.waitForFunction(() => window.__historyStore.getState().editorView?.getValue() === '重做');
  await setMode('wysiwyg');
  await edit('X');
  assert.equal(await text(), '重做X');
  await state(() => window.__historyStore.getState().editorView.focus());
  await page.keyboard.press('Control+z');
  assert.equal(await text(), '重做', 'visual undo runs through the shared history');
  await page.keyboard.press('Control+y');
  assert.equal(await text(), '重做X', 'visual Ctrl+Y redoes the edit');

  // 切回标签后，第一次编辑的撤销点必须记住恢复后的视图位置，而不是文首。
  await setMode('split');
  const caretTab = await addTab('abcdef');
  await page.waitForFunction(id => window.__historyStore.getState().activeTabId === id && window.__historyStore.getState().editorView?.getValue() === 'abcdef', caretTab);
  await state(() => { const editor = window.__historyStore.getState().editorView; editor.setSelection(4); editor.focus(); });
  const awayTab = await addTab('离开');
  await page.waitForFunction(id => window.__historyStore.getState().activeTabId === id && window.__historyStore.getState().editorView?.getValue() === '离开', awayTab);
  await state(id => window.__historyStore.getState().setActiveTab(id), caretTab);
  await page.waitForFunction(id => window.__historyStore.getState().activeTabId === id && window.__historyStore.getState().editorView?.getValue() === 'abcdef', caretTab);
  await page.waitForFunction(() => window.__historyStore.getState().editorView.getSelection().from === 4);
  await state(() => window.__historyStore.getState().editorView.focus());
  await page.keyboard.insertText('X');
  await page.waitForFunction(() => window.__historyStore.getState().editorView.getValue() === 'abcdXef');
  await action('undo');
  assert.equal(await text(), 'abcdef');
  assert.equal(
    await state(() => window.__historyStore.getState().editorView.getSelection().from), 4,
    'undo after a tab switch keeps the caret captured before the edit',
  );

  const otherTab = await addTab('另一份');
  await page.waitForFunction(id => window.__historyStore.getState().activeTabId === id && window.__historyStore.getState().editorView?.getValue() === '另一份', otherTab);
  await action('undo');
  assert.equal(await text(), '另一份', 'history is isolated per tab');
  await setMode('wysiwyg');
  const visualTab = await addTab('可视标签');
  await page.waitForFunction(() => window.__historyStore.getState().editorView?.getValue() === '可视标签');
  await edit('改');
  await addTab('暂时离开');
  await page.waitForFunction(() => window.__historyStore.getState().editorView?.getValue() === '暂时离开');
  await state(id => window.__historyStore.getState().setActiveTab(id), visualTab);
  await page.waitForFunction(() => window.__historyStore.getState().editorView?.getValue() === '可视标签改');
  await action('undo');
  assert.equal(await text(), '可视标签', 'WYSIWYG history survives tab switches');
  await setMode('split');
  await edit('菜单修改');
  await page.getByRole('button', { name: '功能', exact: true }).click();
  await page.getByText('撤销', { exact: true }).last().click();
  assert.equal(await text(), '可视标签', 'application menu uses the shared history');

  await setMode('wysiwyg');
  await addTab('外部前');
  await page.waitForFunction(() => window.__historyStore.getState().editorView?.getValue() === '外部前');
  await state(() => {
    const app = window.__historyStore.getState();
    app.setContent('外部后');
    app.setMode('split');
  });
  await page.waitForFunction(() => window.__historyStore.getState().mode === 'split' && window.__historyStore.getState().editorView?.getValue() === '外部后');
  await action('undo');
  assert.equal(await text(), '外部前', 'external updates stay undoable even when the mode changes immediately');
  await action('redo');
  assert.equal(await text(), '外部后');

  await setMode('wysiwyg');
  await addTab('未提交');
  await page.waitForFunction(() => window.__historyStore.getState().editorView?.getValue() === '未提交');
  await state(() => { const editor = window.__historyStore.getState().editorView; editor.setSelection(3); editor.focus(); });
  await page.keyboard.insertText('X');
  await state(() => {
    const app = window.__historyStore.getState();
    app.setContent('外部替换');
    app.setMode('split');
  });
  await page.waitForFunction(() => window.__historyStore.getState().mode === 'split' && window.__historyStore.getState().editorView?.getValue() === '外部替换');
  await action('undo');
  assert.equal(await text(), '未提交X', 'pending input remains recoverable after an external replacement and mode switch');
  await action('undo');
  assert.equal(await text(), '未提交');
  await state(() => {
    const app = window.__historyStore.getState();
    app.setContent('立即外部修改');
    app.editorView.undo();
  });
  assert.equal(await state(() => window.__historyStore.getState().content), '立即外部修改', 'undo must not overwrite an external update before the view catches up');
  await page.waitForFunction(() => window.__historyStore.getState().editorView?.getValue() === '立即外部修改');
  await action('undo');
  assert.equal(await text(), '未提交');
  await setMode('wysiwyg');
  await addTab('单次外部更改前');
  await page.waitForFunction(() => window.__historyStore.getState().editorView?.getValue() === '单次外部更改前');
  await state(() => window.__historyStore.getState().setContent('单次外部更改后'));
  await page.waitForFunction(() => window.__historyStore.getState().editorView?.getValue() === '单次外部更改后');
  await action('undo');
  assert.equal(await text(), '单次外部更改前');
  await action('undo');
  assert.equal(await text(), '单次外部更改前', 'external synchronization must not create duplicate history steps');
  await action('redo');
  assert.equal(await text(), '单次外部更改后');

  await addTab('无变化');
  await page.waitForFunction(() => window.__historyStore.getState().editorView?.getValue() === '无变化');
  await edit('修改');
  await action('undo');
  await state(() => window.__historyStore.getState().editorView.replaceRange(0, 3, '无变化'));
  await setMode('split');
  await action('redo');
  assert.equal(await text(), '无变化修改', 'an identical replacement must retain cross-mode redo');

  // A menu click must retain the input that owns the undo operation.
  await page.getByRole('button', { name: '搜索当前文档', exact: true }).click();
  const query = page.getByRole('textbox', { name: '查找正文内容', exact: true });
  await query.click();
  await page.keyboard.insertText('query');
  await page.getByRole('button', { name: '功能', exact: true }).click();
  await page.getByText('撤销', { exact: true }).last().click();
  assert.equal(await text(), '无变化修改', 'undo in a search input must not change the document');
  assert.equal(await query.inputValue(), '', 'the search input owns this undo');
  await page.getByRole('button', { name: '功能', exact: true }).click();
  await page.getByText('重做', { exact: true }).last().click();
  assert.equal(await query.inputValue(), 'query');
  assert.deepEqual(errors, []);
  console.log('Cross-mode undo, redo, cursor transfer and per-tab reading position passed.');
} finally { await browser.close(); }
