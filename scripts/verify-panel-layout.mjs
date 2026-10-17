import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
const results = [];
const metrics = [];
const output = process.env.PANEL_TEST_OUTPUT || 'test-output/panel-layout';
mkdirSync(output, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.ZEDITOR_TEST_URL || 'http://127.0.0.1:5199/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('.mode-chooser-card').filter({ hasText: '源码对照' }).click();
  await page.waitForFunction(async () => (await import('/src/stores/appStore.ts')).useAppStore.getState().editorView);
  await page.waitForSelector('#boot-splash', { state: 'detached' });
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const app = (fn, arg) => page.evaluate(async ({ fn, arg }) => {
    const { useAppStore } = await import('/src/stores/appStore.ts');
    const { useAIStore } = await import('/src/stores/aiStore.ts');
    return (0, eval)(`(${fn})`)(useAppStore, useAIStore, arg);
  }, { fn: fn.toString(), arg });
  const rect = selector => page.locator(selector).first().boundingBox();
  const drag = async (selector, delta) => {
    const box = await rect(selector);
    const x = box.x + box.width / 2;
    await page.mouse.move(x, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(x + delta, box.y + 100, { steps: 10 });
    await frame();
    const during = await rect(selector);
    await page.mouse.up();
    await frame();
    const after = await rect(selector);
    return { before: x, during: during.x + during.width / 2, after: after.x + after.width / 2 };
  };
  const test = async (name, run) => {
    if (process.env.PANEL_TEST_FILTER && !name.includes(process.env.PANEL_TEST_FILTER)) return;
    try { await run(); results.push({ name, pass: true }); console.log(`PASS ${name}`); }
    catch (error) { results.push({ name, pass: false, error: error.message }); console.log(`FAIL ${name}: ${error.message}`); }
  };
  await test('source starts with equal editor and preview widths', async () => {
    const editor = await rect('.editor-workspace-pane');
    const preview = await rect('.preview-workspace-pane');
    assert.ok(Math.abs(editor.width - preview.width) <= 1, `${editor.width} vs ${preview.width}`);
  });
  await test('default AI width shares available space equally with source and preview', async () => {
    await app((store, ai) => ai.getState().setChatbotVisible(true));
    await page.waitForSelector('.chatbot-side-panel');
    await frame();
    const widths = await Promise.all(['.editor-workspace-pane', '.preview-workspace-pane', '.chatbot-side-panel'].map(async selector => (await rect(selector)).width));
    assert.ok(Math.max(...widths) - Math.min(...widths) <= 2, JSON.stringify(widths));
    await app((store, ai) => ai.getState().setChatbotVisible(false));
    await frame();
  });
  await test('split follows pointer without sidebar offset or release drift', async () => {
    const moved = await drag('.main-content > .divider', 95);
    assert.ok(Math.abs(moved.during - moved.before - 95) <= 2, JSON.stringify(moved));
    assert.ok(Math.abs(moved.after - moved.during) <= 1, JSON.stringify(moved));
  });
  await test('split limits match committed ratio without snapping at either edge', async () => {
    for (const delta of [-2000, 2000]) {
      const moved = await drag('.main-content > .divider', delta);
      assert.ok(Math.abs(moved.after - moved.during) <= 1, JSON.stringify(moved));
    }
    await page.locator('.main-content > .divider').dblclick();
    await frame();
  });
  await test('opening AI preserves document ratio and freely resizing AI stays put', async () => {
    const editor = await rect('.editor-workspace-pane');
    const preview = await rect('.preview-workspace-pane');
    await app((store, ai) => ai.getState().setChatbotVisible(true));
    await page.waitForSelector('.chatbot-side-panel');
    await frame();
    const editorAfter = await rect('.editor-workspace-pane');
    const previewAfter = await rect('.preview-workspace-pane');
    assert.ok(Math.abs(editor.width / preview.width - editorAfter.width / previewAfter.width) <= 0.02);
  });
  await test('AI divider tracks pointer and does not snap back after release', async () => {
    const moved = await drag('.chatbot-divider', -90);
    assert.ok(Math.abs(moved.during - moved.before + 90) <= 2, JSON.stringify(moved));
    assert.ok(Math.abs(moved.after - moved.during) <= 1, JSON.stringify(moved));
  });
  await test('sidebar drag has no jump at pointer down or release', async () => {
    const moved = await drag('.sidebar-divider', 65);
    assert.ok(Math.abs(moved.during - moved.before - 65) <= 2, JSON.stringify(moved));
    assert.ok(Math.abs(moved.after - moved.during) <= 1, JSON.stringify(moved));
  });
  await test('proofread can resize with AI open without moving unrelated panels', async () => {
    await app((store, ai) => ai.setState({ proofreadResults: [{ from: 0, to: 1, original: '文', suggestion: '字', type: 'spelling', explanation: '布局验证' }] }));
    await page.waitForSelector('.proofread-divider');
    await frame();
    const chat = await rect('.chatbot-side-panel');
    const moved = await drag('.proofread-divider', -35);
    assert.ok(Math.abs(moved.during - moved.before + 35) <= 2, JSON.stringify(moved));
    assert.ok(Math.abs(moved.after - moved.during) <= 1, JSON.stringify(moved));
    assert.ok(Math.abs(chat.width - (await rect('.chatbot-side-panel')).width) <= 1);
  });
  await test('all dividers have identical idle and hover geometry', async () => {
    await page.mouse.move(5, 5);
    const selectors = ['.sidebar-divider', '.main-content > .divider', '.proofread-divider', '.chatbot-divider'];
    const styles = await page.evaluate(selectors => selectors.map(selector => {
      const node = document.querySelector(selector);
      const line = getComputedStyle(node, '::after');
      return { width: node.getBoundingClientRect().width, line: line.width, color: line.backgroundColor, top: line.top, bottom: line.bottom, margin: getComputedStyle(node).margin };
    }), selectors);
    styles.forEach(style => assert.deepEqual(style, styles[0]));
    const hoverStyles = [];
    for (const selector of selectors) {
      const box = await rect(selector);
      await page.mouse.move(box.x + box.width / 2, box.y + 100);
      hoverStyles.push(await page.locator(selector).evaluate(node => {
        const line = getComputedStyle(node, '::after');
        return { width: line.width, color: line.backgroundColor };
      }));
    }
    hoverStyles.forEach(style => assert.deepEqual(style, hoverStyles[0]));
    assert.equal(hoverStyles[0].width, '2px');
  });
  await test('sidebar can exceed the former 400px cap without release drift', async () => {
    try {
      const moved = await drag('.sidebar-divider', 110);
      assert.ok((await rect('.sidebar')).width > 400);
      assert.ok(Math.abs(moved.after - moved.during) <= 1, JSON.stringify(moved));
    } finally { await page.locator('.sidebar-divider').dblclick(); await frame(); }
  });
  await test('AI maximum reserves actual document width with proofread open', async () => {
    try {
      const moved = await drag('.chatbot-divider', -1000);
      assert.ok(Math.abs(moved.after - moved.during) <= 1, JSON.stringify(moved));
      assert.ok((await rect('.editor-workspace-pane')).width + (await rect('.preview-workspace-pane')).width >= 239);
    } finally { await page.locator('.chatbot-divider').dblclick(); await frame(); }
  });
  await test('dividers support keyboard resizing and double-click reset', async () => {
    await page.locator('.main-content > .divider').dblclick();
    await frame();
    assert.ok(Math.abs((await rect('.editor-workspace-pane')).width - (await rect('.preview-workspace-pane')).width) <= 1);
    const initial = (await rect('.sidebar')).width;
    await page.locator('.sidebar-divider').focus();
    await page.keyboard.press('ArrowRight');
    await frame();
    assert.ok(Math.abs((await rect('.sidebar')).width - initial - 10) <= 1);
    await page.locator('.sidebar-divider').dblclick();
    await frame();
    assert.equal((await rect('.sidebar')).width, 250);
  });
  await test('quick release commits the last pointer position and cancellation clears drag state', async () => {
    const box = await rect('.chatbot-divider');
    const x = box.x + box.width / 2;
    await page.mouse.move(x, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(x - 25, box.y + 100);
    await page.mouse.up();
    await frame();
    assert.ok(Math.abs((await rect('.chatbot-divider')).x + box.width / 2 - x + 25) <= 2);
    const next = await rect('.chatbot-divider');
    await page.mouse.move(next.x + next.width / 2, next.y + 100);
    await page.mouse.down();
    await page.locator('.chatbot-divider').dispatchEvent('pointercancel', { pointerId: 1 });
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('panel-resizing')), false);
    await page.mouse.up();
  });
  await test('window shrinking keeps documents visible and widening restores preferred widths', async () => {
    const before = (await rect('.chatbot-side-panel')).width;
    await page.setViewportSize({ width: 800, height: 1000 });
    await app(store => store.getState().setSidebarVisible(true));
    await frame();
    const sum = (await rect('.editor-workspace-pane')).width + (await rect('.preview-workspace-pane')).width;
    assert.ok(sum >= 239, `document width ${sum}`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.setViewportSize({ width: 1600, height: 1000 });
    await frame();
    assert.ok(Math.abs((await rect('.chatbot-side-panel')).width - before) <= 1);
  });
  await test('resizing an already fitted panel in a narrow window keeps its release position', async () => {
    try {
      await page.setViewportSize({ width: 800, height: 1000 });
      await app(store => store.getState().setSidebarVisible(true));
      await frame();
      const moved = await drag('.chatbot-divider', 20);
      assert.ok(Math.abs(moved.during - moved.before - 20) <= 2, JSON.stringify(moved));
      assert.ok(Math.abs(moved.after - moved.during) <= 1, JSON.stringify(moved));
    } finally {
      await page.setViewportSize({ width: 1600, height: 1000 });
      await frame();
    }
  });
  await test('WYSIWYG and immersive outline use the same stable resizing behavior', async () => {
    await app(store => store.getState().setMode('wysiwyg'));
    await page.waitForSelector('.wysiwyg-surface');
    await app((store, ai) => ai.setState({ proofreadResults: [{ from: 0, to: 1, original: '文', suggestion: '字', type: 'spelling', explanation: '所见即所得布局验证' }] }));
    await frame();
    assert.equal(await page.locator('.proofread-side-panel').count(), 1, 'WYSIWYG needs the same resizable proofreading panel');
    const proofread = await drag('.proofread-divider', -25);
    assert.ok(Math.abs(proofread.after - proofread.before + 25) <= 2, JSON.stringify(proofread));
    const chat = await drag('.chatbot-divider', 30);
    assert.ok(Math.abs(chat.during - chat.before - 30) <= 2, JSON.stringify(chat));
    assert.ok(Math.abs(chat.after - chat.during) <= 1, JSON.stringify(chat));
    await app(store => store.getState().setMode('immersive'));
    await page.waitForSelector('.outline-divider');
    const outline = await drag('.outline-divider', 45);
    assert.ok(Math.abs(outline.after - outline.before - 45) <= 2, JSON.stringify(outline));
    await app(store => store.getState().setMode('zen'));
    await page.waitForSelector('.zen-editor-pane');
    const writing = await drag('.chatbot-divider', 25);
    assert.ok(Math.abs(writing.after - writing.before - 25) <= 2, JSON.stringify(writing));
    await app(store => store.getState().setMode('split'));
    await page.waitForSelector('.editor-workspace-pane .monaco-editor');
  });
  await test('narrow immersive AI can resize with expanded and collapsed outline', async () => {
    try {
      await app((store, ai) => { store.getState().setMode('immersive'); ai.getState().setChatbotVisible(true); });
      await page.waitForSelector('.immersive-outline');
      await drag('.chatbot-divider', -700);
      await page.setViewportSize({ width: 800, height: 1000 });
      await frame();
      for (const collapsed of [false, true]) {
        if (collapsed) await page.getByRole('button', { name: '收起大纲', exact: true }).click();
        await frame();
        assert.ok((await rect('.immersive-document-area')).width >= 239);
        const moved = await drag('.chatbot-divider', 20);
        assert.ok(Math.abs(moved.after - moved.during) <= 1, JSON.stringify(moved));
        assert.ok(Math.abs(moved.during - moved.before - 20) <= 2, JSON.stringify(moved));
      }
      await page.getByRole('button', { name: '展开大纲', exact: true }).click();
    } finally {
      await page.setViewportSize({ width: 1600, height: 1000 });
      await app(store => store.getState().setMode('split'));
      await frame();
    }
  });
  await app(store => store.getState().setMode('split'));
  await page.waitForSelector('.editor-workspace-pane .monaco-editor');
  await app((store, ai) => { ai.getState().setChatbotVisible(false); ai.getState().clearResults(); });
  await test('switching documents keeps one source editor and each document undo history', async () => {
    const first = await app(store => store.getState().addTab({ content: '第一个文档' }));
    await page.waitForFunction(async () => (await import('/src/stores/appStore.ts')).useAppStore.getState().editorView?.getValue() === '第一个文档');
    await page.evaluate(async () => {
      const source = await (await fetch('/src/components/Editor/Editor.tsx')).text();
      const url = source.match(/import \* as monaco from ["']([^"']+)["']/)?.[1];
      if (!url) throw new Error('Monaco import not found');
      window.__monaco = await import(url);
      window.__sourceEditor = window.__monaco.editor.getEditors()[0];
    });
    await app(store => store.getState().editorView.replaceRange(6, 6, '编辑'));
    await app(store => store.getState().addTab({ content: '第二个文档' }));
    await page.waitForFunction(async () => (await import('/src/stores/appStore.ts')).useAppStore.getState().editorView?.getValue() === '第二个文档');
    assert.ok(await page.evaluate(() => window.__monaco.editor.getEditors()[0] === window.__sourceEditor), 'source editor instance was recreated');
    assert.ok(await app(store => store.getState().editorView.scrollDOM.isConnected), 'controller points to a detached viewport');
    await app((store, ai, id) => store.getState().setActiveTab(id), first);
    await frame();
    await app(store => store.getState().editorView.undo());
    await page.waitForFunction(async () => (await import('/src/stores/appStore.ts')).useAppStore.getState().content === '第一个文档');
  });
  await test('a controller retained by a previous document cannot edit the active document', async () => {
    await app(store => store.getState().addTab({ content: '旧文档内容' }));
    await frame();
    await app(store => { window.__oldController = store.getState().editorView; });
    await app(store => store.getState().addTab({ content: '新文档内容' }));
    await frame();
    await page.evaluate(() => window.__oldController.replaceRange(0, 2, '错误插入'));
    assert.equal(await app(store => store.getState().content), '新文档内容');
  });
  await test('proofreading highlights return with their document and stay out of other documents', async () => {
    const first = await app(store => store.getState().addTab({ content: '检查文字' }));
    await frame();
    await app((store, ai) => ai.setState({ proofreadSnapshot: { activeTabId: store.getState().activeTabId, content: store.getState().content }, proofreadResults: [{ from: 0, to: 2, original: '检查', suggestion: '核查', type: 'spelling', explanation: '测试' }] }));
    await page.waitForSelector('.monaco-proofread-error');
    await app(store => store.getState().addTab({ content: '其他文字' }));
    await frame();
    assert.equal(await page.locator('.monaco-proofread-error').count(), 0);
    await app((store, ai, id) => store.getState().setActiveTab(id), first);
    await page.waitForSelector('.monaco-proofread-error');
    await app((store, ai) => ai.getState().clearResults());
  });
  await test('late AI slash result cannot write into another document', async () => {
    await app(store => store.getState().addTab({ content: '' }));
    await frame();
    await app((store, ai) => {
      window.__oldChat = ai.getState().chatForEditor;
      ai.setState({ chatForEditor: () => new Promise(resolve => { window.__resolveChat = resolve; }) });
      store.getState().editorView.focus();
    });
    try {
      await page.keyboard.type('/write');
      await page.keyboard.press('Enter');
      await page.locator('.slash-ai-prompt textarea').fill('写一段文字');
      await page.locator('.slash-ai-prompt button.primary').click();
      await page.waitForFunction(() => Boolean(window.__resolveChat));
      await app(store => store.getState().addTab({ content: '另一份文档' }));
      await frame();
      await page.evaluate(() => window.__resolveChat('不应写入的 AI 回答'));
      await frame();
      assert.equal(await app(store => store.getState().content), '另一份文档');
    } finally { await app((store, ai) => ai.setState({ chatForEditor: window.__oldChat })); }
  });
  await test('offscreen tables do not force layout when opening a long document', async () => {
    await page.evaluate(() => {
      window.__tableMeasureCount = 0;
      const original = Element.prototype.getBoundingClientRect;
      window.__restoreTableMeasure = () => { Element.prototype.getBoundingClientRect = original; };
      Element.prototype.getBoundingClientRect = function () {
        if (this.classList.contains('table-resize-wrap')) window.__tableMeasureCount++;
        return original.call(this);
      };
    });
    try {
      const source = Array.from({ length: 100 }, (_, i) => `## 表 ${i}\n\n| A | B |\n| --- | --- |\n| ${i} | 内容 |`).join('\n\n');
      await app((store, ai, source) => store.getState().addTab({ content: source }), source);
      await page.waitForFunction(() => document.querySelectorAll('.preview-document table').length === 100);
      await frame();
      const measured = await page.evaluate(() => window.__tableMeasureCount);
      assert.ok(measured < 30, `measured table wrappers ${measured} times`);
    } finally { await page.evaluate(() => window.__restoreTableMeasure()); }
  });
  await test('WYSIWYG table cells enter the document ready to edit without connected attribute churn', async () => {
    await app(store => store.getState().setMode('wysiwyg'));
    await page.waitForSelector('.wysiwyg-surface');
    await page.evaluate(() => {
      window.__connectedCellChanges = 0;
      window.__cellObserver = new MutationObserver(records => {
        window.__connectedCellChanges += records.filter(record => ['TH', 'TD'].includes(record.target.tagName)).length;
      });
      window.__cellObserver.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['contenteditable'] });
    });
    try {
      const source = Array.from({ length: 30 }, (_, i) => `表 ${i}\n\n| A | B |\n| --- | --- |\n| ${i} | 内容 |`).join('\n\n');
      await app((store, ai, source) => store.getState().addTab({ content: source }), source);
      await page.waitForFunction(() => document.querySelectorAll('.wysiwyg-block table').length === 30);
      await frame();
      assert.equal(await page.evaluate(() => window.__connectedCellChanges), 0);
      assert.equal(await page.locator('.wysiwyg-block td[contenteditable="true"]').count(), 60);
    } finally {
      await page.evaluate(() => window.__cellObserver.disconnect());
      await app(store => store.getState().setMode('split'));
      await page.waitForSelector('.editor-workspace-pane .monaco-editor');
    }
  });
  await test('code language options load on interaction and keep code editing intact', async () => {
    await app(store => store.getState().setMode('wysiwyg'));
    await page.waitForSelector('.wysiwyg-surface');
    try {
      const source = Array.from({ length: 20 }, (_, i) => `\`\`\`js\nconst value = ${i};\n\`\`\``).join('\n\n');
      await app((store, ai, source) => store.getState().addTab({ content: source }), source);
      await page.waitForFunction(() => document.querySelectorAll('.wysiwyg-code-toolbar select').length === 20);
      assert.ok(await page.locator('.wysiwyg-code-toolbar option').count() <= 40);
      const select = page.locator('.wysiwyg-code-toolbar select').first();
      await select.focus();
      await page.waitForFunction(() => document.querySelector('.wysiwyg-code-toolbar select').options.length > 20);
      await select.selectOption('python');
      await page.waitForFunction(async () => (await import('/src/stores/appStore.ts')).useAppStore.getState().editorView.getValue().startsWith('```python\nconst value = 0;'));
    } finally {
      await app(store => store.getState().setMode('split'));
      await page.waitForSelector('.editor-workspace-pane .monaco-editor');
    }
  });
  await test('pasting a long document preserves its final caret for immediate typing', async () => {
    await app(store => { store.getState().setMode('wysiwyg'); store.getState().addTab({ content: '' }); });
    await page.waitForSelector('.wysiwyg-block[contenteditable="true"]');
    const source = Array.from({ length: 200 }, (_, i) => `长粘贴段落 ${i}`).join('\n\n');
    await page.locator('.wysiwyg-block').first().evaluate((host, source) => {
      host.focus();
      const data = new DataTransfer();
      data.setData('text/plain', source);
      host.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, source);
    await page.keyboard.insertText('继续输入');
    await frame();
    assert.ok((await app(store => store.getState().editorView.getValue())).endsWith('长粘贴段落 199继续输入'));
  });
  await test('proofreading reaches blocks mounted after the first WYSIWYG batch', async () => {
    const source = Array.from({ length: 200 }, (_, i) => `校对段落 ${i}`).join('\n\n');
    await app(store => store.getState().setMode('split'));
    const id = await app((store, ai, source) => store.getState().addTab({ content: source }), source);
    await frame();
    const from = source.lastIndexOf('校对段落');
    await app((store, ai, value) => {
      ai.setState({ proofreadSnapshot: { activeTabId: value.id, content: value.source }, proofreadResults: [{ from: value.from, to: value.from + 2, original: '校对', suggestion: '核查', type: 'spelling', explanation: '长文档测试' }] });
      store.getState().setMode('wysiwyg');
    }, { id, source, from });
    try {
      await page.waitForFunction(() => document.querySelectorAll('.wysiwyg-block').length === 200);
      await frame();
      assert.equal(await page.evaluate(() => CSS.highlights.get('wysiwyg-proofread')?.size || 0), 1);
    } finally {
      await app((store, ai) => { ai.getState().clearResults(); store.getState().setMode('split'); });
      await page.waitForSelector('.editor-workspace-pane .monaco-editor');
    }
  });
  const synthetic = Array.from({ length: 120 }, (_, i) => `## 章节 ${i}\n\n中文 Markdown 段落 ${i} **重点** [链接](https://example.com)。\n\n| 名称 | 值 |\n| --- | --- |\n| 项目 ${i} | ${i} |\n\n\`\`\`js\nconst value = ${i};\n\`\`\``).join('\n\n');
  const cdp = await page.context().newCDPSession(page);
  for (const [name, source] of [['handoff', readFileSync('docs/wysiwyg-handoff-2026-10-17-r2.md', 'utf8')], ['tables-120', synthetic]]) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.start');
    const start = Date.now();
    await app((store, ai, source) => store.getState().addTab({ title: '性能验证.md', content: source }), source);
    await page.waitForFunction(text => document.querySelector('.preview-document')?.textContent.includes(text), name === 'handoff' ? '恢复上下文的最短路径' : 'const value = 119;');
    await frame();
    const { profile } = await cdp.send('Profiler.stop');
    writeFileSync(`${output}/${name}-profile.json`, JSON.stringify(profile));
    const hits = new Map();
    const nodes = new Map(profile.nodes.map(node => [node.id, node]));
    for (let i = 0; i < profile.samples.length; i++) {
      const call = nodes.get(profile.samples[i])?.callFrame;
      const label = `${call?.functionName || '(anonymous)'} ${call?.url?.replace(/.*\/src\//, 'src/').slice(-150)}`;
      hits.set(label, (hits.get(label) || 0) + (profile.timeDeltas[i] || 0) / 1000);
    }
    metrics.push({ name, elapsedMs: Date.now() - start, topSelfMs: [...hits].sort((a, b) => b[1] - a[1]).slice(0, 12) });
  }
  await test('no uncaught browser errors', async () => assert.deepEqual(errors, []));
  await page.screenshot({ path: `${output}/layout.png` });
  writeFileSync(`${output}/results.json`, JSON.stringify({ results, metrics }, null, 2));
  console.log(JSON.stringify({ results, metrics }, null, 2));
} finally { await browser.close(); }
if (results.some(result => !result.pass)) process.exitCode = 1;
