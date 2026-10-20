// Isolated browser verification; file dialogs and writes stay in memory.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(process.env.ZEDITOR_TEST_URL || 'http://127.0.0.1:1425');
  await page.locator('.menubar').waitFor();
  const imageResults = await page.evaluate(async () => {
    const { loadDocxImage } = await import('/src/utils/docxImages.ts');
    const canvas = document.createElement('canvas');
    canvas.width = 24;
    canvas.height = 16;
    canvas.getContext('2d').fillRect(0, 0, 24, 16);
    const results = [];
    for (const mime of ['image/png', 'image/jpeg', 'image/webp']) {
      const image = await loadDocxImage(canvas.toDataURL(mime), null);
      results.push({ mime, type: image.type, width: image.width, height: image.height, size: image.data.length });
    }
    const svg = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"><rect width="24" height="16" fill="red"/></svg>');
    const converted = await loadDocxImage(svg, null);
    results.push({ mime: 'image/svg+xml', type: converted.type, width: converted.width, height: converted.height, size: converted.data.length });
    window.__docxFixturePng = canvas.toDataURL('image/png');
    return results;
  });
  assert.deepEqual(imageResults.map(value => value.type), ['png', 'jpg', 'png', 'png']);
  assert.ok(imageResults.every(value => value.width === 24 && value.height === 16 && value.size > 0));
  await page.evaluate(async () => {
    const appSource = await (await fetch('/src/App.tsx')).text();
    const storePath = appSource.match(/from ["']([^"']*appStore[.]ts[^"']*)["']/)[1];
    const { useAppStore } = await import(storePath);
    useAppStore.getState().setMode('split');
    useAppStore.getState().addTab({ title: '浏览器导出.docx.md', content: '# 浏览器导出\n\n原生 Word 文字。\n\n![内嵌图片](' + window.__docxFixturePng + ')\n\n| 名称 | 状态 |\n| --- | --- |\n| 导出 | 完成 |', modified: false });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.__docxCalls = [];
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      invoke: async (command, args) => {
        window.__docxCalls.push({ command, args });
        if (command === 'plugin:dialog|save') return 'C:/in-memory/浏览器导出.docx';
        if (command === 'save_file_bytes') { window.__docxSaved = args; return null; }
        if (command === 'read_export_image') return window.__docxFixturePng;
        if (command === 'get_recent_folders' || command === 'list_recovery_snapshots') return [];
        return null;
      },
      transformCallback: () => 1,
    };
    window.dispatchEvent(new CustomEvent('zeditor-export-request', { detail: { format: 'word' } }));
  });
  await page.waitForFunction(() => window.__docxSaved || window.__docxCalls.some(call => call.command === 'plugin:dialog|message' && call.args.kind === 'error'));
  const exported = await page.evaluate(() => ({ saved: window.__docxSaved, calls: window.__docxCalls }));
  assert.ok(exported.saved, JSON.stringify(exported.calls));
  assert.equal(exported.saved.path, 'C:/in-memory/浏览器导出.docx');
  const dialog = exported.calls.find(call => call.command === 'plugin:dialog|save');
  assert.deepEqual(dialog.args.options.filters[0].extensions, ['docx']);
  assert.ok(dialog.args.options.defaultPath.endsWith('.docx'));
  assert.equal(exported.calls.some(call => call.command === 'export_word'), false);
  const archive = await JSZip.loadAsync(Buffer.from(exported.saved.dataBase64, 'base64'), { checkCRC32: true });
  assert.ok(archive.file('word/document.xml'));
  assert.ok((await archive.file('word/document.xml').async('string')).includes('浏览器导出'));
  assert.ok(Object.keys(archive.files).some(name => name.startsWith('word/media/') && name.endsWith('.png')));
  const localImage = await page.evaluate(async () => {
    const { loadDocxImage } = await import('/src/utils/docxImages.ts');
    const result = await loadDocxImage('.assets/图.png', 'C:/notes/a.md');
    let unsavedError = '';
    try { await loadDocxImage('.assets/图.png', null); } catch (error) { unsavedError = String(error); }
    return { type: result.type, unsavedError, call: window.__docxCalls.find(call => call.command === 'read_export_image') };
  });
  assert.equal(localImage.type, 'png');
  assert.match(localImage.unsavedError, /请先保存文档/);
  assert.deepEqual(localImage.call.args, { documentPath: 'C:/notes/a.md', source: '.assets/图.png' });
  assert.deepEqual(errors, []);
  await mkdir('test-output/docx-export', { recursive: true });
  await writeFile('test-output/docx-export/browser-export.docx', Buffer.from(exported.saved.dataBase64, 'base64'));
  await writeFile('test-output/docx-export/browser-results.json', JSON.stringify({ imageResults, localImage, savedPath: exported.saved.path, errors }, null, 2));
  console.log('DOCX browser export passed: PNG/JPEG/SVG/WebP conversion, local image IPC, .docx save dialog, binary ZIP output, no page errors.');
} finally { await browser.close(); }
