/**
 * 所见即所得的块模型。
 *
 * 文档按顶层块切分：每块记录自己在源码中的行号与字符区间，写回时只替换该区间，
 * 其余字符逐字保留——这是「不做整篇规范化重排」的实现基础。模块是纯函数，
 * 不依赖 DOM 与 React，可直接在 node:test 中断言。
 */
import { markdownRenderer } from '../markdownPipeline.ts';
import { findMediaEmbeds } from '../media.ts';
import { countLines } from './textLines.ts';

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

/**
 * 只有「DOM 序列化能完整往返」的块才允许原地编辑，否则回写会丢内容：
 * - 媒体嵌入渲染成播放器后无法从 DOM 还原语法；
 * - 块级公式渲染成 KaTeX 结构，正文编辑会破坏它（行内公式不受影响）；
 * - 围栏代码在文本容器里是只读岛屿，列表或引用中出现时整块重写会丢掉它；
 * - 代码、HTML、表格等专用块嵌在列表/引用内时仍由 token 守卫保护；文本容器可递归往返。
 */
function isEditableBlock(kind: WysiwygBlockKind, source: string): boolean {
  if (!EDITABLE_KINDS.has(kind)) return false;
  if (findMediaEmbeds(source).length > 0) return false;
  if (/^\s*(?:\$\$|\\\[)/.test(source)) return false;
  if (/^[ \t]*(?:```|~~~)/m.test(source)) return false;
  if (kind === 'blockquote' && /^[ \t]*>[ \t]*\|/m.test(source)) return false;
  return true;
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
  const lines = indexLines(source);
  const blocks: WysiwygBlock[] = [];
  const tokens = source.length > 0 ? markdownRenderer.parse(source, {}) : [];

  for (const token of tokens) {
    if (token.level > 0) {
      const block = blocks[blocks.length - 1];
      if (!block?.editable) continue;
      // 判断实际 token 结构，避免引用前缀、懒续行等写法绕过源码正则。
      // 行内序列化会跳过这些岛屿；整块改为源码编辑才能保留其内容。
      if (['fence', 'code_block', 'html_block', 'hr', 'table_open'].includes(token.type)) block.editable = false;
      continue;
    }
    if (token.level !== 0 || token.hidden || !token.map) continue;
    const kind = KIND_BY_TOKEN[token.type];
    if (!kind) continue;
    const startIndex = Math.max(0, token.map[0]);
    if (startIndex >= lines.length) continue;
    const endIndex = Math.min(Math.max(token.map[1] - 1, startIndex), lines.length - 1);
    const previous = blocks[blocks.length - 1];
    if (previous && startIndex + 1 <= previous.endLine) continue;

    const offset = lines[startIndex].start;
    const rawLength = lines[endIndex].start + lines[endIndex].text.length - offset;
    // 块源码不含块尾换行。列表 token 会把块尾的空行算进自己的范围（`- a\n\n` 的长度是 4 而不是 3），
    // 空行被块吃掉后，块后的光标落点就合成不出来：在列表末尾按「在下方插入段落」或退出列表时，
    // 空段落无处安放，光标直接落空。把换行还给块之间的间隙，落点统一由 pairEnds 合成。
    const blockSource = source.slice(offset, offset + rawLength).replace(/(?:\r\n|\n|\r)+$/, '');
    const length = blockSource.length;
    blocks.push({
      kind,
      startLine: startIndex + 1,
      endLine: endIndex + 1,
      offset,
      length,
      source: blockSource,
      editable: isEditableBlock(kind, blockSource),
    });
  }

  if (blocks.length === 0 && source.trim().length > 0) {
    const rawSource = source.trimEnd();
    blocks.push({
      kind: 'other', startLine: 1, endLine: rawSource.split(/\r\n|\n|\r/).length,
      offset: 0, length: rawSource.length, source: rawSource, editable: false,
    });
  }

  // 空段落可能有数千个；在已建好的行索引上定位，避免每次都重扫整篇前缀。
  const lineNumberAt = (offset: number) => {
    if (offset === source.length && /[\r\n]$/.test(source)) return lines.length + 1;
    let low = 0;
    let high = lines.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (lines[middle].start <= offset) low = middle + 1;
      else high = middle;
    }
    return Math.max(1, low);
  };
  const emptyParagraph = (offset: number, length = 0): WysiwygBlock => ({
    kind: 'paragraph',
    startLine: lineNumberAt(offset),
    endLine: lineNumberAt(offset),
    offset,
    length,
    source: source.slice(offset, offset + length),
    editable: true,
  });

  // Markdown 解析器不生成空段落 token，但编辑器必须保留回车新建的光标落点。
  const pairEnds = (from: number, to: number) => {
    const gap = source.slice(from, to);
    if (gap.trim().length > 0) return [];
    return Array.from(gap.matchAll(/\r\n|\n|\r/g))
      .flatMap((match, index) => index % 2 === 1 ? [from + match.index + match[0].length] : []);
  };
  if (blocks.length === 0) {
    const initialLength = /[\r\n]/.test(source) ? 0 : source.length;
    return { source, eol, blocks: [emptyParagraph(0, initialLength), ...pairEnds(0, source.length).map(offset => emptyParagraph(offset))] };
  }

  const editableBlocks: WysiwygBlock[] = [];
  const leadingPairs = pairEnds(0, blocks[0].offset);
  if (leadingPairs.length > 0) {
    editableBlocks.push(emptyParagraph(0), ...leadingPairs.slice(0, -1).map(offset => emptyParagraph(offset)));
  }
  blocks.forEach((block, index) => {
    editableBlocks.push(block);
    const next = blocks[index + 1];
    const gapPairs = pairEnds(block.offset + block.length, next?.offset ?? source.length);
    const emptyOffsets = next ? gapPairs.slice(0, -1) : gapPairs;
    editableBlocks.push(...emptyOffsets.map(offset => emptyParagraph(offset)));
  });

  return { source, eol, blocks: editableBlocks };
}

/** 用新的块源码替换该块，其余字符逐字保留；源码未变化时返回原对象。 */
export function replaceBlockSource(doc: WysiwygDocument, block: WysiwygBlock, source: string): WysiwygDocument {
  if (source === block.source) return doc;
  const index = doc.blocks.indexOf(block);
  if (index >= 0 && canUpdateBlockInPlace(block, source)) {
    return updateBlockInPlace(doc, index, block, source);
  }
  return splitMarkdownDocument(doc.source.slice(0, block.offset) + source + doc.source.slice(block.offset + block.length));
}

/**
 * 这次改写是否仍属于「同一个块」。
 *
 * 判据交给渲染器本身：只解析这一块的源码，若它仍然生成唯一一个类型、可编辑性都相同、
 * 且完整覆盖输入的块，那么全文分块结果不会改变，可以只平移后续块的偏移。
 *
 * 输入普通文字或行内标记时（每 250ms 写回一次），全文 markdown-it 解析是长文档
 * 输入停顿的主要来源；而敲出 `# `、`- `、换行等结构变化时，单块解析会得到不同结果，
 * 自动退回全文重新分块，不会留下错误的块边界。
 */
function canUpdateBlockInPlace(block: WysiwygBlock, source: string): boolean {
  const standalone = splitMarkdownDocument(source);
  if (standalone.blocks.length !== 1) return false;
  const parsed = standalone.blocks[0];
  return parsed.kind === block.kind
    && parsed.editable === block.editable
    && parsed.offset === 0
    && parsed.length === source.length;
}

function updateBlockInPlace(
  doc: WysiwygDocument,
  index: number,
  block: WysiwygBlock,
  source: string,
): WysiwygDocument {
  const offsetDelta = source.length - block.length;
  const lineDelta = countLines(source) - countLines(block.source);
  const blocks = doc.blocks.map((item, position) => {
    if (position === index) {
      // 行号按行数差平移，而不是按新块行数重算：全文分块时列表等 token 会把块尾
      // 空行算进自己的结束行，局部更新看不到这些间隙，平移才与原有语义一致。
      return {
        ...item,
        source,
        length: source.length,
        endLine: item.endLine + lineDelta,
      };
    }
    if (item.offset <= block.offset) return item;
    return {
      ...item,
      offset: item.offset + offsetDelta,
      startLine: item.startLine + lineDelta,
      endLine: item.endLine + lineDelta,
    };
  });
  return {
    ...doc,
    source: doc.source.slice(0, block.offset) + source + doc.source.slice(block.offset + block.length),
    blocks,
  };
}

/**
 * 删除一个块：连同它与相邻块之间的分隔空白一起删除，避免留下多余空行。
 * 返回新源码与删除后光标应落到的偏移。
 */
export function removeBlockFromSource(document: WysiwygDocument, index: number): { source: string; caret: number } {
  const block = document.blocks[index];
  if (!block) return { source: document.source, caret: 0 };
  const next = document.blocks[index + 1];
  if (next) {
    return {
      source: document.source.slice(0, block.offset) + document.source.slice(next.offset),
      caret: block.offset,
    };
  }
  const previous = document.blocks[index - 1];
  const from = previous ? previous.offset + previous.length : 0;
  return {
    source: document.source.slice(0, from) + document.source.slice(block.offset + block.length),
    caret: from,
  };
}
