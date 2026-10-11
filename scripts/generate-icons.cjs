/**
 * 生成各平台应用图标。
 *
 * Windows / Linux / 浏览器：由满幅方形源图派生（`tauri icon` + 网页图标），
 * 图形铺满画布，符合任务栏、开始菜单与 favicon 的展示习惯。
 *
 * macOS：Apple 自 macOS 26（Tahoe）起要求应用图标是**满幅方块、不带自带圆角、
 * 不带透明内边距**，圆角由系统的 squircle 遮罩统一施加。若图标自带圆角与留白
 * （本项目源图图形占 98.6%，四角透明），系统会判定其「已是成品外观」而走兼容
 * 渲染：额外画一层浅灰 squircle 底板并把图形缩小贴上——外观上就是图标外面多
 * 出一圈空白。因此这里把源图的透明四角按边界色延展填满，产出满幅不透明的
 * icns，让系统直接套用遮罩。
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

/** 计算 alpha 通道的不透明包围盒（源图自带透明边距时需要精确裁掉）。 */
async function alphaBoundingBox(input) {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
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
  if (maxX < 0) throw new Error('源图完全透明，无法生成图标');
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * 把透明四角按边界色延展填满，产出满幅不透明方块。
 *
 * 逐行用该行最左/最右可见像素向外延展，使四角继承图形边界的渐变色；
 * 整行全透明的极端情况再按列从上/下方最近的有内容行继承。这样既保留
 * 图形本身的尺寸（不放大 Z），又满足 Apple「满幅、无自带圆角、无内边距」的要求。
 */
function fillBleed(bitmap) {
  const { width: W, height: H } = bitmap;
  const C = 4;
  const data = bitmap.data;
  const visible = (x, y) => data[(y * W + x) * C + 3] > 8;
  const copy = (sx, sy, dx, dy) => {
    const s = (sy * W + sx) * C;
    const d = (dy * W + dx) * C;
    for (let c = 0; c < C; c++) data[d + c] = data[s + c];
    data[d + 3] = 255;
  };

  // 1) 行内左右延展
  const filledRows = [];
  for (let y = 0; y < H; y++) {
    let first = -1;
    let last = -1;
    for (let x = 0; x < W; x++) {
      if (visible(x, y)) {
        if (first < 0) first = x;
        last = x;
      }
    }
    if (first < 0) continue;
    filledRows.push(y);
    for (let x = 0; x < first; x++) copy(first, y, x, y);
    for (let x = last + 1; x < W; x++) copy(last, y, x, y);
  }
  // 2) 整行透明的补漏：从最近的已填充行整行复制
  if (filledRows.length > 0) {
    const firstFilled = filledRows[0];
    const lastFilled = filledRows[filledRows.length - 1];
    for (let y = 0; y < firstFilled; y++) for (let x = 0; x < W; x++) copy(x, firstFilled, x, y);
    for (let y = lastFilled + 1; y < H; y++) for (let x = 0; x < W; x++) copy(x, lastFilled, x, y);
  }
  // 兜底：任何仍带透明度的像素直接置为不透明
  for (let i = 3; i < data.length; i += C) data[i] = 255;
  return bitmap;
}

/** 产出 1024×1024 满幅不透明画布图。 */
async function buildMacosCanvas() {
  const meta = await sharp(sourceIcon).metadata();
  const box = await alphaBoundingBox(sourceIcon);
  console.log(
    `  源图 ${meta.width}×${meta.height}，图形包围盒 ${box.width}×${box.height}` +
      `（占源图画布 ${(box.width / meta.width * 100).toFixed(1)}%）`,
  );

  const bitmap = await sharp(sourceIcon)
    .extract(box)
    .resize(MACOS_CANVAS, MACOS_CANVAS, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  fillBleed({ data: bitmap.data, width: bitmap.info.width, height: bitmap.info.height });

  return sharp(bitmap.data, {
    raw: { width: bitmap.info.width, height: bitmap.info.height, channels: 4 },
  })
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

  // 覆盖 macOS 的 icns：官方 CLI 直接沿用源图的自带圆角与透明四角，
  // 会被系统判为「成品外观」而走兼容渲染（加灰底板并缩小）。
  const canvas = await buildMacosCanvas();
  const icns = await writeIcns(canvas);
  fs.writeFileSync(icnsPath, icns);
  console.log(
    `macOS 图标已重建：icon.icns（满幅不透明方块 / 画布 ${MACOS_CANVAS}，` +
      `${ICNS_ENTRIES.length} 个尺寸，${icns.length} 字节）`,
  );
}

main().catch((error) => {
  console.error(`生成图标失败：${error.message}`);
  process.exitCode = 1;
});
