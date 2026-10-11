/**
 * 生成各平台应用图标。
 *
 * Windows / Linux / 浏览器：直接由满幅方形源图派生（`tauri icon` + 网页图标），
 * 图形铺满画布，符合任务栏、开始菜单与 favicon 的展示习惯。
 *
 * macOS：**不能**沿用满幅方图。Apple 的 macOS 图标网格要求图形收敛到
 * 1024×1024 画布内的圆角矩形「安全区」（内容区 824×824，即画布的 80.5%），
 * 四周留透明边距。若图形明显超出安全区（本项目的源图占 98.6%），系统会
 * 自行把图形缩进到标准网格，并用默认浅灰底板填补腾出的边缘——外观上就是
 * 图标外面多了一圈空白。因此这里在官方 CLI 生成之后单独重建 icns：
 *   裁到 alpha 包围盒 → 缩放到 824×824 → 居中合成到 1024 透明画布 → 封装 ICNS。
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

/** macOS 图标网格：1024 画布内的内容区尺寸与标准圆角半径。 */
const MACOS_CANVAS = 1024;
const MACOS_CONTENT = 824;
const MACOS_RADIUS = 185.4;

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

/** 按 macOS 网格产出 1024×1024 透明画布图。 */
async function buildMacosCanvas() {
  const meta = await sharp(sourceIcon).metadata();
  const box = await alphaBoundingBox(sourceIcon);
  console.log(
    `  源图 ${meta.width}×${meta.height}，图形包围盒 ${box.width}×${box.height}` +
      `（占源图画布 ${(box.width / meta.width * 100).toFixed(1)}%），按安全区缩放到 ${MACOS_CONTENT}`,
  );

  // 裁到实际图形后缩放到内容区，保证图形恰好占满 80.5%，不因源图自带边距而偏小。
  const artwork = await sharp(sourceIcon)
    .extract(box)
    .resize(MACOS_CONTENT, MACOS_CONTENT, { fit: 'fill' })
    .png()
    .toBuffer();

  const offset = (MACOS_CANVAS - MACOS_CONTENT) / 2;
  return sharp({
    create: {
      width: MACOS_CANVAS,
      height: MACOS_CANVAS,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: artwork, top: offset, left: offset }])
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

  // 覆盖 macOS 的 icns：官方 CLI 产出的是满幅方图，不符合安全区要求。
  const canvas = await buildMacosCanvas();
  const icns = await writeIcns(canvas);
  fs.writeFileSync(icnsPath, icns);
  console.log(
    `macOS 图标已重建：icon.icns（内容区 ${MACOS_CONTENT}×${MACOS_CONTENT} / ` +
      `画布 ${MACOS_CANVAS} / 标准圆角 ${MACOS_RADIUS}，${ICNS_ENTRIES.length} 个尺寸，${icns.length} 字节）`,
  );
  console.log(`macOS 内容占比 ${(MACOS_CONTENT / MACOS_CANVAS * 100).toFixed(1)}%（Apple 标准）`);
}

main().catch((error) => {
  console.error(`生成图标失败：${error.message}`);
  process.exitCode = 1;
});
