import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

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
    await page.locator('.wysiwyg-block').first().click();
    await page.keyboard.press('End');
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
    await setDocument('abc\n\nxyz');
    await page.locator('.wysiwyg-block').first().click();
    await page.keyboard.press('End');
    await page.keyboard.type('X');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('Y');
    assert.equal(await getSource(), 'abcX\n\nYxyz');
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
    await page.locator('.wysiwyg-block').first().click();
    await page.keyboard.press('End');
    await page.keyboard.type(' **bold**');
    await page.waitForTimeout(300);
    await page.locator('.wysiwyg-block').nth(1).click();
    assert.equal(await page.locator('.wysiwyg-block strong').innerText(), 'bold');
    assert.equal(await getSource(), '内容 **bold**\n\n第二段');
  });
  assert.deepEqual(errors, [], 'no uncaught page errors');
  console.log(JSON.stringify({ results, errors }, null, 2));
  if (results.some(result => !result.pass)) process.exitCode = 1;
} finally { await browser.close(); }
