/**
 * 源码行定位工具：状态栏行列、`lineAt` / `line` 适配、按行滚动定位都基于它。
 */
export interface TextLine {
  from: number;
  to: number;
  number: number;
  text: string;
}

/** 每行首字符的偏移；末尾没有换行时最后一行也会记录。 */
export function computeLineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\n') {
      starts.push(index + 1);
    } else if (char === '\r') {
      if (source[index + 1] === '\n') index += 1;
      starts.push(index + 1);
    }
  }
  return starts;
}

/** 1 起的行号；偏移超出范围时返回最后一行的行号（下限 1）。 */
export function lineNumberAt(source: string, offset: number): number {
  const starts = computeLineStarts(source);
  const clamped = Math.max(0, Math.min(offset, source.length));
  let line = 1;
  for (let index = 1; index < starts.length; index += 1) {
    if (starts[index] > clamped) break;
    line = index + 1;
  }
  return line;
}

export function lineAtOffset(source: string, offset: number): TextLine {
  const starts = computeLineStarts(source);
  const number = lineNumberAt(source, offset);
  const from = starts[number - 1] ?? 0;
  const nextStart = starts[number];
  // `to` 指向行内容结束（不含换行符），与 EditorController 的既有约定一致。
  const to = nextStart === undefined
    ? source.length
    : nextStart - (source[nextStart - 2] === '\r' ? 2 : 1);
  return { from, to, number, text: source.slice(from, to) };
}

export function offsetOfLine(source: string, lineNumber: number): number {
  const starts = computeLineStarts(source);
  const index = Math.max(0, Math.min(lineNumber - 1, starts.length - 1));
  return starts[index];
}

/** 行数（与 `state.doc.lines` 一致，至少为 1）。 */
export function countLines(source: string): number {
  return computeLineStarts(source).length;
}
