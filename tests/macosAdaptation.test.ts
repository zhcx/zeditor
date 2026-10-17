import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { collectCheckedStates, collectMenuActions, findMenuItemById, type AppMenuItem } from '../src/utils/menuModel.ts';
import { planMacAppMenu, type NativePlanNode, type SystemMenuLabels } from '../src/utils/nativeMenu.ts';
import { formatShortcut, toAccelerator } from '../src/utils/platformShortcuts.ts';
import { translateUiText } from '../src/i18n/index.ts';

const read = (path: string) => readFileSync(path, 'utf8');

const labels: SystemMenuLabels = {
  edit: '编辑',
  window: '窗口',
  help: '帮助',
  undo: '撤销',
  redo: '重做',
  cut: '剪切',
  copy: '复制',
  paste: '粘贴',
  selectAll: '全选',
  minimize: '最小化',
  zoom: '缩放',
  bringAllToFront: '前置全部窗口',
  closeWindow: '关闭窗口',
  services: '服务',
  hideApp: '隐藏 Zeditor',
  hideOthers: '隐藏其他',
  showAll: '显示全部',
  quitApp: '退出 Zeditor',
};

const flat = (nodes: NativePlanNode[]): NativePlanNode[] =>
  nodes.flatMap((node) => [node, ...(node.children ? flat(node.children) : [])]);

test('macOS window uses the native overlay title bar with traffic lights', () => {
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
  // 实测按钮顶边约在 y-7.5pt：y=18 时红绿灯顶边约 10pt，在 34px 标题栏里居中。
  assert.deepEqual(window.trafficLightPosition, { x: 20, y: 18 });
  // 标题栏高度必须与红绿灯定位一致，否则系统按钮会偏出标题栏。
  assert.match(read('src/styles/macos.css'), /--ui-titlebar-height: 34px;/);
  // WKWebView 的不透明白底只有在私有 API 特性开启时才会被关闭。
  assert.equal(base.app.macOSPrivateApi, true);
  assert.match(read('src-tauri/Cargo.toml'), /"macos-private-api"/);
  // 窗口底色与原生主题跟随应用主题，需要对应权限。
  const capabilities = read('src-tauri/capabilities/default.json');
  assert.match(capabilities, /core:window:allow-set-background-color/);
  assert.match(capabilities, /core:window:allow-set-theme/);
  assert.match(capabilities, /core:window:allow-hide/);
  assert.match(capabilities, /core:window:allow-show/);
});

test('native system panels follow the app language', () => {
  const infoPlist = read('src-tauri/Info.plist');
  const macosConfig = JSON.parse(read('src-tauri/tauri.macos.conf.json'));

  assert.equal(macosConfig.bundle.macOS.infoPlist, 'Info.plist');
  assert.match(infoPlist, /<key>CFBundleDevelopmentRegion<\/key>/);
  assert.match(infoPlist, /<string>zh-Hans<\/string>/);
  assert.match(infoPlist, /<key>CFBundleLocalizations<\/key>/);
  assert.match(infoPlist, /<string>en<\/string>/);
});

test('macOS chrome is scoped to the platform flag written before first paint', () => {
  const app = read('src/App.tsx');
  const boot = read('public/theme-boot.js');
  const css = read('src/styles/macos.css');
  const titlebar = read('src/components/TitleBar/TitleBar.tsx');

  assert.match(app, /import '\.\/styles\/macos\.css';/);
  assert.match(boot, /setAttribute\('data-platform', platform\)/);
  // 首帧前落盘：否则标题栏会先按 Windows 布局渲染一帧。
  assert.ok(
    boot.indexOf("setAttribute('data-platform', platform)") < boot.indexOf("setAttribute('data-theme', theme)"),
    'platform must be resolved before the theme is applied',
  );
  // 样式层整体以 html[data-platform='macos'] 作用域，Windows / Linux 外观不受影响。
  assert.match(css, /html\[data-platform='macos'\] \.titlebar-controls \{ display: none; \}/);
  assert.match(css, /--macos-traffic-light-inset: 84px;/);
  assert.match(css, /padding-left: var\(--macos-traffic-light-inset\);/);
  // 自绘窗口按钮保留在 DOM 中供 Windows 使用，仅 macOS 隐藏。
  assert.match(titlebar, /className="titlebar-controls" data-tauri-drag-region="false"/);
  assert.match(titlebar, /titlebar-macos/);
  assert.match(titlebar, /titlebar-macos-fullscreen/);
});

test('macOS shortcuts use system notation and native accelerators', () => {
  assert.equal(formatShortcut('Ctrl+N', 'MacIntel'), '⌘N');
  assert.equal(formatShortcut('Ctrl+Shift+S', 'MacIntel'), '⇧⌘S');
  assert.equal(formatShortcut('Ctrl+Alt+V', 'MacIntel'), '⌥⌘V');
  assert.equal(formatShortcut('Ctrl+Shift+I', 'MacIntel'), '⇧⌘I');
  assert.equal(formatShortcut('F11', 'MacIntel'), '⌃⌘F');
  // macOS 的「重做」是 ⇧⌘Z，而不是 Windows 的 Ctrl+Y。
  assert.equal(formatShortcut('Ctrl+Y', 'MacIntel'), '⇧⌘Z');
  assert.equal(formatShortcut('Ctrl P', 'MacIntel'), '⌘P');
  // 同一函数也直接作用在整段说明文本上，必须保留换行与其它文字。
  assert.equal(
    formatShortcut('- Ctrl+Shift+S - 另存为\n- F11 - 全屏切换', 'MacIntel'),
    '- ⇧⌘S - 另存为\n- ⌃⌘F - 全屏切换',
  );
  assert.equal(formatShortcut('Ctrl + 滚轮缩放，拖动滚动条平移', 'MacIntel'), '⌘ + 滚轮缩放，拖动滚动条平移');
  // 其它平台保持原样。
  assert.equal(formatShortcut('Ctrl+Shift+S', 'Win32'), 'Ctrl+Shift+S');
  assert.equal(formatShortcut('F11', 'Win32'), 'F11');

  assert.equal(toAccelerator('Ctrl+N'), 'CmdOrCtrl+N');
  assert.equal(toAccelerator('Ctrl+Shift+S'), 'CmdOrCtrl+Shift+S');
  assert.equal(toAccelerator('Ctrl+Alt+V'), 'CmdOrCtrl+Alt+V');
  assert.equal(toAccelerator('Ctrl+,'), 'CmdOrCtrl+Comma');
  assert.equal(toAccelerator('Ctrl+Y'), 'CmdOrCtrl+Shift+Z');
  assert.equal(toAccelerator('F11'), 'Ctrl+Cmd+F');
  assert.equal(toAccelerator(''), undefined);
});

test('planMacAppMenu mirrors the in-app model into the system menu bar', () => {
  const featureItems: AppMenuItem[] = [
    { id: 'feature.undo', label: '撤销', shortcut: 'Ctrl+Z', macNative: 'skip', action: () => undefined },
    { id: 'feature.copy', label: '复制', shortcut: 'Ctrl+C', macNative: 'skip' },
    { id: 'feature.divider.insert', divider: true, label: '' },
    { id: 'feature.insertTable', label: '插入表格', shortcut: 'Ctrl+Shift+T', action: () => undefined },
    { id: 'feature.mode.split', label: '分屏模式', checked: true, action: () => undefined },
    {
      id: 'feature.theme',
      label: '主题',
      children: [
        { id: 'feature.theme.vscode-dark', label: '深色', checked: true, action: () => undefined },
        { id: 'feature.theme.vscode-light', label: '浅色', checked: false, action: () => undefined },
      ],
    },
  ];

  const plan = planMacAppMenu({
    appName: 'Zeditor',
    fileLabel: '文件',
    featureLabel: '功能',
    appMenuItems: [{ id: 'app.about', label: '关于 Zeditor', action: () => undefined }],
    fileItems: [{ id: 'file.save', label: '保存', shortcut: 'Ctrl+S', action: () => undefined }],
    featureItems,
    helpItems: [{ id: 'help.shortcuts', label: '快捷键说明', action: () => undefined }],
    labels,
  });

  // 顶层必须是子菜单（macOS 系统菜单栏只接受子菜单），且顺序固定。
  assert.deepEqual(plan.map((node) => node.id), [
    'menu.app', 'menu.file', 'menu.edit', 'menu.feature', 'menu.window', 'menu.help',
  ]);
  assert.ok(plan.every((node) => node.kind === 'submenu'));
  assert.deepEqual(plan.map((node) => node.text), ['Zeditor', '文件', '编辑', '功能', '窗口', '帮助']);

  const nodes = flat(plan);
  const byId = new Map(nodes.map((node) => [node.id, node]));

  // 系统标准项由预定义项承担，保证原生行为（撤销/剪贴板/窗口）。
  assert.deepEqual(
    flat(byId.get('menu.edit')?.children ?? []).map((node) => node.predefined),
    ['Undo', 'Redo', 'Separator', 'Cut', 'Copy', 'Paste', 'Separator', 'SelectAll'],
  );
  assert.deepEqual(
    flat(byId.get('menu.window')?.children ?? []).map((node) => node.predefined),
    ['Minimize', 'Maximize', 'Separator', 'BringAllToFront'],
  );
  assert.equal(byId.get('app.quit')?.predefined, 'Quit');
  assert.equal(byId.get('app.services')?.predefined, 'Services');
  assert.equal(byId.get('file.closeWindow')?.predefined, 'CloseWindow');

  // 窗口内独有的撤销/剪贴板项不进入原生菜单（改由「编辑」承担）。
  assert.equal(byId.has('feature.undo'), false);
  assert.equal(byId.has('feature.copy'), false);
  assert.equal(byId.get('feature.insertTable')?.accelerator, 'CmdOrCtrl+Shift+T');
  assert.equal(byId.get('feature.mode.split')?.kind, 'check');
  assert.equal(byId.get('feature.mode.split')?.checked, true);
  assert.equal(byId.get('feature.theme.vscode-light')?.checked, false);
});

test('menu model helpers cover nested items so actions and checks stay in sync', () => {
  const items: AppMenuItem[] = [
    { id: 'a', label: 'A', action: () => undefined },
    { id: 'b', label: 'B', checked: true, action: () => undefined },
    { id: 'c', label: 'C', children: [{ id: 'c1', label: 'C1', checked: false, action: () => undefined }] },
  ];

  const actions = collectMenuActions(items);
  assert.deepEqual([...actions.keys()].sort(), ['a', 'b', 'c1']);
  assert.deepEqual(collectCheckedStates(items), { b: true, c1: false });
  assert.equal(findMenuItemById(items, 'c1')?.label, 'C1');
});

test('system menu labels are localized for every supported language family', () => {
  assert.equal(translateUiText('编辑', 'en'), 'Edit');
  assert.equal(translateUiText('窗口', 'en'), 'Window');
  assert.equal(translateUiText('帮助', 'en'), 'Help');
  assert.equal(translateUiText('服务', 'en'), 'Services');
  assert.equal(translateUiText('显示全部', 'en'), 'Show All');
  assert.equal(translateUiText('关闭窗口', 'en'), 'Close Window');
  assert.equal(translateUiText('退出 Zeditor', 'en'), 'Quit Zeditor');
  assert.equal(translateUiText('编辑', 'zh-TW'), '編輯');
  assert.equal(translateUiText('帮助', 'zh-TW'), '說明');
  assert.equal(translateUiText('编辑', 'ja'), '編集');
  assert.equal(translateUiText('编辑', 'ko'), '편집');
  assert.equal(translateUiText('编辑', 'zh-CN'), '编辑');
});

test('macOS integration hides the in-window menubar and falls back when it fails', () => {
  const menuBar = read('src/components/MenuBar/MenuBar.tsx');
  const css = read('src/styles/macos.css');

  // 原生菜单安装成功后写入标记；失败时不写，CSS 便保留窗口内菜单。
  assert.match(menuBar, /document\.documentElement\.dataset\.nativeMenu = 'active'/);
  assert.match(menuBar, /delete document\.documentElement\.dataset\.nativeMenu/);
  assert.match(menuBar, /await menu\.setAsAppMenu\(\)|\.then\(menu => menu\.setAsAppMenu\(\)\)/);
  assert.match(css, /html\[data-platform='macos'\]\[data-native-menu='active'\] \.titlebar \.menubar \{ display: none; \}/);
  assert.match(css, /html\[data-platform='macos'\]\[data-native-menu='active'\] \.titlebar-drag-spacer \{ padding-right: 72px; \}/);
  // 模型里的撤销/剪贴板项只在窗口内菜单出现。
  assert.match(menuBar, /macNative: 'skip'/);
  // ⌘, 打开设置（macOS 惯例），⌃⌘F 切换全屏。
  assert.match(menuBar, /shortcut: 'Ctrl\+,'/);
  assert.match(read('src/App.tsx'), /event\.ctrlKey && event\.metaKey/);
});

test('window lifecycle follows macOS conventions', () => {
  const app = read('src/App.tsx');
  const main = read('src-tauri/src/main.rs');

  // 关闭窗口只隐藏窗口，应用常驻 Dock；退出才销毁进程。
  assert.match(app, /isMacOS\(\) && closeMode === 'window'/);
  assert.match(app, /await currentWindow\.hide\(\)/);
  assert.match(app, /requestAppClose\(undefined, 'quit'\)/);
  // 窗口隐藏时触发退出仍要能看到未保存确认框。
  assert.match(app, /await currentWindow\.show\(\)/);
  assert.match(app, /listen\('zeditor-window-reopened'/);
  // 点按 Dock 图标（Reopen）恢复窗口；Finder 打开文件走 Apple Event。
  assert.match(main, /tauri::RunEvent::Reopen \{/);
  assert.match(main, /zeditor-window-reopened/);
  assert.match(main, /tauri::RunEvent::Opened \{ urls \}/);
  assert.match(main, /zeditor-quit-requested/);
  // 退出闸门：只有前端确认后才放行，避免 app.exit 被自己的守卫拦住。
  assert.match(main, /struct ExitState\(AtomicBool\)/);
  assert.match(main, /api\.prevent_exit\(\)/);
  // 窗口底色按 Rust 命令的真实参数名（value）调用，并兼容旧的 color 键。
  assert.match(app, /invoke\('plugin:window\|set_background_color', \{ label: null, value: color, color \}\)/);
  assert.match(app, /classList\.add\('window-resizing'\)/);
  assert.match(read('src/styles/macos.css'), /html\[data-platform='macos'\]\.window-resizing/);
});
