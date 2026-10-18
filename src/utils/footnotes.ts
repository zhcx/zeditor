/**
 * 脚注定义解析与引用定位。
 *
 * 支持：
 * - `[^name]: 内容`
 * - 续行缩进 4 空格或 1 个 tab（中间允许空行）
 * - 围栏代码里的“定义”不参与解析
 * - 同名的第二个定义忽略（与主流 Markdown 实现一致）
 *
 * 预览渲染、所见即所得回写、Monaco 悬停提示共用这里的规则。
 */
export interface FootnoteDefinition {
  name: string;
  content: string;
  /** 定义起始行（1 起）。 */
  line: number;
}

export interface FootnoteReference {
  name: string;
  /** 行内 0 起偏移（含 `[`）。 */
  from: number;
  /** 行内 0 起偏移（不含 `]` 之后）。 */
  to: number;
}

const DEFINITION_START = /^ {0,3}\[\^([^\]\r\n]+)\]:[ \t]*(.*)$/;
const CONTINUATION = /^(?: {4}|\t)(.*)$/;
const REFERENCE = /\[\^([^\]\r\n]+)\]/g;

/** 解析全文的脚注定义；内容保留 Markdown 原文。 */
export function parseFootnoteDefinitions(source: string): Map<string, FootnoteDefinition> {
  const definitions = new Map<string, FootnoteDefinition>();
  const lines = source.split(/\r?\n/);
  let fence: { marker: string; length: number } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      const length = fenceMatch[1].length;
      if (!fence) fence = { marker, length };
      else if (fence.marker === marker && length >= fence.length && /^ {0,3}(`{3,}|~{3,})[ \t]*$/.test(line)) fence = null;
      continue;
    }
    if (fence) continue;

    const match = DEFINITION_START.exec(line);
    if (!match) continue;
    const name = match[1].trim();
    if (!name || definitions.has(name)) continue;

    const content = [match[2]];
    let next = index + 1;
    for (; next < lines.length; next += 1) {
      const continuation = CONTINUATION.exec(lines[next]);
      if (continuation) {
        content.push(continuation[1]);
        continue;
      }
      // 空行属于定义的一部分（后续仍可能有缩进续行）。
      if (lines[next].trim() === '') {
        content.push('');
        continue;
      }
      break;
    }
    while (content.length > 1 && content[content.length - 1] === '') content.pop();
    definitions.set(name, { name, content: content.join('\n'), line: index + 1 });
    index = next - 1;
  }

  return definitions;
}

/** 该匹配是否位于行首且后面紧跟冒号（脚注定义行，不是引用）。 */
function isDefinitionPlaceholder(text: string, from: number, to: number): boolean {
  const prefix = text.slice(0, from);
  const atLineStart = prefix.length === 0 || /(?:^|\n)[ \t]*$/.test(prefix);
  return atLineStart && text.charAt(to) === ':';
}

/** 文本内 `offset` 处的脚注引用（Monaco 悬停提示用）。 */
export function findFootnoteReferenceAt(text: string, offset: number): FootnoteReference | null {
  REFERENCE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REFERENCE.exec(text)) !== null) {
    const from = match.index;
    const to = from + match[0].length;
    if (offset < from || offset > to) continue;
    if (isDefinitionPlaceholder(text, from, to)) continue;
    return { name: match[1].trim(), from, to };
  }
  return null;
}

/**
 * 光标前刚闭合的引用（所见即所得输入即渲染用）。
 * 行首的身份是定义，不转换，否则 `[^1]: 内容` 会被拆坏。
 */
export function matchFootnoteAt(text: string, caret: number): FootnoteReference | null {
  if (caret < 4 || text.charAt(caret - 1) !== ']') return null;
  const from = text.lastIndexOf('[^', caret - 2);
  if (from < 0) return null;
  const name = text.slice(from + 2, caret - 1);
  if (!name || name.includes('[') || name.includes(']') || /[\r\n:]/.test(name)) return null;
  // 行首一律当作定义行，保持纯文本：输入 `[^1]` 时还看不到后面的冒号，
  // 若此刻转成引用，用户就再也写不出 `[^1]: 内容` 了。
  const prefix = text.slice(0, from);
  if (prefix.length === 0 || /(?:^|\n)[ \t]*$/.test(prefix)) return null;
  return { name: name.trim(), from, to: caret };
}
