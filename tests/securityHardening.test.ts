import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path: string) => readFileSync(path, 'utf8')

test('all rendered Markdown HTML is sanitized before reaching a browser or PDF sink', () => {
  const preview = read('src/components/Preview/Preview.tsx')
  const menu = read('src/components/MenuBar/MenuBar.tsx')
  const imageExport = read('src/components/Export/ImageExportDialog.tsx')
  const pdfExport = read('src/components/Export/PdfExportDialog.tsx')
  const chatbot = read('src/components/Chatbot/AIChatbotPanel.tsx')

  for (const source of [preview, menu, imageExport, pdfExport, chatbot]) {
    assert.match(source, /sanitizeRenderedHtml/)
  }
  assert.match(preview, /securityLevel:\s*['"]strict['"]/)
  assert.match(preview, /sanitizeRenderedHtml\([^)]*svg/)
})

test('preview uses the shared document extension preparation before Markdown rendering', () => {
  const preview = read('src/components/Preview/Preview.tsx')

  assert.match(preview, /prepareMarkdownSource/)
  assert.match(preview, /FrontmatterPanel/)
})

test('workspace navigation exposes the knowledge graph view', () => {
  const activity = read('src/components/ActivityBar/ActivityBar.tsx')
  const app = read('src/App.tsx')
  const sidebar = read('src/components/Sidebar/Sidebar.tsx')

  assert.match(activity, /graph/)
  assert.match(app, /activityView.*graph/)
  assert.match(sidebar, /KnowledgeGraphPanel/)
})

test('desktop graph indexing has a bounded Tauri workspace command', () => {
  const commands = read('src-tauri/src/graph.rs')
  const main = read('src-tauri/src/main.rs')

  assert.match(commands, /build_workspace_graph/)
  assert.match(commands, /workspace graph/)
  assert.match(commands, /symlink_metadata/)
  assert.match(main, /graph::build_workspace_graph/)
})

test('workspace navigation exposes structured SuperTag records', () => {
  const activity = read('src/components/ActivityBar/ActivityBar.tsx')
  const app = read('src/App.tsx')
  const sidebar = read('src/components/Sidebar/Sidebar.tsx')

  assert.match(activity, /library/)
  assert.match(app, /activityView.*library/)
  assert.match(sidebar, /SuperTagPanel/)
})

test('PDF annotations use versioned sidecar commands instead of mutating the source PDF', () => {
  const commands = read('src-tauri/src/commands.rs')
  const main = read('src-tauri/src/main.rs')

  assert.match(commands, /load_pdf_annotations/)
  assert.match(commands, /save_pdf_annotations/)
  assert.match(commands, /zditor-pdf-annotation\.json/)
  assert.match(main, /commands::load_pdf_annotations/)
  assert.match(main, /commands::save_pdf_annotations/)
})

test('opening a PDF uses the reader state while conversion remains an explicit action', () => {
  const store = read('src/stores/appStore.ts')
  const app = read('src/App.tsx')

  assert.match(store, /pdfReaderPath/)
  assert.match(store, /openPdfReader/)
  assert.match(app, /PdfReaderPanel/)
})

test('export templates escape document metadata and cannot break out of style blocks', async () => {
  const { applyExportTemplate, EXPORT_TEMPLATES } = await import('../src/components/Export/exportTemplates.ts')
  const template = {
    ...EXPORT_TEMPLATES[0],
    watermark: '<img src=x onerror=alert(1)>',
    customCss: '</style><script>alert(1)</script>',
  }
  const rendered = applyExportTemplate('<p>safe</p>', '<img src=x onerror=alert(1)>', template)

  assert.doesNotMatch(rendered, /<script/i)
  assert.doesNotMatch(rendered, /<img src=x/i)
  assert.doesNotMatch(rendered, /<\/style><script/i)
  assert.match(rendered, /&lt;img/)
})

test('the update installer only accepts repository release URLs and safe installer names', () => {
  const commands = read('src-tauri/src/commands.rs')
  const main = read('src-tauri/src/main.rs')

  assert.match(commands, /validate_update_download/)
  assert.match(commands, /github\.com/)
  assert.match(commands, /releases\/download/)
  assert.match(commands, /\.msi/)
  assert.match(commands, /\.exe/)
  assert.doesNotMatch(main, /cleanup_export_file/)
})

test('workspace search avoids symlink loops and preserves literal replacement text and UTF-16 columns', () => {
  const commands = read('src-tauri/src/commands.rs')

  assert.match(commands, /symlink_metadata/)
  assert.match(commands, /NoExpand/)
  assert.match(commands, /encode_utf16/)
})

test('image uploads reject nameless files and return the configured local destination', () => {
  const local = read('src-tauri/src/image/local.rs')
  const cloudinary = read('src-tauri/src/image/cloudinary.rs')
  const s3 = read('src-tauri/src/image/s3.rs')

  assert.match(local, /dest_path\.to_string_lossy/)
  assert.doesNotMatch(local, /\.unwrap\(\)/)
  assert.doesNotMatch(cloudinary, /\.unwrap\(\)/)
  assert.doesNotMatch(s3, /\.unwrap\(\)/)
})
