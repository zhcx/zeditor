/**
 * 光标位置（容器路径 + 文本偏移）与块内 Markdown 偏移的双向映射。
 *
 * 正向：容器偏移（块级序列化的记录）+ 容器内行内偏移（片段表 + 逐字转义步）。
 * 反向：在片段表里累加长度定位片段；落在标记字符内部时吸附到最近的一个文本位置，
 * 恰好越过标记时落在后一个文本片段的起点。
 */
import { emitInlineMarkdown, type MarkdownPiece } from './inlineSerialize.ts';
import type { InlineNode, InlinePoint } from './inlineNodes.ts';
import type { BlockContainerOffset, BlockSerializeResult } from './blockSerialize.ts';

export interface ContainerInput {
  /** 容器节点树（必须与块级序列化时该容器对应的节点一致）。 */
  nodes: InlineNode[];
  /** 容器在块节点树中的路径。 */
  path: number[];
}

function samePath(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function containerEntryOf(block: BlockSerializeResult, path: number[]): BlockContainerOffset | null {
  return block.containers.find(container => samePath(container.path, path)) ?? null;
}

function firstTextPoint(pieces: MarkdownPiece[]): InlinePoint | null {
  const piece = pieces.find(candidate => candidate.kind === 'text' || candidate.atomic);
  if (!piece) return null;
  return piece.atomic
    ? { path: piece.path.slice(0, -1), offset: piece.path[piece.path.length - 1] }
    : { path: piece.path, offset: 0 };
}

/** 光标位置 → 块内 Markdown 偏移；容器未知或光标不在任何文本片段内时返回 null。 */
export function blockOffsetFromPoint(block: BlockSerializeResult, container: ContainerInput, point: InlinePoint): number | null {
  const entry = containerEntryOf(block, container.path);
  if (!entry) return null;

  // 转义上下文必须与序列化时一致，否则片段长度对不上、光标会整体偏移。
  const pieces = emitInlineMarkdown(container.nodes, { escapeLineStart: entry.escapeLineStart, escapePipes: entry.escapePipes, preserveFootnoteDefinition: entry.preserveFootnoteDefinition });
  if (pieces.length === 0) return entry.contentOffset;
  let local = 0;
  for (const piece of pieces) {
    if (piece.atomic && piece.path.every((part, index) => point.path[index] === part)) {
      return entry.contentOffset + local + (point.offset === 0 ? 0 : piece.text.length);
    }
    if (piece.kind === 'text' && samePath(piece.path, point.path)) {
      const escaped = (piece.steps ?? [])
        .filter(step => step.from < point.offset)
        .reduce((total, step) => total + step.escaped.length, 0);
      return entry.contentOffset + local + escaped;
    }
    local += piece.text.length;
  }
  return null;
}

/** 块内 Markdown 偏移 → 光标位置；容器未知时返回 null。 */
export function pointFromBlockOffset(block: BlockSerializeResult, container: ContainerInput, offset: number): InlinePoint | null {
  const entry = containerEntryOf(block, container.path);
  if (!entry) return null;

  const pieces = emitInlineMarkdown(container.nodes, { escapeLineStart: entry.escapeLineStart, escapePipes: entry.escapePipes, preserveFootnoteDefinition: entry.preserveFootnoteDefinition });
  if (pieces.length === 0) return { path: [], offset: 0 };
  const target = offset - entry.contentOffset;
  let local = 0;
  let last: InlinePoint | null = null;

  for (const piece of pieces) {
    if (piece.atomic) {
      const path = piece.path.slice(0, -1);
      const offset = piece.path[piece.path.length - 1];
      if (target <= local) return { path, offset };
      last = { path, offset: offset + 1 };
      if (target <= local + piece.text.length) return last;
      local += piece.text.length;
      continue;
    }
    if (piece.kind === 'text') {
      if (target <= local) return { path: piece.path, offset: 0 };
      let escaped = 0;
      for (const step of piece.steps ?? []) {
        if (local + escaped + step.escaped.length > target) {
          return { path: piece.path, offset: step.from };
        }
        escaped += step.escaped.length;
        last = { path: piece.path, offset: step.from + 1 };
      }
      local += piece.text.length;
      continue;
    }
    // 标记片段：目标落在其内部时吸附到最近的一个文本位置。
    if (local + piece.text.length > target) return last ?? firstTextPoint(pieces);
    local += piece.text.length;
  }

  return last ?? firstTextPoint(pieces);
}
