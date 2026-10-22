import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// 可选的浏览器回归：先启动开发服务器，运行环境需提供 Playwright。
// PLAYWRIGHT_MODULE_PATH 可指向已有 Playwright 的 index.mjs，不改项目依赖。
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const browser = await chromium.launch({
  channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
const results = [];
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.ZEDITOR_TEST_URL || 'http://127.0.0.1:5199/');
  await page.locator('.mode-chooser-card').filter({ hasText: '所见即所得' }).click();
  await page.waitForSelector('.wysiwyg-block');
  const setDocument = async source => {
    const id = await page.evaluate(async text => {
      const { useAppStore } = await import('/src/stores/appStore.ts');
      return useAppStore.getState().addTab({ content: text });
    }, source);
    await page.waitForFunction(async ({ id, source }) => {
      const { useAppStore } = await import('/src/stores/appStore.ts');
      const state = useAppStore.getState();
      return state.activeTabId === id && state.editorView?.getValue() === source
        && document.querySelector('.wysiwyg-block');
    }, { id, source });
    return id;
  };
  const getSource = () => page.evaluate(async () => {
    const { useAppStore } = await import('/src/stores/appStore.ts');
    return useAppStore.getState().editorView.getValue();
  });
  const test = async (name, run) => {
    if (process.env.WYSIWYG_TEST_FILTER && !name.includes(process.env.WYSIWYG_TEST_FILTER)) return;
    try { await run(); results.push({ name, pass: true }); }
    catch (error) { results.push({ name, pass: false, error: error.message }); }
  };
  const caretIn = async (locator, text, offset) => locator.evaluate((host, { text, offset }) => {
    host.closest('[contenteditable="true"]')?.focus();
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode()) && !node.textContent.includes(text)) { /* 查找正文文本节点。 */ }
    if (!node) throw new Error(`Text not found: ${text}`);
    const range = document.createRange();
    range.setStart(node, node.textContent.indexOf(text) + offset);
    range.collapse(true);
    document.getSelection().removeAllRanges();
    document.getSelection().addRange(range);
  }, { text, offset });
  await test('line editing: Enter at the end accepts typing on the following line immediately', async () => {
    await setDocument('');
    await page.locator('.wysiwyg-block').first().click();
    await page.keyboard.insertText('第一行');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('第二行');
    assert.equal(await getSource(), '第一行\n第二行');
    for (let cycle = 0; cycle < 3; cycle++) {
      await page.locator('.status-view-state').click();
      await page.waitForSelector('.monaco-editor');
      assert.equal(await getSource(), '第一行\n第二行');
      await page.locator('.status-view-state').click();
      await page.waitForSelector('.wysiwyg-block');
      assert.equal(await getSource(), '第一行\n第二行');
    }
  });
  await test('line editing: repeated Enter creates exactly one source newline per key', async () => {
    await setDocument('第一行');
    await caretIn(page.locator('.wysiwyg-block').first(), '第一行', 3);
    for (let line = 0; line < 4; line++) await page.keyboard.press('Enter');
    await page.keyboard.insertText('最后一行');
    assert.equal(await getSource(), '第一行\n\n\n\n最后一行');
  });
  await test('line editing: editing rendered soft breaks never doubles LF or CRLF', async () => {
    for (const eol of ['\n', '\r\n']) {
      await setDocument(`第一行${eol}第二行`);
      await caretIn(page.locator('.wysiwyg-block').first(), '第二行', 3);
      await page.keyboard.insertText('修改');
      assert.equal(await getSource(), `第一行${eol}第二行修改`);
    }
  });
  await test('line editing: editing two blocks before the debounce preserves both edits', async () => {
    await setDocument('alpha\n\nbeta');
    await caretIn(page.locator('.wysiwyg-block').first(), 'alpha', 5);
    await page.keyboard.insertText('X');
    await caretIn(page.locator('.wysiwyg-block').last(), 'beta', 4);
    await page.keyboard.insertText('Y');
    assert.equal(await getSource(), 'alphaX\n\nbetaY');
  });
  await test('line editing: document focus has no browser outline', async () => {
    await setDocument('正文');
    await page.locator('.wysiwyg-block').first().click();
    const outline = await page.locator('.wysiwyg-document').evaluate(host => {
      const style = getComputedStyle(host);
      return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
    });
    assert.ok(outline.style === 'none' || outline.width === 0, JSON.stringify(outline));
  });
  await test('line editing: native mouse selection copies across blocks', async () => {
    await setDocument('alpha\n\nbeta');
    const first = await page.locator('.wysiwyg-block').first().boundingBox();
    const last = await page.locator('.wysiwyg-block').last().boundingBox();
    const firstLine = await page.locator('.wysiwyg-block').first().evaluate(host => Number.parseFloat(getComputedStyle(host.querySelector('p')).lineHeight));
    await page.mouse.move(first.x + 1, first.y + firstLine / 2);
    await page.mouse.down();
    await page.mouse.move(last.x + 45, last.y + last.height / 2, { steps: 12 });
    await page.mouse.up();
    const selected = await page.evaluate(() => document.getSelection().toString());
    assert.match(selected, /alpha/);
    assert.match(selected, /beta/);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.keyboard.press('Control+c');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(copied, /alpha/);
    assert.match(copied, /beta/);
  });
  await test('line editing: mid-paragraph Enter and blank-line typing preserve exact source', async () => {
    await setDocument('alphabeta');
    await caretIn(page.locator('.wysiwyg-block').first(), 'alphabeta', 5);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.insertText('X');
    assert.equal(await getSource(), 'alpha\nX\nbeta');
  });
  await test('line editing: heading Enter, Shift+Enter and Backspace keep usable caret positions', async () => {
    await setDocument('## 标题');
    await caretIn(page.locator('.wysiwyg-block').first(), '标题', 2);
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('正文');
    assert.equal(await getSource(), '## 标题\n正文');
    await setDocument('前后');
    await caretIn(page.locator('.wysiwyg-block').first(), '前后', 1);
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.insertText('中');
    assert.equal(await getSource(), '前\n中后');
    await page.keyboard.press('Home');
    await page.keyboard.press('Backspace');
    assert.equal(await getSource(), '前中后');
  });
  await test('line editing: CRLF Enter and input after a blank document retain line positions', async () => {
    await setDocument('第一行\r\n第二行');
    await caretIn(page.locator('.wysiwyg-block').first(), '第二行', 3);
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('第三行');
    assert.equal(await getSource(), '第一行\r\n第二行\r\n第三行');
    await setDocument('前段\r\n\r\n后段');
    await caretIn(page.locator('.wysiwyg-block').last(), '后段', 0);
    await page.keyboard.press('Backspace');
    assert.equal(await getSource(), '前段\r\n后段');
    await setDocument('');
    await page.locator('.wysiwyg-block').first().click();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('正文');
    assert.equal(await getSource(), '\n\n正文');
  });
  await test('line editing: clicking the document whitespace focuses the end without adding blank lines', async () => {
    await setDocument('正文');
    const block = await page.locator('.wysiwyg-block').first().boundingBox();
    await page.mouse.click(block.x + 50, block.y + block.height + 90);
    assert.equal(await getSource(), '正文');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('下一行');
    assert.equal(await getSource(), '正文\n下一行');
  });
  await test('line editing: replacing a cross-block selection keeps source and DOM in sync', async () => {
    await setDocument('alpha\n\nbeta');
    await caretIn(page.locator('.wysiwyg-block').first(), 'alpha', 0);
    await page.keyboard.press('Control+Shift+End');
    assert.match(await page.evaluate(() => document.getSelection().toString()), /beta/);
    await page.keyboard.type('replacement');
    assert.equal(await getSource(), 'replacement');
    assert.equal(await page.locator('.wysiwyg-document').innerText(), 'replacement');
  });
  await test('line editing: cross-block cut keeps plaintext line breaks and can undo', async () => {
    await setDocument('alpha\n\nbeta');
    await caretIn(page.locator('.wysiwyg-block').first(), 'alpha', 0);
    await page.keyboard.press('Control+Shift+End');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.keyboard.press('Control+x');
    assert.equal(await getSource(), '');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(copied, /alpha[\r\n]+beta/);
    await page.keyboard.press('Control+z');
    assert.equal(await getSource(), 'alpha\n\nbeta');
    await caretIn(page.locator('.wysiwyg-block').first(), 'alpha', 0);
    await page.keyboard.press('Control+Shift+End');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('替换');
    assert.equal(await getSource(), '\n替换');
  });
  await test('line editing: composition replacing a cross-block selection preserves only the new text', async () => {
    await setDocument('alpha\n\nbeta');
    await caretIn(page.locator('.wysiwyg-block').first(), 'alpha', 0);
    await page.keyboard.press('Control+Shift+End');
    await page.locator('.wysiwyg-document').dispatchEvent('compositionstart');
    await page.keyboard.insertText('中文');
    await page.locator('.wysiwyg-document').dispatchEvent('compositionend', { data: '中文' });
    assert.equal(await getSource(), '中文');
  });
  await test('line editing: Delete cannot natively merge a heading or list outside the block model', async () => {
    for (const suffix of ['## beta', '- beta']) {
      const source = `alpha\n${suffix}`;
      await setDocument(source);
      await caretIn(page.locator('.wysiwyg-block').first(), 'alpha', 5);
      await page.keyboard.press('Delete');
      assert.equal(await getSource(), source);
      assert.equal(await page.locator('.wysiwyg-block').count(), 2);
      assert.equal(await page.locator('.wysiwyg-block').first().innerText(), 'alpha');
    }
  });
  await test('line editing: native IME replaces a partial cross-block selection without losing its neighbors', async () => {
    await setDocument('alpha\n\nbeta');
    await page.locator('.wysiwyg-document').evaluate(host => {
      host.focus();
      const paragraphs = host.querySelectorAll('.wysiwyg-block p');
      const range = document.createRange();
      range.setStart(paragraphs[0].firstChild, 2);
      range.setEnd(paragraphs[1].firstChild, 2);
      const selection = document.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    const ime = await page.context().newCDPSession(page);
    try {
      await ime.send('Input.imeSetComposition', { text: '拼', selectionStart: 1, selectionEnd: 1 });
      await ime.send('Input.insertText', { text: '拼音' });
      await page.waitForTimeout(300);
      assert.equal(await getSource(), 'al拼音ta');
      assert.equal(await page.locator('.wysiwyg-block').innerText(), 'al拼音ta');
    } finally { await ime.detach(); }
  });
  await test('table arrows move only at cell edges and can leave the table', async () => {
    await setDocument('前段\n\n| A | B |\n| --- | --- |\n| abc | def |\n\n后段');
    const cell = page.locator('.wysiwyg-block td').first();
    await caretIn(cell, 'abc', 1);
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'abc');
    await caretIn(cell, 'abc', 3);
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'def');
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'B');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowDown');
    assert.match(await page.evaluate(() => document.activeElement.textContent), /后段/);
  });
  await test('Tab indents only the active list item and Shift+Tab restores it', async () => {
    await setDocument('- 甲\n- 乙\n  - 子项\n- 丙');
    await caretIn(page.locator('.wysiwyg-block'), '乙', 1);
    await page.keyboard.press('Tab');
    assert.equal(await getSource(), '- 甲\n  - 乙\n    - 子项\n- 丙');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await getSource(), '- 甲\n- 乙\n  - 子项\n- 丙');
  });
  await test('nested quotes and multi-paragraph list items are editable without content loss', async () => {
    await setDocument('> 外层\n>\n> > 内层\n\n- 第一段\n\n  第二段\n- 下一项');
    assert.deepEqual(await page.locator('.wysiwyg-block').evaluateAll(nodes => nodes.map(node => node.contentEditable)), ['true', 'true']);
    await caretIn(page.locator('.wysiwyg-block').first(), '内层', 2);
    await page.keyboard.insertText('修改');
    assert.match(await getSource(), /> > 内层修改/);
    await caretIn(page.locator('.wysiwyg-block').last(), '第二段', 3);
    await page.keyboard.insertText('修改');
    const source = await getSource();
    assert.match(source, /第一段\n\n  第二段修改/);
    assert.match(source, /- 下一项/);
  });
  await test('underscore markers render at valid boundaries and keep word-internal underscores', async () => {
    await setDocument('正文');
    await caretIn(page.locator('.wysiwyg-block'), '正文', 2);
    await page.keyboard.type(' __bold__');
    assert.equal(await page.locator('.wysiwyg-block strong').innerText({ timeout: 2000 }), 'bold');
    await setDocument('文件');
    await caretIn(page.locator('.wysiwyg-block'), '文件', 2);
    await page.keyboard.type('_name_');
    assert.equal(await page.locator('.wysiwyg-block em').count(), 0);
  });
  await test('triple emphasis and different nested inline formats keep their structure', async () => {
    await setDocument('开始');
    await caretIn(page.locator('.wysiwyg-block'), '开始', 2);
    await page.keyboard.type(' ***mix***');
    assert.equal(await page.locator('.wysiwyg-block em strong').innerText({ timeout: 2000 }), 'mix');
    await setDocument('**外层**');
    await caretIn(page.locator('.wysiwyg-block strong'), '外层', 2);
    await page.keyboard.type(' *内层*');
    assert.equal(await page.locator('.wysiwyg-block strong em').innerText({ timeout: 2000 }), '内层');
    assert.equal(await getSource(), '**外层 *内层***');
  });
  await test('modified table arrows keep native text selection', async () => {
    await setDocument('| A | B |\n| --- | --- |\n| abc | def |');
    await caretIn(page.locator('.wysiwyg-block td').first(), 'abc', 1);
    await page.keyboard.press('Shift+ArrowRight');
    assert.equal(await page.evaluate(() => document.getSelection().toString()), 'b');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'abc');
  });
  await test('Enter inside nested quotes and quoted lists preserves context and exits one level', async () => {
    await setDocument('> > 内层');
    await caretIn(page.locator('.wysiwyg-block'), '内层', 2);
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('新段');
    assert.match(await getSource(), /> > 内层\n> >\n> > 新段/);
    await setDocument('> - 项');
    await caretIn(page.locator('.wysiwyg-block'), '项', 1);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('引用正文');
    const source = await getSource();
    assert.match(source, /> - 项/);
    assert.match(source, /> 引用正文/);
    assert.doesNotMatch(source, /> - 引用正文/);
  });
  await test('enhanced nested quote/list DOM round-trips without hiding quoted subtrees', async () => {
    for (const source of ['- > quote\n  >\n  > second', '> - parent\n>   > quote\n>   >\n>   > second']) {
      await setDocument(source);
      await caretIn(page.locator('.wysiwyg-block'), 'quote', 5);
      await page.keyboard.insertText('X');
      const updated = await getSource();
      assert.match(updated, /quoteX/);
      assert.match(updated, /second/);
      assert.equal(await page.locator('.preview-list-item-content .preview-list-item-content').count(), 0);
    }
  });
  await test('horizontal arrows leave lists and quotes despite renderer whitespace', async () => {
    for (const source of ['- item\n\nafter', '> item\n\nafter']) {
      await setDocument(source);
      await caretIn(page.locator('.wysiwyg-block').first(), 'item', 4);
      await page.keyboard.press('ArrowRight');
      await page.keyboard.insertText('X');
      assert.match(await getSource(), /\n\nXafter$/);
    }
  });
  await test('quoted-list Tab keeps the quote boundary and can undo its indentation', async () => {
    await setDocument('> - 甲\n> - 乙\n> - 丙');
    await caretIn(page.locator('.wysiwyg-block'), '乙', 1);
    await page.keyboard.press('Tab');
    assert.equal(await getSource(), '> - 甲\n>   - 乙\n> - 丙');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await getSource(), '> - 甲\n> - 乙\n> - 丙');
  });
  await test('vertical arrows leave the last visual line even before the source ends', async () => {
    const text = 'word '.repeat(50);
    await setDocument(text + '\n\n下一段');
    const block = page.locator('.wysiwyg-block').first();
    await block.evaluate(host => { host.style.width = '240px'; });
    await caretIn(block, text.trimEnd(), text.trimEnd().length - 2);
    await page.keyboard.press('ArrowDown');
    assert.match(await page.evaluate(() => document.activeElement.textContent), /下一段/);
  });
  await test('clicking display math opens the formula editor and writes back', async () => {
    await setDocument('$$\nx^2\n$$');
    await page.locator('.katex-block').click();
    assert.equal(await page.locator('.inline-popup textarea').count(), 1);
    await page.locator('.inline-popup textarea').fill('y^3');
    await page.locator('.inline-popup-button.primary').click();
    assert.equal(await getSource(), '$$\ny^3\n$$');
  });
  await test('proofread highlights preserve source and clear when results become stale', async () => {
    await setDocument('错字在这里');
    await page.evaluate(async () => {
      const { useAppStore } = await import('/src/stores/appStore.ts');
      const { useAIStore } = await import('/src/stores/aiStore.ts');
      const state = useAppStore.getState();
      useAIStore.setState({ proofreadSnapshot: { activeTabId: state.activeTabId, content: state.content }, proofreadResults: [{ from: 0, to: 2, original: '错字', suggestion: '正字', type: 'spelling', explanation: '测试' }] });
    });
    await page.waitForFunction(() => CSS.highlights.get('wysiwyg-proofread')?.size === 1);
    assert.equal(await getSource(), '错字在这里');
    await caretIn(page.locator('.wysiwyg-block'), '错字在这里', 0);
    await page.keyboard.insertText('新');
    await getSource();
    await page.waitForFunction(() => !CSS.highlights.has('wysiwyg-proofread'));
  });
  await test('ordered list starts and Enter continues current item', async () => {
    await setDocument('7. 第一项\n8. 第二项');
    await page.locator('.wysiwyg-block li').last().click();
    await page.keyboard.press('End');
    await page.keyboard.type('x');
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    assert.equal(await getSource(), '7. 第一项\n8. 第二项x\n9. ');
  });
  await test('nested list Enter stays nested', async () => {
    await setDocument('- 父项\n  1. 子项\n  2. 子二');
    await page.locator('.wysiwyg-block li').last().click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    assert.match(await getSource(), /\n  3\. $/);
  });
  await test('editing a parent item preserves every mixed child list', async () => {
    await setDocument('- Parent\n  - Child A\n\n  1. Child B');
    await page.locator('.wysiwyg-block li').first().evaluate(item => {
      const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
      let text;
      while ((text = walker.nextNode()) && !text.textContent.includes('Parent')) { /* 找到父项正文，略过渲染空白与包装层。 */ }
      if (!text) throw new Error('Parent text not found');
      const range = document.createRange();
      range.setStart(text, text.textContent.indexOf('Parent') + 6);
      range.collapse(true);
      item.closest('[contenteditable="true"]').focus();
      const selection = document.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.keyboard.insertText('X');
    const source = await getSource();
    assert.match(source, /^- +ParentX/);
    assert.match(source, /Child A/);
    assert.match(source, /Child B/);
  });
  await test('code trailing Enter and text survive edit completion', async () => {
    await setDocument('```ts\nconst x = 1;\n```');
    await page.locator('.wysiwyg-block[data-block-kind="fence"]').click();
    await page.locator('.wysiwyg-code-editor').focus();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('next');
    assert.equal(await page.locator('.wysiwyg-code-editor').inputValue(), 'const x = 1;\n\nnext');
    await page.keyboard.press('Escape');
    assert.equal(await getSource(), '```ts\nconst x = 1;\n\nnext\n```');
  });
  await test('CRLF code exposes only code body', async () => {
    await setDocument('```ts\r\nconst x = 1;\r\n```');
    await page.locator('.wysiwyg-block[data-block-kind="fence"]').click();
    assert.equal(await page.locator('.wysiwyg-code-editor').inputValue(), 'const x = 1;');
  });
  await test('unrelated blocks retain DOM on blur and structural Enter', async () => {
    await setDocument(Array.from({ length: 80 }, (_, i) => `段落 ${i}`).join('\n\n'));
    await page.evaluate(() => { window.untouchedNode = document.querySelectorAll('.wysiwyg-block')[20].firstChild; });
    await caretIn(page.locator('.wysiwyg-block').first(), '段落 0', 4);
    await page.keyboard.type('x');
    await page.waitForTimeout(300);
    await page.locator('.wysiwyg-block').nth(1).click();
    assert.equal(await page.evaluate(() => window.untouchedNode === document.querySelectorAll('.wysiwyg-block')[20].firstChild), true);
    await page.locator('.wysiwyg-block').last().click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.untouchedNode === document.querySelectorAll('.wysiwyg-block')[20].firstChild), true);
  });
  await test('arrow navigation flushes immediate typing without misplacing next text', async () => {
    await setDocument('## abc\n\nxyz');
    await caretIn(page.locator('.wysiwyg-block').first(), 'abc', 3);
    await page.keyboard.type('X');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('Y');
    assert.equal(await getSource(), '## abcX\n\nYxyz');
  });
  await test('undo and redo preserve source and restored DOM', async () => {
    await setDocument('初始');
    await page.locator('.wysiwyg-block').click();
    await page.keyboard.press('End');
    await page.keyboard.insertText('文字');
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Control+z');
    assert.equal(await getSource(), '初始文字');
    await page.keyboard.press('Control+z');
    assert.equal(await getSource(), '初始');
    await page.keyboard.press('Control+Shift+z');
    assert.equal(await getSource(), '初始文字');
    assert.equal(await page.locator('.wysiwyg-block').innerText(), '初始文字');
  });
  await test('undo before debounce restores DOM as well as source', async () => {
    await setDocument('初始');
    await page.locator('.wysiwyg-block').click();
    await page.keyboard.press('End');
    await page.keyboard.insertText('文字');
    await page.keyboard.press('Control+z');
    assert.equal(await getSource(), '初始');
    assert.equal(await page.locator('.wysiwyg-block').innerText(), '初始');
    await page.keyboard.insertText('新');
    assert.equal(await getSource(), '初始新');
  });
  await test('compositionend schedules the final IME input', async () => {
    await setDocument('开始');
    const block = page.locator('.wysiwyg-block');
    await block.click();
    await page.keyboard.press('End');
    await block.dispatchEvent('compositionstart');
    await page.keyboard.insertText('中文');
    await block.dispatchEvent('compositionend');
    await page.waitForTimeout(300);
    assert.equal(await getSource(), '开始中文');
  });
  await test('switching tabs before debounce preserves visible input', async () => {
    const previous = await setDocument('旧标签');
    await page.locator('.wysiwyg-block').click();
    await page.keyboard.press('End');
    await page.keyboard.insertText('刚输入');
    await setDocument('新标签');
    const text = await page.evaluate(async id => {
      const { useAppStore } = await import('/src/stores/appStore.ts');
      return useAppStore.getState().tabs.find(tab => tab.id === id).content;
    }, previous);
    assert.equal(text, '旧标签刚输入');
  });
  await test('table editing and Tab navigation retain table structure', async () => {
    await setDocument('| A | B |\n| --- | --- |\n| 1 | 2 |\n\n后记');
    await page.locator('.wysiwyg-block td').first().click();
    await page.keyboard.press('End');
    await page.keyboard.insertText('x');
    await page.keyboard.press('Tab');
    await page.keyboard.insertText('y');
    const source = await getSource();
    assert.match(source, /\| 1x \| y \|/);
    assert.match(source, /\n\n后记$/);
  });
  await test('unsupported nested blocks stay readonly with source intact', async () => {
    const source = '> ```ts\n> x\n> ```\n\n- 列表项\n\n      indented code';
    await setDocument(source);
    const editable = await page.locator('.wysiwyg-block').evaluateAll(nodes => nodes.map(node => node.contentEditable));
    assert.deepEqual(editable, ['false', 'false']);
    assert.equal(await getSource(), source);
  });
  await test('inline marker normalization survives blur with stable neighbors', async () => {
    await setDocument('内容\n\n第二段');
    await caretIn(page.locator('.wysiwyg-block').first(), '内容', 2);
    await page.keyboard.type(' **bold**');
    await page.waitForTimeout(300);
    await page.locator('.wysiwyg-block').nth(1).click();
    assert.equal(await page.locator('.wysiwyg-block strong').innerText(), 'bold');
    assert.equal(await getSource(), '内容 **bold**\n\n第二段');
  });
  await test('paragraph height stays stable across Enter and write-back re-render', async () => {
    await setDocument('');
    const shellHeight = index => page.locator('.wysiwyg-block-shell').nth(index).evaluate(node => node.getBoundingClientRect().height);
    await page.locator('.wysiwyg-block').first().click();
    await page.keyboard.type('AAA');
    await page.waitForTimeout(400);
    const typed = await shellHeight(0);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    const afterEnter = await shellHeight(0);
    await page.keyboard.type('BBB');
    await page.waitForTimeout(400);
    assert.equal(await getSource(), 'AAA\nBBB');
    // 输入态与重建后的 <p> 必须同高：此前 21px 会在写回后跳成 25.76px。
    const lineHeight = await page.locator('.wysiwyg-block p').first().evaluate(node => Number.parseFloat(getComputedStyle(node).lineHeight));
    assert.ok(Math.abs(afterEnter - (await shellHeight(0))) < 0.5, 'typing on the new line must not change its height');
    assert.ok(Math.abs(afterEnter - typed - lineHeight) < 0.5, `Enter should add exactly one visual line: ${typed} -> ${afterEnter}`);
  });
  await test('block source editing stays inline and writes back', async () => {
    await setDocument('前段\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n后段');
    const shell = page.locator('.wysiwyg-block-shell').filter({ has: page.locator('.wysiwyg-block[data-block-kind="table"]') });
    await page.locator('.wysiwyg-block[data-block-kind="table"]').hover();
    await shell.locator('.wysiwyg-block-handle').click();
    await shell.locator('.wysiwyg-block-menu button', { hasText: '编辑块源码' }).click();
    const layer = shell.locator('.wysiwyg-source-layer');
    await layer.waitFor({ state: 'visible' });
    assert.equal(await page.locator('.modal-overlay').count(), 0, 'source editing must not open a modal');
    assert.equal(await shell.locator('.wysiwyg-block.is-source-editing').count(), 1, 'rendered block yields to the inline panel');
    await layer.locator('.wysiwyg-source-editor').fill('| A | B |\n| --- | --- |\n| 9 | 8 |');
    await layer.locator('.wysiwyg-source-toolbar button.is-primary').click();
    await page.waitForTimeout(400);
    assert.equal(await shell.locator('.wysiwyg-source-layer').count(), 0);
    assert.match(await getSource(), /\| 9 \| 8 \|/);
  });
  await test('editor tables render like the preview surface', async () => {
    await setDocument('| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |');
    const metrics = await page.locator('.wysiwyg-block[data-block-kind="table"] table').evaluate(table => ({
      display: getComputedStyle(table).display,
      collapse: getComputedStyle(table).borderCollapse,
      width: table.getBoundingClientRect().width,
      columnWidth: table.closest('.wysiwyg-document').getBoundingClientRect().width,
    }));
    assert.equal(metrics.display, 'inline-table');
    assert.equal(metrics.collapse, 'collapse');
    assert.ok(metrics.width < metrics.columnWidth - 40, `table should shrink to content width, got ${metrics.width}`);
  });
  assert.deepEqual(errors, [], 'no uncaught page errors');
  if (process.env.WYSIWYG_TEST_OUTPUT) {
    const output = process.env.WYSIWYG_TEST_OUTPUT;
    await mkdir(output, { recursive: true });
    await writeFile(join(output, 'browser-results.json'), JSON.stringify({ results, errors }, null, 2));
    if (results.every(result => result.pass)) {
      const sample = '第一行：回车后可以继续输入\n第二行：切换源码不会增加空行';
      await setDocument(sample);
      await page.evaluate(async () => {
        const { useAppStore } = await import('/src/stores/appStore.ts');
        const { useAIStore } = await import('/src/stores/aiStore.ts');
        const state = useAppStore.getState();
        // 仅清理隔离测试上下文，截图只展示最后一份验证样稿。
        useAppStore.setState({ tabs: state.tabs.filter(tab => tab.id === state.activeTabId), sidebarVisible: true });
        useAIStore.setState({ proofreadPanelVisible: false, proofreadResults: [] });
      });
      await caretIn(page.locator('.wysiwyg-block').first(), '第二行', 3);
      await page.screenshot({ path: join(output, 'wysiwyg.png') });
      await page.locator('.status-view-state').click();
      await page.waitForSelector('.monaco-editor');
      assert.equal(await getSource(), sample);
      await page.screenshot({ path: join(output, 'source.png') });
    }
  }
  console.log(JSON.stringify({ results, errors }, null, 2));
  if (results.some(result => !result.pass)) process.exitCode = 1;
} finally { await browser.close(); }
