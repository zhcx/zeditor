import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

test('HTML, Word and PDF exports begin with the shared Markdown renderer', async () => {
  const menu = await read('../src/components/MenuBar/MenuBar.tsx');
  const pdf = await read('../src/components/Export/PdfExportDialog.tsx');
  const image = await read('../src/components/Export/ImageExportDialog.tsx');
  const wechat = await read('../src/components/Export/WeChatExportDialog.tsx');

  assert.match(menu, /import \{ renderMarkdownToHtml \} from ['"]\.\.\/\.\.\/utils\/markdownPipeline['"]/);
  assert.match(menu, /const renderMarkdown = \(text: string\): string =>\s*\{\s*return renderMarkdownToHtml\(text\);\s*\}/);
  assert.match(menu, /captureExportSnapshot\(useAppStore\.getState\)/);
  assert.match(menu, /renderMarkdown\(snapshot\.content\)/);
  assert.match(pdf, /renderMarkdownToHtml\(content\)/);
  assert.match(image, /renderMarkdownToHtml\(source\)/);
  assert.match(wechat, /renderWeChatHtml\(bodyHtml, title, theme\)/);
});

test('各导出入口都补做预览里的图表增强，而不是只导出源码', async () => {
  const menu = await read('../src/components/MenuBar/MenuBar.tsx');
  const pdf = await read('../src/components/Export/PdfExportDialog.tsx');
  const image = await read('../src/components/Export/ImageExportDialog.tsx');
  const wechat = await read('../src/components/Export/WeChatExportDialog.tsx');

  // HTML / PDF：内联 SVG，与预览一致。
  assert.match(menu, /enhanceExportHtml\(renderMarkdown\(snapshot\.content\)/);
  assert.match(menu, /mode: 'svg'/);
  assert.match(pdf, /enhanceExportHtml\(renderMarkdownToHtml\(content\)/);
  // Word：围栏图表转 PNG 后以图片写入，失败才回退源码。
  assert.match(menu, /loadDiagram: \(language, diagramSource\) => renderDiagramForDocx/);
  const docx = await read('../src/utils/docxExport.ts');
  assert.match(docx, /loadDiagram\?: \(language: string, source: string\) => Promise<DocxImage \| null>/);
  assert.match(docx, /diagram = await options\.loadDiagram\(language, token\.content\)/);
  assert.match(docx, /new ImageRun\(\{\s*type: diagram\.type, data: diagram\.data/);
  // 长图 / 公众号：先转 PNG 数据地址，避免嵌套 SVG 在光栅化时丢图。
  assert.match(image, /enhanceExportHtml\(renderMarkdownToHtml\(diagramRequest\.source\)/);
  assert.match(image, /mode: 'image'/);
  // foreignObject 内部必须先是良构 XHTML，否则带 <img>/<br> 的文档整张图都无法解码。
  assert.match(image, /new XMLSerializer\(\)\.serializeToString\(container\)/);
  assert.match(wechat, /enhanceExportHtml\(renderMarkdownToHtml\(diagramRequest\.source\)/);
  assert.match(wechat, /theme: 'light'/);
});

test('图表渲染失败时保留源码并把原因交给用户', async () => {
  const module = await read('../src/utils/exportDiagrams.ts');
  const docx = await read('../src/utils/docxExport.ts');
  const menu = await read('../src/components/MenuBar/MenuBar.tsx');
  const pdf = await read('../src/components/Export/PdfExportDialog.tsx');

  assert.match(module, /warnings\.push\(`\$\{diagramCaption\(kind\)\}未能转换，已保留源码：/);
  assert.match(docx, /if \(explicitDiagram && !reportedFailure\)/);
  assert.match(menu, /diagramWarnings\.join\('\\n\\n'\)/);
  assert.match(pdf, /enhanced\.warnings\.join\('\\n\\n'\)/);
});

test('长图与公众号图表尚未按当前内容和主题渲染完成时不允许导出', async () => {
  const image = await read('../src/components/Export/ImageExportDialog.tsx');
  const wechat = await read('../src/components/Export/WeChatExportDialog.tsx');

  assert.match(image, /resolveThemePreference\(settings\.appearance\.theme\)/);
  assert.match(image, /isExportDiagramRequestReady\(renderedDiagramRequest, diagramRequest\)/);
  assert.match(image, /if \(!diagramsReady \|\| exporting\) return/);
  assert.match(image, /disabled=\{exporting \|\| !diagramsReady\}/);
  assert.match(wechat, /isExportDiagramRequestReady\(renderedDiagramRequest, diagramRequest\)/);
  assert.match(wechat, /if \(!diagramsReady\) return/);
  assert.equal((wechat.match(/disabled=\{!diagramsReady\}/g) ?? []).length, 2);
});

test('工作流图渲染开关传入 Word 和公众号导出', async () => {
  const menu = await read('../src/components/MenuBar/MenuBar.tsx');
  const wechat = await read('../src/components/Export/WeChatExportDialog.tsx');
  const docx = await read('../src/utils/docxExport.ts');

  assert.match(menu, /createDocx\(snapshot\.content,[\s\S]*?workflowViewerEnabled: settings\.workflow\?\.render_in_preview !== false/);
  assert.match(menu, /<WeChatExportDialog content=\{exportSnapshot\.content\} title=\{exportSnapshot\.title\} workflowViewerEnabled=\{settings\.workflow\?\.render_in_preview !== false\}/);
  assert.match(wechat, /workflowViewerEnabled: diagramRequest\.workflowViewerEnabled/);
  assert.match(docx, /workflowViewerEnabled\?: boolean/);
});
