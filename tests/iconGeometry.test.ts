import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { ICON_GEOMETRY, getCommandIcon } from '../src/components/Icons/iconGeometry.ts';
import { SLASH_COMMANDS } from '../src/utils/slashCommands.ts';
import { BUILTIN_GENIES } from '../src/utils/aiGenies.ts';

test('所有内置插入命令和 AI 指令有用途明确的图标', () => {
  for (const command of [...SLASH_COMMANDS, ...BUILTIN_GENIES]) {
    assert.notEqual(getCommandIcon(command.id), 'sparkles', `${command.id} 不能退回通用占位图标`);
  }
});

test('易混淆模块使用不同轮廓，避免依靠颜色区分用途', () => {
  for (const [first, second] of [['settings', 'sun'], ['chatAi', 'terminal'], ['languages', 'webSearch'], ['fileCheck', 'checkCircle'], ['fileText', 'folder'], ['paperclip', 'link']] as const) {
    assert.notDeepEqual(ICON_GEOMETRY[first], ICON_GEOMETRY[second]);
  }
});

test('全部图标在 16px 下可以正确渲染并保留可见图形', async () => {
  for (const [name, geometry] of Object.entries(ICON_GEOMETRY)) {
    const shapes = geometry.map(shape => `<${shape.tag} ${Object.entries(shape.attrs).map(([key, value]) => `${key}="${value}"`).join(' ')}/>`).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#20252b" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${shapes}</svg>`;
    const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let visible = 0;
    for (let index = 3; index < data.length; index += info.channels) if (data[index] > 0) visible += 1;
    assert.ok(visible > 2, `${name} 在小尺寸下不能为空白`);
  }
});

/** 解析 ICNS 容器，返回 [(类型码, PNG Buffer)]。 */
function parseIcns(buffer: Buffer): Array<[string, Buffer]> {
  assert.equal(buffer.toString('ascii', 0, 4), 'icns');
  assert.equal(buffer.readUInt32BE(4), buffer.length, 'icns 头部长度应与文件大小一致');
  const entries: Array<[string, Buffer]> = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const type = buffer.toString('ascii', offset, offset + 4);
    const length = buffer.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > buffer.length) break;
    entries.push([type, buffer.subarray(offset + 8, offset + length)]);
    offset += length;
  }
  return entries;
}

/** 计算 alpha 通道的不透明包围盒。 */
async function alphaBox(png: Buffer) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * channels + 3] > 24) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { width, height, boxWidth: maxX - minX + 1, boxHeight: maxY - minY + 1, minX, minY };
}

test('macOS 图标自带圆角并二值化 alpha，应用图标与卷图标都能正确显示', async () => {
  const icns = readFileSync('src-tauri/icons/icon.icns');
  const entries = parseIcns(icns);
  assert.deepEqual(
    entries.map(([type]) => type),
    ['ic10', 'ic14', 'ic09', 'ic13', 'ic08', 'ic07', 'ic12', 'ic11'],
    'icns 应包含 macOS 所需的全部尺寸',
  );
  for (const [type, data] of entries) {
    assert.equal(data[0], 0x89, `${type} 应为 PNG 数据`);
  }

  const bitmap = entries.find(([type]) => type === 'ic10');
  assert.ok(bitmap, '应存在 1024 尺寸的 ic10');
  const box = await alphaBox(bitmap[1]);
  assert.equal(box.width, 1024);

  // 同一个 icon.icns 被 Tauri 同时用作 .app 图标和 DMG 卷图标，两处期望不同：
  // 应用图标由系统套 squircle 遮罩，卷图标则原样显示、不会补圆角。满幅方块会让
  // 桌面上的安装包显示成方角（四角是蓝色背景），所以图形必须自带圆角与留白。
  const artRatio = box.boxWidth / box.width;
  assert.ok(artRatio > 0.78 && artRatio < 0.83, `图形应落在 80.5% 安全区，实际 ${(artRatio * 100).toFixed(1)}%`);
  assert.equal(box.boxHeight, box.boxWidth, '图形包围盒应为正方形');
  assert.ok(box.minX > 0 && box.minY > 0, '图形四周应留出透明边距');

  // 实测（macOS 27）触发系统「兼容底板」的是边缘的半透明羽化，而不是留白本身：
  // 源图自带的外发光阴影会让系统叠一层灰色底板并把图形缩小。alpha 必须是纯 0/255。
  const { data, info } = await sharp(bitmap[1]).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const partial = new Set<number>();
  for (let index = 3; index < data.length; index += info.channels) {
    const alpha = data[index];
    if (alpha !== 0 && alpha !== 255) partial.add(alpha);
  }
  assert.equal(partial.size, 0, `alpha 必须二值化，但仍存在半透明值：${[...partial].slice(0, 5).join(', ')}`);
});

test('图标生成脚本在官方 CLI 之后按安全区重建 macOS icns', () => {
  const script = readFileSync('scripts/generate-icons.cjs', 'utf8');
  assert.match(script, /const MACOS_CANVAS = 1024;/);
  assert.match(script, /const MACOS_ART_RATIO = 0\.805;/);
  assert.match(script, /execFileSync\(process\.execPath, \[tauriCli, 'icon', sourceIcon\]/);
  assert.match(script, /fs\.writeFileSync\(icnsPath, icns\);/);
  // 先裁到实心区（源图四周的外发光阴影不计入），再缩到安全区居中，
  // 最后把 alpha 压成 0/255，避免系统给应用图标补灰底板。
  assert.match(script, /\.extract\(box\)/);
  assert.match(script, /function solidBoundingBox\(input\)/);
  assert.match(script, /function binarizeAlpha\(data\)/);
  // 旧的「延展填满四角」做法已删除：它会把蓝色背景推到圆角之外。
  assert.doesNotMatch(script, /fillBleed/);
});
