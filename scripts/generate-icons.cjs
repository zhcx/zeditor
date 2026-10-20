/**
 * 生成各平台应用图标。
 *
 * Windows / Linux / 浏览器：由满幅方形源图派生（`tauri icon` + 网页图标），
 * 图形铺满画布，符合任务栏、开始菜单与 favicon 的展示习惯。
 *
 * macOS：同一个 icon.icns 会被 Tauri 用到两处，两处对图形的期望不同——
 *   1. .app 图标：系统套用自己的 squircle 遮罩。实测（macOS 27）触发「兼容
 *      底板」的条件不是留白本身，而是**边缘带半透明羽化**：源图四周约 8px 的
 *      外发光阴影（alpha 0→252 渐变）会让系统判定图标「自带外观」，叠一层浅灰
 *      底板并把图形缩小。把 alpha 二值化（>=128 → 255）后，即使满幅方块也能
 *      干净地套上遮罩。
 *   2. DMG 卷图标：Tauri 把同一个 icns 复制成 .VolumeIcon.icns，Finder 对卷图标
 *      **不套遮罩**，原样显示。满幅方块会显示成方角，四角是蓝色背景。
 * 两个要求同时满足的唯一做法：让图形自身带圆角且留白，alpha 二值化。于是本脚本
 * 裁掉外发光阴影，把实心图形缩到 80.5%（Apple 网格的安全区）居中放进透明画布。
 *
 * 用法：npm run icons:app
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const projectRoot = path.resolve(__dirname, '..');
const sourceIcon = path.join(projectRoot, 'src-tauri', 'icons', 'app-icon.png');
const icnsPath = path.join(projectRoot, 'src-tauri', 'icons', 'icon.icns');
const tauriCli = require.resolve('@tauri-apps/cli/tauri.js');

/** macOS 图标画布边长（Apple 依据 1024 画布生成各尺寸）。 */
const MACOS_CANVAS = 1024;

/** macOS 图标安全区：实心图形占画布的比例（Apple 网格规范为 80.5%）。 */
const MACOS_ART_RATIO = 0.805;

/** alpha 二值化阈值：高于此值视为不透明。低于它的像素是阴影/抗锯齿，一律抹掉。 */
const ALPHA_SOLID_THRESHOLD = 128;

/** ICNS 条目：类型码 → 该条目内嵌 PNG 的像素边长。 */
const ICNS_ENTRIES = [
  ['ic10', 1024],
  ['ic14', 512],
  ['ic09', 512],
  ['ic13', 256],
  ['ic08', 256],
  ['ic07', 128],
  ['ic12', 64],
  ['ic11', 32],
];

/**
 * 计算「实心区」包围盒：alpha 达到阈值的像素范围。
 *
 * 源图四周有一圈外发光阴影（alpha 从 0 渐变到 252），它既是边缘羽化的来源，
 * 也会让裁切范围比真实图形更大。这里只认 alpha >= 阈值的像素，把阴影排除在
 * 包围盒之外。
 */
async function solidBoundingBox(input) {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * channels + 3] >= ALPHA_SOLID_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error('源图完全透明，无法生成图标');
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** 把 alpha 压成纯 0 / 255：半透明边缘会让系统给应用图标补一层灰色底板。 */
function binarizeAlpha(data) {
  for (let i = 3; i < data.length; i += 4) {
    data[i] = data[i] >= ALPHA_SOLID_THRESHOLD ? 255 : 0;
  }
  return data;
}

/** 产出 1024×1024 画布图：实心图形按 80.5% 居中，四周透明，alpha 二值化。 */
async function buildMacosCanvas() {
  const meta = await sharp(sourceIcon).metadata();
  const box = await solidBoundingBox(sourceIcon);
  console.log(
    `  源图 ${meta.width}×${meta.height}，实心图形 ${box.width}×${box.height}` +
      `（占源图画布 ${(box.width / meta.width * 100).toFixed(1)}%）`,
  );

  const artSize = Math.round(MACOS_CANVAS * MACOS_ART_RATIO);
  const art = await sharp(sourceIcon)
    .extract(box)
    .resize(artSize, artSize, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  binarizeAlpha(art.data);

  const offset = Math.round((MACOS_CANVAS - artSize) / 2);
  return sharp({
    create: {
      width: MACOS_CANVAS,
      height: MACOS_CANVAS,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{
      input: art.data,
      raw: { width: artSize, height: artSize, channels: 4 },
      left: offset,
      top: offset,
    }])
    .png()
    .toBuffer();
}

/** 由 1024 画布图组装 ICNS：8 字节文件头 + 若干「类型码 + 长度 + PNG 数据」块。 */
async function writeIcns(canvas) {
  const chunks = [];
  for (const [type, size] of ICNS_ENTRIES) {
    const png = await sharp(canvas).resize(size, size).png().toBuffer();
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, 'ascii');
    header.writeUInt32BE(png.length + 8, 4);
    chunks.push(header, png);
  }

  const body = Buffer.concat(chunks);
  const fileHeader = Buffer.alloc(8);
  fileHeader.write('icns', 0, 4, 'ascii');
  fileHeader.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([fileHeader, body]);
}

async function main() {
  // 官方 CLI 生成 Windows / Linux / Store 等平台资源（满幅方图，符合各平台习惯）。
  execFileSync(process.execPath, [tauriCli, 'icon', sourceIcon], {
    cwd: projectRoot,
    stdio: 'inherit',
  });

  // 网页图标保持满幅，避免浏览器标签页与桌面快捷方式出现透明边。
  await Promise.all([
    sharp(sourceIcon).resize(64, 64).png().toFile(path.join(projectRoot, 'public', 'app-icon.png')),
    sharp(sourceIcon).resize(32, 32).png().toFile(path.join(projectRoot, 'public', 'favicon.png')),
    sharp(sourceIcon).resize(128, 128).png().toFile(path.join(projectRoot, 'docs', 'public', 'logo.png')),
  ]);

  // 覆盖 macOS 的 icns：官方 CLI 直接沿用源图，周围带一圈半透明外发光阴影，
  // 系统会据此判定「自带外观」并补一层灰色底板；同时满幅图形会让 DMG 卷图标
  // 显示成方角。改为「实心图形缩到安全区 + alpha 二值化」后，两处都能正确显示。
  const canvas = await buildMacosCanvas();
  const icns = await writeIcns(canvas);
  fs.writeFileSync(icnsPath, icns);
  console.log(
    `macOS 图标已重建：icon.icns（图形占画布 ${(MACOS_ART_RATIO * 100).toFixed(1)}%，` +
      `alpha 二值化，${ICNS_ENTRIES.length} 个尺寸，${icns.length} 字节）`,
  );
}

main().catch((error) => {
  console.error(`生成图标失败：${error.message}`);
  process.exitCode = 1;
});
