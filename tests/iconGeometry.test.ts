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

test('macOS 图标遵循 Apple 安全区，图形不超出 80.5% 网格', async () => {
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

  // Apple 的 macOS 图标网格：内容区 824/1024 = 80.5%，居中留透明边距。
  // 之前源图图形占 98.6%，远超安全区，macOS 会自行缩进并用默认浅灰底板
  // 填补腾出的边缘，外观上就是图标外多了一圈空白。
  const ratio = box.boxWidth / box.width;
  assert.ok(
    ratio > 0.78 && ratio < 0.83,
    `ic10 内容宽度占比应为 80.5%（Apple 标准），实际 ${(ratio * 100).toFixed(1)}%`,
  );
  const margin = (box.width - box.boxWidth) / 2;
  assert.ok(
    Math.abs(box.minX - margin) <= 2 && Math.abs(box.minY - margin) <= 2,
    `图形应居中，实际左上角 ${box.minX},${box.minY}（期望约 ${margin}）`,
  );
});

test('图标生成脚本在官方 CLI 之后重建 macOS icns', () => {
  const script = readFileSync('scripts/generate-icons.cjs', 'utf8');
  // macOS 不能沿用满幅方图，必须在 tauri icon 之后单独按安全区重建 icns
  assert.match(script, /const MACOS_CANVAS = 1024;/);
  assert.match(script, /const MACOS_CONTENT = 824;/);
  assert.match(script, /execFileSync\(process\.execPath, \[tauriCli, 'icon', sourceIcon\]/);
  assert.match(script, /fs\.writeFileSync\(icnsPath, icns\);/);
  // 源图自带透明边距时要先裁到图形包围盒，否则内容会小于 80.5%
  assert.match(script, /\.extract\(box\)/);
});
