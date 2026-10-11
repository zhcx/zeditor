import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('macOS shortcuts use system notation instead of Windows notation', () => {
  assert.equal(formatShortcut('Ctrl+N', 'MacIntel'), '⌘N');
  assert.equal(formatShortcut('Ctrl+Shift+S', 'MacIntel'), '⇧⌘S');
  assert.equal(formatShortcut('Ctrl+Alt+V', 'MacIntel'), '⌥⌘V');
  assert.equal(formatShortcut('Ctrl+Shift+I', 'MacIntel'), '⇧⌘I');
  assert.equal(formatShortcut('F11', 'MacIntel'), '⌃⌘F');
  // macOS 的「重做」是 ⇧⌘Z，而不是 Windows 的 Ctrl+Y。
  assert.equal(formatShortcut('Ctrl+Y', 'MacIntel'), '⇧⌘Z');
  // 快捷键说明、状态栏等处使用空格写法（Ctrl P）。
  assert.equal(formatShortcut('Ctrl P', 'MacIntel'), '⌘P');
  // 同一函数也直接作用在整段说明文本上，必须保留换行与其它文字。
  assert.equal(
    formatShortcut('- Ctrl+Shift+S - 另存为\n- F11 - 全屏切换', 'MacIntel'),
    '- ⇧⌘S - 另存为\n- ⌃⌘F - 全屏切换',
  );
  // 中文操作说明（没有 ASCII 按键）：Ctrl + 滚轮 → ⌘ + 滚轮。
  assert.equal(formatShortcut('Ctrl + 滚轮缩放，拖动滚动条平移', 'MacIntel'), '⌘ + 滚轮缩放，拖动滚动条平移');
  // 其它平台保持原样。
  assert.equal(formatShortcut('Ctrl+Shift+S', 'Win32'), 'Ctrl+Shift+S');
  assert.equal(formatShortcut('F11', 'Win32'), 'F11');
  assert.equal(formatShortcut('Ctrl + 滚轮缩放', 'Win32'), 'Ctrl + 滚轮缩放');
});

test('native menu accelerators are produced in Tauri syntax', () => {
  assert.equal(toAccelerator('Ctrl+N'), 'CmdOrCtrl+N');
  assert.equal(toAccelerator('Ctrl+Shift+S'), 'CmdOrCtrl+Shift+S');
  assert.equal(toAccelerator('Ctrl+Alt+V'), 'CmdOrCtrl+Alt+V');
  assert.equal(toAccelerator('Ctrl+,'), 'CmdOrCtrl+Comma');
  // mac 上重做与全屏沿用系统惯例组合。
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

  // 应用菜单与文件菜单里的系统项。
  assert.equal(byId.get('app.quit')?.predefined, 'Quit');
  assert.equal(byId.get('app.quit')?.text, '退出 Zeditor');
  assert.equal(byId.get('app.services')?.predefined, 'Services');
  assert.equal(byId.get('file.closeWindow')?.predefined, 'CloseWindow');
  // 文件菜单以分隔线 + 关闭窗口收尾。
  const fileChildren = byId.get('menu.file')?.children ?? [];
  assert.deepEqual(fileChildren.map((node) => node.id).slice(-2), ['file.closeWindow.separator', 'file.closeWindow']);

  // 窗口内菜单独有的撤销/剪贴板项不进入原生菜单（改由「编辑」承担）。
  assert.equal(byId.has('feature.undo'), false);
  assert.equal(byId.has('feature.copy'), false);
  // 分隔线与加速键照搬模型。
  assert.equal(byId.get('feature.divider.insert')?.predefined, 'Separator');
  assert.equal(byId.get('feature.insertTable')?.accelerator, 'CmdOrCtrl+Shift+T');
  // 勾选项与子菜单层级保留。
  assert.equal(byId.get('feature.mode.split')?.kind, 'check');
  assert.equal(byId.get('feature.mode.split')?.checked, true);
  assert.equal(byId.get('feature.theme.vscode-dark')?.kind, 'check');
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
  assert.equal(translateUiText('帮助', 'zh-TW'), '幫助');
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
  assert.match(menuBar, /await menu\.setAsAppMenu\(\)/);
  assert.match(css, /html\[data-platform='macos'\]\[data-native-menu='active'\] \.titlebar \.menubar \{ display: none; \}/);
  // 菜单隐藏后标题栏中央内容仍然居中。
  assert.match(css, /html\[data-platform='macos'\]\[data-native-menu='active'\] \.titlebar-drag-spacer \{ padding-right: 72px; \}/);

  // ⌘, 打开设置（macOS 惯例），⌃⌘F 切换演示/全屏。
  assert.match(menuBar, /useAppStore\.getState\(\)\.setSettingsOpen\(true\)/);
  assert.match(menuBar, /event\.ctrlKey && event\.metaKey && event\.key\.toLowerCase\(\) === 'f'/);
  // 模型里的每一项都带稳定 id，原生菜单才能按 id 派发。
  assert.doesNotMatch(menuBar, /\{ label: t\(/, 'every menu entry must carry an id');
  assert.match(menuBar, /macNative: 'skip'/);
});
