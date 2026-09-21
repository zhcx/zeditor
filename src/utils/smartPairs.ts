export type SmartPairInput = {
  value: string;
  offset: number;
  key: string;
  enabled: boolean;
};

export type SmartPairRequest = SmartPairInput;

export type SmartPairDecision =
  | { kind: 'default' }
  | { kind: 'insert'; from: number; to: number; text: string; cursor: number }
  | { kind: 'replace'; from: number; to: number; text: string; cursor: number }
  | { kind: 'move'; cursor: number }
  | { kind: 'delete'; from: number; to: number; cursor: number };

const PAIRS: Readonly<Record<string, string>> = {
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

const defaultDecision = (): SmartPairDecision => ({ kind: 'default' });

function isInsideFencedCode(value: string, offset: number): boolean {
  const beforeCursor = value.slice(0, offset);
  let fence: { marker: string; length: number } | null = null;

  for (const line of beforeCursor.split(/\r?\n/)) {
    const match = /^\s*(`{3,}|~{3,})/.exec(line);
    if (match === null) continue;

    const run = match[1];
    if (fence === null) {
      fence = { marker: run[0], length: run.length };
    } else if (run[0] === fence.marker && run.length >= fence.length) {
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
    if (opening.end < cursor && cursor <= start) return true;
    opening = null;
  }

  return opening !== null && opening.end < cursor;
}

function isInCode(value: string, offset: number): boolean {
  return isInsideFencedCode(value, offset) || isInsideInlineCode(value, offset);
}

function resolveTab(value: string, offset: number): SmartPairDecision | null {
  const lineStart = value.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;

  if (
    value[offset] === ']'
    && value.slice(offset + 1, offset + 3) === '()'
    && /\[[^\]\r\n]*\]\(\)$/.test(value.slice(lineStart, offset + 3))
  ) {
    return { kind: 'move', cursor: offset + 2 };
  }

  if (
    value[offset] === ')'
    && /\[[^\]\r\n]*\]\([^\r\n)]*\)$/.test(value.slice(lineStart, offset + 1))
  ) {
    return { kind: 'move', cursor: offset + 1 };
  }

  return null;
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
  if (!enabled) return defaultDecision();

  const isEmptyBacktickPair = value.slice(offset - 1, offset + 1) === '``'
    && value[offset - 2] !== '`'
    && value[offset + 1] !== '`';
  if (isEmptyBacktickPair) {
    if (key === 'Tab') return { kind: 'move', cursor: offset + 1 };
    if (key === 'Backspace') {
      return { kind: 'delete', from: offset - 1, to: offset + 1, cursor: offset - 1 };
    }
  }

  if (isInCode(value, offset)) return defaultDecision();
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
