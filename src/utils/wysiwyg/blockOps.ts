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
const TABLE_ROW_PATTERN = /^[ \t]*\|/;
const FENCE_PATTERN = /^[ \t]*(?:```|~~~)/;

/**
 * 可以按光标拆行的块类型。
 *
 * 表格、代码块、分隔线、HTML 块各有自己的交互入口（表格用单元格导航，代码块用编辑器图层），
 * 按光标拆行会把它们拆成不成形的东西——表格源码 `| a |\n| --- |` 拆开后第二半会被解析成
 * 一个 `- ` 列表项，整张表就此损坏。因此这些类型一律拒绝拆行，交回调用方。
 */
const SPLITTABLE_KINDS: ReadonlySet<WysiwygBlockKind> = new Set<WysiwygBlockKind>([
  'paragraph',
  'heading',
  'list',
  'blockquote',
]);

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
  /**
   * 拼接 head 与 tail 时使用的分隔符。
   *
   * 列表用单换行（同一列表的下一项），引用用「空引用行」（`\n>\n`，同一引用的下一段），
   * 其余用空行。引用不能用单换行：`> a\n> b` 在 CommonMark 里是同一个段落里的软换行，
   * 显示成一个空格，用户会觉得回车没反应。
   */
  separator: string;
}

/**
 * 回车：把块在光标处拆成两部分。
 *
 * 不支持拆行的块类型（表格、代码块、分隔线、HTML）返回 null，调用方应交回浏览器，
 * 不要 `preventDefault`。
 */
export function splitBlock(input: { source: string; kind: WysiwygBlockKind; caret: number }): SplitBlockResult | null {
  if (!SPLITTABLE_KINDS.has(input.kind)) return null;
  const caret = Math.max(0, Math.min(input.caret, input.source.length));
  const head = input.source.slice(0, caret);
  const rest = input.source.slice(caret);
  if (input.kind === 'list') return { head, tail: `${listMarkerForSplit(input.source)}${rest}`, separator: '\n' };
  if (input.kind === 'blockquote') {
    // 沿用该块自己的引用符，嵌套引用（`> > `）才不会被降级成单层。
    const marker = QUOTE_PATTERN.exec(input.source)?.[0] ?? '> ';
    // 光标已在引用内容开头：拆出来只有空引用行，等价于原块，不必插分隔符。
    const separator = head.length === 0 ? '' : `\n${marker.trimEnd()}\n`;
    return { head, tail: `${marker}${rest}`, separator };
  }
  return { head, tail: rest, separator: '\n\n' };
}

/**
 * 引用块末尾是否有一个空的引用行（`> a\n>\n> ` 的最后一行）。
 *
 * markdown-it 不会为空的引用行生成段落元素，渲染出来只有前面的段落，
 * 于是「回车拆出来的新引用段落」在 DOM 里没有落点，光标只能留在原段落。
 * 外壳据此补一个空段落节点（与文档级空段落一样由 pairEnds 合成），
 * 序列化时它又会还原成同一个空引用行。
 */
export function hasTrailingEmptyQuoteLine(source: string): boolean {
  return /^[ \t]*>[ \t]*$/.test(source.split('\n').at(-1) ?? '');
}

/**
 * 空块退块：光标在空的列表项 / 空引用行上按回车时，把这一行降级成普通段落。
 *
 * `- 甲` 回车后会得到 `- 甲\n- `（一个新的空项），此时再按回车应该离开列表，
 * 而不是继续堆空项——这是所有编辑器的通行行为，也是 CHANGELOG 里承诺的「空块退块」。
 *
 * 只在「光标所在行就是块的最后一行的空项」时生效（光标之后还有内容时返回 null，
 * 交给正常拆行），因此列表中间的空项不会意外把列表劈成两半。返回新的块源码与光标偏移。
 */
export function exitEmptyItem(input: { source: string; kind: WysiwygBlockKind; caret: number }): { source: string; caret: number } | null {
  if (input.kind !== 'list' && input.kind !== 'blockquote') return null;
  const caret = Math.max(0, Math.min(input.caret, input.source.length));
  if (input.source.slice(caret).trim().length > 0) return null;
  const lineStart = input.source.lastIndexOf('\n', Math.max(0, caret - 1)) + 1;
  const line = input.source.slice(lineStart, caret);
  const pattern = input.kind === 'list' ? LIST_PATTERN : QUOTE_PATTERN;
  if (line.replace(pattern, '').trim().length > 0) return null;
  // 连同空项前的换行一起收掉，避免退出后留下多余空行。
  const head = input.source.slice(0, lineStart).replace(/(?:\r\n|\n|\r)+$/, '');
  const eol = input.source.includes('\r\n') ? '\r\n' : '\n';
  const separator = head.length === 0 ? '' : `${eol}${eol}`;
  return { source: `${head}${separator}`, caret: head.length + separator.length };
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
    && !LIST_PATTERN.test(source)
    // 表格行与围栏也不能被拼进段落：`| a |` 拼进去会被解析成表格，吞掉两侧正文。
    && !TABLE_ROW_PATTERN.test(source)
    && !FENCE_PATTERN.test(source);
}

/** 退格合并：只在两个都不带块前缀（都是段落）时拼接。 */
export function mergeBlocks(previous: string, current: string): { source: string; caret: number } | null {
  if (!isPlainParagraph(previous) || !isPlainParagraph(current)) return null;
  return { source: `${previous}${current}`, caret: previous.length };
}

/**
 * 块尾 Delete：把后一块的内容并入当前块。
 *
 * 只吸收不带块前缀的段落。被吸收块的前缀（`# `、`- `、`> `）不会随内容一起降级，
 * 拼进来只会变成正文里的符号；后一块带前缀时返回 null，交回浏览器。
 * 当前块自己的前缀保留，因此「标题」「列表项」「引用」都能直接吞掉下一段正文。
 */
export function mergeForward(current: string, next: string): { source: string; caret: number } | null {
  if (!isPlainParagraph(next)) return null;
  return { source: `${current}${next}`, caret: current.length };
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
