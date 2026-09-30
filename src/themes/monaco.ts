// 由主题定义构建 Monaco 编辑器主题（编辑器画布 + 语法高亮 + 差异对比 + 内建组件）。
// 颜色全部派生自主题的 vars/syntax token，保证 12 套配色在编辑器内外的视觉一致。
import { getThemeById, themeModeOf, DEFAULT_DARK_THEME_ID, DEFAULT_LIGHT_THEME_ID, type ThemeDefinition } from './index';

export interface MonacoTokenThemeRule {
  token: string;
  foreground?: string;
  fontStyle?: string;
}

export interface MonacoThemeData {
  base: 'vs' | 'vs-dark' | 'hc-black';
  inherit: boolean;
  rules: MonacoTokenThemeRule[];
  colors: Record<string, string>;
}

interface MonacoLike {
  editor: {
    defineTheme(name: string, data: MonacoThemeData): void;
    setTheme(name: string): void;
  };
}

/** 把 #rgb/#rrggbb 或 rgb()/rgba() 调整为指定透明度的 rgba()；无法解析时原样返回。 */
function alpha(color: string, a: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    const n = parseInt(hex[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*[\d.]+)?\s*\)$/.exec(color.trim());
  if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${a})`;
  return color;
}

export function buildMonacoTheme(theme: ThemeDefinition): MonacoThemeData {
  const v = theme.vars;
  const s = theme.syntax;
  const dark = theme.mode === 'dark';
  const accent = v['accent-color'];
  const accentSoft = v['accent-soft'];
  const selected = v['selected'];

  const colors: Record<string, string> = {
    // ── 编辑器画布 ──
    'editor.background': v['bg-document'],
    'editor.foreground': v['text-primary'],
    'editor.lineHighlightBackground': v['active'],
    'editor.lineHighlightBorder': '#00000000',
    'editorLineNumber.foreground': v['text-muted'],
    'editorLineNumber.activeForeground': v['text-secondary'],
    'editorCursor.foreground': accent,
    'editor.selectionBackground': selected,
    'editor.inactiveSelectionBackground': alpha(accent, dark ? 0.2 : 0.14),
    'editor.selectionHighlightBackground': alpha(accent, dark ? 0.12 : 0.08),
    'editorBracketMatch.background': accentSoft,
    'editorBracketMatch.border': accent,
    'editorIndentGuide.background1': v['border'],
    'editorIndentGuide.activeBackground1': v['text-muted'],
    'editorWhitespace.foreground': v['border-soft'],
    'editorLink.foreground': accent,
    'editor.wordHighlightBackground': accentSoft,
    'editor.wordHighlightStrongBackground': alpha(accent, dark ? 0.2 : 0.14),
    'editor.hoverHighlightBackground': accentSoft,
    // ── 查找/搜索高亮 ──
    'editor.findMatchBackground': alpha(accent, dark ? 0.36 : 0.3),
    'editor.findMatchHighlightBackground': alpha(accent, dark ? 0.18 : 0.13),
    'editor.findRangeHighlightBackground': alpha(accent, dark ? 0.12 : 0.08),
    // ── 内建组件（建议/悬浮/输入框/列表/通知） ──
    'editorWidget.background': v['bg-elevated'],
    'editorWidget.foreground': v['text-primary'],
    'editorWidget.border': v['border'],
    'editorSuggestWidget.background': v['bg-elevated'],
    'editorSuggestWidget.border': v['border'],
    'editorSuggestWidget.foreground': v['text-primary'],
    'editorSuggestWidget.selectedBackground': alpha(accent, dark ? 0.18 : 0.12),
    'editorSuggestWidget.highlightForeground': accent,
    'editorSuggestWidget.focusHighlightForeground': accent,
    'editorHoverWidget.background': v['bg-elevated'],
    'editorHoverWidget.border': v['border'],
    'editorHoverWidget.foreground': v['text-primary'],
    'input.background': v['surface-raised'] ?? v['bg-elevated'],
    'input.foreground': v['text-primary'],
    'input.border': v['border'],
    'inputOption.activeBorder': accent,
    'inputValidation.infoBorder': accent,
    'inputValidation.warningBorder': v['warning-color'],
    'inputValidation.errorBorder': v['danger-color'],
    'focusBorder': accent,
    'list.activeSelectionBackground': selected,
    'list.activeSelectionForeground': v['text-primary'],
    'list.inactiveSelectionBackground': v['surface-muted'],
    'list.hoverBackground': v['hover'],
    'list.focusBackground': selected,
    'list.focusForeground': v['text-primary'],
    'list.highlightForeground': accent,
    'badge.background': accent,
    'badge.foreground': '#ffffff',
    'notifications.background': v['bg-elevated'],
    'notifications.foreground': v['text-primary'],
    'notifications.border': v['border'],
    'notificationCenterHeader.background': v['bg-shell'],
    'notificationLink.foreground': accent,
    // ── 滚动条（Monaco 自绘滚动条的兜底；DOM 滚动条由 CSS 变量控制） ──
    'scrollbarSlider.background': alpha(v['text-muted'], dark ? 0.26 : 0.2),
    'scrollbarSlider.hoverBackground': alpha(v['text-muted'], dark ? 0.4 : 0.32),
    'scrollbarSlider.activeBackground': alpha(v['text-muted'], dark ? 0.5 : 0.42),
    // ── 差异对比视图 ──
    'diffEditor.insertedTextBackground': alpha(v['success-color'], dark ? 0.16 : 0.14),
    'diffEditor.removedTextBackground': alpha(v['danger-color'], dark ? 0.16 : 0.13),
    'diffEditor.insertedLineBackground': alpha(v['success-color'], dark ? 0.1 : 0.08),
    'diffEditor.removedLineBackground': alpha(v['danger-color'], dark ? 0.1 : 0.08),
    'diffEditor.diagonalFill': v['border-soft'],
    'diffEditorOverview.insertedForeground': v['success-color'],
    'diffEditorOverview.removedForeground': v['danger-color'],
    // ── Git 行号槽 ──
    'editorGutter.addedBackground': alpha(v['success-color'], 0.6),
    'editorGutter.deletedBackground': alpha(v['danger-color'], 0.6),
    'editorGutter.modifiedBackground': alpha(v['warning-color'], 0.6),
    // ── Peek 视图 ──
    'peekView.border': v['border-strong'],
    'peekViewEditor.background': v['bg-document'],
    'peekViewResult.background': v['bg-panel'],
    'peekViewResultSelectionBackground': selected,
    'peekViewTitle.background': v['bg-shell'],
    'peekViewTitleLabel.foreground': v['text-primary'],
    'peekViewTitleDescription.foreground': v['text-secondary'],
    'peekViewEditor.matchHighlightBackground': accentSoft,
    // ── 诊断 ──
    'editorMarkerNavigationError.background': v['danger-color'],
    'editorMarkerNavigationWarning.background': v['warning-color'],
    'editorMarkerNavigationInfo.background': accent,
  };

  const rules: MonacoTokenThemeRule[] = [
    // ── 基础语法 ──
    { token: 'comment', foreground: s.comment },
    { token: 'string', foreground: s.string },
    { token: 'string.escape', foreground: s.operator },
    { token: 'regexp', foreground: s.regexp },
    { token: 'number', foreground: s.number },
    { token: 'keyword', foreground: s.keyword },
    { token: 'operator', foreground: s.operator },
    { token: 'delimiter', foreground: v['text-secondary'] },
    { token: 'identifier', foreground: v['text-primary'] },
    { token: 'type', foreground: s.type },
    { token: 'class', foreground: s.type },
    { token: 'interface', foreground: s.type },
    { token: 'enum', foreground: s.type },
    { token: 'function', foreground: s.function },
    { token: 'variable', foreground: s.variable },
    { token: 'variable.predefined', foreground: s.variable },
    { token: 'tag', foreground: s.tag },
    { token: 'attribute.name', foreground: s.attribute },
    { token: 'attribute.value', foreground: s.string },
    { token: 'attribute.value.number', foreground: s.number },
    { token: 'constant', foreground: s.number },
    { token: 'boolean', foreground: s.keyword },
    { token: 'key', foreground: s.attribute },
    { token: 'annotation', foreground: s.attribute },
    { token: 'invalid', foreground: v['danger-color'] },
    // ── Markdown 编辑体验（主语言） ──
    { token: 'md-header', foreground: s.keyword },
    { token: 'md-strong', fontStyle: 'bold' },
    { token: 'md-emphasis', fontStyle: 'italic' },
    { token: 'md-link', foreground: s.function },
    { token: 'md-code', foreground: s.string },
    { token: 'md-quote', foreground: s.comment },
  ];

  return {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules,
    colors,
  };
}

const definedThemes = new Set<string>();

/** 首次使用时 defineTheme，返回可传给 setTheme 的主题名。 */
export function ensureMonacoTheme(monaco: MonacoLike, id: string): string {
  const themeId = getThemeById(id) ? id : themeModeOf(id) === 'dark' ? DEFAULT_DARK_THEME_ID : DEFAULT_LIGHT_THEME_ID;
  if (!definedThemes.has(themeId)) {
    const theme = getThemeById(themeId);
    if (theme) monaco.editor.defineTheme(themeId, buildMonacoTheme(theme));
    definedThemes.add(themeId);
  }
  return themeId;
}
