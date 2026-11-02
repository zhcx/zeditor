import MarkdownIt from 'markdown-it';

// 只读标准列表结构；不引入预览的公式、图表与高亮渲染依赖。
const listParser = new MarkdownIt({ html: true });

export interface MarkdownIndentGuide {
  startLine: number;
  endLine: number;
  /** 源码中的可视列（Tab 按编辑器的缩进宽度展开），1 起。 */
  column: number;
  depth: number;
}

/** Obsidian 风格：参考线描述嵌套列表层级，不推测普通段落的空白缩进。 */
export function markdownIndentGuides(source: string, tabSize = 2): MarkdownIndentGuide[] {
  const lines = source.split(/\r\n|\n|\r/);
  const parents: Array<{ column: number; startLine: number }> = [];
  const guides: MarkdownIndentGuide[] = [];
  for (const token of listParser.parse(source, {})) {
    if (token.type === 'bullet_list_close' || token.type === 'ordered_list_close') {
      parents.pop();
      continue;
    }
    if ((token.type !== 'bullet_list_open' && token.type !== 'ordered_list_open') || !token.map) continue;
    const first = token.map[0];
    const prefix = /^(?:[ \t]*>[ \t]?)*[ \t]*/.exec(lines[first])?.[0] ?? '';
    let column = 1;
    for (const char of prefix) column += char === '\t' ? tabSize - ((column - 1) % tabSize) : 1;
    const parent = parents.at(-1);
    if (parent) {
      let last = token.map[1] - 1;
      while (last >= first && !lines[last].trim()) last -= 1;
      const startLine = Math.max(first + 1, parent.startLine + 1);
      if (last + 1 >= startLine) guides.push({ startLine, endLine: last + 1, column: parent.column, depth: parents.length });
    }
    parents.push({ column, startLine: first + 1 });
  }
  return guides;
}
