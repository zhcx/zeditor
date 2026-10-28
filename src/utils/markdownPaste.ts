/** 行首的块级标记：出现在任何一行都意味着不能当作行内内容插入。 */
const BLOCK_LINE = /^[ \t]*(?:#{1,6}[ \t]|[-+*][ \t]|\d+[.)][ \t]|>|`{3,}|~{3,}|\||-{3,}(?:[ \t]|$))/;

/**
 * 可作为行内内容放进现有段落的 Markdown；含块级结构时返回 null。
 *
 * 从剪贴板 HTML 转换出的单个段落会带首尾空行，这里一并剥掉：粘贴到一段文字中间时，
 * 它应当就地替换选区，而不是另起一段。是否真的能按行内渲染由调用方的渲染器决定
 * （图片、公式等行内元素允许；标题、列表、表格、媒体块等拒绝）。
 */
export function inlinePasteMarkdown(markdown: string): string | null {
  const text = markdown
    .replace(/\r\n?/g, '\n')
    .replace(/^(?:[ \t]*\n)+/, '')
    .replace(/(?:\n[ \t]*)+$/, '');
  if (!text.trim()) return null;
  const lines = text.split('\n');
  if (lines.some(line => line.trim().length === 0)) return null;
  if (lines.some(line => BLOCK_LINE.test(line))) return null;
  return text;
}

/** 块内容与所在段落分开；行内格式不附加转换器的结尾换行。 */
export function prepareMarkdownPaste(markdown: string, source: string, from: number, to: number): string {
  const text = markdown.trimEnd();
  const isBlock = /^(?:#{1,6} |[-+*] |\d+[.)] |>|`{3,}|~{3,}|\||-{3,}(?:\n|$))/.test(text)
    || /\r?\n\r?\n/.test(text);
  if (!isBlock) return text;
  const before = source.slice(0, from);
  const after = source.slice(to);
  const prefix = before && !/\r?\n\r?\n$/.test(before) ? (before.endsWith('\n') ? '\n' : '\n\n') : '';
  const suffix = after && !/^\r?\n\r?\n/.test(after) ? (/^\r?\n/.test(after) ? '\n' : '\n\n') : '';
  return prefix + text + suffix;
}
