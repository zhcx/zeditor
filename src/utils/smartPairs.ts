export type SmartPairRequest = {
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
  let fenced = false;

  for (const line of beforeCursor.split(/\r?\n/)) {
    if (/^\s*(`{3,}|~{3,})/.test(line)) fenced = !fenced;
  }

  return fenced;
}

function isInsideInlineCode(value: string, offset: number): boolean {
  const beforeCursor = value.slice(0, offset);
  let inside = false;

  for (let index = 0; index < beforeCursor.length;) {
    if (beforeCursor[index] !== '`') {
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < beforeCursor.length && beforeCursor[end] === '`') end += 1;
    if (end - index === 1) inside = !inside;
    index = end;
  }

  return inside;
}

function isInCode(value: string, offset: number): boolean {
  return isInsideFencedCode(value, offset) || isInsideInlineCode(value, offset);
}

function resolveTab(value: string, offset: number): SmartPairDecision | null {
  if (value.slice(offset - 1, offset + 1) === '``') {
    return { kind: 'move', cursor: offset + 1 };
  }

  if (value[offset] === ']' && value.slice(offset + 1, offset + 3) === '()') {
    return { kind: 'move', cursor: offset + 2 };
  }

  if (value[offset] === ')' && value.lastIndexOf('](', offset - 1) !== -1) {
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
  if (closing !== undefined && value[offset] === closing) {
    return { kind: 'delete', from: offset - 1, to: offset + 1, cursor: offset - 1 };
  }

  if (MARKERS.has(opening) && value[offset] === opening) {
    return { kind: 'delete', from: offset - 1, to: offset + 1, cursor: offset - 1 };
  }

  return null;
}

export function resolveSmartPair({ value, offset, key, enabled }: SmartPairRequest): SmartPairDecision {
  if (!enabled) return defaultDecision();

  if (key === 'Tab') return resolveTab(value, offset) ?? defaultDecision();
  if (key === 'Backspace') return resolveBackspace(value, offset) ?? defaultDecision();
  if (isInCode(value, offset)) return defaultDecision();

  if (MARKERS.has(key) && value[offset - 1] === key && value[offset] === key) {
    return { kind: 'replace', from: offset - 1, to: offset + 1, text: key.repeat(4), cursor: offset + 1 };
  }

  const closing = PAIRS[key];
  if (closing === undefined && !MARKERS.has(key)) return defaultDecision();

  const text = key === '[' ? '[]()' : `${key}${closing ?? key}`;
  return { kind: 'insert', from: offset, to: offset, text, cursor: offset + 1 };
}
