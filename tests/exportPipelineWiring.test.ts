import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('HTML, Word and PDF exports begin with the shared Markdown renderer', async () => {
  const menu = await readFile(new URL('../src/components/MenuBar/MenuBar.tsx', import.meta.url), 'utf8');
  const pdf = await readFile(new URL('../src/components/Export/PdfExportDialog.tsx', import.meta.url), 'utf8');
  const image = await readFile(new URL('../src/components/Export/ImageExportDialog.tsx', import.meta.url), 'utf8');
  const wechat = await readFile(new URL('../src/components/Export/WeChatExportDialog.tsx', import.meta.url), 'utf8');
  assert.match(menu, /import \{ renderMarkdownToHtml \} from ['"]\.\.\/\.\.\/utils\/markdownPipeline['"]/);
  assert.match(menu, /const renderMarkdown = \(text: string\): string =>\s*\{\s*return renderMarkdownToHtml\(text\);\s*\}/);
  assert.match(menu, /applyExportTemplate\(renderMarkdown\(snapshot\.content\)/);
  assert.match(pdf, /renderMarkdownToHtml\(content\)/);
  assert.match(image, /renderMarkdownToHtml\(content \|\| '暂无内容'\)/);
  assert.match(wechat, /renderMarkdownToHtml\(markdown \|\| '暂无内容'\)/);
});
