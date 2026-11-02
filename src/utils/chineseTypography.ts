export interface TypographyRules {
  spacing: boolean;
  punctuation: boolean;
  width: boolean;
  quotes: boolean;
}

export const DEFAULT_TYPOGRAPHY_RULES: TypographyRules = {
  spacing: true, punctuation: true, width: true, quotes: true,
};

interface TextRange { from: number; to: number }
interface TypographyResult { content: string; changed: boolean }

/** Tags whose content is code-like: protect them together with their body. */
const CODE_CONTAINER_TAGS = new Set(['a', 'code', 'math', 'pre', 'script', 'style', 'textarea']);

/** Sticky scanners: matching in place avoids slicing the remaining document. */
const ESCAPE_PATTERN = /\\[^\r\n]/y;
const URL_PATTERN = /(?:https?:\/\/|mailto:)[^\s<>]+/iy;

function scanAt(pattern: RegExp, source: string, at: number): string | null {
  pattern.lastIndex = at;
  const match = pattern.exec(source);
  return match ? match[0] : null;
}

/**
 * Strip block container prefixes (`>` quotes, list markers) so the indentation
 * that matters is measured against the container content, as CommonMark does.
 */
function stripContainerPrefixes(body: string): string {
  let rest = body;
  for (let guard = 0; guard < 32; guard++) {
    const quote = rest.match(/^ {0,3}> ?/);
    if (quote) { rest = rest.slice(quote[0].length); continue; }
    // A marker followed by 1-4 spaces keeps the rest as content; 5+ spaces mean
    // the extra indentation belongs to the content (an indented code block).
    const marker = rest.match(/^ {0,3}(?:[-+*]|\d{1,9}[.)])(?: |$)/);
    if (marker) { rest = rest.slice(marker[0].length); continue; }
    break;
  }
  return rest;
}

/**
 * Return the index just past the HTML tag or comment starting at `start`, or -1
 * when the text there is not a single tag. Tags may wrap across lines inside a
 * paragraph (multiline attributes are valid HTML), so the scan keeps going
 * until a blank line instead of stopping at the first line break.
 */
function htmlTagEnd(source: string, start: number): number {
  let i = start + 1;
  if (source.startsWith('!--', i)) {
    const close = source.indexOf('-->', i + 3);
    return close < 0 ? source.length : close + 3;
  }
  if (source[i] === '/') i++;
  if (!/[A-Za-z]/.test(source[i] ?? '')) return -1;
  while (i < source.length && /[A-Za-z0-9-]/.test(source[i])) i++;
  let quote: string | null = null;
  for (; i < source.length; i++) {
    const char = source[i];
    if (quote) { if (char === quote) quote = null; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '>') return i + 1;
    if (char === '<') return -1;
    if (char === '\n' || char === '\r') {
      let next = i + 1;
      if (char === '\r' && source[next] === '\n') next++;
      let probe = next;
      while (probe < source.length && (source[probe] === ' ' || source[probe] === '\t')) probe++;
      // A blank line ends the paragraph, and a tag cannot continue past it.
      if (probe >= source.length || source[probe] === '\n' || source[probe] === '\r') return -1;
      i = next - 1;
    }
  }
  return -1;
}

/**
 * Match `[` … `]` pairs in one pass. Unmatched openers resolve to -1, so a
 * document full of stray brackets cannot make link scanning quadratic.
 */
function bracketMatches(source: string): Int32Array {
  const matches = new Int32Array(source.length).fill(-1);
  const openers: number[] = [];
  let backslashes = 0;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '\\') { backslashes++; continue; }
    const escaped = backslashes % 2 === 1;
    backslashes = 0;
    if (escaped) continue;
    if (char === '[') openers.push(i);
    else if (char === ']' && openers.length) matches[openers.pop()!] = i;
  }
  return matches;
}

/** Mark syntax conservatively before considering selection boundaries. */
function protectedCharacters(source: string): Uint8Array {
  const mask = new Uint8Array(source.length);
  const mark = (from: number, to: number) => mask.fill(1, from, Math.min(to, source.length));
  let offset = 0;
  let fence: { char: string; length: number } | null = null;
  let mathBlock = false;
  let frontmatter = false;
  let htmlBlock: string | null = null;
  for (const line of source.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? []) {
    if (!line) continue;
    const body = line.replace(/[\r\n]+$/, '');
    if (offset === 0 && /^---\s*$/.test(body)) frontmatter = true;
    else if (frontmatter && /^(?:---|\.\.\.)\s*$/.test(body)) { mark(offset, offset + line.length); frontmatter = false; offset += line.length; continue; }
    if (frontmatter) { mark(offset, offset + line.length); offset += line.length; continue; }
    const marker = body.match(/^\s*(?:>\s*)*(?:(?:[-+*]|\d+[.)])\s+)?(`{3,}|~{3,})/);
    if (fence) {
      mark(offset, offset + line.length);
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && /^\s*$/.test(body.slice((marker.index ?? 0) + marker[0].length))) fence = null;
      offset += line.length; continue;
    }
    if (marker) { fence = { char: marker[1][0], length: marker[1].length }; mark(offset, offset + line.length); offset += line.length; continue; }
    const content = stripContainerPrefixes(body);
    if (/^\s*\$\$/.test(content)) {
      mark(offset, offset + line.length);
      if (mathBlock) mathBlock = false;
      else if (!/\$\$\s*$/.test(content.trim().slice(2))) mathBlock = true;
      offset += line.length; continue;
    }
    if (mathBlock) { mark(offset, offset + line.length); offset += line.length; continue; }
    if (htmlBlock) {
      mark(offset, offset + line.length);
      if (body.toLowerCase().includes(htmlBlock)) htmlBlock = null;
      offset += line.length; continue;
    }
    const htmlOpen = body.match(/^\s*<(script|style|pre|textarea)(?:\s|>)/i);
    if (htmlOpen) {
      htmlBlock = `</${htmlOpen[1].toLowerCase()}>`;
      mark(offset, offset + line.length);
      if (body.toLowerCase().includes(htmlBlock)) htmlBlock = null;
      offset += line.length; continue;
    }
    if (/^(?: {4}|\t)/.test(content) || /^\s*\[[^\]]+\]:/.test(content)) mark(offset, offset + line.length);
    offset += line.length;
  }

  // Preserve email-like tokens, including internationalized local parts. Scan
  // each token once instead of backtracking over long uninterrupted CJK text.
  for (const match of source.matchAll(/[^\s<>()]+/gu)) {
    const at = match[0].indexOf('@');
    if (at > 0 && at < match[0].length - 1) mark(match.index, match.index + match[0].length);
  }

  // Ranges are based on the original document, so a selection inside a construct is safe.
  // Ordinary prose, formulas and code-only documents need no full-size pair table.
  const brackets = source.includes('[') ? bracketMatches(source) : null;
  // Many inline spans may share one long line. Find that line's end once,
  // rather than scanning its remaining characters for every span.
  let inlineLineEnd = -1;
  const lineEndAt = (start: number) => {
    if (start > inlineLineEnd) {
      inlineLineEnd = start;
      while (inlineLineEnd < source.length && source[inlineLineEnd] !== '\n' && source[inlineLineEnd] !== '\r') inlineLineEnd++;
    }
    return inlineLineEnd;
  };
  for (let i = 0; i < source.length;) {
    if (mask[i]) { i++; continue; }
    const texClose = source.startsWith('\\(' , i) ? '\\)' : source.startsWith('\\[', i) ? '\\]' : null;
    if (texClose) {
      const close = source.indexOf(texClose, i + 2);
      const finish = close < 0 ? source.length : close + 2;
      mark(i, finish); i = finish; continue;
    }
    if (source[i] === '<') {
      const tagEnd = htmlTagEnd(source, i);
      if (tagEnd > 0) {
        const tag = source.slice(i, tagEnd);
        const name = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(tag)?.[1].toLowerCase();
        if (name && CODE_CONTAINER_TAGS.has(name) && !tag.endsWith('/>')) {
          const close = new RegExp(`</${name}\\s*>`, 'i').exec(source.slice(tagEnd));
          const finish = close ? tagEnd + close.index + close[0].length : source.length;
          mark(i, finish); i = finish; continue;
        }
        mark(i, tagEnd); i = tagEnd; continue;
      }
    }
    const escaped = scanAt(ESCAPE_PATTERN, source, i);
    if (escaped) { mark(i, i + escaped.length); i += escaped.length; continue; }
    const url = scanAt(URL_PATTERN, source, i);
    if (url) { mark(i, i + url.length); i += url.length; continue; }
    if (source[i] === '`' || source[i] === '$') {
      const char = source[i];
      let end = i + 1;
      while (source[end] === char) end++;
      const delimiter = source.slice(i, end);
      const close = source.indexOf(delimiter, end);
      const limit = char === '`' && close >= 0 ? close : lineEndAt(end);
      const finish = close >= 0 && (char === '`' || close < limit) ? close + delimiter.length : limit;
      mark(i, finish); i = Math.max(finish, end); continue;
    }
    const linkStart = source[i] === '[' ? i : source[i] === '!' && source[i + 1] === '[' ? i + 1 : -1;
    if (linkStart >= 0) {
      const closing = brackets![linkStart];
      if (closing < 0) {
        // Fail closed for the rest of the line only: an unmatched opener is more
        // likely prose than a link, and rescanning further lines would be quadratic.
        let finish = i;
        while (finish < source.length && source[finish] !== '\n' && source[finish] !== '\r') finish++;
        mark(i, finish); i = finish; continue;
      }
      let j = closing + 1;
      if (source[j] === '(') {
        let nesting = 1; j++;
        for (; j < source.length && nesting; j++) {
          if (source[j] === '\\') { j++; continue; }
          if (source[j] === '(') nesting++;
          if (source[j] === ')') nesting--;
        }
      } else if (source[j] === '[') {
        const close = brackets![j]; j = close < 0 ? source.length : close + 1;
      }
      mark(i, j); i = j; continue;
    }
    i++;
  }
  return mask;
}

function formatText(text: string, rules: TypographyRules): string {
  let output = text;
  if (rules.width) output = output.replace(/[Ａ-Ｚａ-ｚ０-９]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
  if (rules.quotes) output = output.replace(/"([^"\r\n]*[\p{Script=Han}][^"\r\n]*)"/gu, '“$1”');
  if (rules.punctuation) {
    const symbols: Record<string, string> = { ',': '，', '!': '！', '?': '？', ':': '：', ';': '；' };
    output = output.replace(/(?<=\p{Script=Han})[,!?:;]|(?<![A-Za-z0-9])[,!?:;](?=\p{Script=Han})/gu, char => symbols[char]);
  }
  if (rules.spacing) {
    output = output.replace(/(\p{Script=Han})([A-Za-z0-9])/gu, '$1 $2')
      .replace(/([A-Za-z0-9])(\p{Script=Han})/gu, '$1 $2');
  }
  return output;
}

export function formatChineseTypography(source: string, rules: TypographyRules = DEFAULT_TYPOGRAPHY_RULES, selection?: TextRange): TypographyResult {
  const from = Math.max(0, Math.min(selection?.from ?? 0, source.length));
  const to = Math.max(from, Math.min(selection?.to ?? source.length, source.length));
  const mask = protectedCharacters(source);
  let output = ''; let cursor = 0;
  while (cursor < source.length) {
    const editable = cursor >= from && cursor < to && !mask[cursor];
    let end = cursor + 1;
    while (end < source.length && (end >= from && end < to && !mask[end]) === editable) end++;
    const part = source.slice(cursor, end);
    output += editable ? formatText(part, rules) : part;
    cursor = end;
  }
  return { content: output, changed: output !== source };
}
