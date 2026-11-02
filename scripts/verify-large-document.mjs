// Isolated browser integration: mock only text-file IPC, exercise the real store and UI.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.ZEDITOR_TEST_URL || 'http://127.0.0.1:1425/', { waitUntil: 'domcontentloaded' });
  await page.locator('.mode-chooser-card').filter({ hasText: '所见即所得' }).click();
  await page.waitForFunction(async () => Boolean((await import('/src/stores/appStore.ts')).useAppStore.getState().editorView));
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/stores/appStore.ts');
    window.__largeStore = useAppStore;
    window.__smallTab = useAppStore.getState().addTab({ title: '小文档.md', content: '# 小文档\n\n原始内容', modified: true });
  });
  await page.waitForSelector('.wysiwyg-surface');

  const opened = await page.evaluate(async () => {
    const state = window.__largeStore.getState();
    const original = window.__TAURI_INTERNALS__;
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      if (command === 'read_text_document') return { content: '# 大文档\n\n保持原文。', encoding: 'utf-8', fileVersion: { size: 524288, sha256: 'fixture' } };
      if (command === 'read_file_version') return null;
      throw new Error(`Unexpected fixture command: ${command} ${JSON.stringify(args)}`);
    } };
    const pending = state.openFile('C:\\fixture\\大文档.md');
    if (original === undefined) delete window.__TAURI_INTERNALS__; else window.__TAURI_INTERNALS__ = original;
    await pending;
    const next = window.__largeStore.getState();
    window.__largeTab = next.activeTabId;
    return { mode: next.mode, preference: next.settings.editor.mode, content: next.content, assessment: next.getActiveTab().performance.assessment };
  });
  assert.equal(opened.mode, 'source');
  assert.equal(opened.preference, 'wysiwyg');
  assert.equal(opened.content, '# 大文档\n\n保持原文。');
  assert.ok(opened.assessment.reasons.includes('size'));
  try { await page.locator('.large-document-banner').waitFor({ timeout: 10000 }); }
  catch (error) {
    console.error('UI state:', await page.evaluate(() => ({ mode: window.__largeStore.getState().mode, text: document.body.innerText.slice(0, 2000) })), errors);
    throw error;
  }
  assert.match(await page.locator('.large-document-banner').innerText(), /已启用轻量源码模式/);
  assert.equal(await page.locator('.preview-workspace-pane, .wysiwyg-surface').count(), 0);
  await page.waitForFunction(() => window.__largeStore.getState().editorView?.getValue() === '# 大文档\n\n保持原文。');

  await page.getByRole('button', { name: '切换到默认视图' }).click();
  await page.waitForSelector('.wysiwyg-surface');
  assert.equal(await page.evaluate(() => window.__largeStore.getState().mode), 'wysiwyg');
  await page.getByRole('button', { name: '启用轻量模式' }).click();
  await page.waitForFunction(() => window.__largeStore.getState().mode === 'source');
  await page.evaluate(() => window.__largeStore.getState().setActiveTab(window.__smallTab));
  await page.waitForSelector('.wysiwyg-surface');
  assert.equal(await page.evaluate(() => window.__largeStore.getState().content), '# 小文档\n\n原始内容');
  await page.evaluate(() => window.__largeStore.getState().setActiveTab(window.__largeTab));
  await page.waitForFunction(() => window.__largeStore.getState().mode === 'source');
  assert.equal(await page.evaluate(() => window.__largeStore.getState().settings.editor.mode), 'wysiwyg');
  assert.equal(await page.evaluate(() => window.__largeStore.getState().content), '# 大文档\n\n保持原文。');

  const background = await page.evaluate(async () => {
    const original = window.__TAURI_INTERNALS__;
    let finish;
    window.__TAURI_INTERNALS__ = { invoke: command => command === 'read_text_document'
      ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(null) };
    const pending = window.__largeStore.getState().openFile('C:\\fixture\\较晚打开.md');
    if (original === undefined) delete window.__TAURI_INTERNALS__; else window.__TAURI_INTERNALS__ = original;
    const foreground = window.__largeStore.getState().addTab({ title: '前台.md', content: '继续编辑', modified: true });
    finish({ content: '# 后台大文档', encoding: 'utf-8', fileVersion: { size: 524288, sha256: 'background' } });
    await pending;
    const state = window.__largeStore.getState();
    const tab = state.tabs.find(item => item.path?.endsWith('较晚打开.md'));
    return { foreground, active: state.activeTabId, mode: state.mode, pendingId: tab?.id, lightweight: tab?.performance?.lightweight };
  });
  assert.equal(background.active, background.foreground);
  assert.equal(background.mode, 'wysiwyg');
  assert.equal(background.lightweight, true);
  await page.evaluate(id => window.__largeStore.getState().setActiveTab(id), background.pendingId);
  await page.waitForFunction(() => window.__largeStore.getState().mode === 'source');
  const dense = await page.evaluate(() => {
    const body = Array.from({ length: 1300 }, (_, i) => `# 第 ${i} 节\n\n正文 ${i}\n`).join('\n');
    const id = window.__largeStore.getState().addTab({ title: '密集文稿.md', content: body, modified: true });
    window.__denseText = body;
    const state = window.__largeStore.getState();
    return { id, mode: state.mode, assessment: state.getActiveTab().performance.assessment };
  });
  assert.equal(dense.mode, 'source');
  assert.ok(dense.assessment.reasons.includes('blocks'));
  await page.waitForFunction(() => window.__largeStore.getState().editorView?.getValue() === window.__denseText);
  assert.equal(await page.locator('.preview-workspace-pane, .wysiwyg-surface').count(), 0);
  await page.evaluate(() => {
    const editor = window.__largeStore.getState().editorView;
    editor.replaceRange(0, 0, '新增内容\n');
  });
  await page.evaluate(() => window.__largeStore.getState().setActiveTab(window.__smallTab));
  await page.evaluate(id => window.__largeStore.getState().setActiveTab(id), dense.id);
  await page.waitForFunction(() => window.__largeStore.getState().editorView?.getValue() === `新增内容\n${window.__denseText}`);
  assert.equal(await page.evaluate(() => window.__largeStore.getState().getActiveTab().modified), true);
  assert.deepEqual(errors, []);

  // Opening into an unused tab must not create an undoable edit or mark the file dirty.
  for (const initialMode of ['源码对照', '所见即所得']) {
    const replacement = await browser.newPage();
    await replacement.goto(process.env.ZEDITOR_TEST_URL || 'http://127.0.0.1:1425/', { waitUntil: 'domcontentloaded' });
    await replacement.locator('.mode-chooser-card').filter({ hasText: initialMode }).click();
    await replacement.waitForFunction(async () => Boolean((await import('/src/stores/appStore.ts')).useAppStore.getState().editorView));
    await replacement.evaluate(async () => {
      const { useAppStore } = await import('/src/stores/appStore.ts');
      window.__replacementStore = useAppStore;
      const original = window.__TAURI_INTERNALS__;
      window.__TAURI_INTERNALS__ = { invoke: async () => ({ content: '# 已打开的文档', encoding: 'utf-8', fileVersion: { size: 524288, sha256: 'replacement' } }) };
      const pending = useAppStore.getState().openFile('C:\\fixture\\替换空文档.md');
      if (original === undefined) delete window.__TAURI_INTERNALS__; else window.__TAURI_INTERNALS__ = original;
      await pending;
    });
    await replacement.waitForFunction(() => window.__replacementStore.getState().editorView?.getValue() === '# 已打开的文档');
    assert.equal(await replacement.evaluate(() => window.__replacementStore.getState().getActiveTab().modified), false, initialMode);
    await replacement.evaluate(() => window.__replacementStore.getState().editorView.undo());
    assert.equal(await replacement.evaluate(() => window.__replacementStore.getState().editorView.getValue()), '# 已打开的文档', initialMode);
    await replacement.close();
  }
  console.log('Large-document UI, source preservation, per-tab mode, manual switch and background-open race passed.');
} finally { await browser.close(); }
