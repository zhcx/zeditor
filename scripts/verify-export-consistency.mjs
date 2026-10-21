// Isolated browser verification for export consistency.
// Covers Mermaid / Markmap / SVG / GitHub Actions fences in HTML, PDF body, Word,
// and the PNG mode used by long-image and WeChat exports. File dialogs and writes
// are mocked in memory; no user files or cloud services are touched.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJXkAAAAASUVORK5CYII=';
const sample = [
  '# 导出一致性样稿',
  '',
  '正文包含 **粗体**、行内公式 $E=mc^2$、脚注[^来源]与 Wiki 链接 [[笔记B]]。',
  '',
  '- [x] 已完成',
  '- [ ] 待处理',
  '',
  '| 名称 | 状态 |',
  '| --- | --- |',
  '| 图表 | 待验证 |',
  '',
  '```mermaid',
  'graph TD',
  '  A[开始] --> B{判断}',
  '  B -->|是| C[结束]',
  '```',
  '',
  '```markmap',
  '# 中心主题',
  '## 分支一',
  '### 要点 A',
  '## 分支二',
  '### 要点 B',
  '```',
  '',
  '```svg',
  '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="60"><rect width="160" height="60" fill="#2d6ae0"/><text x="12" y="36" fill="#fff" font-size="16">SVG 图形</text></svg>',
  '```',
  '',
  '```yaml',
  'name: 导出验收',
  'on: push',
  'jobs:',
  '  build:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - run: echo build',
  '  test:',
  '    needs: build',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - run: echo test',
  '```',
  '',
  `![示例图片](data:image/png;base64,${png})`,
  '',
  '[^来源]: 脚注定义保持可编辑。',
  '',
].join('\n');

try {
  await page.goto(process.env.ZEDITOR_TEST_URL || 'http://localhost:1425');
  await page.locator('.menubar').waitFor();

  const direct = await page.evaluate(async (markdown) => {
    const appSource = await (await fetch('/src/App.tsx')).text();
    const storePath = appSource.match(/from ["']([^"']*appStore[.]ts[^"']*)["']/)[1];
    const { useAppStore } = await import(storePath);
    useAppStore.getState().setMode('split');
    useAppStore.getState().addTab({ title: '导出一致性.md', content: markdown, modified: false });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const { enhanceExportHtml, renderDiagramForDocx } = await import('/src/utils/exportDiagrams.ts');
    const { renderMarkdownToHtml } = await import('/src/utils/markdownPipeline.ts');
    const html = renderMarkdownToHtml(markdown);

    const svgResult = await enhanceExportHtml(html, { mode: 'svg', theme: 'vscode-dark', workflowViewerEnabled: true });
    const imageResult = await enhanceExportHtml(html, { mode: 'image', theme: 'light', background: '#ffffff' });
    const mermaidPng = await renderDiagramForDocx('mermaid', 'graph TD\n  A --> B', { theme: 'vscode-light' });
    const plainYaml = await renderDiagramForDocx('yaml', 'name: data\nvalues:\n  - 1', { theme: 'vscode-light' });
    const broken = await enhanceExportHtml(renderMarkdownToHtml('```mermaid\nnot a diagram\n```'), { mode: 'svg', theme: 'light' });
    const workflowOff = await enhanceExportHtml(html, { mode: 'svg', theme: 'light', workflowViewerEnabled: false });

    // 长图导出走同样的 SVG foreignObject 路径：内联 PNG 图表必须真的画到画布上。
    const canvasWidth = 640;
    const canvasHeight = 960;
    const container = document.createElement('div');
    container.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
    container.setAttribute('style', 'box-sizing:border-box;width:100%;height:100%;padding:24px;background:#ffffff;color:#242321;font-size:16px;overflow:hidden');
    container.innerHTML = `<style>img{max-width:100%}</style>${imageResult.html}`;
    const xhtml = new XMLSerializer().serializeToString(container);
    const exportSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}"><foreignObject width="100%" height="100%">${xhtml}</foreignObject></svg>`;
    const raster = new Image();
    raster.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(exportSvg)}`;
    await raster.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvasWidth, canvasHeight);
    context.drawImage(raster, 0, 0);
    const pixels = context.getImageData(0, 0, canvasWidth, canvasHeight).data;
    let coloredPixels = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] < 240 || pixels[index + 1] < 240 || pixels[index + 2] < 240) coloredPixels += 1;
    }

    const figures = (value) => [...value.matchAll(/data-export-diagram="([^"]+)"/g)].map(match => match[1]);
    const pngHeaders = [...imageResult.html.matchAll(/data:image\/png;base64,([^"]+)/g)]
      .map(match => atob(match[1].slice(0, 12)).slice(0, 4));
    return {
      svgFigures: figures(svgResult.html),
      svgCount: (svgResult.html.match(/<svg/g) || []).length,
      imageFigures: figures(imageResult.html),
      imageCount: (imageResult.html.match(/<img src="data:image\/png;base64,/g) || []).length,
      pngHeaders,
      warnings: [...new Set([...svgResult.warnings, ...imageResult.warnings])],
      diagramCounts: [svgResult.diagrams, imageResult.diagrams],
      mermaidPng: mermaidPng && { type: mermaidPng.type, width: mermaidPng.width, height: mermaidPng.height, size: mermaidPng.data.length },
      plainYaml,
      broken: {
        warnings: broken.warnings,
        diagrams: broken.diagrams,
        keepsSource: /<code class="language-mermaid"/.test(broken.html),
      },
      workflowOff: {
        keepsSource: /<code class="language-yaml"/.test(workflowOff.html),
        figures: figures(workflowOff.html),
      },
      coloredPixels,
    };
  }, sample);

  assert.deepEqual(direct.svgFigures.sort(), ['markmap', 'mermaid', 'svg', 'workflow']);
  assert.deepEqual(direct.imageFigures.sort(), ['markmap', 'mermaid', 'svg', 'workflow']);
  assert.deepEqual(direct.diagramCounts, [4, 4]);
  // 4 diagrams + the sample's own inline PNG image.
  assert.equal(direct.imageCount, 5);
  assert.ok(direct.pngHeaders.every(header => header === '\x89PNG'), JSON.stringify(direct.pngHeaders));
  assert.ok(direct.svgCount >= 4);
  assert.deepEqual(direct.warnings, []);
  assert.ok(direct.mermaidPng && direct.mermaidPng.type === 'png' && direct.mermaidPng.size > 1000, JSON.stringify(direct.mermaidPng));
  assert.equal(direct.plainYaml, null);
  assert.equal(direct.broken.diagrams, 0);
  assert.equal(direct.broken.keepsSource, true);
  assert.ok(direct.broken.warnings.some(warning => warning.includes('保留源码')), JSON.stringify(direct.broken.warnings));
  // 关闭工作流预览开关时保持 YAML 源码，与预览行为一致。
  assert.equal(direct.workflowOff.keepsSource, true);
  assert.deepEqual(direct.workflowOff.figures.sort(), ['markmap', 'mermaid', 'svg']);
  // 长图画布上必须有实际内容（文字、表格与 4 张图表），不能只剩白底。
  assert.ok(direct.coloredPixels > 5000, `long-image canvas looks blank: ${direct.coloredPixels}`);

  const exported = await page.evaluate(async () => {
    window.__exportCalls = [];
    window.__messages = [];
    window.__htmlSaved = null;
    window.__pdfArgs = null;
    window.__docxSaved = null;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => 1,
      invoke: async (command, args) => {
        window.__exportCalls.push(command);
        if (command === 'plugin:dialog|save') return 'C:/in-memory/导出一致性';
        if (command === 'plugin:dialog|message') { window.__messages.push(args); return null; }
        if (command === 'export_html') return args.htmlBody;
        if (command === 'save_file_content') { window.__htmlSaved = args; return null; }
        if (command === 'export_pdf_direct') { window.__pdfArgs = args; return 'C:/in-memory/导出一致性.pdf'; }
        if (command === 'save_file_bytes') { window.__docxSaved = args; return null; }
        if (/list_|get_recent|font_families|pending_backup|startup_files/.test(command)) return [];
        return null;
      },
    };
    const wait = (check) => new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (check()) { clearInterval(timer); resolve(); }
        else if (Date.now() - started > 120000) { clearInterval(timer); reject(new Error('export timeout')); }
      }, 100);
    });
    const request = (format) => window.dispatchEvent(new CustomEvent('zeditor-export-request', { detail: { format } }));

    request('html');
    await wait(() => window.__htmlSaved);
    request('pdf');
    await wait(() => window.__pdfArgs);
    request('word');
    await wait(() => window.__docxSaved);
    return { html: window.__htmlSaved, pdf: window.__pdfArgs, docx: window.__docxSaved, calls: window.__exportCalls, messages: window.__messages };
  });

  assert.ok(exported.html?.content, JSON.stringify(exported.calls));
  assert.ok(exported.pdf?.htmlBody, JSON.stringify(exported.calls));
  assert.ok(exported.docx?.dataBase64, JSON.stringify(exported.calls));
  for (const body of [exported.html.content, exported.pdf.htmlBody]) {
    assert.equal((body.match(/data-export-diagram="mermaid"/g) || []).length, 1);
    assert.equal((body.match(/data-export-diagram="markmap"/g) || []).length, 1);
    assert.equal((body.match(/data-export-diagram="svg"/g) || []).length, 1);
    assert.equal((body.match(/data-export-diagram="workflow"/g) || []).length, 1);
    assert.match(body, /class="katex"/);
    assert.match(body, /class="footnote-ref/);
    assert.match(body, /task-list-item/);
    assert.match(body, /class="wiki-link/);
    assert.doesNotMatch(body, /<code class="language-mermaid"/);
  }
  // Word still warns about wiki links/TeX by design, but not about diagrams.
  assert.ok(exported.messages.every(message => !String(message.message).includes('图表')), JSON.stringify(exported.messages));

  const archive = await JSZip.loadAsync(Buffer.from(exported.docx.dataBase64, 'base64'), { checkCRC32: true });
  const documentXml = await archive.file('word/document.xml').async('string');
  assert.match(documentXml, /导出一致性样稿/);
  assert.doesNotMatch(documentXml, /graph TD/);
  const media = Object.keys(archive.files).filter(name => name.startsWith('word/media/') && name.endsWith('.png'));
  assert.ok(media.length >= 4, JSON.stringify(media));
  for (const name of media) {
    const bytes = await archive.file(name).async('uint8array');
    assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], `${name} must be a real PNG`);
  }
  const footnotesXml = await archive.file('word/footnotes.xml').async('string');
  assert.match(footnotesXml, /脚注定义保持可编辑/);

  // 导出文件本身要在浏览器里画出图表，而不只是 HTML 字符串里有 SVG。
  await page.setContent(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${exported.html.content}</body></html>`);
  const renderedFigures = await page.evaluate(() => Array.from(document.querySelectorAll('figure[data-export-diagram]')).map((figure) => {
    const svg = figure.querySelector('svg');
    const box = svg?.getBoundingClientRect();
    return {
      kind: figure.getAttribute('data-export-diagram'),
      hasSvg: Boolean(svg),
      width: Math.round(box?.width ?? 0),
      height: Math.round(box?.height ?? 0),
    };
  }));
  assert.equal(renderedFigures.length, 4, JSON.stringify(renderedFigures));
  assert.ok(renderedFigures.every(item => item.hasSvg && item.width > 100 && item.height > 20), JSON.stringify(renderedFigures));

  assert.deepEqual(errors, []);
  await mkdir('test-output/export-consistency', { recursive: true });
  await writeFile('test-output/export-consistency/export.html', exported.html.content);
  await writeFile('test-output/export-consistency/export.docx', Buffer.from(exported.docx.dataBase64, 'base64'));
  await writeFile('test-output/export-consistency/sample.md', sample);
  await writeFile('test-output/export-consistency/results.json', JSON.stringify({
    direct: { ...direct, mermaidPng: direct.mermaidPng },
    htmlFigures: direct.svgFigures,
    docxMedia: media,
    renderedFigures,
    calls: exported.calls,
    errors,
  }, null, 2));
  console.log('Export consistency passed: 4 diagram types in SVG and PNG modes, HTML/PDF diagram figures, DOCX media images, formulas/footnotes/tasks/wiki links preserved, no page errors.');
} finally {
  await browser.close();
}
