export function usesMacShortcuts(platform: string): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}

function currentPlatform(): string {
  return typeof navigator === 'undefined' ? '' : navigator.platform;
}

/**
 * 修饰键在 macOS 上的符号与展示顺序（⌃ ⌥ ⇧ ⌘，与系统菜单一致）。
 *
 * 顺序即数组顺序：无论输入写成 `Ctrl+Shift+S` 还是 `Shift+Ctrl+S`，
 * 输出都是系统惯例的 `⇧⌘S`。
 */
const MAC_MODIFIERS: ReadonlyArray<{ names: string; symbol: string }> = [
  { names: 'Control', symbol: '⌃' },
  { names: 'Alt|Option', symbol: '⌥' },
  { names: 'Shift', symbol: '⇧' },
  { names: 'Ctrl|Cmd|Command|Meta|Super', symbol: '⌘' },
];

/** 组合键写法：修饰键之间用 `+` 或空格分隔，最后跟一个可见按键。 */
const SHORTCUT_SEQUENCE = new RegExp(
  `(?:${MAC_MODIFIERS.map((modifier) => modifier.names).join('|')})(?:[+ ](?:${MAC_MODIFIERS
    .map((modifier) => modifier.names)
    .join('|')}))*[+ ]([A-Za-z0-9,./;'\`\\[\\]-])`,
  'g',
);

/** 修饰键 + 中日韩文字：`Ctrl + 滚轮` 这类操作说明（没有 ASCII 按键）。 */
const CJK_KEY_SEQUENCE = new RegExp(
  `(?:${MAC_MODIFIERS.map((modifier) => modifier.names).join('|')})([ \\t]*(?:\\+[ \\t]*)?)([\\u3400-\\u9fff])`,
  'g',
);

function toMacSequence(sequence: string, key: string): string {
  const symbols = MAC_MODIFIERS.filter((modifier) =>
    new RegExp(`(?:^|[+ ])(?:${modifier.names})(?:$|[+ ])`, 'i').test(sequence),
  )
    .map((modifier) => modifier.symbol)
    .join('');
  return `${symbols}${key}`;
}

/**
 * 把快捷键文案格式化成当前平台的写法。
 *
 * 该函数既用于单个组合键（菜单、工具栏提示），也直接作用在整段说明文本上
 * （「快捷键说明」弹窗、语法速查卡），因此按「文本内逐段替换」实现：
 * 只改写真正构成组合键的片段，不触碰其余文字与换行。
 *
 * macOS 上：
 * - `Ctrl+N` / `Ctrl P` → `⌘N`（去掉 Windows 的 `+` 写法）；
 * - `Ctrl+Shift+S` → `⇧⌘S`（按系统顺序重排修饰键）；
 * - `Ctrl+Y` → `⇧⌘Z`、`F11` → `⌃⌘F`（系统惯例组合）。
 */
export function formatShortcut(shortcut: string, platform = currentPlatform()): string {
  if (!usesMacShortcuts(platform)) return shortcut;
  return shortcut
    .replace(/Ctrl\s?[+ ]\s?Y\b/gi, '⇧⌘Z')
    .replace(/\bF11\b/g, '⌃⌘F')
    .replace(SHORTCUT_SEQUENCE, (match, key: string) => toMacSequence(match, key))
    .replace(CJK_KEY_SEQUENCE, (match, spacing: string, key: string) => `${toMacSequence(match, '')}${spacing}${key}`);
}

/** 非字母数字按键在 Tauri 加速键语法中的名称（W3C key code 名）。 */
const ACCELERATOR_KEY_NAMES: Record<string, string> = {
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  '\\': 'Backslash',
  '`': 'Backquote',
  '-': 'Minus',
  '=': 'Equal',
  ';': 'Semicolon',
  "'": 'Quote',
  '[': 'BracketLeft',
  ']': 'BracketRight',
};

/**
 * 把应用内快捷键文案转成 Tauri 的加速键字符串（macOS 原生菜单使用）。
 *
 * `CmdOrCtrl` 由 Tauri 按平台解析：macOS 渲染为 ⌘，Windows/Linux 渲染为 Ctrl，
 * 因此同一份菜单定义在两端都能显示正确的按键提示。
 */
export function toAccelerator(shortcut: string): string | undefined {
  const normalized = shortcut.replace(/\s+/g, '');
  if (!normalized) return undefined;
  if (/^F11$/i.test(normalized)) return 'Ctrl+Cmd+F';
  if (/^Ctrl[+]Y$/i.test(normalized)) return 'CmdOrCtrl+Shift+Z';
  const parts = normalized.split('+').filter(Boolean);
  const key = parts.filter((part) => !/^(ctrl|cmd|command|meta|super|shift|alt|option|control)$/i.test(part)).join('+');
  if (!key) return undefined;
  const tokens: string[] = [];
  if (/Ctrl|Cmd|Command|Meta|Super/i.test(normalized)) tokens.push('CmdOrCtrl');
  if (/Shift/i.test(normalized)) tokens.push('Shift');
  if (/Alt|Option/i.test(normalized)) tokens.push('Alt');
  tokens.push(ACCELERATOR_KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key));
  return tokens.join('+');
}
