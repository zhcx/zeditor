/**
 * 链接检查：收集 Markdown 文档中的本地链接与图片目标。
 *
 * 对齐 VMark 的 linkCheck 规则：只验证「本地」目标是否真实存在于磁盘——
 * - `[text](./other.md)`、`![alt](./image.png)`、媒体指令 `@[video](demo.mp4)`
 * - 引用式定义 `[ref]: ./other.md`
 *
 * 不检查：外部 URL（任何 URI 协议与协议相对 URL）、仅片段链接（`#anchor`）、
 * UNC 网络路径（`\\server\share`，网络探测可能泄露登录凭据）与驱动器相对路径
 * （`C:file.md`）。Windows 盘符绝对路径（`C:\…`）与根相对路径（`/docs/x.md`）
 * 仍按文件路径检查。
 *
 * 与 markdownLint / inlineTargets 一致保持零依赖，便于 node:test 直接加载。
 * 所有偏移均为 UTF-16 单位，与 Monaco 一致。
 */

export type LinkCheckTargetKind = 'link' | 'image' | 'media' | 'reference';

export interface LocalLinkTarget {
  kind: LinkCheckTargetKind;
  /** 待检查的本地路径（已去除片段与查询串，保留原始写法）。 */
  path: string;
  /** 目标语法在源码中的区间（UTF-16），用于诊断标记定位。 */
  from: number;
  to: number;
  /** 源码中的完整语法片段，用于报告展示。 */
  raw: string;
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

/** 收集围栏代码块占用的行号；未闭合的围栏按延续到文末处理。 */
function collectFencedLines(lines: LineSpan[]): Set<number> {
  const fenced = new Set<number>();
  let current: { marker: string; length: number } | null = null;
  lines.forEach((line, index) => {
    const match = FENCE_OPEN.exec(line.text);
    if (!match) {
      if (current) fenced.add(index);
      return;
    }
    const marker = match[2][0];
    const length = match[2].length;
    if (!current) {
      current = { marker, length };
      fenced.add(index);
      return;
    }
    const rest = line.text.slice(match[0].length);
    if (marker === current.marker && length >= current.length && /^\s*$/.test(rest)) {
      fenced.add(index);
      current = null;
      return;
    }
    fenced.add(index);
  });
  // 未闭合的围栏：current 在循环中保持非空，其后所有行已全部视为代码。
  return fenced;
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

/** index 处的字符是否被反斜杠转义。 */
function isEscaped(value: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && value[i] === '\\'; i -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

/** 尾部 title：`./x.md "标题"` / `'标题'` / `(标题)`。 */
const TRAILING_TITLE = /^(\S+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))$/;

/**
 * 把 Markdown 链接目标归一化为待检查的本地路径；应跳过时返回 null。
 * 解析规则与 VMark 的 linkCheck 一致：
 * - 尖括号写法 `[a](<./my file.md>)` 剥离尖括号
 * - 去除 `#片段` 与 `?查询串`（都不是文件路径的一部分）
 * - 跳过 URI 协议、协议相对 URL、UNC 路径与驱动器相对路径
 */
export function resolveLocalLinkPath(raw: string): string | null {
  let value = raw.trim();
  if (!value) return null;

  if (value.startsWith('<')) {
    const close = value.indexOf('>');
    value = close === -1 ? value.slice(1) : value.slice(1, close);
  }

  const hashIndex = value.indexOf('#');
  if (hashIndex !== -1) value = value.slice(0, hashIndex);
  const queryIndex = value.indexOf('?');
  if (queryIndex !== -1) value = value.slice(0, queryIndex);
  value = value.trim();
  if (!value) return null;

  const titleMatch = TRAILING_TITLE.exec(value);
  if (titleMatch) value = titleMatch[1];

  // Windows 盘符绝对路径（C:\、C:/）是本地文件，先于 URI 协议判断放行。
  if (/^[a-z]:[\\/]/i.test(value)) return value;
  // 驱动器相对路径（C:file.md）相对应用工作目录而非文档目录，跳过。
  if (/^[a-z]:(?![/\\])/i.test(value)) return null;
  // 协议相对 URL（//host/…）与 UNC 网络路径（\\server\share\…）。
  if (value.startsWith('//') || value.startsWith('\\\\')) return null;
  // 其余任何 URI 协议（http:、mailto:、obsidian:、vscode: 等）不是本地文件。
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;

  return value;
}

// 图片：`![alt](src "title")`（src 不含空白，与 inlineTargets 保持一致）。
const IMAGE_PATTERN = /!\[([^\]]*)\]\(\s*([^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
// 媒体指令：`@[video](demo.mp4)`（youtube/embed 等远程地址由 resolveLocalLinkPath 跳过）。
const MEDIA_DIRECTIVE_PATTERN = /@\[(?:video|audio|youtube|embed)\]\(([^\s)]+)\)/g;
// 链接：`[text](url)`，括号内容可含 title，由 resolveLocalLinkPath 归一化。
const LINK_PATTERN = /\[([^\]\r\n]*)\]\(([^)\r\n]*)\)/g;
// 引用式定义：`[ref]: ./path "title"`（与 markdownLint.REF_DEFINITION 同款规则）。
const REF_DEFINITION = /^\s{0,3}\[([^\]^][^\]]{0,200})\]:[ \t]*(\S.*)?$/;

/**
 * 扫描 Markdown 源码，返回按文档顺序排列的本地链接 / 图片目标。
 * 跳过代码块与行内代码；外部 URL、片段与网络路径不进入结果。
 */
export function collectLocalLinkTargets(source: string): LocalLinkTarget[] {
  const targets: LocalLinkTarget[] = [];
  if (!source) return targets;
  const lines = splitLines(source);
  const fenced = collectFencedLines(lines);

  lines.forEach((line, index) => {
    if (fenced.has(index)) return;

    const definition = REF_DEFINITION.exec(line.text);
    if (definition) {
      const path = definition[2] === undefined ? null : resolveLocalLinkPath(definition[2]);
      if (path) {
        targets.push({
          kind: 'reference',
          path,
          from: line.start,
          to: line.end,
          raw: line.text.trim(),
        });
      }
      return;
    }

    for (const segment of outsideCodeSpans(line.text)) {
      // 图片（含被提升为媒体播放器的 ![](demo.mp4)）。
      for (const match of segment.text.matchAll(IMAGE_PATTERN)) {
        const start = match.index ?? 0;
        if (isEscaped(line.text, segment.start + start)) continue;
        const path = resolveLocalLinkPath(match[2]);
        if (!path) continue;
        const from = line.start + segment.start + start;
        targets.push({ kind: 'image', path, from, to: from + match[0].length, raw: match[0] });
      }

      // 媒体指令 `@[video](demo.mp4)`。
      for (const match of segment.text.matchAll(MEDIA_DIRECTIVE_PATTERN)) {
        const start = match.index ?? 0;
        if (isEscaped(line.text, segment.start + start)) continue;
        const path = resolveLocalLinkPath(match[1]);
        if (!path) continue;
        const from = line.start + segment.start + start;
        targets.push({ kind: 'media', path, from, to: from + match[0].length, raw: match[0] });
      }

      // 链接（`![` 前缀属于图片语法、`@[` 前缀属于媒体指令，跳过避免重复报告）。
      for (const match of segment.text.matchAll(LINK_PATTERN)) {
        const start = match.index ?? 0;
        if (start > 0 && (segment.text[start - 1] === '!' || segment.text[start - 1] === '@')) continue;
        if (isEscaped(line.text, segment.start + start)) continue;
        const path = resolveLocalLinkPath(match[2]);
        if (!path) continue;
        const from = line.start + segment.start + start;
        targets.push({ kind: 'link', path, from, to: from + match[0].length, raw: match[0] });
      }
    }
  });

  return targets.sort((a, b) => a.from - b.from);
}
