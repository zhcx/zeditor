import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path: string) => readFileSync(path, 'utf8')

test('all rendered Markdown HTML is sanitized before reaching a browser or PDF sink', () => {
  // 预览的渲染与增强已抽成共享管线（预览与所见即所得共用），净化点随之移动。
  const pipeline = read('src/utils/markdownPipeline.ts')
  const enhancers = read('src/utils/markdownEnhancers.tsx')
  const menu = read('src/components/MenuBar/MenuBar.tsx')
  const imageExport = read('src/components/Export/ImageExportDialog.tsx')
  const pdfExport = read('src/components/Export/PdfExportDialog.tsx')
  const chatbot = read('src/components/Chatbot/AIChatbotPanel.tsx')

  for (const source of [pipeline, enhancers, menu, imageExport, pdfExport, chatbot]) {
    assert.match(source, /sanitizeRenderedHtml/)
  }
  assert.match(enhancers, /securityLevel:\s*['"]strict['"]/)
  assert.match(enhancers, /sanitizeRenderedHtml\([^)]*svg/)
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

test('WebDAV code never logs credentials or document content', () => {
  const sources = [
    read('src/stores/webdavStore.ts'),
    read('src/components/WebDav/WebDavSettings.tsx'),
    read('src-tauri/src/webdav/client.rs'),
    read('src-tauri/src/webdav/manager.rs'),
  ].join('\n')
  assert.doesNotMatch(sources, /console\.log|println!|dbg!/)
  assert.doesNotMatch(sources, /Authorization.*\{.*password|password.*Authorization/)
})

test('WebDAV errors are centralized and sanitized in Rust', () => {
  const client = read('src-tauri/src/webdav/client.rs')
  assert.match(client, /pub fn sanitize_webdav_error/)
  assert.match(client, /sanitize_diagnostic/)
  assert.match(client, /filter\(\|character\| !character\.is_control\(\)\)/)
})
