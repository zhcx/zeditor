/**
 * Markdown editing always wraps to the visible viewport. Horizontal scrolling
 * therefore has no useful content to reveal and must not reserve layout space.
 *
 * 折行必须用 'advanced' 策略：它按真实字形逐段 DOM 测量折行列，会把 letterSpacing
 * 计入宽度。默认的 'simple' 策略用缓存的字符宽度估算、不计 letterSpacing（本应用
 * 字间距默认 0.6px），长行因此渲染得比折行列更宽，又因为横向滚动被隐去而看不到尾部，
 * 表现为「文字超出编辑框」。
 */
export const EDITOR_OVERFLOW_OPTIONS = {
  scrollBeyondLastColumn: 0,
  wrappingStrategy: 'advanced',
  scrollbar: {
    vertical: 'auto',
    useShadows: false,
    horizontal: 'hidden',
    horizontalScrollbarSize: 0,
    verticalScrollbarSize: 10,
    verticalSliderSize: 10,
  },
} as const;

/**
 * Chinese punctuation and typography are normal document content. Monaco's
 * ambiguous-character detector produces a noisy warning banner for these
 * documents, so only genuinely invisible code points remain highlighted.
 */
export const EDITOR_UNICODE_HIGHLIGHT_OPTIONS = {
  nonBasicASCII: false,
  ambiguousCharacters: false,
  invisibleCharacters: true,
  allowedLocales: {
    _os: true,
    _vscode: true,
    'zh-hans': true,
    'zh-hant': true,
  },
} as const;
