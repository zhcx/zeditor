/**
 * 所见即所得的块模型。
 *
 * 文档按顶层块切分：每块记录自己在源码中的行号与字符区间，写回时只替换该区间，
 * 其余字符逐字保留——这是「不做整篇规范化重排」的实现基础。模块是纯函数，
 * 不依赖 DOM 与 React，可直接在 node:test 中断言。
 */
import { markdownRenderer } from '../markdownPipeline.ts';

export type WysiwygBlockKind =
  | 'heading'
  | 'paragraph'
  | 'blockquote'
  | 'list'
  | 'fence'
  | 'table'
  | 'hr'
  | 'html'
  | 'other';

export interface WysiwygBlock {
  kind: WysiwygBlockKind;
  /** 1 起的起始行号（含）。 */
  startLine: number;
  /** 1 起的结束行号（含）。 */
  endLine: number;
  /** 块首字符在整篇源码中的偏移。 */
  offset: number;
  /** 块源码长度，不含块后的换行。 */
  length: number;
  /** 块源码，等于 source.slice(offset, offset + length)。 */
  source: string;
  /** 是否支持原地文本编辑（标题、段落、引用、列表）。 */
  editable: boolean;
}

export interface WysiwygDocument {
  /** 原始 Markdown 源码，逐字保留。 */
  source: string;
  /** 文档主要使用的换行符，新建块时沿用。 */
  eol: '\n' | '\r\n';
  blocks: WysiwygBlock[];
}

const KIND_BY_TOKEN: Record<string, WysiwygBlockKind> = {
  heading_open: 'heading',
  paragraph_open: 'paragraph',
  blockquote_open: 'blockquote',
  bullet_list_open: 'list',
  ordered_list_open: 'list',
  fence: 'fence',
  code_block: 'fence',
  table_open: 'table',
  hr: 'hr',
  html_block: 'html',
};

const EDITABLE_KINDS: ReadonlySet<WysiwygBlockKind> = new Set<WysiwygBlockKind>([
  'heading',
  'paragraph',
  'blockquote',
  'list',
]);

interface SourceLine {
  text: string;
  start: number;
}

export function detectEol(source: string): '\n' | '\r\n' {
  return source.includes('\r\n') ? '\r\n' : '\n';
}

/** 按行切分并记录每行首字符的偏移；结尾换行不会产生额外的空行。 */
function indexLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  const pattern = /\r\n|\n|\r/g;
  let lineStart = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    lines.push({ text: source.slice(lineStart, match.index), start: lineStart });
    lineStart = match.index + match[0].length;
  }
  if (lineStart < source.length) lines.push({ text: source.slice(lineStart), start: lineStart });
  return lines;
}

export function splitMarkdownDocument(source: string): WysiwygDocument {
  const eol = detectEol(source);
  if (source.length === 0) return { source, eol, blocks: [] };

  const lines = indexLines(source);
  const blocks: WysiwygBlock[] = [];
  const tokens = markdownRenderer.parse(source, {});

  for (const token of tokens) {
    if (token.level !== 0 || token.hidden || !token.map) continue;
    const kind = KIND_BY_TOKEN[token.type];
    if (!kind) continue;
    const startIndex = Math.max(0, token.map[0]);
    if (startIndex >= lines.length) continue;
    const endIndex = Math.min(Math.max(token.map[1] - 1, startIndex), lines.length - 1);
    const previous = blocks[blocks.length - 1];
    if (previous && startIndex + 1 <= previous.endLine) continue;

    const offset = lines[startIndex].start;
    const length = lines[endIndex].start + lines[endIndex].text.length - offset;
    blocks.push({
      kind,
      startLine: startIndex + 1,
      endLine: endIndex + 1,
      offset,
      length,
      source: source.slice(offset, offset + length),
      editable: EDITABLE_KINDS.has(kind),
    });
  }

  return { source, eol, blocks };
}

/** 用新的块源码替换该块，其余字符逐字保留；源码未变化时返回原对象。 */
export function replaceBlockSource(doc: WysiwygDocument, block: WysiwygBlock, source: string): WysiwygDocument {
  if (source === block.source) return doc;
  return splitMarkdownDocument(doc.source.slice(0, block.offset) + source + doc.source.slice(block.offset + block.length));
}
