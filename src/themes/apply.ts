// 主题运行时：偏好解析 → CSS 变量注入 → Monaco 主题定义/切换。
// 约定：<html data-theme="<主题 id>">（全部 id 以 -light/-dark 结尾，
//       既有 [data-theme$="-dark"] 后缀选择器与旗舰主题的精确块照常匹配）。
// 主题的全部 token 以行内 CSS 变量注入 <html>，优先级高于样式表中的
// :root / [data-theme=...] 变量定义，因此 12 套主题无需改动任何既有组件样式。
import {
  THEMES,
  THEME_MAP,
  getThemeById,
  DEFAULT_DARK_THEME_ID,
  DEFAULT_LIGHT_THEME_ID,
  SYSTEM_THEME,
  type ThemeDefinition,
} from './index';

export { THEMES, DEFAULT_DARK_THEME_ID, DEFAULT_LIGHT_THEME_ID, SYSTEM_THEME };
export type { ThemeDefinition };

let themeSwitchFrame: number | null = null;

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * 把任意设置值（'system' / 'dark' / 'light' / 主题 id / 历史遗留 id）
 * 归一化为已注册的主题 id。
 */
export function resolveThemePreference(preference: string): string {
  if (preference === SYSTEM_THEME) return systemPrefersDark() ? DEFAULT_DARK_THEME_ID : DEFAULT_LIGHT_THEME_ID;
  if (preference === 'dark') return DEFAULT_DARK_THEME_ID;
  if (preference === 'light') return DEFAULT_LIGHT_THEME_ID;
  if (THEME_MAP.has(preference)) return preference;
  // 历史遗留主题 id（claude-*/notion-*/已下线方案）按明暗迁移到旗舰主题。
  return preference.endsWith('-light') ? DEFAULT_LIGHT_THEME_ID : DEFAULT_DARK_THEME_ID;
}

/** 当前生效的主题 id（含 'system' 解析）。 */
export function currentThemeId(): string {
  if (typeof document === 'undefined') return DEFAULT_LIGHT_THEME_ID;
  return resolveThemePreference(document.documentElement.dataset.theme ?? DEFAULT_LIGHT_THEME_ID);
}

// 记录上一次注入的变量键，切换主题时先清理，避免残留。
let injectedVarKeys: string[] = [];

function injectThemeVars(theme: ThemeDefinition): void {
  const root = document.documentElement;
  for (const key of injectedVarKeys) root.style.removeProperty(`--${key}`);
  injectedVarKeys = Object.keys(theme.vars);
  for (const [key, value] of Object.entries(theme.vars)) {
    root.style.setProperty(`--${key}`, value);
  }
}

/**
 * 应用主题：注入 CSS 变量、同步 data-theme/data-theme-id 与 colorScheme，
 * 并广播 zeditor-theme-change（detail 为主题 id，以 -light/-dark 结尾，
 * 既有监听按后缀判断明暗的逻辑继续有效）。返回解析后的主题 id。
 */
export function applyThemeToDocument(preference: string): string {
  const id = resolveThemePreference(preference);
  const theme = getThemeById(id) ?? getThemeById(DEFAULT_DARK_THEME_ID)!;
  const root = document.documentElement;

  if (themeSwitchFrame !== null) window.cancelAnimationFrame(themeSwitchFrame);
  root.classList.add('theme-switching');

  injectThemeVars(theme);
  root.setAttribute('data-theme', theme.id);
  root.style.colorScheme = theme.mode;

  window.dispatchEvent(new CustomEvent('zeditor-theme-change', { detail: theme.id }));
  themeSwitchFrame = window.requestAnimationFrame(() => {
    root.classList.remove('theme-switching');
    themeSwitchFrame = null;
  });

  return theme.id;
}

/**
 * 活动栏明暗切换：优先在主题声明的对偶（partner）之间切换；
 * 无对偶（非旗舰主题）时回退到目标模式的旗舰主题。
 */
export function toggleThemeMode(preference: string): string {
  const id = resolveThemePreference(preference);
  const theme = getThemeById(id);
  if (!theme) return DEFAULT_DARK_THEME_ID;
  if (theme.partner && THEME_MAP.has(theme.partner)) return theme.partner;
  return theme.mode === 'dark' ? DEFAULT_LIGHT_THEME_ID : DEFAULT_DARK_THEME_ID;
}
