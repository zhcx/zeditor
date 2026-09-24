export type SmartPairInput = {
  value: string;
  offset: number;
  key: string;
  enabled: boolean;
};

export type SmartPairDecision =
  | { kind: 'default' }
  | { kind: 'insert'; from: number; to: number; text: string; cursor: number }
  | { kind: 'replace'; from: number; to: number; text: string; cursor: number }
  | { kind: 'move'; cursor: number }
  | { kind: 'delete'; from: number; to: number; cursor: number };

const PAIRS: Readonly<Partial<Record<string, string>>> = {
  '(': ')',
  '[': ']',
  '{': '}',
  '"': '"',
  "'": "'",
  '`': '`',
  '「': '」',
  '『': '』',
  '（': '）',
  '【': '】',
  '《': '》',
  '〈': '〉',
  '“': '”',
  '‘': '’',
};

const MARKERS = new Set(['*', '_', '~']);
const SMART_KEYS = new Set(['Tab', 'Backspace', ...Object.keys(PAIRS), ...MARKERS]);

const defaultDecision = (): SmartPairDecision => ({ kind: 'default' });

function isInsideFencedCode(value: string, offset: number): boolean {
  const beforeCursor = value.slice(0, offset);
  let fence: { marker: string; length: number } | null = null;

  for (const line of beforeCursor.split(/\r?\n/)) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (match === null) continue;

    const run = match[1];
    if (fence === null) {
      fence = { marker: run[0], length: run.length };
    } else if (
      run[0] === fence.marker
      && run.length >= fence.length
      && /^[ \t]*$/.test(match[2])
    ) {
      fence = null;
    }
  }

  return fence !== null;
}

function isInsideInlineCode(value: string, offset: number): boolean {
  const lineStart = value.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  const lineEnd = value.indexOf('\n', offset);
  const line = value.slice(lineStart, lineEnd === -1 ? value.length : lineEnd);
  const cursor = offset - lineStart;
  let opening: { end: number; length: number } | null = null;

  for (const match of line.matchAll(/`+/g)) {
    const start = match.index;
    const length = match[0].length;
    const end = start + length;

    if (opening === null) {
      if (end <= cursor) opening = { end, length };
      continue;
    }

    if (length !== opening.length) continue;
    if (opening.end < start && opening.end <= cursor && cursor <= start) return true;
    opening = null;
  }

  return opening !== null && opening.end < cursor;
}

function isInCode(value: string, offset: number): boolean {
  return isInsideFencedCode(value, offset) || isInsideInlineCode(value, offset);
}

function isEscaped(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

/* ── 智能 Tab 导航（源码模式）─────────────────────────────────────
   规则参考 VMark：Tab 在链接字段、括号/引号、Markdown 行内格式之间穿梭。
   优先级由内而外——先处理链接字段，再处理括号/引号，最后处理格式区间；
   代码块（围栏与行内代码）内的跳出由 resolveSmartPair 顶部的 isInCode
   门禁统一禁用，因为代码里的括号与标记是字面语法。 */

// 闭合字符 → 对应开符；引号开闭同形。反引号不在此列：它要么由空对逻辑
// 处理，要么被 isInCode 判定为行内代码而整段禁用，计数法会误伤 ``` 围栏。
const CLOSING_TO_OPENING: Readonly<Record<string, string>> = {
  ')': '(', ']': '[', '}': '{',
  '"': '"', "'": "'",
  '」': '「', '』': '『', '）': '（', '】': '【', '》': '《', '〉': '〈',
  '”': '“', '’': '‘',
};

// 行内格式标记。长标记在前，避免 ** 被拆成两个 * 造成区间误判。
const INLINE_MARKERS: readonly string[] = ['**', '__', '~~', '==', '*', '_', '^'];

function resolveLinkTab(value: string, offset: number): SmartPairDecision | null {
  const lineStart = value.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  const lineEndIndex = value.indexOf('\n', offset);
  const line = value.slice(lineStart, lineEndIndex === -1 ? value.length : lineEndIndex);
  const cursor = offset - lineStart;

  for (const match of line.matchAll(/\[[^\]\r\n]*\]\([^\r\n)]*\)/g)) {
    const start = match.index;
    if (isEscaped(line, start)) continue;
    const openParen = start + match[0].indexOf('(');
    const closeParen = start + match[0].length - 1;
    // 源码模式的链接字段导航：标签方括号后按 Tab 进入 URL，URL 区间内任意
    // 位置（含闭合圆括号处）再按 Tab 跳出整个链接。
    if (cursor === openParen - 1) return { kind: 'move', cursor: lineStart + openParen + 1 };
    if (cursor >= openParen + 1 && cursor <= closeParen) {
      return { kind: 'move', cursor: lineStart + closeParen + 1 };
    }
  }
  return null;
}

// 光标紧邻闭合括号/引号之前时跳出：仅跳过最内一层，嵌套结构需逐次按 Tab。
function resolveBracketTab(value: string, offset: number): SmartPairDecision | null {
  const closing = value[offset];
  const opening = CLOSING_TO_OPENING[closing];
  if (opening === undefined) return null;
  // 闭合字符本身被转义（如 `\」`）时它是字面量，不构成可跳出的闭合。
  if (isEscaped(value, offset)) return null;

  const lineStart = value.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;

  if (opening === closing) {
    // 开闭同形（引号、反引号）：统计同侧未转义的同类字符，奇数表示光标
    // 处于一个尚未闭合的对内。
    let count = 0;
    for (let index = offset - 1; index >= lineStart; index -= 1) {
      if (value[index] === closing && !isEscaped(value, index)) count += 1;
    }
    return count % 2 === 1 ? { kind: 'move', cursor: offset + 1 } : null;
  }

  let depth = 0;
  for (let index = offset - 1; index >= lineStart; index -= 1) {
    const char = value[index];
    if (isEscaped(value, index)) continue;
    if (char === closing) {
      depth += 1;
      continue;
    }
    if (char === opening) {
      if (depth === 0) return { kind: 'move', cursor: offset + 1 };
      depth -= 1;
    }
  }
  return null;
}

// 光标位于行内格式区间内（标记之间）时跳到闭合标记之后。
function resolveInlineRangeTab(value: string, offset: number): SmartPairDecision | null {
  const lineStart = value.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  const lineEndIndex = value.indexOf('\n', offset);
  const line = value.slice(lineStart, lineEndIndex === -1 ? value.length : lineEndIndex);
  const cursor = offset - lineStart;
  const used = new Array<boolean>(line.length).fill(false);

  for (const marker of INLINE_MARKERS) {
    const positions: number[] = [];
    for (let index = 0; index + marker.length <= line.length; index += 1) {
      if (used[index] || !line.startsWith(marker, index) || isEscaped(line, index)) continue;
      positions.push(index);
      for (let step = 0; step < marker.length; step += 1) used[index + step] = true;
      index += marker.length - 1;
    }

    for (let index = 0; index + 1 < positions.length; index += 2) {
      const openEnd = positions[index] + marker.length;
      const closeStart = positions[index + 1];
      const closeEnd = closeStart + marker.length;
      if (cursor < openEnd || cursor > closeStart) continue;
      // CommonMark 分隔符规则：开标记之后、闭标记之前不能是空白，
      // 否则 `2 * 3 * 4` 这类普通文本会被误判为斜体区间。
      if (/\s/.test(line[openEnd] ?? ' ') || /\s/.test(line[closeStart - 1] ?? ' ')) continue;
      return { kind: 'move', cursor: lineStart + closeEnd };
    }
  }
  return null;
}

function resolveTab(value: string, offset: number): SmartPairDecision | null {
  return resolveLinkTab(value, offset)
    ?? resolveBracketTab(value, offset)
    ?? resolveInlineRangeTab(value, offset);
}

function resolveBackspace(value: string, offset: number): SmartPairDecision | null {
  if (offset <= 0 || offset > value.length) return null;

  if (value.slice(offset - 1, offset + 3) === '[]()') {
    return { kind: 'delete', from: offset - 1, to: offset + 3, cursor: offset - 1 };
  }

  const opening = value[offset - 1];
  const closing = PAIRS[opening];
  if (opening !== '`' && closing !== undefined && value[offset] === closing) {
    return { kind: 'delete', from: offset - 1, to: offset + 1, cursor: offset - 1 };
  }

  if (MARKERS.has(opening) && value[offset] === opening) {
    return { kind: 'delete', from: offset - 1, to: offset + 1, cursor: offset - 1 };
  }

  return null;
}

export function resolveSmartPair({ value, offset, key, enabled }: SmartPairInput): SmartPairDecision {
  if (
    !enabled
    || !Number.isInteger(offset)
    || offset < 0
    || offset > value.length
    || !SMART_KEYS.has(key)
  ) return defaultDecision();

  if (isInCode(value, offset)) return defaultDecision();

  const isEmptyBacktickPair = value.slice(offset - 1, offset + 1) === '``'
    && value[offset - 2] !== '`'
    && value[offset + 1] !== '`';
  if (isEmptyBacktickPair) {
    if (key === 'Tab') return { kind: 'move', cursor: offset + 1 };
    if (key === 'Backspace') {
      return { kind: 'delete', from: offset - 1, to: offset + 1, cursor: offset - 1 };
    }
  }

  if (key === 'Tab') return resolveTab(value, offset) ?? defaultDecision();
  if (key === 'Backspace') return resolveBackspace(value, offset) ?? defaultDecision();

  if (MARKERS.has(key) && value[offset - 1] === key && value[offset] === key) {
    return { kind: 'replace', from: offset - 1, to: offset + 1, text: key.repeat(4), cursor: offset + 1 };
  }

  const closing = PAIRS[key];
  if (closing === undefined && !MARKERS.has(key)) return defaultDecision();

  const text = key === '[' ? '[]()' : `${key}${closing ?? key}`;
  return { kind: 'insert', from: offset, to: offset, text, cursor: offset + 1 };
}
