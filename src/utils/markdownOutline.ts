export interface MarkdownHeading {
  level: number;
  text: string;
  line: number;
}

interface DocumentWithContent {
  id: string;
  content: string;
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
    if (text && setextMatch) {
      headings.push({ level: setextMatch[1][0] === '=' ? 1 : 2, text, line: index + 1 });
      index += 1;
    }
  }

  return headings;
}
