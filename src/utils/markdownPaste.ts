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
