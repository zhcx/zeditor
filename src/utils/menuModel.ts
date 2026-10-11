/**
 * 应用菜单模型：窗口内自绘菜单栏（Windows / Linux）与 macOS 系统菜单栏
 * （原生 NSMenu）共用同一份定义，避免两端菜单各自维护而漂移。
 *
 * 每个条目都必须带稳定 `id`：原生菜单点击后按 id 回到最新一次渲染的模型上
 * 取动作闭包，这样菜单项不必随每次渲染重建。
 */
export interface AppMenuItem {
  /** 稳定标识，原生菜单据此派发动作、同步勾选态。 */
  id: string;
  label: string;
  action?: () => void;
  /** 应用内快捷键文案（如 `Ctrl+Shift+S`），展示与加速键转换共用。 */
  shortcut?: string;
  divider?: boolean;
  children?: AppMenuItem[];
  /** 单选型菜单项的当前选中态，窗口内渲染为前置 ✓，原生菜单用勾选项。 */
  checked?: boolean;
  /**
   * `skip`：只保留在窗口内菜单里，不进入 macOS 原生菜单。
   * 例如「功能」里的撤销/剪贴板项，在 macOS 上由系统标准「编辑」菜单承担。
   */
  macNative?: 'skip';
}

export interface AppMenuGroup {
  label: string;
  variant?: 'app';
  items: AppMenuItem[];
}

function walk(items: AppMenuItem[], visit: (item: AppMenuItem) => void) {
  for (const item of items) {
    visit(item);
    if (item.children?.length) walk(item.children, visit);
  }
}

/** 汇总菜单模型里的所有动作，供原生菜单按 id 派发。 */
export function collectMenuActions(...itemLists: AppMenuItem[][]): Map<string, () => void> {
  const actions = new Map<string, () => void>();
  for (const items of itemLists) {
    walk(items, (item) => {
      if (item.action) actions.set(item.id, item.action);
    });
  }
  return actions;
}

/** 汇总带勾选态的条目（模式、主题、语言），用于同步原生勾选项。 */
export function collectCheckedStates(...itemLists: AppMenuItem[][]): Record<string, boolean> {
  const states: Record<string, boolean> = {};
  for (const items of itemLists) {
    walk(items, (item) => {
      if (item.checked !== undefined) states[item.id] = item.checked;
    });
  }
  return states;
}

/** 按 id 深度查找菜单项（子菜单优先命中自身）。 */
export function findMenuItemById(items: AppMenuItem[], id: string): AppMenuItem | undefined {
  for (const item of items) {
    if (item.id === id) return item;
    const child = item.children?.length ? findMenuItemById(item.children, id) : undefined;
    if (child) return child;
  }
  return undefined;
}
