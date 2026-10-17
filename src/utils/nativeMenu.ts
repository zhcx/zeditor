/**
 * macOS 系统菜单栏（原生 NSMenu）构建器。
 *
 * 窗口内的自绘菜单栏在 macOS 上会隐藏，改由系统菜单栏承担：应用菜单、文件、
 * 编辑、功能、窗口、帮助全部来自 {@link AppMenuItem} 模型，点击后按 id 派发回
 * 最新一次渲染的模型（见 collectMenuActions），因此菜单不需要随每次渲染重建。
 *
 * 结构（planMacAppMenu）与创建（buildMacAppMenu）分离：结构是纯函数，便于在
 * 单元测试里断言菜单层级、文案与加速键，而不需要真的连上 Tauri 运行时。
 *
 * 权限：core:default 已包含 core:menu:default（allow-new / allow-set-as-app-menu /
 * allow-set-checked 等），无需额外配置 capabilities。
 */
import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu } from '@tauri-apps/api/menu';
import type { AppMenuItem } from './menuModel.ts';
import { toAccelerator } from './platformShortcuts.ts';

/** 系统预定义（原生行为）项。 */
export type NativePredefinedKind =
  | 'Separator'
  | 'Undo'
  | 'Redo'
  | 'Cut'
  | 'Copy'
  | 'Paste'
  | 'SelectAll'
  | 'Minimize'
  | 'Maximize'
  | 'CloseWindow'
  | 'Services'
  | 'Hide'
  | 'HideOthers'
  | 'ShowAll'
  | 'Quit'
  | 'BringAllToFront';

export interface NativePlanNode {
  id: string;
  kind: 'submenu' | 'item' | 'check' | 'predefined';
  text?: string;
  accelerator?: string;
  checked?: boolean;
  predefined?: NativePredefinedKind;
  /** 点击时派发到窗口内菜单模型的 id（预定义项不需要）。 */
  dispatchId?: string;
  children?: NativePlanNode[];
}

/** 系统标准菜单与预定义项的本地化文案。 */
export interface SystemMenuLabels {
  edit: string;
  window: string;
  help: string;
  undo: string;
  redo: string;
  cut: string;
  copy: string;
  paste: string;
  selectAll: string;
  minimize: string;
  zoom: string;
  bringAllToFront: string;
  closeWindow: string;
  services: string;
  hideApp: string;
  hideOthers: string;
  showAll: string;
  quitApp: string;
}

export interface PlanMacMenuOptions {
  appName: string;
  /** 「文件」/「功能」顶层标题（来自菜单模型，已本地化）。 */
  fileLabel: string;
  featureLabel: string;
  appMenuItems: AppMenuItem[];
  fileItems: AppMenuItem[];
  featureItems: AppMenuItem[];
  helpItems: AppMenuItem[];
  labels: SystemMenuLabels;
}

type NativeEntry = Submenu | MenuItem | CheckMenuItem | PredefinedMenuItem;

function safeAccelerator(shortcut?: string): string | undefined {
  return shortcut ? toAccelerator(shortcut) : undefined;
}

/** 把窗口内菜单模型的条目转成原生菜单节点（跳过只属于窗口内的条目）。 */
function planItems(items: AppMenuItem[]): NativePlanNode[] {
  const planned: NativePlanNode[] = [];
  for (const item of items) {
    if (item.macNative === 'skip') continue;
    if (item.divider) {
      planned.push({ id: item.id, kind: 'predefined', predefined: 'Separator' });
      continue;
    }
    if (item.children?.length) {
      planned.push({
        id: item.id,
        kind: 'submenu',
        text: item.label,
        children: planItems(item.children),
      });
      continue;
    }
    planned.push({
      id: item.id,
      kind: item.checked === undefined ? 'item' : 'check',
      text: item.label,
      accelerator: safeAccelerator(item.shortcut),
      checked: item.checked,
      dispatchId: item.id,
    });
  }
  return planned;
}

function predefined(id: string, kind: NativePredefinedKind, text?: string): NativePlanNode {
  return { id, kind: 'predefined', predefined: kind, text };
}

/**
 * 规划 macOS 系统菜单栏结构：Zeditor（应用菜单）/ 文件 / 编辑 / 功能 / 窗口 / 帮助。
 * 「编辑」「窗口」使用系统预定义项，保证撤销、剪贴板、最小化与前置窗口行为与
 * 原生应用一致。
 */
export function planMacAppMenu(options: PlanMacMenuOptions): NativePlanNode[] {
  const { labels } = options;

  const appMenu: NativePlanNode[] = [
    ...planItems(options.appMenuItems),
    predefined('app.services.separator', 'Separator'),
    predefined('app.services', 'Services', labels.services),
    predefined('app.hide.separator', 'Separator'),
    predefined('app.hide', 'Hide', labels.hideApp),
    predefined('app.hideOthers', 'HideOthers', labels.hideOthers),
    predefined('app.showAll', 'ShowAll', labels.showAll),
    predefined('app.quit.separator', 'Separator'),
    predefined('app.quit', 'Quit', labels.quitApp),
  ];

  const fileMenu: NativePlanNode[] = [
    ...planItems(options.fileItems),
    predefined('file.closeWindow.separator', 'Separator'),
    // ⌘W 关闭窗口：系统行为，仍会经过窗口的 CloseRequested 未保存守卫。
    predefined('file.closeWindow', 'CloseWindow', labels.closeWindow),
  ];

  const editMenu: NativePlanNode[] = [
    predefined('edit.undo', 'Undo', labels.undo),
    predefined('edit.redo', 'Redo', labels.redo),
    predefined('edit.clipboard.separator', 'Separator'),
    predefined('edit.cut', 'Cut', labels.cut),
    predefined('edit.copy', 'Copy', labels.copy),
    predefined('edit.paste', 'Paste', labels.paste),
    predefined('edit.selectAll.separator', 'Separator'),
    predefined('edit.selectAll', 'SelectAll', labels.selectAll),
  ];

  const windowMenu: NativePlanNode[] = [
    predefined('window.minimize', 'Minimize', labels.minimize),
    predefined('window.zoom', 'Maximize', labels.zoom),
    predefined('window.front.separator', 'Separator'),
    predefined('window.bringAllToFront', 'BringAllToFront', labels.bringAllToFront),
  ];

  return [
    { id: 'menu.app', kind: 'submenu', text: options.appName, children: appMenu },
    { id: 'menu.file', kind: 'submenu', text: options.fileLabel, children: fileMenu },
    { id: 'menu.edit', kind: 'submenu', text: labels.edit, children: editMenu },
    { id: 'menu.feature', kind: 'submenu', text: options.featureLabel, children: planItems(options.featureItems) },
    { id: 'menu.window', kind: 'submenu', text: labels.window, children: windowMenu },
    { id: 'menu.help', kind: 'submenu', text: labels.help, children: planItems(options.helpItems) },
  ];
}

export interface BuildMacMenuOptions extends PlanMacMenuOptions {
  /** 点击原生菜单项时按 id 派发到窗口内菜单模型。 */
  dispatch: (id: string) => void;
  /** 登记勾选项，供后续同步选中态。 */
  registerCheckItem: (id: string, item: CheckMenuItem) => void;
}

async function createNode(node: NativePlanNode, options: BuildMacMenuOptions): Promise<NativeEntry> {
  if (node.kind === 'submenu') {
    const children: NativeEntry[] = [];
    for (const child of node.children ?? []) children.push(await createNode(child, options));
    return Submenu.new({ id: node.id, text: node.text ?? '', items: children });
  }

  if (node.kind === 'predefined') {
    return PredefinedMenuItem.new({ item: node.predefined ?? 'Separator', text: node.text });
  }

  const action = node.dispatchId ? () => options.dispatch(node.dispatchId as string) : undefined;

  if (node.kind === 'check') {
    const item = await CheckMenuItem.new({
      id: node.id,
      text: node.text ?? '',
      checked: Boolean(node.checked),
      accelerator: node.accelerator,
      action,
    });
    options.registerCheckItem(node.id, item);
    return item;
  }

  try {
    return await MenuItem.new({ id: node.id, text: node.text ?? '', accelerator: node.accelerator, action });
  } catch {
    // 个别加速键不被系统接受时退化为无加速键，避免整份菜单构建失败。
    return MenuItem.new({ id: node.id, text: node.text ?? '', action });
  }
}

/** 按规划好的结构创建并返回 macOS 应用菜单。 */
export async function buildMacAppMenu(options: BuildMacMenuOptions): Promise<Menu> {
  const items: NativeEntry[] = [];
  for (const node of planMacAppMenu(options)) items.push(await createNode(node, options));
  return Menu.new({ items });
}
