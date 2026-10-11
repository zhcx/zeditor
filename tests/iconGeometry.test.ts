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

test('macOS 图标为满幅不透明方块，避免系统套用兼容底板', async () => {
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

  // Apple 自 macOS 26 起要求应用图标是「满幅方块、不带自带圆角、不带透明内边距」，
  // 圆角由系统的 squircle 遮罩统一施加。若图标自带圆角与留白，系统会判定其
  // 「已是成品外观」而走兼容渲染：额外画一层浅灰底板并把图形缩小贴上，
  // 外观上就是图标外面多出一圈空白。因此 ic10 必须铺满整个画布。
  assert.equal(box.boxWidth, box.width, `图形应铺满画布宽度，实际 ${box.boxWidth}/${box.width}`);
  assert.equal(box.boxHeight, box.height, `图形应铺满画布高度，实际 ${box.boxHeight}/${box.height}`);
  assert.equal(box.minX, 0, '图形左上角应在画布原点');
  assert.equal(box.minY, 0, '图形左上角应在画布原点');

  // 连一个透明像素都不能有：任何透明区域都会成为系统底板的露出窗口
  const stats = await sharp(bitmap[1]).stats();
  assert.equal(stats.channels[3].min, 255, 'ic10 不应存在任何透明像素（min alpha 应为 255）');
});

test('图标生成脚本在官方 CLI 之后把 macOS icns 重建为满幅方块', () => {
  const script = readFileSync('scripts/generate-icons.cjs', 'utf8');
  assert.match(script, /const MACOS_CANVAS = 1024;/);
  assert.match(script, /execFileSync\(process\.execPath, \[tauriCli, 'icon', sourceIcon\]/);
  assert.match(script, /fs\.writeFileSync\(icnsPath, icns\);/);
  // 先裁到图形包围盒（源图自带 0.6% 边距），再延展填满透明四角
  assert.match(script, /\.extract\(box\)/);
  assert.match(script, /function fillBleed\(bitmap\)/);
});
