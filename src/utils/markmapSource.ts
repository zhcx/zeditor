/**
 * Markmap 思维导图相关的常量与纯函数。
 *
 * Markmap 直接复用标准 Markdown 标题层级（`#` / `##` / `###`）作为树的形状，
 * 因此不需要新的 DSL：` ```markmap ` 围栏里的内容就是一份普通 Markdown。
 * 这里只放与预览管线、插入入口共用的纯逻辑，渲染与交互在 MarkmapViewer 中完成。
 */

/** Markdown 代码围栏里可被识别为思维导图的语言标记。 */
export const MARKMAP_FENCE_SELECTOR = 'code.language-markmap';

/**
 * 插入模板：一级标题是中心主题，二级标题是一级分支，三级标题是分支要点。
 * 斜杠命令、工具栏与功能菜单共用同一份模板，保证插入结果一致。
 */
export const MARKMAP_TEMPLATE = [
  '```markmap',
  '# 中心主题',
  '',
  '## 分支一',
  '### 要点 1',
  '### 要点 2',
  '',
  '## 分支二',
  '### 要点 3',
  '```',
].join('\n');

/** 插入后默认选中的区间（中心主题），让用户直接改写根节点。 */
export const MARKMAP_TEMPLATE_SELECTION = {
  start: MARKMAP_TEMPLATE.indexOf('中心主题'),
  end: MARKMAP_TEMPLATE.indexOf('中心主题') + '中心主题'.length,
};

export type MarkmapTheme = 'light' | 'dark';

/** 当前主题：与 Mermaid 一样跟随 `html[data-theme]` 的明暗后缀。 */
export function readMarkmapTheme(): MarkmapTheme {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.dataset.theme?.endsWith('-dark') ? 'dark' : 'light';
}

/** 一级分支配色：同一条分支下的所有节点共用一个颜色，明暗主题各一套。 */
export const MARKMAP_BRANCH_COLORS: Record<MarkmapTheme, readonly string[]> = {
  light: ['#2d6ae0', '#0f9488', '#c2410c', '#7c3aed', '#be123c', '#15803d', '#a16207', '#0e7490'],
  dark: ['#58a6ff', '#2dd4bf', '#f0883e', '#c084fc', '#f87171', '#4ade80', '#e3b341', '#38bdf8'],
};

/**
 * 节点内部排版变量（markmap 自带 CSS 全部走 `--markmap-*` 变量）。
 * 由渲染组件作为内联样式写到 `<svg>` 上：既覆盖全局样式，导出 PNG 时也会随
 * SVG 一起克隆，无需额外注入样式表。
 */
export const MARKMAP_THEME_VARIABLES: Record<MarkmapTheme, Record<string, string>> = {
  light: {
    '--markmap-text-color': '#2e3640',
    '--markmap-a-color': '#2d6ae0',
    '--markmap-a-hover-color': '#2457bd',
    '--markmap-code-bg': '#f4f5f7',
    '--markmap-code-color': '#5b6572',
    '--markmap-highlight-bg': '#ffe9a8',
    '--markmap-circle-open-bg': '#ffffff',
  },
  dark: {
    '--markmap-text-color': '#c6cdd6',
    '--markmap-a-color': '#58a6ff',
    '--markmap-a-hover-color': '#7ab5ff',
    '--markmap-code-bg': '#2f343d',
    '--markmap-code-color': '#c6cdd6',
    '--markmap-highlight-bg': '#5b4a15',
    '--markmap-circle-open-bg': '#22262c',
  },
};

/** 导出 PNG 的底色：与预览文档背景一致，避免透明底在浅色文档里看不清分支。 */
export const MARKMAP_BACKGROUND: Record<MarkmapTheme, string> = {
  light: '#ffffff',
  dark: '#22262c',
};

/** 节点字体（markmap 的 `--markmap-font` 是 font 简写，需要一次性给出全部字段）。 */
export const MARKMAP_FONT = "300 15px/20px -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif";

/**
 * 取节点所属一级分支的颜色。
 * `state.path` 是节点 id 的点连接路径（根为 `1`，第二层为 `1.3`），
 * 因此第二段就是所属的一级分支序号。
 */
export function branchColor(colors: readonly string[], path: string | undefined): string {
  if (colors.length === 0) return 'currentColor';
  const segments = String(path ?? '').split('.');
  const branch = segments.length > 1 ? Number(segments[1]) : 1;
  const index = Number.isFinite(branch) && branch > 0 ? branch - 1 : 0;
  return colors[index % colors.length];
}

/** markmap 的 `color` 选项：按主题色板给节点着色（库只传节点本身）。 */
export function markmapColor(theme: MarkmapTheme): (node: { state?: { path?: string } }) => string {
  const colors = MARKMAP_BRANCH_COLORS[theme];
  return (node) => branchColor(colors, node.state?.path);
}

/** 把主题变量写到 SVG 元素上（内联样式优先级高于 markmap 注入的 `<style>`）。 */
export function applyMarkmapTheme(svg: SVGElement, theme: MarkmapTheme): void {
  Object.entries(MARKMAP_THEME_VARIABLES[theme]).forEach(([name, value]) => {
    svg.style.setProperty(name, value);
  });
  svg.style.setProperty('--markmap-font', MARKMAP_FONT);
}
