export interface MarkdownHeading {
  level: number;
  text: string;
  line: number;
}

interface DocumentWithContent {
  id: string;
  content: string;
}

/**
 * Setext 下划线（`---` / `===`）能否给这一行定级。
 *
 * 列表项、引用、缩进代码、引用定义、围栏、分隔线都会把下一行吞进自己的结构里，
 * 此时那行 `---` 不是下划线（而是分隔线、表格分隔行或普通文本），文本行也就不是标题。
 * 不加这个判断，大纲会把 `- 丙\n---` 这类内容当 H2 列出来，与正文渲染结果对不上。
 */
function isSetextHeadingText(line: string, underline: string): boolean {
  if (/^(?: {4,}|\t)/.test(line)) return false;
  if (/^ {0,3}(?:[-*+]|\d{1,9}[.)])[\t ]/.test(line)) return false;
  if (/^ {0,3}>/.test(line)) return false;
  if (/^ {0,3}\[[^\]]*\]:/.test(line)) return false;
  if (/^ {0,3}(?:`{3,}|~{3,})/.test(line)) return false;
  // 文本行本身就是分隔线时不会再被下一行定级。
  if (/^ {0,3}(?:(?:-[\t ]*){3,}|(?:\*[\t ]*){3,}|(?:_[\t ]*){3,})$/.test(line)) return false;
  // 表格行后面跟 `---` 是表格分隔行（构成表格），跟 `===` 才是下划线。
  if (underline === '-' && /^ {0,3}\|/.test(line)) return false;
  return true;
}

export function createOutlineDetectionKey(documentId: string | null, hasHeadings: boolean): string {
  return `${documentId ?? 'unbound'}:${hasHeadings ? 'headings' : 'empty'}`;
}

export function shouldAutoRevealOutline(
  previousDetectionKey: string | null,
  currentDetectionKey: string,
  hasHeadings: boolean,
  outlineVisible: boolean,
): boolean {
  return previousDetectionKey !== currentDetectionKey && hasHeadings && !outlineVisible;
}

export function selectActiveDocumentContent(
  documents: DocumentWithContent[],
  activeDocumentId: string | null,
  fallbackContent: string,
): string {
  return documents.find((document) => document.id === activeDocumentId)?.content ?? fallbackContent;
}

export function parseMarkdownHeadings(content: string): MarkdownHeading[] {
  const lines = content.split(/\r?\n/);
  const headings: MarkdownHeading[] = [];
  let fence: { marker: '`' | '~'; length: number } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = index === 0 ? lines[index].replace(/^\uFEFF/, '') : lines[index];
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as '`' | '~';
      const rest = line.slice(fenceMatch[0].length);
      if (!fence) {
        // 反引号围栏的信息串不能包含反引号，否则它是普通文本。
        if (marker !== '`' || !rest.includes('`')) fence = { marker, length: fenceMatch[1].length };
      } else if (fence.marker === marker && fenceMatch[1].length >= fence.length && /^[\t ]*$/.test(rest)) {
        fence = null;
      }
      continue;
    }
    if (fence) continue;

    const atxMatch = line.match(/^ {0,3}(#{1,6})(?:[\t ]+|$)(.*)$/);
    if (atxMatch) {
      const text = atxMatch[2].replace(/[\t ]+#+[\t ]*$/, '').trim();
      if (text) headings.push({ level: atxMatch[1].length, text, line: index + 1 });
      continue;
    }

    const nextLine = lines[index + 1];
    const setextMatch = nextLine?.match(/^ {0,3}(=+|-+)[\t ]*$/);
    const text = line.trim();
    // Setext 下划线只能给「普通段落」定级。列表项、引用、表格行、缩进代码后面的 `---`
    // 在解析器里是分隔线（或继续留在列表/表格里），不是下划线；不加这个判断，
    // 大纲会把 `- 丙` 这类列表项当成 H2 列出来，与正文渲染结果不一致。
    if (text && setextMatch && isSetextHeadingText(line, setextMatch[1][0])) {
      headings.push({ level: setextMatch[1][0] === '=' ? 1 : 2, text, line: index + 1 });
      index += 1;
    }
  }

  return headings;
}
