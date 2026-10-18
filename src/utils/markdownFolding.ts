/**
 * Markdown 折叠范围计算：标题分节与缩进块。
 *
 * 纯函数、不依赖 Monaco 与 DOM：源码编辑器的 FoldingRangeProvider 直接消费它，
 * node:test 也能对边界情况（代码围栏内的标题、末尾空行、嵌套缩进）逐一断言。
 */

export interface FoldingRangeSpec {
  /** 1 起的起始行（折叠后从该行末尾收起）。 */
  start: number;
  /** 1 起的结束行（含）。 */
  end: number;
}

export interface MarkdownFoldingOptions {
  /** 折叠标题：一个标题到下一个同级或更高级标题之前的全部行。 */
  headings?: boolean;
  /** 折叠缩进：缩进块的各行，以及每一层更深缩进。 */
  indentation?: boolean;
}

const HEADING_LINE = /^ {0,3}(#{1,6})[ \t]+\S/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** 标记代码围栏内的行：围栏里的 `#` 不是标题，缩进也不是文档结构。 */
export function fenceLineMask(lines: readonly string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  let open: string | null = null;
  let openChar = '';
  let openLength = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (open === null) {
      const opened = FENCE_OPEN.exec(line);
      if (opened) {
        mask[index] = true;
        open = opened[1];
        openChar = opened[1][0];
        openLength = opened[1].length;
      }
      continue;
    }
    mask[index] = true;
    const closed = FENCE_CLOSE.exec(line);
    if (closed && closed[1][0] === openChar && closed[1].length >= openLength) {
      open = null;
      openChar = '';
      openLength = 0;
    }
  }
  return mask;
}

/** 行首缩进宽度：制表符按 2 列计，与所见即所得里列表的 2 空格缩进一致。 */
function indentWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    if (char === ' ') width += 1;
    else if (char === '\t') width += 2;
    else break;
  }
  return width;
}

export function markdownFoldingRanges(
  lines: readonly string[],
  options: MarkdownFoldingOptions = {},
): FoldingRangeSpec[] {
  const headingsEnabled = options.headings !== false;
  const indentationEnabled = options.indentation !== false;
  if (lines.length === 0 || (!headingsEnabled && !indentationEnabled)) return [];

  const fenced = fenceLineMask(lines);
  const ranges: FoldingRangeSpec[] = [];

  if (headingsEnabled) {
    const headings: Array<{ line: number; level: number }> = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (fenced[index]) continue;
      const match = HEADING_LINE.exec(lines[index]);
      if (match) headings.push({ line: index, level: match[1].length });
    }
    for (let index = 0; index < headings.length; index += 1) {
      const heading = headings[index];
      let last = lines.length - 1;
      for (let next = index + 1; next < headings.length; next += 1) {
        if (headings[next].level <= heading.level) {
          last = headings[next].line - 1;
          break;
        }
      }
      while (last > heading.line && lines[last].trim().length === 0) last -= 1;
      if (last > heading.line) ranges.push({ start: heading.line + 1, end: last + 1 });
    }
  }

  if (indentationEnabled) {
    // 每层只入栈/出栈一次；折叠锚点是父行，单个子项也能收起。
    const stack: Array<{ width: number; start: number }> = [];
    let previous = -1;
    let previousWidth = 0;
    const close = () => {
      const section = stack.pop();
      if (section && previous > section.start) ranges.push({ start: section.start + 1, end: previous + 1 });
    };
    for (let index = 0; index < lines.length; index += 1) {
      if (fenced[index]) {
        while (stack.length) close();
        previous = -1;
        previousWidth = 0;
        continue;
      }
      if (lines[index].trim().length === 0) continue;
      const width = indentWidth(lines[index]);
      while (stack.length && stack[stack.length - 1].width > width) close();
      if (width > previousWidth) stack.push({ width, start: previous < 0 ? index : previous });
      previous = index;
      previousWidth = width;
    }
    while (stack.length) close();
  }

  // 同一行可能出现两个起点相同的范围（标题与缩进），Monaco 只接受互不重叠的近似
  // 结构，这里按起点排序并丢弃与已有范围起点相同、结束更早的重复项。
  ranges.sort((left, right) => left.start - right.start || right.end - left.end);
  const unique: FoldingRangeSpec[] = [];
  for (const range of ranges) {
    const previous = unique[unique.length - 1];
    if (previous && previous.start === range.start) {
      if (range.end > previous.end) unique[unique.length - 1] = range;
      continue;
    }
    unique.push(range);
  }
  return unique;
}
