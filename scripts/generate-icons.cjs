const { execFileSync } = require('node:child_process');
const path = require('node:path');
const sharp = require('sharp');

const projectRoot = path.resolve(__dirname, '..');
const sourceIcon = path.join(projectRoot, 'src-tauri', 'icons', 'app-icon.png');
const tauriCli = require.resolve('@tauri-apps/cli/tauri.js');

// 使用用户提供的应用图标生成全部平台尺寸，保留原图的颜色、折叠细节与透明度。
execFileSync(process.execPath, [tauriCli, 'icon', sourceIcon], {
  cwd: projectRoot,
  stdio: 'inherit',
});

async function generateWebIcons() {
  await sharp(sourceIcon).resize(64, 64).png().toFile(path.join(projectRoot, 'public', 'app-icon.png'));
  await sharp(sourceIcon).resize(32, 32).png().toFile(path.join(projectRoot, 'public', 'favicon.png'));
}
generateWebIcons().catch(error => { console.error(error); process.exitCode = 1; });
