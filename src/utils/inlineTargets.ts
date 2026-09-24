/**
 * 内联弹窗目标检测。
 *
 * 给定文档全文与一个偏移量，判断该位置是否落在可就地编辑的内联结构上：
 * 链接 `[text](url)`、图片 `![alt](src)`、数学公式 `$...$` / `$$...$$`、
 * 脚注引用 `[^1]` 与 Wiki 链接 `[[目标]]`。命中时返回结构的完整区间与
 * 各字段的子区间，供弹窗定位与按字段回写。
 *
 * 与 imageSyntax / smartPairs 一致保持零依赖，便于 node:test 直接加载。
 */

export type InlineTargetKind = 'link' | 'image' | 'math' | 'footnote' | 'wikilink';

/** 一段可编辑的子文本：文档偏移区间 + 原文。 */
export interface InlineFieldRange {
  from: number;
  to: number;
  text: string;
}

export interface InlineTarget {
  kind: InlineTargetKind;
  /** 整个结构的源码区间（含语法标记）。 */
  from: number;
  to: number;
  /** 结构起始行（1 起）。 */
  line: number;
  raw: string;
  /** 链接文字 / wiki 链接别名。链接删除时保留这段文本。 */
  label?: InlineFieldRange;
  /** 链接目标（仅 link）。 */
  url?: InlineFieldRange;
  /** 图片来源。 */
  src?: InlineFieldRange;
  /** 图片替代文本。 */
  alt?: InlineFieldRange;
  /** 图片标题（引号内原文）。 */
  title?: string;
  /** 图片尾部 `{width=…}` 属性原文（回写时原样保留）。 */
  attrs?: string;
  /** 公式 LaTeX 内容（不含定界符）。 */
  latex?: string;
  /** 是否块级公式 `$$…$$`。 */
  display?: boolean;
  /** 脚注名（`[^name]` 的 name）。 */
  name?: string;
  /** 对应的脚注定义 `[^name]: 内容`；未找到为 null。 */
  definition?: InlineFieldRange | null;
  /** wiki 链接目标（工作区相对路径）。 */
  target?: InlineFieldRange;
}

/** index 处的字符是否被反斜杠转义。 */
function isEscaped(value: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && value[i] === '\\'; i -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

/** 每行起始偏移。 */
function lineStartOffsets(value: string): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const line of value.split('\n')) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  return offsets;
}

/**
 * 行内代码 span（`` `…` ``、```` ```…``` ````）的 [start, end) 区间。
 * 按 CommonMark 规则：等长反引号串开闭，内容可含不等长反引号。
 */
function inlineCodeSpans(line: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let index = 0;
  while (index < line.length) {
    if (line[index] !== '`') {
      index += 1;
      continue;
    }
    let runEnd = index;
    while (runEnd < line.length && line[runEnd] === '`') runEnd += 1;
    const runLength = runEnd - index;
    const close = line.indexOf('`'.repeat(runLength), runEnd);
    if (close === -1) {
      index = runEnd;
      continue;
    }
    spans.push([index, close + runLength]);
    index = close + runLength;
  }
  return spans;
}

const FENCE_PATTERN = /^\s*(```+|~~~+)/;

interface LineContext {
  offsets: number[];
  fences: boolean[];
  /** 每行的行内代码 span（行内偏移）。 */
  codeSpans: Array<Array<[number, number]>>;
}

function analyzeLines(value: string): LineContext {
  const lines = value.split('\n');
  const offsets = lineStartOffsets(value);
  const fences: boolean[] = [];
  const codeSpans: Array<Array<[number, number]>> = [];
  let fence = '';
  lines.forEach((line) => {
    const fenceMatch = line.match(FENCE_PATTERN);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!fence) fence = marker;
      else if (fence === marker) fence = '';
      fences.push(true);
    } else {
      fences.push(Boolean(fence));
    }
    codeSpans.push(fence ? [] : inlineCodeSpans(line));
  });
  return { offsets, fences, codeSpans };
}

function inInlineCode(context: LineContext, lineIndex: number, column: number): boolean {
  return context.codeSpans[lineIndex]?.some(([start, end]) => column >= start && column < end) ?? false;
}

interface LineMatch {
  from: number;
  to: number;
  build: (from: number, to: number, raw: string) => InlineTarget;
}

/** 在一行内按优先级匹配各类结构，全部返回行内偏移。 */
function matchLineStructures(line: string): LineMatch[] {
  const matches: LineMatch[] = [];

  // 图片：`![alt](src "title"){attrs}`
  for (const match of line.matchAll(/!\[([^\]]*)\]\(\s*([^\s)]+)(?:\s+(?:"([^"]*)"|'([^']*)'))?\s*\)(\s*\{[^}]*\})?/g)) {
    const start = match.index ?? 0;
    if (isEscaped(line, start)) continue;
    const raw = match[0];
    const srcOffset = start + raw.indexOf('(') + 1;
    matches.push({
      from: start,
      to: start + raw.length,
      build: (from, to) => ({
        kind: 'image',
        from, to, raw, line: 0,
        alt: { from: from + 2, to: from + 2 + (match[1]?.length ?? 0), text: match[1] ?? '' },
        src: {
          from: from + (srcOffset - start),
          to: from + (srcOffset - start) + (match[2]?.length ?? 0),
          text: match[2] ?? '',
        },
        ...(match[3] !== undefined || match[4] !== undefined ? { title: match[3] ?? match[4] } : {}),
        ...(match[5] ? { attrs: match[5].trim() } : {}),
      }),
    });
  }

  // 链接：`[label](url)`（排除已被图片匹配的 `![`）。
  for (const match of line.matchAll(/\[([^\]\r\n]*)\]\(([^)\r\n]*)\)/g)) {
    const start = match.index ?? 0;
    if (start > 0 && line[start - 1] === '!') continue;
    if (isEscaped(line, start)) continue;
    const raw = match[0];
    const openParen = start + raw.indexOf('(');
    matches.push({
      from: start,
      to: start + raw.length,
      build: (from, to) => ({
        kind: 'link',
        from, to, raw, line: 0,
        label: { from: from + 1, to: from + 1 + (match[1]?.length ?? 0), text: match[1] ?? '' },
        url: {
          from: from + (openParen - start) + 1,
          to: from + (openParen - start) + 1 + (match[2]?.length ?? 0),
          text: match[2] ?? '',
        },
      }),
    });
  }

  // Wiki 链接：`[[目标]]` / `[[目标|别名]]`。
  for (const match of line.matchAll(/\[\[([^\]\r\n|]+)(?:\|([^\]\r\n]*))?\]\]/g)) {
    const start = match.index ?? 0;
    if (isEscaped(line, start)) continue;
    const raw = match[0];
    matches.push({
      from: start,
      to: start + raw.length,
      build: (from, to) => ({
        kind: 'wikilink',
        from, to, raw, line: 0,
        target: {
          from: from + 2,
          to: from + 2 + (match[1]?.length ?? 0),
          text: match[1] ?? '',
        },
        ...(match[2] !== undefined
          ? { label: { from: from + 2 + (match[1]?.length ?? 0) + 1, to: from + raw.length - 2, text: match[2] } }
          : {}),
      }),
    });
  }

  // 脚注引用：`[^name]`（`[^name]:` 是定义，不算引用）。
  for (const match of line.matchAll(/\[\^([^\]\r\n]+)\]/g)) {
    const start = match.index ?? 0;
    if (isEscaped(line, start)) continue;
    const raw = match[0];
    matches.push({
      from: start,
      to: start + raw.length,
      build: (from, to) => ({
        kind: 'footnote',
        from, to, raw, line: 0,
        name: match[1] ?? '',
      }),
    });
  }

  return matches;
}

/**
 * 块级公式 `$$…$$`：`$$` 成对开闭，可跨行。返回包含 offset 的公式区间
 * （文档偏移），不在任何块级公式内时返回 null。
 */
function findMathBlockAt(value: string, context: LineContext, offset: number): { from: number; to: number; latex: string } | null {
  const lines = value.split('\n');
  let openOffset: number | null = null;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (context.fences[lineIndex]) continue;
    const line = lines[lineIndex];
    let searchFrom = 0;
    for (;;) {
      const index = line.indexOf('$$', searchFrom);
      if (index === -1) break;
      if (!isEscaped(line, index) && !inInlineCode(context, lineIndex, index)) {
        const docOffset = context.offsets[lineIndex] + index;
        if (openOffset === null) {
          openOffset = docOffset;
        } else {
          const closeEnd = docOffset + 2;
          if (offset >= openOffset && offset <= closeEnd) {
            return { from: openOffset, to: closeEnd, latex: value.slice(openOffset + 2, closeEnd - 2) };
          }
          openOffset = null;
        }
      }
      searchFrom = index + 2;
    }
  }
  // 未闭合的块级公式：光标在开符之后也视为公式区域，便于边写边预览。
  if (openOffset !== null && offset > openOffset) {
    return { from: openOffset, to: openOffset + 2, latex: '' };
  }
  return null;
}

/** 行内公式 `$…$`（同一条线内成对、非 `$$`）。 */
function findInlineMathAt(line: string, context: LineContext, lineIndex: number, column: number): { start: number; end: number; latex: string } | null {
  const dollars: number[] = [];
  for (let index = line.indexOf('$'); index !== -1; index = line.indexOf('$', index + 1)) {
    // `$$` 属于块级公式（或空公式），行内匹配跳过。
    if (line[index + 1] === '$' || line[index - 1] === '$') continue;
    if (isEscaped(line, index)) continue;
    if (inInlineCode(context, lineIndex, index)) continue;
    dollars.push(index);
  }
  for (let pair = 0; pair + 1 < dollars.length; pair += 2) {
    const start = dollars[pair];
    const end = dollars[pair + 1];
    if (column > start && column < end + 1) {
      const latex = line.slice(start + 1, end);
      if (!latex.trim()) continue;
      return { start, end, latex };
    }
  }
  return null;
}

/**
 * 查找 offset 处的内联弹窗目标；offset 恰好落在结构结束位置之后一格时
 * 也视为命中（光标常停在闭合括号后）。
 */
export function findInlineTargetAt(value: string, offset: number): InlineTarget | null {
  if (!value) return null;
  const safeOffset = Math.max(0, Math.min(offset, value.length));
  for (const attempt of [safeOffset, safeOffset - 1]) {
    if (attempt < 0) continue;
    const target = findTargetAtExact(value, attempt);
    if (target) return target;
  }
  return null;
}

function findTargetAtExact(value: string, offset: number): InlineTarget | null {
  const context = analyzeLines(value);
  const safeOffset = Math.max(0, Math.min(offset, value.length));

  // 块级公式可跨行，优先于行内结构判定。
  const blockMath = findMathBlockAt(value, context, safeOffset);
  if (blockMath && safeOffset >= blockMath.from && safeOffset <= blockMath.to) {
    return {
      kind: 'math',
      from: blockMath.from,
      to: blockMath.to,
      line: positionOf(value, blockMath.from).line,
      raw: value.slice(blockMath.from, blockMath.to),
      latex: blockMath.latex,
      display: true,
    };
  }

  const lineIndex = positionOf(value, safeOffset).line - 1;
  if (lineIndex < 0 || context.fences[lineIndex]) return null;
  const lineStart = context.offsets[lineIndex];
  const line = value.split('\n')[lineIndex] ?? '';
  const column = safeOffset - lineStart;
  if (inInlineCode(context, lineIndex, column)) return null;

  for (const match of matchLineStructures(line)) {
    if (column >= match.from && column <= match.to) {
      const target = match.build(lineStart + match.from, lineStart + match.to, line.slice(match.from, match.to));
      target.line = positionOf(value, target.from).line;
      if (target.kind === 'footnote') target.definition = findFootnoteDefinition(value, target.name ?? '');
      return target;
    }
  }

  const inlineMath = findInlineMathAt(line, context, lineIndex, column);
  if (inlineMath) {
    return {
      kind: 'math',
      from: lineStart + inlineMath.start,
      to: lineStart + inlineMath.end + 1,
      line: lineIndex + 1,
      raw: line.slice(inlineMath.start, inlineMath.end + 1),
      latex: inlineMath.latex,
      display: false,
    };
  }
  return null;
}

function positionOf(value: string, offset: number): { line: number; column: number } {
  const before = value.slice(0, Math.max(0, offset));
  const lines = before.split('\n');
  return { line: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 };
}

/** 查找脚注定义 `[^name]: 内容`（跳过代码围栏，允许至多 3 格缩进）。 */
export function findFootnoteDefinition(value: string, name: string): InlineFieldRange | null {
  if (!name) return null;
  const context = analyzeLines(value);
  const lines = value.split('\n');
  const pattern = new RegExp(`^ {0,3}\\[\\^${escapeRegExp(name)}\\]:\\s?`);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (context.fences[lineIndex]) continue;
    const line = lines[lineIndex];
    const match = pattern.exec(line);
    if (!match) continue;
    const start = context.offsets[lineIndex];
    return {
      from: start,
      to: start + line.length,
      text: line.slice(match[0].length),
    };
  }
  return null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 重建链接源码；URL 含空格或括号时包一层尖括号。 */
export function formatLinkMarkdown(label: string, url: string): string {
  const needsAngle = /[\s()]/.test(url) && !/^<.*>$/.test(url);
  const target = needsAngle ? `<${url}>` : url;
  return `[${label}](${target})`;
}

/** 重建 wiki 链接源码。 */
export function formatWikiLinkMarkdown(target: string, display?: string): string {
  return display ? `[[${target}|${display}]]` : `[[${target}]]`;
}

/** 重建脚注引用源码。 */
export function formatFootnoteReference(name: string): string {
  return `[^${name}]`;
}

/** 链接是否可直接在浏览器打开（仅网络地址）。 */
export function isOpenableUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}
