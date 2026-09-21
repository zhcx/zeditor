export interface TextCleanupResult {
  content: string;
  changed: boolean;
  mapOffset: (offset: number) => number;
}

interface Line {
  start: number;
  contentEnd: number;
  end: number;
}

function isNonNewlineWhitespace(character: string): boolean {
  return /\s/u.test(character) && character !== '\r' && character !== '\n';
}

function splitLines(source: string): Line[] {
  const lines: Line[] = [];
  let lineStart = 0;
  let index = 0;

  while (index < source.length) {
    const character = source[index];
    if (character !== '\r' && character !== '\n') {
      index += 1;
      continue;
    }

    const contentEnd = index;
    index += character === '\r' && source[index + 1] === '\n' ? 2 : 1;
    lines.push({ start: lineStart, contentEnd, end: index });
    lineStart = index;
  }

  if (lineStart < source.length) {
    lines.push({ start: lineStart, contentEnd: source.length, end: source.length });
  }

  return lines;
}

export function cleanText(source: string): TextCleanupResult {
  const lines = splitLines(source);
  const mapping = new Array<number>(source.length + 1).fill(0);
  const parts: string[] = [];
  let outputLength = 0;
  let previousLineWasBlank = false;

  const preserve = (start: number, end: number): void => {
    for (let offset = start; offset <= end; offset += 1) {
      mapping[offset] = outputLength + offset - start;
    }
    parts.push(source.slice(start, end));
    outputLength += end - start;
  };

  const remove = (start: number, end: number): void => {
    for (let offset = start; offset <= end; offset += 1) {
      mapping[offset] = outputLength;
    }
  };

  for (const line of lines) {
    let trimmedContentEnd = line.contentEnd;
    while (
      trimmedContentEnd > line.start &&
      isNonNewlineWhitespace(source[trimmedContentEnd - 1])
    ) {
      trimmedContentEnd -= 1;
    }

    const isBlank = trimmedContentEnd === line.start;
    if (isBlank && previousLineWasBlank) {
      remove(line.start, line.end);
      continue;
    }

    preserve(line.start, trimmedContentEnd);
    remove(trimmedContentEnd, line.contentEnd);
    preserve(line.contentEnd, line.end);
    previousLineWasBlank = isBlank;
  }

  const content = parts.join('');
  const clampOffset = (offset: number): number => {
    if (Number.isNaN(offset) || offset <= 0) {
      return 0;
    }
    if (offset >= source.length) {
      return content.length;
    }
    return mapping[Math.trunc(offset)];
  };

  return {
    content,
    changed: content !== source,
    mapOffset: clampOffset,
  };
}
