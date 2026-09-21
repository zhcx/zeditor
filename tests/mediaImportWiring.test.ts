import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MEDIA_FILE_EXTENSIONS } from '../src/utils/media.ts';

const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

test('preview resolves local media through the desktop command and builds players in the DOM', async () => {
  const preview = await read('../src/components/Preview/Preview.tsx');

  assert.match(preview, /import\s*\{[\s\S]*?findMediaEmbeds[\s\S]*?\}\s*from\s*'\.\.\/\.\.\/utils\/media'/);
  assert.match(preview, /renderMediaPlaceholders\(deferredContent\)/);
  assert.match(preview, /data-zeditor-media-key/);
  assert.match(preview, /resolveMediaSources\(currentFile,\s*localSources\)/);
  assert.match(preview, /document\.createElement\(placeholder\.kind === 'audio' \? 'audio' : 'video'\)/);
  assert.match(preview, /player\.controls = true/);
  assert.match(preview, /player\.src = url/);
  // 播放器点击（播放、进度、音量）不能被“定位源码”的预览点击逻辑抢走。
  assert.match(preview, /closest\('video, audio'\)/);
  // 播放器由 createElement 构建，绝不把播放器标签拼进待清洗的 HTML 字符串。
  assert.doesNotMatch(preview, /innerHTML\s*=\s*[^;]*<\s*(video|audio)\b/);
  assert.match(preview, /无法读取媒体文件/);
});

test('media asset service imports files, resolves paths and inserts syntax at the cursor', async () => {
  const service = await read('../src/services/mediaAssets.ts');

  assert.match(service, /invoke<MediaAssetImport>\('import_media_asset',\s*\{\s*sourcePath,\s*documentPath\s*\}\)/);
  assert.match(service, /invoke<\(string \| null\)\[\]>\('resolve_media_sources',\s*\{\s*documentPath:\s*baseDocument,\s*sources:\s*pending\s*\}\)/);
  assert.match(service, /convertFileSrc\(absolutePath, 'asset'\)/);
  assert.match(service, /请先保存文档/);
  assert.match(service, /resolvedMediaCache\.delete\(cacheKey\(documentPath, asset\.relativePath\)\)/);
  assert.match(service, /setUploadStatus\('error'/);
});

test('toolbar and dropped files both run local media through the import pipeline', async () => {
  const toolbar = await read('../src/components/Toolbar/Toolbar.tsx');
  const app = await read('../src/App.tsx');

  assert.match(toolbar, /mediaDialogFilters\('auto'\)/);
  assert.match(toolbar, /await insertMediaFromPath\(path\)/);
  assert.match(toolbar, /本地视频 \/ 音频/);
  assert.match(toolbar, /formatMediaEmbed\(\{\s*kind:/);
  assert.match(app, /isMediaFilePath\(path\)/);
  assert.match(app, /await insertMediaFromPath\(path\)/);
});

test('desktop side whitelists media extensions, caps size and enables the asset protocol', async () => {
  const commands = await read('../src-tauri/src/commands.rs');
  const main = await read('../src-tauri/src/main.rs');
  const cargo = await read('../src-tauri/Cargo.toml');
  const config = JSON.parse(await read('../src-tauri/tauri.conf.json'));

  assert.match(commands, /const MEDIA_EXTENSIONS:\s*\[&str; 18\]/);
  assert.match(commands, /const MAX_MEDIA_BYTES:\s*u64 = 512 \* 1024 \* 1024/);
  assert.match(commands, /仅支持导入视频或音频文件/);
  assert.match(commands, /fn sanitize_media_file_name/);
  assert.match(commands, /folder\.contains\("\.\."\)/);
  assert.match(commands, /pub async fn import_media_asset/);
  assert.match(commands, /pub async fn resolve_media_sources/);

  assert.match(main, /commands::import_media_asset/);
  assert.match(main, /commands::resolve_media_sources/);

  // 前端文件选择器与后端白名单必须保持一致。
  const declared = commands.match(/const MEDIA_EXTENSIONS:\s*\[&str; 18\] = \[([\s\S]*?)\];/);
  assert.ok(declared, 'media extension whitelist');
  const rustExtensions = [...declared[1].matchAll(/"([a-z0-9]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...rustExtensions].sort(), [...MEDIA_FILE_EXTENSIONS].sort());

  assert.equal(config.app.security.assetProtocol.enable, true);
  // 开启 assetProtocol 必须同时启用 tauri 的 protocol-asset feature，否则桌面端无法构建。
  assert.match(cargo, /tauri = \{ version = "2", features = \["protocol-asset"\] \}/);
  assert.match(config.app.security.csp, /media-src 'self' asset: http:\/\/asset\.localhost data: blob: https:/);
});
