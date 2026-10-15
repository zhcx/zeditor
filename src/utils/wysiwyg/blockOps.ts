/**
 * 块结构操作：前缀识别、回车拆块、去前缀、合并、标题级别、列表缩进。
 *
 * 全部是「块源码 + 光标偏移 → 新块源码 + 新光标偏移」的纯函数，不碰 DOM，
 * 因此可以在 node:test 里穷举。行首块标记（`# `、`- `、`> `、`1. `、` ``` `、`---`）不需要
 * 单独的输入规则：编辑回写时由 `serializeBlockMarkdown(..., { allowBlockMarkers: true })`
 * 原样保留，块类型交给随后的重新解析决定。
 */
import type { WysiwygBlockKind } from './blocks.ts';

const HEADING_PATTERN = /^#{1,6}[ \t]+/;
const QUOTE_PATTERN = /^(?:[ \t]*>[ \t]?)+/;
const LIST_PATTERN = /^([ \t]*)([-*+]|\d+[.)])[ \t]+(\[[ xX]\][ \t]+)?/;

/** 块内容（去掉标题/列表/引用前缀）在块源码中的起始偏移。 */
export function contentStartOffset(source: string, kind: WysiwygBlockKind): number {
  if (kind === 'heading') return HEADING_PATTERN.exec(source)?.[0].length ?? 0;
  if (kind === 'blockquote') return QUOTE_PATTERN.exec(source)?.[0].length ?? 0;
  if (kind === 'list') return LIST_PATTERN.exec(source)?.[0].length ?? 0;
  return 0;
}

/** 回车时新块的标记：列表沿用同型标记（有序序号 +1、任务项变未勾选），引用沿用引用符。 */
function listMarkerForSplit(source: string): string {
  const match = LIST_PATTERN.exec(source);
  if (!match) return '- ';
  const [, indent, bullet, task] = match;
  if (task) return `${indent}- [ ] `;
  if (/^\d/.test(bullet)) return `${indent}${Number.parseInt(bullet, 10) + 1}. `;
  return `${indent}${bullet} `;
}

export interface SplitBlockResult {
  head: string;
  tail: string;
  /** 拼接 head 与 tail 时使用的分隔符：列表与引用用单换行，其余用空行。 */
  separator: string;
}

/** 回车：把块在光标处拆成两块。 */
export function splitBlock(input: { source: string; kind: WysiwygBlockKind; caret: number }): SplitBlockResult {
  const caret = Math.max(0, Math.min(input.caret, input.source.length));
  const head = input.source.slice(0, caret);
  const rest = input.source.slice(caret);
  if (input.kind === 'list') return { head, tail: `${listMarkerForSplit(input.source)}${rest}`, separator: '\n' };
  if (input.kind === 'blockquote') return { head, tail: `> ${rest}`, separator: '\n' };
  return { head, tail: rest, separator: '\n\n' };
}

/** 去掉块前缀（标题 / 列表 / 引用降级为段落）；段落本身返回 null。 */
export function stripBlockPrefix(source: string, kind: WysiwygBlockKind): { source: string; caret: number } | null {
  const start = contentStartOffset(source, kind);
  if (start === 0) return null;
  return { source: source.slice(start), caret: 0 };
}

function isPlainParagraph(source: string): boolean {
  return !HEADING_PATTERN.test(source)
    && !QUOTE_PATTERN.test(source)
    && !LIST_PATTERN.test(source);
}

/** 退格合并：只在两个都不带块前缀（都是段落）时拼接。 */
export function mergeBlocks(previous: string, current: string): { source: string; caret: number } | null {
  if (!isPlainParagraph(previous) || !isPlainParagraph(current)) return null;
  return { source: `${previous}${current}`, caret: previous.length };
}

/** Ctrl+0..6：设置标题级别（0 表示还原为段落）。 */
export function setHeadingLevel(source: string, kind: WysiwygBlockKind, level: number): { source: string; caret: number } {
  const stripped = kind === 'heading'
    ? source.replace(HEADING_PATTERN, '')
    : source.slice(contentStartOffset(source, kind));
  const clamped = Math.max(0, Math.min(6, Math.floor(level)));
  if (clamped === 0) return { source: stripped, caret: 0 };
  return { source: `${'#'.repeat(clamped)} ${stripped}`, caret: clamped + 1 };
}

/** Tab / Shift+Tab：列表层级缩进（v1 统一 2 个空格）。 */
export function adjustListIndent(
  source: string,
  kind: WysiwygBlockKind,
  direction: 'indent' | 'outdent',
): { source: string; caret: number } | null {
  if (kind !== 'list') return null;
  const match = LIST_PATTERN.exec(source);
  if (!match) return null;
  if (direction === 'indent') {
    const next = `  ${source}`;
    return { source: next, caret: contentStartOffset(next, 'list') };
  }
  if ((match[1] ?? '').length < 2) return null;
  const next = source.slice(2);
  return { source: next, caret: contentStartOffset(next, 'list') };
}
