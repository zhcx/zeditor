import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const results = [];
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const state = fn => page.evaluate(expression => new Function('s', `return (${expression})(s)`)(window.__notesStore.getState()), fn.toString());
const source = () => state(s => s.editorView.getValue());
const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const doc = async (content, name = `note-${Date.now()}`) => {
  await page.mouse.move(0, 0);
  await page.evaluate(({ content, name }) => window.__notesStore.getState().addTab({ title: `${name}.md`, path: `web://notes/${name}.md`, content }), { content, name });
  await page.waitForFunction(content => window.__notesStore.getState().editorView?.getValue() === content && document.querySelector('.wysiwyg-block'), content);
};
const caret = async (selector, offset) => page.locator(selector).first().evaluate((host, offset) => {
  host.closest('[contenteditable="true"]')?.focus();
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let node;
  while ((node = walker.nextNode())) nodes.push(node);
  const target = offset === 'end' ? nodes.at(-1) : nodes[0];
  const range = document.createRange();
  range.setStart(target, offset === 'end' ? target.textContent.length : offset);
  range.collapse(true);
  document.getSelection().removeAllRanges();
  document.getSelection().addRange(range);
}, offset);
try {
  await mkdir('test-output', { recursive: true });
  await page.goto(process.env.ZEDITOR_TEST_URL || 'http://127.0.0.1:1425');
  await page.locator('.open-editor-row').first().waitFor();
  await page.evaluate(async () => {
    const app = await (await fetch('/src/App.tsx')).text();
    window.__notesStore = (await import(app.match(/from ["']([^"']*appStore[.]ts[^"']*)["']/)[1])).useAppStore;
    const s = window.__notesStore.getState();
    s.setSettings({ ...s.settings, editor: { ...s.settings.editor, mode: 'wysiwyg' } });
    s.setMode('wysiwyg');
  });
  await doc('正文[^n]。\n\n[^n]: 定义');
  assert.equal(await page.locator('.footnote-ref').getAttribute('data-footnote-content'), '定义');
  assert.equal(await page.locator('.wysiwyg-block').filter({ hasText: '[^n]: 定义' }).count(), 1);
  await page.locator('.footnote-ref').hover();
  await page.locator('.footnote-popover').waitFor();
  assert.match(await page.locator('.footnote-popover').textContent(), /定义/);
  assert.doesNotMatch(await page.locator('.footnote-popover').textContent(), /未找到/);
  await page.mouse.move(0, 0);
  await page.locator('.footnote-popover').waitFor({ state: 'detached' });
  const definition = page.locator('.wysiwyg-block').filter({ hasText: '[^n]: 定义' });
  await definition.evaluate(host => {
    host.focus();
    const range = document.createRange(); range.selectNodeContents(host); range.collapse(false);
    document.getSelection().removeAllRanges(); document.getSelection().addRange(range);
  });
  await page.keyboard.insertText('更新');
  assert.match(await source(), /\[\^n\]: 定义更新/);
  await page.locator('.footnote-ref').hover();
  await page.locator('.footnote-popover').waitFor();
  assert.match(await page.locator('.footnote-popover').textContent(), /定义更新/);
  results.push({ name: 'WYS footnote definition remains editable and hover reads current full-document definition', pass: true });

  await doc('[^my_note]: definition');
  await caret('.wysiwyg-block', 'end');
  await page.keyboard.press('Enter');
  assert.equal(await source(), '[^my_note]: definition\n\n');
  await state(s => s.editorView.undo());
  assert.equal(await source(), '[^my_note]: definition');
  results.push({ name: 'Enter and undo preserve the full syntax and identifier of a single-line definition', pass: true });

  for (const continuation of ['    continued', '\tcontinued', '\n    continued']) {
    const original = `正文[^n]\n\n[^n]: first\n${continuation}`;
    await doc(original);
    const block = page.locator('.wysiwyg-block').filter({ hasText: '[^n]: first' });
    assert.equal(await block.getAttribute('contenteditable'), 'false');
    const shell = block.locator('..');
    await frames();
    await shell.hover();
    await shell.locator('.wysiwyg-block-handle').click();
    await page.getByRole('menuitem', { name: '编辑块源码', exact: true }).click();
    const editor = page.locator('.wysiwyg-source-editor');
    await editor.fill(`[^n]: edited\n${continuation}`);
    await page.keyboard.press('Control+Enter');
    assert.equal(await source(), `正文[^n]\n\n[^n]: edited\n${continuation}`);
  }
  results.push({ name: 'multiline footnote editing preserves space, tab and blank-line continuation syntax', pass: true });

  await doc('前文 \n\n[^n]: 动态定义');
  await caret('.wysiwyg-block', 'end');
  await page.keyboard.insertText('引用[^n]');
  await page.locator('.footnote-ref').waitFor();
  await page.locator('.footnote-ref').hover();
  await page.locator('.footnote-popover').waitFor();
  assert.match(await page.locator('.footnote-popover').textContent(), /动态定义/);
  assert.match(await source(), /引用\[\^n\]/);
  results.push({ name: 'newly typed footnotes receive delegated hover behavior without rebuilding the editable block', pass: true });

  await doc('# First\n\n目标一', 'First');
  await doc('# Second\n\n目标二', 'Second');
  await doc('[[First]][[Second]]', 'Origin');
  await page.locator('.wiki-link').nth(1).click({ modifiers: ['Control'] });
  await page.waitForFunction(() => window.__notesStore.getState().currentFile === 'web://notes/Second.md');
  assert.equal(await source(), '# Second\n\n目标二');
  results.push({ name: 'Ctrl-click on adjacent Wiki links opens the clicked target rather than the preceding link', pass: true });

  for (const offset of [0, 'end']) {
    await doc('[[Second]]');
    await caret('.wiki-link', offset);
    await page.keyboard.press('Enter');
    const updated = await source();
    assert.equal((updated.match(/\[\[Second\]\]/g) ?? []).length, 1, updated);
    assert.equal(updated, offset === 0 ? '\n\n[[Second]]' : '[[Second]]\n\n');
    await state(s => s.editorView.undo());
    assert.equal(await source(), '[[Second]]');
  }
  results.push({ name: 'Enter at either Wiki boundary does not duplicate the atom and undo restores source', pass: true });

  await doc('prefix');
  await caret('.wysiwyg-block', 'end');
  await page.keyboard.insertText(' [[Second]]');
  await page.keyboard.press('Enter');
  assert.equal(await source(), 'prefix [[Second]]\n\n');
  await doc('**[[Second]]**');
  await state(s => { s.editorView.setSelection(0); s.editorView.focus(); });
  await page.keyboard.press('Enter');
  assert.equal(((await source()).match(/\[\[Second\]\]/g) ?? []).length, 1);
  results.push({ name: 'newly typed and formatted Wiki atoms keep valid caret and structural editing boundaries', pass: true });

  await doc('[[First]][^n]\n\n[^n]: 说明');
  await page.locator('.footnote-ref').click();
  await page.locator('.inline-popup').waitFor();
  assert.match(await page.locator('.inline-popup').textContent(), /脚注|引用/);
  await page.keyboard.press('Escape');
  await caret('.footnote-ref', 'end');
  await page.keyboard.press('Enter');
  assert.equal(((await source()).match(/\[\^n\]/g) ?? []).length, 2);
  results.push({ name: 'adjacent footnote clicks resolve the footnote and structural Enter keeps exactly one reference', pass: true });

  await doc('# Previous\n\n正文\n\n# Empty');
  await caret('.wysiwyg-block[data-block-index="2"]', 'end');
  await page.keyboard.press('Control+Alt+[');
  assert.equal(await page.locator('.wysiwyg-fold-toggle').first().getAttribute('aria-expanded'), 'true');
  results.push({ name: 'fold shortcut on an empty heading does not collapse the preceding unrelated section', pass: true });
  await frames();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(results, null, 2));
} finally {
  await page.screenshot({ path: 'test-output/notes-stability.png' }).catch(() => {});
  await writeFile('test-output/notes-stability-results.json', JSON.stringify({ results, errors }, null, 2));
  await browser.close();
}
