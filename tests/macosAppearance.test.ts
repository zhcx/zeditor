import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path: string) => readFileSync(path, 'utf8');

test('macOS uses the native overlay title bar and enables the private API', () => {
  const base = JSON.parse(read('src-tauri/tauri.conf.json'));
  const macosPath = 'src-tauri/tauri.macos.conf.json';
  assert.ok(existsSync(macosPath), 'missing platform-level macOS configuration');

  const macos = JSON.parse(read(macosPath));
  const window = macos.app.windows[0];

  // 平台配置按 RFC 7396 合并，数组会被整体替换，因此必须自带完整的窗口定义。
  for (const key of [
    'label', 'title', 'width', 'height', 'minWidth', 'minHeight', 'resizable',
    'center', 'dragDropEnabled', 'backgroundColor', 'visible',
  ]) {
    assert.ok(key in window, `macOS window configuration is missing ${key}`);
  }

  assert.equal(window.decorations, true);
  assert.equal(window.titleBarStyle, 'Overlay');
  assert.equal(window.hiddenTitle, true);
  assert.equal(window.acceptFirstMouse, true);
  // 系统标题栏容器高度 = 红绿灯高度(14) + y = 34px，与 macos.css 的固定标题栏
  // 高度一致，红绿灯因此在标题栏里垂直居中。
  assert.deepEqual(window.trafficLightPosition, { x: 20, y: 20 });
  assert.match(read('src/styles/macos.css'), /--ui-titlebar-height: 34px;/);

  // macOS 从 Finder 双击 .md 走 Apple Event，必须由 RunEvent::Opened 接住。
  assert.match(read('src-tauri/src/main.rs'), /tauri::RunEvent::Opened \{ urls \}/);

  // WKWebView 的不透明白底只有在私有 API 特性开启时才会被关闭，
  // 这正是「最大化后先露出大面积白边」的成因。
  assert.equal(base.app.macOSPrivateApi, true);
  assert.match(read('src-tauri/Cargo.toml'), /"macos-private-api"/);
  // 窗口底色由前端跟随主题同步，需要对应权限。
  assert.match(read('src-tauri/capabilities/default.json'), /core:window:allow-set-background-color/);
});

test('macOS chrome is scoped to the platform flag written before first paint', () => {
  const app = read('src/App.tsx');
  const boot = read('public/theme-boot.js');
  const css = read('src/styles/macos.css');
  const titlebar = read('src/components/TitleBar/TitleBar.tsx');

  assert.match(app, /import '\.\/styles\/macos\.css';/);
  assert.match(boot, /document\.documentElement\.setAttribute\('data-platform', platform\);/);
  // 样式层整体以 html[data-platform='macos'] 作用域，Windows / Linux 外观不受影响。
  assert.match(css, /html\[data-platform='macos'\] \.titlebar-controls \{ display: none; \}/);
  assert.match(css, /--macos-traffic-light-inset: 78px;/);
  // 自绘窗口按钮保留在 DOM 中供 Windows 使用，仅 macOS 隐藏。
  assert.match(titlebar, /className="titlebar-controls" data-tauri-drag-region="false"/);
  assert.match(titlebar, /titlebar-macos/);
});

test('window background follows the theme and native quit keeps the unsaved guard', () => {
  const app = read('src/App.tsx');
  const main = read('src-tauri/src/main.rs');

  // 窗口底色必须按 Rust 命令的真实参数名（value）调用：@tauri-apps/api 的
  // window.setBackgroundColor 发送的是 `color`，与 Tauri 2.11 的命令签名不匹配，
  // 调用会因缺少 value 而失败并被静默吞掉——这正是「窗口底色一直停留在系统
  // 默认色（浅色外观下为白色）、最大化动画露出白底」的根因。保留 color 作为
  // 未来版本改名的兼容回退。
  assert.match(app, /invoke\('plugin:window\|set_background_color', args\)/);
  assert.match(app, /\{ label, value: color \}, \{ label, color \}/);
  assert.doesNotMatch(app, /getCurrentWindow\(\)\.setBackgroundColor\(/);
  // 原生窗口外观跟随应用主题（标题栏材质 / 系统面板明暗）。
  assert.match(app, /syncNativeWindowTheme/);
  assert.match(read('src-tauri/capabilities/default.json'), /core:window:allow-set-theme/);
  // 自研 objc2 原生调用曾导致启动即崩溃：msg_send! 的 Rust panic 穿不过
  // exception::catch 的 C trampoline（panic=abort），必须彻底禁止回归。
  assert.doesNotMatch(app, /sync_macos_window_background/);
  assert.doesNotMatch(read('src-tauri/src/main.rs'), /sync_macos_window_background|mod macos_window/);
  assert.doesNotMatch(read('src-tauri/Cargo.toml'), /objc2\s*=/);
  // 缩放开始时重新应用窗口底色：WKWebView 会随尺寸变化重置自身背景。
  assert.match(app, /if \(resizeTimer === null\) syncNativeWindowBackground\(\);/);
  assert.match(app, /addEventListener\('zeditor-theme-change', applyWindowBackgroundColor\)/);
  assert.match(app, /listen\('zeditor-quit-requested'/);
  assert.match(main, /RunEvent::ExitRequested/);
  assert.match(main, /window\.emit\("zeditor-quit-requested", \(\)\)/);
});

test('native macOS panels follow the app language', () => {
  // 缺少本地化声明时，macOS 认为应用只支持开发区域（English），
  // 「打开 / 保存」等系统面板会一律显示英文。
  const infoPlist = read('src-tauri/Info.plist');
  const macosConfig = JSON.parse(read('src-tauri/tauri.macos.conf.json'));

  assert.equal(macosConfig.bundle.macOS.infoPlist, 'Info.plist');
  assert.match(infoPlist, /<key>CFBundleDevelopmentRegion<\/key>/);
  assert.match(infoPlist, /<string>zh-Hans<\/string>/);
  assert.match(infoPlist, /<key>CFBundleLocalizations<\/key>/);
  assert.match(infoPlist, /<string>en<\/string>/);
});

test('closing the window keeps the app resident in the Dock and reopens on demand', () => {
  const app = read('src/App.tsx');
  const main = read('src-tauri/src/main.rs');
  const capabilities = read('src-tauri/capabilities/default.json');

  // macOS 惯例：关闭窗口只隐藏窗口，应用常驻 Dock；只有退出才销毁窗口。
  assert.match(app, /mode === 'window' && isMacOS\(\)/);
  assert.match(app, /await getCurrentWindow\(\)\.hide\(\)/);
  assert.match(app, /requestAppClose\(undefined, 'quit'\)/);
  // 窗口隐藏时触发退出仍要能看到未保存确认框。
  assert.match(app, /current\.show\(\)\.then\(\(\) => current\.setFocus\(\)\)/);
  assert.match(app, /listen\('zeditor-window-reopened'/);
  // 点按 Dock 图标（Reopen）恢复窗口。rustfmt 会把该 match 臂折成多行，
  // 因此正则容忍换行与缩进差异。
  assert.match(main, /tauri::RunEvent::Reopen \{\s*has_visible_windows,\s*\.\.\s*\}/);
  assert.match(main, /window\.emit\("zeditor-window-reopened", \(\)\)/);
  // 隐藏/显示/聚焦需要对应权限。
  assert.match(capabilities, /core:window:allow-hide/);
  assert.match(capabilities, /core:window:allow-show/);
  assert.match(capabilities, /core:window:allow-set-focus/);
});

test('maximizing no longer shows an unpainted band before the UI catches up', () => {
  const app = read('src/App.tsx');
  const mainRs = read('src-tauri/src/main.rs');

  // WKWebView 重绘前的新区域显示的是它自己的白色不透明图层。修复方式：
  // 1) macos-private-api + 前端 setBackgroundColor（wry 会关闭 WebView 白底
  //    并设置 underPageBackgroundColor），且在缩放开始时重新应用；
  // 2) 缩放期间临时关闭毛玻璃/阴影/过渡，降低重绘开销。
  // 禁止再引入 NSWindow.setAnimationBehavior / setWantsLayer / 自研 objc2
  // 调用——实测会触发 tao drawRect 回调里的 unwrap panic 或无法捕获的
  // Rust panic（panic=abort），导致进程崩溃。
  assert.match(mainRs, /pub\(crate\) fn log_startup/);
  assert.match(app, /if \(resizeTimer === null\) syncNativeWindowBackground\(\);/);
  assert.match(app, /classList\.add\('window-resizing'\)/);
  assert.match(read('src/styles/main.css'), /html\.window-resizing \*/);
  assert.doesNotMatch(mainRs, /setAnimationBehavior|setWantsLayer/);
  // 窗口初始底色 = 默认深色主题的应用底色（vscode-dark 的 bg-app）。
  assert.equal(JSON.parse(read('src-tauri/tauri.macos.conf.json')).app.windows[0].backgroundColor, '#21242b');
  // 缩放期间不做逐帧重排（面板是 flex 比例，会自行跟随窗口），
  // 避免 React 重渲染拖慢 WebView 重绘。
  assert.match(app, /const scheduleRebalance = \(\) => \{/);
  // 尺寸稳定 150ms 后才重排面板。
  assert.match(app, /resizeTimer = window\.setTimeout\(\(\) => \{[\s\S]*?rebalancePanels\(\);[\s\S]*?\}, 150\);/);
  assert.match(app, /window\.addEventListener\('resize', scheduleRebalance\)/);
});
