/**
 * 内置 Markdown 静态校对（lint）。
 *
 * 设计参考 VMark 的 lint 引擎：只检查「正确性」问题（断链、未闭合围栏、跳级标题、
 * 反向链接等），不做样式偏好强制（行宽、列表标记风格等交给格式化工具）。
 *
 * 输出与 AI 校对（ProofreadResult）相同结构：UTF-16 偏移 + 原文 + 建议。
 * fixable 的项可直接走「应用修复」链路；report-only 的项 suggestion 与原文相同，
 * 校对面板据此隐藏「应用」按钮。所有偏移均为 UTF-16 单位，与 Monaco 一致。
 */

// 显式 .ts 后缀：该模块被 Node 原生测试直接加载，需要可解析的完整说明符。
import { createHeadingAnchorBase } from './headingAnchors.ts';

export type LintSeverity = 'error' | 'warning';

export interface MarkdownLintIssue {
  /** 规则编号：E** = 错误，W** = 警告（VMark 同款编号，便于文档对照）。 */
  ruleId: string;
  severity: LintSeverity;
  message: string;
  from: number;
  to: number;
  /** 修复后的文本；report-only 规则与原文相同。 */
  suggestion: string;
  fixable: boolean;
}

export interface MarkdownLintOptions {
  /** 选区校对时开启：跳过依赖全文上下文的规则（跳级标题、锚点、链接引用定义）。 */
  partial?: boolean;
}

interface LineSpan {
  text: string;
  start: number;
  end: number;
}

function splitLines(source: string): LineSpan[] {
  const lines: LineSpan[] = [];
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '\n') continue;
    let end = index;
    if (end > start && source[end - 1] === '\r') end -= 1;
    lines.push({ text: source.slice(start, end), start, end });
    start = index + 1;
  }
  if (start <= source.length) {
    let end = source.length;
    if (end > start && source[end - 1] === '\r') end -= 1;
    lines.push({ text: source.slice(start, end), start, end });
  }
  return lines;
}

const FENCE_OPEN = /^(\s{0,3})(`{3,}|~{3,})/;

interface UnclosedFence {
  marker: '`' | '~';
  length: number;
  line: LineSpan;
}

/** 收集围栏代码块占用的行区间；未闭合的围栏单独返回供 E06 使用。 */
function collectFences(lines: LineSpan[]): { spans: Array<[number, number]>; unclosed: UnclosedFence[] } {
  const spans: Array<[number, number]> = [];
  const unclosed: UnclosedFence[] = [];
  let current: { marker: '`' | '~'; length: number; startIndex: number } | null = null;

  lines.forEach((line, index) => {
    const match = FENCE_OPEN.exec(line.text);
    if (!match) return;
    const marker = match[2][0] as '`' | '~';
    const length = match[2].length;

    if (!current) {
      current = { marker, length, startIndex: index };
      return;
    }
    // 关闭条件：同字符、长度不小于开启行、行尾只剩空白
    const rest = line.text.slice(match[0].length);
    if (marker === current.marker && length >= current.length && /^\s*$/.test(rest)) {
      spans.push([current.startIndex, index]);
      current = null;
    }
  });

  if (current) {
    spans.push([current.startIndex, lines.length - 1]);
    unclosed.push({ marker: current.marker, length: current.length, line: lines[current.startIndex] });
  }

  return { spans, unclosed };
}

/** 把一行切成「行内代码 span 之外」的片段，避免在 `code` 里报假阳性。 */
function outsideCodeSpans(text: string): Array<{ start: number; text: string }> {
  const segments: Array<{ start: number; text: string }> = [];
  let cursor = 0;
  let segmentStart = 0;
  let inside = false;
  while (cursor < text.length) {
    if (text[cursor] !== '`') {
      cursor += 1;
      continue;
    }
    let run = 1;
    while (text[cursor + run] === '`') run += 1;
    if (!inside) {
      segments.push({ start: segmentStart, text: text.slice(segmentStart, cursor) });
    }
    inside = !inside;
    cursor += run;
    segmentStart = cursor;
  }
  if (!inside) {
    segments.push({ start: segmentStart, text: text.slice(segmentStart) });
  }
  return segments;
}

/* —— E04：标题 # 后缺少空格 —— */

function checkHeadingSpace(line: LineSpan, issues: MarkdownLintIssue[]): void {
  const match = /^(\s{0,3})(#{1,6})([^#\s])/.exec(line.text);
  if (!match) return;
  const from = line.start + match[1].length;
  const marker = match[2];
  const rest = line.text.slice(match[1].length + marker.length);
  issues.push({
    ruleId: 'E04',
    severity: 'error',
    message: '标题 # 后缺少空格，将无法渲染为标题',
    from,
    to: line.end,
    suggestion: `${marker} ${rest}`,
    fixable: true,
  });
}

/* —— E03：反向链接 (文字)[地址] —— */

const REVERSE_LINK = /\(([^()\n]{1,300}?)\)\[([^\]\n]{1,500}?)\]/g;

function looksLikeLinkTarget(target: string): boolean {
  const value = target.trim();
  if (/^(https?:\/\/|mailto:|#|\/|\.\/|\.\.\/)/i.test(value)) return true;
  // 域名或文件路径（example.com、a/b.png）；排除纯数字等歧义写法
  return /^[^\s]+\.[^\s]+$/.test(value) && !/^\d+$/.test(value);
}

function checkReverseLinks(line: LineSpan, issues: MarkdownLintIssue[]): void {
  for (const segment of outsideCodeSpans(line.text)) {
    REVERSE_LINK.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = REVERSE_LINK.exec(segment.text)) !== null) {
      const [, text, target] = match;
      if (!looksLikeLinkTarget(target)) continue;
      const from = line.start + segment.start + match.index;
      issues.push({
        ruleId: 'E03',
        severity: 'error',
        message: '链接括号写反了：应为 [文字](地址)',
        from,
        to: from + match[0].length,
        suggestion: `[${text}](${target})`,
        fixable: true,
      });
    }
  }
}

/* —— E05：强调标记内侧有空格（* 文字 * 不会渲染为斜体） —— */

const SPACED_EMPHASIS = /(?<!\*)(\*{1,3})[ ]+([^*]*?\p{L}[^*]*?)[ ]+\1(?!\*)/gu;

function checkSpacedEmphasis(line: LineSpan, issues: MarkdownLintIssue[]): void {
  for (const segment of outsideCodeSpans(line.text)) {
    SPACED_EMPHASIS.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SPACED_EMPHASIS.exec(segment.text)) !== null) {
      const marker = match[1];
      const from = line.start + segment.start + match.index;
      issues.push({
        ruleId: 'E05',
        severity: 'error',
        message: '强调标记内侧有空星号空格，渲染时会退化为普通星号',
        from,
        to: from + match[0].length,
        suggestion: `${marker}${match[2].trim()}${marker}`,
        fixable: true,
      });
    }
  }
}

/* —— E02：表格列数不匹配 —— */

const TABLE_DELIMITER = /^\s{0,3}\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

function splitTableRow(text: string): string[] {
  const cells: string[] = [];
  let current = '';
  let escaped = false;
  for (const char of text) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      current += char;
      escaped = true;
      continue;
    }
    if (char === '|') {
      cells.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current);
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells;
}

function checkTables(lines: LineSpan[], fenced: Set<number>, issues: MarkdownLintIssue[]): void {
  let index = 0;
  while (index < lines.length - 1) {
    const headerLine = lines[index];
    const delimiterLine = lines[index + 1];
    if (fenced.has(index) || !headerLine.text.includes('|') || !TABLE_DELIMITER.test(delimiterLine.text)) {
      index += 1;
      continue;
    }

    const headerCount = splitTableRow(headerLine.text).length;
    const delimiterCount = splitTableRow(delimiterLine.text).length;
    if (delimiterCount !== headerCount) {
      issues.push({
        ruleId: 'E02',
        severity: 'error',
        message: `表格分隔行列数（${delimiterCount}）与表头（${headerCount}）不一致`,
        from: delimiterLine.start,
        to: delimiterLine.end,
        suggestion: delimiterLine.text,
        fixable: false,
      });
    }

    let rowIndex = index + 2;
    while (
      rowIndex < lines.length
      && !fenced.has(rowIndex)
      && lines[rowIndex].text.trim() !== ''
      && lines[rowIndex].text.includes('|')
    ) {
      const rowLine = lines[rowIndex];
      const rowCells = splitTableRow(rowLine.text);
      if (rowCells.length < headerCount) {
        const padded = [...rowCells.map((cell) => cell.trim()), ...Array<string>(headerCount - rowCells.length).fill('')];
        issues.push({
          ruleId: 'E02',
          severity: 'error',
          message: `表格列数（${rowCells.length}）少于表头（${headerCount}），已补空单元格`,
          from: rowLine.start,
          to: rowLine.end,
          suggestion: `| ${padded.join(' | ')} |`,
          fixable: true,
        });
      } else if (rowCells.length > headerCount) {
        issues.push({
          ruleId: 'E02',
          severity: 'error',
          message: `表格列数（${rowCells.length}）多于表头（${headerCount}），请合并或删除多余单元格`,
          from: rowLine.start,
          to: rowLine.end,
          suggestion: rowLine.text,
          fixable: false,
        });
      }
      rowIndex += 1;
    }
    index = rowIndex;
  }
}

/* —— E01 / E07 / W03：链接引用定义 —— */

const REF_DEFINITION = /^\s{0,3}\[([^\]^][^\]]{0,200})\]:[ \t]*(\S.*)?$/;
const REF_USAGE_FULL = /\[([^\]^][^\]]{0,200})\]\[([^\]\n]{1,200})\]/g;
const REF_USAGE_COLLAPSED = /\[([^\]^][^\]]{0,200})\]\[\]/g;

function checkReferences(lines: LineSpan[], fenced: Set<number>, issues: MarkdownLintIssue[]): void {
  const definitions = new Map<string, LineSpan[]>();
  const usages = new Map<string, Array<{ from: number; to: number; text: string }>>();

  lines.forEach((line, index) => {
    if (fenced.has(index)) return;
    const definition = REF_DEFINITION.exec(line.text);
    if (definition) {
      const label = definition[1].toLocaleLowerCase();
      const list = definitions.get(label) ?? [];
      list.push(line);
      definitions.set(label, list);
    }
    for (const segment of outsideCodeSpans(line.text)) {
      const register = (regex: RegExp, labelIndex: number) => {
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(segment.text)) !== null) {
          const label = match[labelIndex].toLocaleLowerCase();
          const from = line.start + segment.start + match.index;
          const list = usages.get(label) ?? [];
          list.push({ from, to: from + match[0].length, text: match[0] });
          usages.set(label, list);
        }
      };
      register(REF_USAGE_FULL, 2);
      register(REF_USAGE_COLLAPSED, 1);
    }
  });

  usages.forEach((spans, label) => {
    if (definitions.has(label)) return;
    spans.forEach(({ from, to, text }) => {
      issues.push({
        ruleId: 'E01',
        severity: 'error',
        message: `引用了未定义的链接 [${label}]`,
        from,
        to,
        // report-only：suggestion 必须与原文一致，面板据此隐藏「应用」。
        suggestion: text,
        fixable: false,
      });
    });
  });

  definitions.forEach((spans, label) => {
    spans.slice(1).forEach((line) => {
      issues.push({
        ruleId: 'E07',
        severity: 'error',
        message: `链接引用定义 [${label}] 重复`,
        from: line.start,
        to: line.end,
        suggestion: line.text,
        fixable: false,
      });
    });
    if (!usages.has(label)) {
      issues.push({
        ruleId: 'W03',
        severity: 'warning',
        message: `链接引用定义 [${label}] 未被使用`,
        from: spans[0].start,
        to: spans[0].end,
        suggestion: spans[0].text,
        fixable: false,
      });
    }
  });
}

/* —— W01：标题层级跳级 —— */

const HEADING = /^\s{0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;

function collectHeadings(lines: LineSpan[], fenced: Set<number>): Array<{ level: number; text: string; line: LineSpan }> {
  const headings: Array<{ level: number; text: string; line: LineSpan }> = [];
  lines.forEach((line, index) => {
    if (fenced.has(index)) return;
    const match = HEADING.exec(line.text);
    if (!match) return;
    headings.push({ level: match[1].length, text: match[2], line });
  });
  return headings;
}

function checkHeadingLevels(headings: ReturnType<typeof collectHeadings>, issues: MarkdownLintIssue[]): void {
  let previous = 0;
  headings.forEach(({ level, line }) => {
    if (previous > 0 && level > previous + 1) {
      issues.push({
        ruleId: 'W01',
        severity: 'warning',
        message: `标题层级从 H${previous} 跳到 H${level}，中间缺少 H${previous + 1}`,
        from: line.start,
        to: line.end,
        suggestion: line.text,
        fixable: false,
      });
    }
    previous = level;
  });
}

/* —— W04：内部锚点没有匹配的标题 —— */

const ANCHOR_LINK = /\[([^\]\n]{0,300})\]\((#[^)\s]+)\)/g;

function checkAnchors(lines: LineSpan[], fenced: Set<number>, issues: MarkdownLintIssue[]): void {
  const headings = collectHeadings(lines, fenced);
  const ids = new Set<string>();
  const used = new Set<string>();
  headings.forEach(({ text }) => {
    const base = createHeadingAnchorBase(text);
    let id = base;
    let duplicate = 2;
    while (used.has(id)) id = `${base}-${duplicate++}`;
    used.add(id);
    ids.add(id);
  });

  lines.forEach((line, index) => {
    if (fenced.has(index)) return;
    for (const segment of outsideCodeSpans(line.text)) {
      ANCHOR_LINK.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = ANCHOR_LINK.exec(segment.text)) !== null) {
        const rawFragment = match[2].slice(1);
        let fragment: string;
        try {
          fragment = decodeURIComponent(rawFragment);
        } catch {
          fragment = rawFragment;
        }
        if (ids.has(fragment)) continue;
        const from = line.start + segment.start + match.index;
        issues.push({
          ruleId: 'W04',
          severity: 'warning',
          message: `锚点 #${fragment} 没有匹配的标题`,
          from,
          to: from + match[0].length,
          suggestion: match[0],
          fixable: false,
        });
      }
    }
  });
}

/* —— W02 / E08 / W05：图片与链接的完整性 —— */

function checkLinksAndImages(line: LineSpan, issues: MarkdownLintIssue[]): void {
  for (const segment of outsideCodeSpans(line.text)) {
    const report = (ruleId: string, severity: LintSeverity, message: string, regex: RegExp) => {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(segment.text)) !== null) {
        const from = line.start + segment.start + match.index;
        issues.push({
          ruleId,
          severity,
          message,
          from,
          to: from + match[0].length,
          suggestion: match[0],
          fixable: false,
        });
      }
    };
    report('W02', 'warning', '图片缺少替代文本（alt），会影响无障碍阅读与加载失败提示', /!\[\s*\]\([^)\n]*\)/g);
    // 链接规则不能匹配图片语法：![alt](url) 里的 [](url) 属于图片而非链接
    report('E08', 'error', '链接地址为空（[文字]()），请补充 URL 或删除链接语法', /(?<!!)\[([^\]\n]+)\]\(\s*\)/g);
    report('W05', 'warning', '链接文字为空（[](地址)），不利于无障碍阅读', /(?<!!)\[\s*\]\([^)\n]+\)/g);
  }
}

/**
 * 对 Markdown 源码运行静态校对，返回按文档顺序排列的问题列表。
 * 选区校对（partial）只运行不依赖全文上下文的规则。
 */
export function lintMarkdown(source: string, options: MarkdownLintOptions = {}): MarkdownLintIssue[] {
  const issues: MarkdownLintIssue[] = [];
  const lines = splitLines(source);
  const { spans, unclosed } = collectFences(lines);
  const fenced = new Set<number>();
  spans.forEach(([from, to]) => {
    for (let index = from; index <= to; index += 1) fenced.add(index);
  });

  lines.forEach((line, index) => {
    if (fenced.has(index)) return;
    checkHeadingSpace(line, issues);
    checkReverseLinks(line, issues);
    checkSpacedEmphasis(line, issues);
    checkLinksAndImages(line, issues);
  });

  checkTables(lines, fenced, issues);

  if (!options.partial) {
    const headings = collectHeadings(lines, fenced);
    checkHeadingLevels(headings, issues);
    checkReferences(lines, fenced, issues);
    checkAnchors(lines, fenced, issues);
  }

  // E06：未闭合的围栏代码块
  unclosed.forEach((fence) => {
    issues.push({
      ruleId: 'E06',
      severity: 'error',
      message: `围栏代码块未闭合：请在文末补充 ${fence.marker.repeat(Math.min(3, fence.length))} 关闭`,
      from: fence.line.start,
      to: fence.line.end,
      suggestion: fence.line.text,
      fixable: false,
    });
  });

  return issues.sort((a, b) => a.from - b.from || a.ruleId.localeCompare(b.ruleId));
}
