/**
 * 行内标记「输入即渲染」：识别光标前刚刚闭合的 Markdown 行内标记。
 *
 * 编辑表面按块各自 contenteditable，用户键入 `**粗体**` 时得到的是字面字符；写回时 `*`
 * 属于必须转义的字符，源码于是变成 `\*\*粗体\*\*`，永远变不成粗体。这里只做纯文本判断，
 * 把「哪一段文本、换成哪种行内元素」算出来交给调用方改 DOM，因此可以在 node:test 里
 * 穷举，不需要 jsdom。
 *
 * 判定必须与 markdown-it 的结果一致：一旦改写就和用户看到的不一样了，所以候选还要交给
 * `rendersAsMarker` 用渲染器本身复核一遍，拿不准的情况一律返回 null，保持字面文本。
 */

import { renderMarkdownSource } from '../markdownPipeline.ts';

/** 支持的标记种类。 */
export type InlineMarkerKind = 'strong' | 'em' | 'del' | 'code';

/**
 * 标记种类 → 生成的行内元素。
 *
 * 删除线用 `<s>`：markdown-it 对 `~~x~~` 输出的是 `<s>`，而 `EMPHASIS_MARKERS` 里
 * `del` 也回写成 `~~`，两边一致才能保证「改写 DOM → 回写源码 → 重新渲染」不再变形。
 *
 * 下划线（`_` / `__`）刻意不支持：CommonMark 只在标点或空白边界才认它，中文正文里
 * `文件_名称` 这类写法很常见，而纯文本判断无法可靠覆盖全部边界规则，宁可交回字面文本。
 */
export const INLINE_MARKER_TAGS: Record<InlineMarkerKind, string> = {
  strong: 'strong',
  em: 'em',
  del: 's',
  code: 'code',
};

export interface InlineMarkerMatch {
  kind: InlineMarkerKind;
  /** 起始标记的左边界（text 内的下标）。 */
  from: number;
  /** 结束标记的右边界，等于光标位置。 */
  to: number;
  /** 标记之间的内容。 */
  content: string;
}

interface MarkerRule {
  marker: string;
  kind: InlineMarkerKind;
}

/** 长标记在前：`**` 必须先于 `*` 尝试，否则 `**粗**` 会被当成 `*` 加 `*粗*`。 */
const MARKER_RULES: readonly MarkerRule[] = [
  { marker: '**', kind: 'strong' },
  { marker: '~~', kind: 'del' },
  { marker: '*', kind: 'em' },
  { marker: '`', kind: 'code' },
];

/**
 * 内容是否值得转换。
 *
 * 空内容、含换行、首尾带空白的都不算（`* 斜 *` 不是强调）；内容里还留着标记字符的
 * 也拒绝，避免把 `**a*b**` 这类嵌套写法只转换一半、留下半截字面量。
 */
function isValidContent(rule: MarkerRule, content: string): boolean {
  if (content.length === 0) return false;
  if (/[\r\n]/.test(content)) return false;
  if (/^\s/.test(content) || /\s$/.test(content)) return false;
  return !content.includes(rule.marker[0]);
}

/**
 * 候选是否真的会渲染成我们准备创建的那个元素。
 *
 * 这是「不误判」的最后一道保险：像 `**a**b**`、`a*b*c*` 这种文本里，光标前的标记虽然
 * 与更早的标记表面配了对，但 markdown-it 的配对是「就近先配」，尾部这一对其实会当字面量
 * 渲染。用渲染器本身复核，就不会出现「敲完变成粗体、但源码渲染回来不是粗体」的分叉。
 */
function rendersAsMarker(text: string, match: InlineMarkerMatch): boolean {
  const tag = INLINE_MARKER_TAGS[match.kind];
  const escaped = match.content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return renderMarkdownSource(text).trim().endsWith(`<${tag}>${escaped}</${tag}></p>`);
}

/**
 * 光标位于 `caret` 时，紧邻光标左侧是否刚好闭合了一个行内标记。
 *
 * 关键约束是「起始标记左边不能再挨着同一个标记字符」：用户打 `**粗体**` 时，第 5 个
 * 字符（收尾 `**` 的第一个 `*`）会让文本停在 `**粗体*`，若此时按单 `*` 收尾就会先把
 * `粗体` 变成斜体，结果整段变成字面量加斜体，再也拼不出粗体。加上这条边界后，
 * 单 `*` 在那一步被拒绝，等第 6 个字符补齐 `**` 才由长标记规则一次成型。
 */
export function matchInlineMarker(text: string, caret: number): InlineMarkerMatch | null {
  if (caret <= 0 || caret > text.length) return null;
  for (const rule of MARKER_RULES) {
    const width = rule.marker.length;
    // 至少要有「一对标记 + 一个内容字符」。
    if (caret < width * 2 + 1) continue;
    if (text.slice(caret - width, caret) !== rule.marker) continue;
    const contentEnd = caret - width;
    const from = text.lastIndexOf(rule.marker, contentEnd - width);
    if (from < 0) continue;
    // 标记左边紧挨同一个字符说明这其实是更长标记的半截，交回字面文本。
    if (from > 0 && text[from - 1] === rule.marker[0]) continue;
    const content = text.slice(from + width, contentEnd);
    if (!isValidContent(rule, content)) continue;
    const match: InlineMarkerMatch = { kind: rule.kind, from, to: caret, content };
    if (!rendersAsMarker(text, match)) continue;
    return match;
  }
  return null;
}
