// Zeditor 主题系统：12 套配色方案。
// 命名与分组参考 ColaMD 主题集（colamd.com），并结合各主题的官方/社区色板：
//   浅色：浅色(Light)、雅致(Elegant)、简白(Notion)、作家(Writer)、熊红(Bear)、羊皮纸(Sepia)
//   深色：深色(Dark)、暖木(Gruvbox)、午夜(Midnight)、夜航(Solarized Dark)、极地(Nord)、德古拉(Dracula)
//
// 每套主题包含三部分，覆盖全部界面元素：
//   vars    — UI 变量（键不带 `--`）：编辑器/侧边栏/标签栏/状态栏/按钮/输入框/弹窗/滚动条等
//   syntax  — 语法高亮（关键字/字符串/注释/函数/变量/类型/数字/运算符/标签/属性/正则）
//   terminal— 终端 ANSI 16 色 + 前后景（供终端与类终端输出使用）
// 编辑器画布细节（背景/前景/行号/当前行/选区/光标/括号匹配/缩进线/查找高亮等）
// 由 vars 派生注入 Monaco 主题（见 ./monaco.ts），预览代码块经 --code-* 变量自动跟随。

export type ThemeMode = 'light' | 'dark';

export interface ThemeSyntax {
  keyword: string;
  string: string;
  comment: string;
  number: string;
  operator: string;
  function: string;
  variable: string;
  type: string;
  tag: string;
  attribute: string;
  regexp: string;
}

export interface ThemeTerminal {
  background: string;
  foreground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface ThemeDefinition {
  id: string;
  /** 中文显示名（菜单/设置）。 */
  label: string;
  /** 英文/原名（括号标注）。 */
  labelEn: string;
  mode: ThemeMode;
  /** 同族对偶主题 id：活动栏明暗切换优先在对偶间进行（仅旗舰主题成对）。 */
  partner?: string;
  /** CSS 变量覆盖（键不带 `--`），包含全部界面 token。 */
  vars: Record<string, string>;
  syntax: ThemeSyntax;
  terminal: ThemeTerminal;
}

export const DEFAULT_LIGHT_THEME_ID = 'vscode-light';
export const DEFAULT_DARK_THEME_ID = 'vscode-dark';
export const SYSTEM_THEME = 'system';

const lightBase: Record<string, string> = {
  'bg-app': '#f7f8fa',
  'bg-shell': '#edeef1',
  'bg-panel': '#f2f3f5',
  'bg-document': '#ffffff',
  'bg-elevated': '#ffffff',
  'bg-tertiary': '#e9ebef',
  'surface-raised': '#ffffff',
  'surface-subtle': '#f4f5f7',
  'surface-muted': '#e9edf1',
  'text-color': '#2e3640',
  'text-primary': '#222a35',
  'text-secondary': '#5b6572',
  'text-muted': '#656b76',
  'border': '#dce0e6',
  'border-soft': 'rgba(34, 42, 53, .06)',
  'border-strong': 'rgba(34, 42, 53, .15)',
  'hover': 'rgba(34, 42, 53, .045)',
  'active': 'rgba(34, 42, 53, .08)',
  'selected': 'rgba(45, 106, 224, .10)',
  'accent-color': '#2d6ae0',
  'accent-hover': '#2457bd',
  'accent-soft': 'rgba(45, 106, 224, .12)',
  'success-color': '#2f9463',
  'warning-color': '#b07708',
  'danger-color': '#d0545f',
  'toolbar-bg': '#f2f3f5',
  'menubar-bg': '#edeef1',
  'tab-bg': '#edeef1',
  'tab-active-bg': '#ffffff',
  'statusbar-bg': '#edeef1',
  'code-bg': '#f1f3f6',
  'code-text': '#3d4652',
  'code-title': '#3868d2',
  'overlay-bg': 'rgba(25, 32, 42, .28)',
  'font-reading': '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif',
};

const darkBase: Record<string, string> = {
  'bg-app': '#21242b',
  'bg-shell': '#1b1e25',
  'bg-panel': '#252932',
  'bg-document': '#2a2f38',
  'bg-elevated': '#313741',
  'bg-tertiary': '#313741',
  'surface-raised': '#313741',
  'surface-subtle': '#2b3039',
  'surface-muted': '#384049',
  'text-color': '#ced5de',
  'text-primary': '#e9edf2',
  'text-secondary': '#a3adba',
  'text-muted': '#9aa2ac',
  'border': '#363c45',
  'border-soft': 'rgba(206, 213, 222, .08)',
  'border-strong': 'rgba(206, 213, 222, .16)',
  'hover': 'rgba(206, 213, 222, .06)',
  'active': 'rgba(206, 213, 222, .10)',
  'selected': 'rgba(88, 166, 255, .18)',
  'accent-color': '#58a6ff',
  'accent-hover': '#7ab5ff',
  'accent-soft': 'rgba(88, 166, 255, .15)',
  'success-color': '#3fb950',
  'warning-color': '#d29922',
  'danger-color': '#f47067',
  'toolbar-bg': '#252932',
  'menubar-bg': '#1b1e25',
  'tab-bg': '#1b1e25',
  'tab-active-bg': '#2a2f38',
  'statusbar-bg': '#1b1e25',
  'code-bg': '#242932',
  'code-text': '#ced5de',
  'code-title': '#d2a8ff',
  'overlay-bg': 'rgba(8, 12, 17, .55)',
  'font-reading': '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif',
};

/** syntax token → 预览代码块对应的 CSS 变量（键不带 `--`）。 */
const SYNTAX_TO_CODE_VAR: Record<keyof ThemeSyntax, string> = {
  keyword: 'code-keyword',
  string: 'code-string',
  comment: 'code-comment',
  number: 'code-number',
  operator: 'code-operator',
  function: 'code-function',
  variable: 'code-variable',
  type: 'code-type',
  tag: 'code-tag',
  attribute: 'code-attribute',
  regexp: 'code-regexp',
};

function defineTheme(
  id: string,
  label: string,
  labelEn: string,
  mode: ThemeMode,
  vars: Record<string, string>,
  syntax: ThemeSyntax,
  terminal: ThemeTerminal,
  partner?: string,
): ThemeDefinition {
  const merged: Record<string, string> = { ...(mode === 'dark' ? darkBase : lightBase), ...vars };
  // 预览代码块（--code-*）统一由 syntax 派生：编辑器（Monaco）与预览的语法
  // 配色因此永远一致，不会因两处手工维护而漂移。
  for (const [token, varKey] of Object.entries(SYNTAX_TO_CODE_VAR)) {
    merged[varKey] = syntax[token as keyof ThemeSyntax];
  }
  return {
    id,
    label,
    labelEn,
    mode,
    partner,
    vars: merged,
    syntax,
    terminal,
  };
}

const lightTerminal = (over: Partial<ThemeTerminal>): ThemeTerminal => ({
  background: '#f1f3f6',
  foreground: '#3d4652',
  black: '#24292f',
  red: '#cf222e',
  green: '#116329',
  yellow: '#9a6700',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#197b35',
  brightYellow: '#926100',
  brightBlue: '#1a6dc9',
  brightMagenta: '#7e5abf',
  brightCyan: '#277487',
  brightWhite: '#656c73',
  ...over,
});

const darkTerminal = (over: Partial<ThemeTerminal>): ThemeTerminal => ({
  background: '#242932',
  foreground: '#ced5de',
  black: '#484f58',
  red: '#ff7b72',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#b1bac4',
  brightBlack: '#8b919a',
  brightRed: '#ffa198',
  brightGreen: '#56d347',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#f0f6fc',
  ...over,
});

export const THEMES: ThemeDefinition[] = [
  // ─────────────────────────── 浅色系列 ───────────────────────────
  defineTheme(
    'vscode-light', '浅色', 'Light', 'light',
    {},
    {
      keyword: '#a626a4', string: '#3d7b3c', comment: '#686e77', number: '#a05e01',
      operator: '#626f84', function: '#3868d2', variable: '#bc473c', type: '#936501',
      tag: '#207e36', attribute: '#6f42c1', regexp: '#3d7b3c',
    },
    lightTerminal({}),
    'vscode-dark',
  ),
  defineTheme(
    'elegant-light', '雅致', 'Elegant', 'light',
    {
      'bg-app': '#f6f6f8', 'bg-shell': '#efeff2', 'bg-panel': '#f3f3f6',
      'bg-tertiary': '#e8e8ec', 'surface-subtle': '#f4f4f6', 'surface-muted': '#e9e9ee',
      'text-color': '#33363b', 'text-primary': '#2b2e33', 'text-secondary': '#61656b', 'text-muted': '#696c71',
      'border': '#dedfe4', 'border-soft': 'rgba(43, 46, 51, .06)', 'border-strong': 'rgba(43, 46, 51, .15)',
      'hover': 'rgba(43, 46, 51, .045)', 'active': 'rgba(43, 46, 51, .08)',
      'selected': 'rgba(108, 92, 231, .12)',
      'accent-color': '#6c5ce7', 'accent-hover': '#5847d6', 'accent-soft': 'rgba(108, 92, 231, .12)',
      'toolbar-bg': '#f3f3f6', 'menubar-bg': '#efeff2', 'tab-bg': '#efeff2', 'tab-active-bg': '#ffffff', 'statusbar-bg': '#efeff2',
      'code-bg': '#f0f0f4', 'code-text': '#3a3d42', 'code-title': '#3766d1',
    },
    {
      keyword: '#7657cb', string: '#307a4d', comment: '#686c73', number: '#946219',
      operator: '#6a6e75', function: '#3766d1', variable: '#aa514a', type: '#916301',
      tag: '#357950', attribute: '#6758dc', regexp: '#307a4d',
    },
    lightTerminal({
      background: '#f0f0f4', foreground: '#3a3d42',
      blue: '#3b6ee0', magenta: '#6c5ce7', brightBlue: '#3766d1', brightMagenta: '#6758dc',
    }),
  ),
  defineTheme(
    'notion-light', '简白', 'Notion', 'light',
    {
      'bg-app': '#ffffff', 'bg-shell': '#f7f7f5', 'bg-panel': '#fbfbfa',
      'bg-tertiary': '#f1f1ef', 'surface-subtle': '#f7f7f5', 'surface-muted': '#edece9',
      'text-color': '#37352f', 'text-primary': '#37352f', 'text-secondary': '#686765', 'text-muted': '#71706e',
      'border': '#e9e9e7', 'border-soft': 'rgba(55, 53, 47, .08)', 'border-strong': 'rgba(55, 53, 47, .16)',
      'hover': 'rgba(55, 53, 47, .045)', 'active': 'rgba(55, 53, 47, .08)',
      'selected': 'rgba(35, 131, 226, .14)',
      'accent-color': '#2383e2', 'accent-hover': '#1a73cc', 'accent-soft': 'rgba(35, 131, 226, .13)',
      'success-color': '#448361', 'warning-color': '#cb912f', 'danger-color': '#d44c47',
      'toolbar-bg': '#fbfbfa', 'menubar-bg': '#f7f7f5', 'tab-bg': '#f7f7f5', 'tab-active-bg': '#ffffff', 'statusbar-bg': '#f7f7f5',
      'code-bg': '#f5f4f2', 'code-text': '#37352f', 'code-title': '#8250df',
    },
    {
      keyword: '#cf222e', string: '#116329', comment: '#6f6e6c', number: '#0550ae',
      operator: '#6b6f6d', function: '#6f42c1', variable: '#953800', type: '#953800',
      tag: '#116329', attribute: '#0550ae', regexp: '#116329',
    },
    lightTerminal({
      background: '#f5f4f2', foreground: '#37352f',
      red: '#cf222e', green: '#116329', blue: '#0969da', magenta: '#8250df',
    }),
  ),
  defineTheme(
    'writer-light', '作家', 'Writer', 'light',
    {
      'bg-app': '#fafafa', 'bg-shell': '#f2f2f2', 'bg-panel': '#f6f6f6',
      'bg-tertiary': '#ececec', 'surface-subtle': '#f5f5f5', 'surface-muted': '#e8e8e8',
      'text-color': '#2c3e50', 'text-primary': '#243b53', 'text-secondary': '#536a81', 'text-muted': '#656e77',
      'border': '#dde3e8', 'border-soft': 'rgba(36, 59, 83, .06)', 'border-strong': 'rgba(36, 59, 83, .15)',
      'hover': 'rgba(36, 59, 83, .045)', 'active': 'rgba(36, 59, 83, .08)',
      'selected': 'rgba(42, 122, 226, .12)',
      'accent-color': '#2a7ae2', 'accent-hover': '#1f63bd', 'accent-soft': 'rgba(42, 122, 226, .12)',
      'toolbar-bg': '#f6f6f6', 'menubar-bg': '#f2f2f2', 'tab-bg': '#f2f2f2', 'tab-active-bg': '#ffffff', 'statusbar-bg': '#f2f2f2',
      'code-bg': '#f0f3f5', 'code-text': '#33475b', 'code-title': '#256cc9',
    },
    {
      keyword: '#8256c4', string: '#257c4e', comment: '#666e75', number: '#a35b1c',
      operator: '#587088', function: '#256cc9', variable: '#ad5245', type: '#8e6616',
      tag: '#257c4e', attribute: '#8256c4', regexp: '#257c4e',
    },
    lightTerminal({
      background: '#f0f3f5', foreground: '#33475b',
      blue: '#2a7ae2', magenta: '#8256c4', brightBlue: '#256cc9', brightMagenta: '#8256c4',
    }),
  ),
  defineTheme(
    'bear-light', '熊红', 'Bear', 'light',
    {
      'bg-app': '#f8f5f0', 'bg-shell': '#f1ece4', 'bg-panel': '#f5f1ea',
      'bg-document': '#fdfbf7', 'bg-elevated': '#fffdf9',
      'bg-tertiary': '#eae4d8', 'surface-raised': '#fffdf9', 'surface-subtle': '#f6f2ea', 'surface-muted': '#ece5d8',
      'text-color': '#43403a', 'text-primary': '#3a3733', 'text-secondary': '#686259', 'text-muted': '#6f695f',
      'border': '#e0d9cb', 'border-soft': 'rgba(58, 55, 51, .07)', 'border-strong': 'rgba(58, 55, 51, .16)',
      'hover': 'rgba(58, 55, 51, .05)', 'active': 'rgba(58, 55, 51, .09)',
      'selected': 'rgba(191, 64, 52, .13)',
      'accent-color': '#bf4034', 'accent-hover': '#a53627', 'accent-soft': 'rgba(191, 64, 52, .12)',
      'success-color': '#4a7c59', 'warning-color': '#b07708', 'danger-color': '#bf4034',
      'toolbar-bg': '#f5f1ea', 'menubar-bg': '#f1ece4', 'tab-bg': '#f1ece4', 'tab-active-bg': '#fdfbf7', 'statusbar-bg': '#f1ece4',
      'code-bg': '#f3eee6', 'code-text': '#4a463f', 'code-title': '#a4553f',
    },
    {
      keyword: '#b3453a', string: '#597331', comment: '#716a5f', number: '#8b6416',
      operator: '#716a60', function: '#a4553f', variable: '#826738', type: '#8b6416',
      tag: '#597331', attribute: '#b3453a', regexp: '#597331',
    },
    lightTerminal({
      background: '#f3eee6', foreground: '#4a463f',
      red: '#bf4034', green: '#4a7c59', yellow: '#af7e1b', blue: '#a4553f', magenta: '#b3453a',
      brightRed: '#a53627', brightBlue: '#a4553f', brightMagenta: '#b3453a',
    }),
  ),
  defineTheme(
    'sepia-light', '羊皮纸', 'Sepia', 'light',
    {
      'bg-app': '#f1e8d5', 'bg-shell': '#e9dfc8', 'bg-panel': '#ede4cf',
      'bg-document': '#f7efdd', 'bg-elevated': '#fbf5e6',
      'bg-tertiary': '#e2d5b8', 'surface-raised': '#fbf5e6', 'surface-subtle': '#f2ead6', 'surface-muted': '#e6d9bd',
      'text-color': '#534331', 'text-primary': '#4a3a28', 'text-secondary': '#685945', 'text-muted': '#6e604c',
      'border': '#d8c9ab', 'border-soft': 'rgba(74, 58, 40, .08)', 'border-strong': 'rgba(74, 58, 40, .17)',
      'hover': 'rgba(74, 58, 40, .05)', 'active': 'rgba(74, 58, 40, .09)',
      'selected': 'rgba(154, 103, 52, .16)',
      'accent-color': '#9a6734', 'accent-hover': '#855427', 'accent-soft': 'rgba(154, 103, 52, .15)',
      'success-color': '#6b7f3f', 'warning-color': '#a87b1f', 'danger-color': '#a54e36',
      'toolbar-bg': '#ede4cf', 'menubar-bg': '#e9dfc8', 'tab-bg': '#e9dfc8', 'tab-active-bg': '#f7efdd', 'statusbar-bg': '#e9dfc8',
      'code-bg': '#ece1c8', 'code-text': '#4d3b2e', 'code-title': '#7a4a2b',
    },
    {
      keyword: '#8a4b2d', string: '#536b2e', comment: '#70614d', number: '#7f5d18',
      operator: '#72604b', function: '#7a4a2b', variable: '#6b4f2f', type: '#865a2d',
      tag: '#536b2e', attribute: '#8a4b2d', regexp: '#536b2e',
    },
    lightTerminal({
      background: '#ece1c8', foreground: '#584334',
      black: '#4a3a28', red: '#a54e36', green: '#6b7f3f', yellow: '#a2771e',
      blue: '#7a4a2b', magenta: '#8a4b2d', cyan: '#5f7a35', white: '#8e7b63',
      brightBlack: '#72604b', brightRed: '#9e4b34', brightGreen: '#596934', brightYellow: '#7f5d18',
      brightBlue: '#7a4a2b', brightMagenta: '#8a4b2d', brightCyan: '#536b2e', brightWhite: '#5b4a36',
    }),
  ),

  // ─────────────────────────── 深色系列 ───────────────────────────
  defineTheme(
    'vscode-dark', '深色', 'Dark', 'dark',
    {},
    {
      keyword: '#ff7b72', string: '#a5d6ff', comment: '#8b949e', number: '#ffa657',
      operator: '#79c0ff', function: '#d2a8ff', variable: '#79c0ff', type: '#56d4dd',
      tag: '#7ee787', attribute: '#79c0ff', regexp: '#a5d6ff',
    },
    darkTerminal({}),
    'vscode-light',
  ),
  defineTheme(
    'gruvbox-dark', '暖木', 'Gruvbox', 'dark',
    {
      'bg-app': '#282828', 'bg-shell': '#1d2021', 'bg-panel': '#2e2c2a',
      'bg-document': '#282828', 'bg-elevated': '#3c3836',
      'bg-tertiary': '#3c3836', 'surface-raised': '#3c3836', 'surface-subtle': '#2a2825', 'surface-muted': '#463f39',
      'text-color': '#d9c9a9', 'text-primary': '#ebdbb2', 'text-secondary': '#bdae93', 'text-muted': '#ada296',
      'border': '#3c3836', 'border-soft': 'rgba(235, 219, 178, .08)', 'border-strong': 'rgba(235, 219, 178, .16)',
      'hover': 'rgba(235, 219, 178, .06)', 'active': 'rgba(235, 219, 178, .10)',
      'selected': 'rgba(131, 165, 152, .22)',
      'accent-color': '#83a598', 'accent-hover': '#8fb7b5', 'accent-soft': 'rgba(131, 165, 152, .18)',
      'success-color': '#b8bb26', 'warning-color': '#fabd2f', 'danger-color': '#fb4934',
      'toolbar-bg': '#2e2c2a', 'menubar-bg': '#1d2021', 'tab-bg': '#1d2021', 'tab-active-bg': '#282828', 'statusbar-bg': '#1d2021',
      'code-bg': '#282828', 'code-text': '#d9c9a9', 'code-title': '#fabd2f',
    },
    {
      keyword: '#fb5844', string: '#b8bb26', comment: '#9c8e80', number: '#d3869b',
      operator: '#8ec07c', function: '#fabd2f', variable: '#83a598', type: '#d3869b',
      tag: '#8ec07c', attribute: '#fabd2f', regexp: '#b8bb26',
    },
    darkTerminal({
      background: '#282828', foreground: '#ebdbb2',
      black: '#282828', red: '#d23d36', green: '#98971a', yellow: '#d79921',
      blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
      brightBlack: '#9c8e80', brightRed: '#fb5844', brightGreen: '#b8bb26', brightYellow: '#fabd2f',
      brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
    }),
  ),
  defineTheme(
    'midnight-dark', '午夜', 'Midnight', 'dark',
    {
      'bg-app': '#151f2e', 'bg-shell': '#101827', 'bg-panel': '#1a2434',
      'bg-document': '#1d2839', 'bg-elevated': '#243145',
      'bg-tertiary': '#243145', 'surface-raised': '#243145', 'surface-subtle': '#1b2636', 'surface-muted': '#2c3c52',
      'text-color': '#c3d0e4', 'text-primary': '#dfe8f5', 'text-secondary': '#9fb2cc', 'text-muted': '#889bb6',
      'border': '#2a3a52', 'border-soft': 'rgba(195, 208, 228, .08)', 'border-strong': 'rgba(195, 208, 228, .16)',
      'hover': 'rgba(195, 208, 228, .06)', 'active': '#25334a',
      'selected': 'rgba(77, 159, 255, .22)',
      'accent-color': '#4d9fff', 'accent-hover': '#70b5ff', 'accent-soft': 'rgba(77, 159, 255, .18)',
      'success-color': '#3ecf8e', 'warning-color': '#e0a93e', 'danger-color': '#f26d6d',
      'toolbar-bg': '#1a2434', 'menubar-bg': '#101827', 'tab-bg': '#101827', 'tab-active-bg': '#1d2839', 'statusbar-bg': '#101827',
      'code-bg': '#17212f', 'code-text': '#ced9e8', 'code-title': '#5ccfe6',
    },
    {
      keyword: '#7d9bff', string: '#7ee0a3', comment: '#7b8a9e', number: '#f0b35e',
      operator: '#89a7c8', function: '#5ccfe6', variable: '#a9c1e8', type: '#c89df0',
      tag: '#7ee0a3', attribute: '#7d9bff', regexp: '#7ee0a3',
    },
    darkTerminal({
      background: '#17212f', foreground: '#ced9e8',
      black: '#1d2839', red: '#f26d6d', green: '#3ecf8e', yellow: '#e0a93e',
      blue: '#4d9fff', magenta: '#c792ea', cyan: '#5ccfe6', white: '#c3d0e0',
      brightBlack: '#7c8a9e', brightRed: '#f78f8f', brightGreen: '#6fe3a5', brightYellow: '#eec06a',
      brightBlue: '#70b5ff', brightMagenta: '#d5aef5', brightCyan: '#85dbea', brightWhite: '#e8f0f8',
    }),
  ),
  defineTheme(
    'solarized-dark', '夜航', 'Solarized Dark', 'dark',
    {
      'bg-app': '#06303c', 'bg-shell': '#042733', 'bg-panel': '#0b3d4a',
      'bg-document': '#06303c', 'bg-elevated': '#104a5c',
      'bg-tertiary': '#104a5c', 'surface-raised': '#104a5c', 'surface-subtle': '#0a3641', 'surface-muted': '#135264',
      'text-color': '#d5dede', 'text-primary': '#dee5e5', 'text-secondary': '#b0bfc2', 'text-muted': '#a5b6ba',
      'border': '#16525f', 'border-soft': 'rgba(168, 188, 188, .10)', 'border-strong': 'rgba(168, 188, 188, .18)',
      'hover': 'rgba(168, 188, 188, .07)', 'active': 'rgba(168, 188, 188, .11)',
      'selected': 'rgba(56, 152, 222, .26)',
      'accent-color': '#3f9ad8', 'accent-hover': '#5cb0e6', 'accent-soft': 'rgba(63, 154, 216, .22)',
      'success-color': '#9aad1a', 'warning-color': '#c99a1f', 'danger-color': '#e2504d',
      'toolbar-bg': '#0b3d4a', 'menubar-bg': '#042733', 'tab-bg': '#042733', 'tab-active-bg': '#06303c', 'statusbar-bg': '#042733',
      'code-bg': '#0b3d4a', 'code-text': '#bfcccc', 'code-title': '#5fa9de',
    },
    {
      keyword: '#9aab2c', string: '#4fb1aa', comment: '#97a4a9', number: '#e484b2',
      operator: '#9a9ed7', function: '#5fa9de', variable: '#c29e2d', type: '#9a9ed7',
      tag: '#4fb1aa', attribute: '#c29e2d', regexp: '#4fb1aa',
    },
    darkTerminal({
      background: '#0b3d4a', foreground: '#c2cbcb',
      black: '#0b3d4a', red: '#e15350', green: '#859900', yellow: '#b58900',
      blue: '#268bd2', magenta: '#d95193', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#97a4a9', brightRed: '#de8e6d', brightGreen: '#9aab2c', brightYellow: '#c29e2d',
      brightBlue: '#5fa9de', brightMagenta: '#9a9ed7', brightCyan: '#97a5a5', brightWhite: '#fdf6e3',
    }),
  ),
  defineTheme(
    'nord-dark', '极地', 'Nord', 'dark',
    {
      'bg-app': '#2e3440', 'bg-shell': '#242933', 'bg-panel': '#2e3440',
      'bg-document': '#2e3440', 'bg-elevated': '#3b4252',
      'bg-tertiary': '#3b4252', 'surface-raised': '#3b4252', 'surface-subtle': '#2a303b', 'surface-muted': '#434c5e',
      'text-color': '#d8dee9', 'text-primary': '#eceff4', 'text-secondary': '#d8dee9', 'text-muted': '#a9b0be',
      'border': '#3b4252', 'border-soft': 'rgba(216, 222, 233, .08)', 'border-strong': 'rgba(216, 222, 233, .16)',
      'hover': 'rgba(216, 222, 233, .06)', 'active': 'rgba(216, 222, 233, .10)',
      'selected': 'rgba(136, 192, 208, .20)',
      'accent-color': '#88c0d0', 'accent-hover': '#8fbcbb', 'accent-soft': 'rgba(136, 192, 208, .18)',
      'success-color': '#a3be8c', 'warning-color': '#ebcb8b', 'danger-color': '#bf616a',
      'toolbar-bg': '#2e3440', 'menubar-bg': '#242933', 'tab-bg': '#242933', 'tab-active-bg': '#2e3440', 'statusbar-bg': '#242933',
      'code-bg': '#2e3440', 'code-text': '#d8dee9', 'code-title': '#88c0d0',
    },
    {
      keyword: '#81a1c1', string: '#a3be8c', comment: '#959eaf', number: '#b792b0',
      operator: '#81a1c1', function: '#88c0d0', variable: '#d8dee9', type: '#8fbcbb',
      tag: '#81a1c1', attribute: '#ebcb8b', regexp: '#a3be8c',
    },
    darkTerminal({
      background: '#2e3440', foreground: '#d8dee9',
      black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b',
      blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
      brightBlack: '#989ea9', brightRed: '#d08b91', brightGreen: '#a3be8c', brightYellow: '#ebcb8b',
      brightBlue: '#81a1c1', brightMagenta: '#b792b0', brightCyan: '#8fbcbb', brightWhite: '#eceff4',
    }),
  ),
  defineTheme(
    'dracula-dark', '德古拉', 'Dracula', 'dark',
    {
      'bg-app': '#282a36', 'bg-shell': '#21222c', 'bg-panel': '#282a36',
      'bg-document': '#282a36', 'bg-elevated': '#34353f',
      'bg-tertiary': '#44475a', 'surface-raised': '#34353f', 'surface-subtle': '#2a2c37', 'surface-muted': '#44475a',
      'text-color': '#f8f8f2', 'text-primary': '#f8f8f2', 'text-secondary': '#aab0c0', 'text-muted': '#949fc1',
      'border': '#44475a', 'border-soft': 'rgba(248, 248, 242, .08)', 'border-strong': 'rgba(248, 248, 242, .16)',
      'hover': 'rgba(248, 248, 242, .06)', 'active': '#34353f',
      'selected': 'rgba(189, 147, 249, .22)',
      'accent-color': '#bd93f9', 'accent-hover': '#cba3ff', 'accent-soft': 'rgba(189, 147, 249, .20)',
      'success-color': '#50fa7b', 'warning-color': '#f1fa8c', 'danger-color': '#ff5555',
      'toolbar-bg': '#282a36', 'menubar-bg': '#21222c', 'tab-bg': '#21222c', 'tab-active-bg': '#282a36', 'statusbar-bg': '#21222c',
      'code-bg': '#282a36', 'code-text': '#f8f8f2', 'code-title': '#50fa7b',
    },
    {
      keyword: '#ff79c6', string: '#f1fa8c', comment: '#8692b9', number: '#bd93f9',
      operator: '#ff79c6', function: '#50fa7b', variable: '#f8f8f2', type: '#8be9fd',
      tag: '#ff79c6', attribute: '#ffb86c', regexp: '#f1fa8c',
    },
    darkTerminal({
      background: '#282a36', foreground: '#f8f8f2',
      black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
      blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#8692b9', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5',
      brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
    }),
  ),
];

export const THEME_MAP = new Map(THEMES.map((theme) => [theme.id, theme]));

export function getThemeById(id: string): ThemeDefinition | undefined {
  return THEME_MAP.get(id);
}

/** 主题 id 对应的明暗模式（未知 id 按后缀推断）。 */
export function themeModeOf(id: string): ThemeMode {
  return THEME_MAP.get(id)?.mode ?? (id.endsWith('-dark') ? 'dark' : 'light');
}
