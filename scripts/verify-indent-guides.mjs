import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
const results = [];
page.on('pageerror', error => errors.push(error.message));
const state = fn => page.evaluate(async expression => {
  const { useAppStore } = await import('/src/stores/appStore.ts');
  return new Function('s', `return (${expression})(s)`)(useAppStore.getState());
}, fn.toString());
const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
try {
  await mkdir('test-output/indent-guides', { recursive: true });
  await page.goto(process.env.ZEDITOR_TEST_URL || 'http://127.0.0.1:5199/');
  await page.locator('.mode-chooser-card').filter({ hasText: '所见即所得' }).click();
  await state(s => {
    s.setMode('split');
    s.addTab({ content: Array.from({ length: 8 }, (_, i) => `正文${i + 1}`).join('\n') + '\n\n\n ase二\n asdf asdf' });
  });
  await page.locator('.monaco-editor').waitFor();
  await frames();
  assert.equal(await page.locator('.core-guide-indent, .markdown-indent-guide').count(), 0);
  results.push('ordinary spaces and the preceding blank lines have no guides');
  await state(s => s.addTab({ content: '- 父项\n  - ' + '子项'.repeat(40) + '\n    - 孙项\n  - 另一子项\n- 同级项\n\n 普通正文' }));
  await page.waitForFunction(() => document.querySelectorAll('.markdown-indent-guide').length === 2);
  const geometry = await state(s => ({ expectedHeight: s.editorView.getTopForLineNumber(5) - s.editorView.getTopForLineNumber(2) }));
  const rootHeight = await page.locator('.markdown-indent-guide[data-depth="1"]').evaluate(node => node.getBoundingClientRect().height);
  assert.ok(Math.abs(rootHeight - geometry.expectedHeight) < 1, JSON.stringify({ rootHeight, ...geometry }));
  assert.ok(rootHeight > 60, 'guide spans wrapped list content');
  await state(s => { s.editorView.setSelection(s.editorView.line(3).from); s.editorView.focus(); });
  await page.waitForFunction(() => document.querySelectorAll('.markdown-indent-guide.is-active').length === 2);
  const activeColor = await page.locator('.markdown-indent-guide.is-active').first().evaluate(node => getComputedStyle(node).backgroundColor);
  await page.screenshot({ path: 'test-output/indent-guides/source.png' });
  await state(s => s.editorView.setSelection(s.editorView.line(7).from));
  await page.waitForFunction(() => document.querySelectorAll('.markdown-indent-guide.is-active').length === 0);
  await state(s => s.setSettings({ ...s.settings, editor: { ...s.settings.editor, indent_guides: false } }));
  await page.waitForFunction(() => document.querySelectorAll('.markdown-indent-guide').length === 0);
  await state(s => s.setSettings({ ...s.settings, editor: { ...s.settings.editor, indent_guides: true } }));
  await page.waitForFunction(() => document.querySelectorAll('.markdown-indent-guide').length === 2);
  results.push('nested lists show dim guides, active ancestors, wrapping, and immediate toggle updates');
  await state(s => { s.editorView.setSelection(0); s.editorView.focus(); });
  await page.locator('.monaco-editor .codicon-folding-expanded').first().click({ force: true });
  await page.waitForFunction(() => document.querySelectorAll('.markdown-indent-guide').length === 0);
  assert.equal(await page.locator('.markdown-indent-guide').count(), 0, 'folded children have no visible guides');
  await page.locator('.monaco-editor .codicon-folding-collapsed').first().click({ force: true });
  await page.waitForFunction(() => document.querySelectorAll('.markdown-indent-guide').length === 2);
  await state(s => s.setMode('wysiwyg'));
  const nested = page.locator('.wysiwyg-block ul ul');
  await nested.first().waitFor();
  await page.locator('.wysiwyg-block').first().evaluate(host => {
    host.focus();
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode()) && !node.textContent.includes('孙项')) { /* 找到孙项正文。 */ }
    const range = document.createRange();
    range.setStart(node, 0); range.collapse(true);
    document.getSelection().removeAllRanges(); document.getSelection().addRange(range);
  });
  await page.waitForFunction(() => document.querySelectorAll('.wysiwyg-document .is-active-indent-guide').length === 2);
  assert.equal(await nested.last().evaluate(node => getComputedStyle(node).borderLeftWidth), '1px');
  assert.equal(await nested.last().evaluate(node => getComputedStyle(node).borderLeftColor), activeColor);
  await page.screenshot({ path: 'test-output/indent-guides/wysiwyg.png' });
  await state(s => s.setSettings({ ...s.settings, editor: { ...s.settings.editor, indent_guides: false } }));
  await frames();
  assert.equal(await nested.last().evaluate(node => getComputedStyle(node).borderLeftWidth), '0px');
  results.push('WYSIWYG shares guide styling and active ancestry; disabling removes the borders');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ results, errors }, null, 2));
} finally {
  await page.screenshot({ path: 'test-output/indent-guides/last-state.png' }).catch(() => {});
  await writeFile('test-output/indent-guides/results.json', JSON.stringify({ results, errors }, null, 2));
  await browser.close();
}
