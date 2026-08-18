import { parseMarkdownHeadings, type MarkdownHeading } from './markdownOutline.ts';

export type FrontmatterFieldType =
  | 'text'
  | 'number'
  | 'checkbox'
  | 'date'
  | 'datetime'
  | 'time'
  | 'array'
  | 'select'
  | 'multiselect'
  | 'progress'
  | 'asset';

export interface DocumentDiagnostic {
  severity: 'warning' | 'error';
  message: string;
  from?: number;
  to?: number;
}

export interface FrontmatterField {
  key: string;
  type: FrontmatterFieldType;
  label?: string;
  description?: string;
  value: unknown;
  default?: unknown;
  options?: unknown[];
  sourceRange: { from: number; to: number };
}

export interface ParsedFrontmatter {
  present: boolean;
  raw: string;
  bodyStart: number;
  values: Record<string, unknown>;
  fields: FrontmatterField[];
  diagnostics: DocumentDiagnostic[];
}

export interface DocumentReference {
  sourcePath: string;
  targetPath: string;
  mode: 'link' | 'tip' | 'revision' | 'supertag' | 'pdf-card';
  label?: string;
  metadata?: Record<string, string>;
  sourceRange?: { from: number; to: number };
}

export interface DocumentFootnote {
  label: string;
  content: string;
  referenceCount: number;
  definitionRange?: { from: number; to: number };
}

export interface DocumentAnalysis {
  sourcePath: string;
  contentHash: string;
  frontmatter: ParsedFrontmatter;
  headings: MarkdownHeading[];
  footnotes: DocumentFootnote[];
  references: DocumentReference[];
  diagnostics: DocumentDiagnostic[];
}

const FRONTMATTER_TYPES = new Set<FrontmatterFieldType>([
  'text',
  'number',
  'checkbox',
  'date',
  'datetime',
  'time',
  'array',
  'select',
  'multiselect',
  'progress',
  'asset',
]);

function splitLinesWithOffsets(source: string) {
  const lines: Array<{ text: string; from: number; to: number }> = [];
  let from = 0;
  for (const text of source.split('\n')) {
    const to = from + text.length;
    lines.push({ text: text.endsWith('\r') ? text.slice(0, -1) : text, from, to });
    from = to + 1;
  }
  return lines;
}

function splitInlineList(value: string) {
  const items: string[] = [];
  let current = '';
  let quote = '';
  let depth = 0;
  for (const character of value.slice(1, -1)) {
    if ((character === '"' || character === "'") && (!quote || quote === character)) {
      quote = quote ? '' : character;
      current += character;
      continue;
    }
    if (!quote && (character === '[' || character === '{')) depth += 1;
    if (!quote && (character === ']' || character === '}')) depth -= 1;
    if (character === ',' && !quote && depth === 0) {
      items.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  if (current.trim() || value.trim() === '[]') items.push(current.trim());
  return items.filter(Boolean);
}

function parseScalar(raw: string): unknown {
  const value = raw.trim();
  if (!value) return '';
  if (value.startsWith('[') && value.endsWith(']')) {
    return splitInlineList(value).map((item) => parseScalar(item));
  }
  if (value.startsWith('{') && value.endsWith('}')) {
    const object: Record<string, unknown> = {};
    for (const entry of splitInlineList('[' + value.slice(1, -1) + ']')) {
      const separator = entry.indexOf(':');
      if (separator > 0) object[entry.slice(0, separator).trim()] = parseScalar(entry.slice(separator + 1));
    }
    return object;
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).replace(/\\(["'])/g, '$1');
  }
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  if (/^(null|~)$/i.test(value)) return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith('[') || value.startsWith('{')) throw new Error('invalid inline collection');
  return value;
}

function inferFieldType(value: unknown): FrontmatterFieldType {
  if (typeof value === 'boolean') return 'checkbox';
  if (typeof value === 'number') return 'number';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return 'datetime';
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'date';
    if (/^\d{2}:\d{2}(?::\d{2})?$/.test(value)) return 'time';
  }
  return 'text';
}

function parseFieldBlock(
  lines: Array<{ text: string; from: number; to: number }>,
  start: number,
  end: number,
  key: string,
  rawValue: string,
  diagnostics: DocumentDiagnostic[],
) {
  let value: unknown;
  let typed: Record<string, unknown> | null = null;
  try {
    value = rawValue ? parseScalar(rawValue) : '';
  } catch (error) {
    diagnostics.push({
      severity: 'error',
      message: 'invalid frontmatter value for ' + key + ': ' + (error instanceof Error ? error.message : 'parse error'),
      from: lines[start].from,
      to: lines[end].to,
    });
    value = rawValue;
  }

  const block = lines.slice(start + 1, end + 1);
  if (!rawValue && block.length > 0) {
    typed = {};
    for (const line of block) {
      const match = /^\s{2,}([\w.-]+):(?:\s*(.*))?$/.exec(line.text);
      if (!match) {
        if (line.text.trim()) {
          diagnostics.push({ severity: 'error', message: 'invalid frontmatter field line: ' + line.text.trim(), from: line.from, to: line.to });
        }
        continue;
      }
      try {
        typed[match[1]] = parseScalar(match[2] || '');
      } catch (error) {
        diagnostics.push({
          severity: 'error',
          message: 'invalid frontmatter value for ' + key + '.' + match[1] + ': ' + (error instanceof Error ? error.message : 'parse error'),
          from: line.from,
          to: line.to,
        });
      }
    }
    value = typed.value ?? typed;
  }

  const typeCandidate = typed?.type;
  const type = typeof typeCandidate === 'string' && FRONTMATTER_TYPES.has(typeCandidate as FrontmatterFieldType)
    ? typeCandidate as FrontmatterFieldType
    : inferFieldType(value);

  return {
    key,
    type,
    label: typeof typed?.label === 'string' ? typed.label : undefined,
    description: typeof typed?.description === 'string' ? typed.description : undefined,
    value,
    default: typed?.default,
    options: Array.isArray(typed?.options) ? typed.options : undefined,
    sourceRange: { from: lines[start].from, to: lines[end].to },
  } satisfies FrontmatterField;
}

export function parseFrontmatter(source: string): ParsedFrontmatter {
  const lines = splitLinesWithOffsets(source);
  const firstLine = lines[0]?.text.replace(/^\uFEFF/, '');
  if (firstLine !== '---') {
    return { present: false, raw: '', bodyStart: 0, values: {}, fields: [], diagnostics: [] };
  }

  const closingIndex = lines.findIndex((line, index) => index > 0 && (line.text === '---' || line.text === '...'));
  const endIndex = closingIndex >= 0 ? closingIndex : lines.length - 1;
  let bodyStart = closingIndex >= 0 ? Math.min(source.length, lines[closingIndex].to + (source[lines[closingIndex].to] === '\n' ? 1 : 0)) : source.length;
  while (bodyStart < source.length) {
    const nextLineEnd = source.indexOf('\n', bodyStart);
    const lineEnd = nextLineEnd >= 0 ? nextLineEnd : source.length;
    if (source.slice(bodyStart, lineEnd).trim()) break;
    bodyStart = nextLineEnd >= 0 ? nextLineEnd + 1 : source.length;
  }
  const diagnostics: DocumentDiagnostic[] = [];
  if (closingIndex < 0) {
    diagnostics.push({ severity: 'error', message: 'frontmatter is missing its closing delimiter', from: 0, to: source.length });
  }

  const values: Record<string, unknown> = {};
  const fields: FrontmatterField[] = [];
  for (let index = 1; index < endIndex; index += 1) {
    const line = lines[index];
    if (!line.text.trim()) continue;
    const match = /^([\w.-]+):(?:\s*(.*))?$/.exec(line.text);
    if (!match) {
      diagnostics.push({ severity: 'error', message: 'invalid frontmatter line: ' + line.text.trim(), from: line.from, to: line.to });
      continue;
    }

    let fieldEnd = index;
    while (fieldEnd + 1 < endIndex && /^\s{2,}/.test(lines[fieldEnd + 1].text)) fieldEnd += 1;
    const field = parseFieldBlock(lines, index, fieldEnd, match[1], match[2] || '', diagnostics);
    values[field.key] = field.value;
    fields.push(field);
    index = fieldEnd;
  }

  return {
    present: true,
    raw: source.slice(lines[0].to, closingIndex >= 0 ? lines[closingIndex].from : source.length),
    bodyStart,
    values,
    fields,
    diagnostics,
  };
}

function decodePart(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizePath(path: string) {
  const parts: string[] = [];
  for (const part of path.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function resolveDocumentPath(sourcePath: string, target: string) {
  if (/^(?:[a-z]+:)?\/\//i.test(target)) return target;
  const sourceParts = normalizePath(sourcePath).split('/');
  sourceParts.pop();
  return normalizePath(sourceParts.concat(target).join('/'));
}

export function parseDocumentReferences(source: string, sourcePath: string): DocumentReference[] {
  const references: DocumentReference[] = [];
  const linkPattern = /(!?)\[([^\]\n]+)\]\(([^)\n]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(source))) {
    if (match[1] === '!') continue;
    const parts = match[3].split('|');
    const target = decodePart(parts.shift()?.trim() || '');
    if (!target || target.startsWith('#')) continue;

    let mode: DocumentReference['mode'] = 'link';
    const metadata: Record<string, string> = {};
    for (const part of parts) {
      const separator = part.indexOf('=');
      if (separator <= 0) continue;
      const key = part.slice(0, separator).trim();
      const value = decodePart(part.slice(separator + 1).trim());
      if (key === 'mode' && ['tip', 'revision', 'supertag', 'pdf-card'].includes(value)) {
        mode = value as DocumentReference['mode'];
      } else if (key !== 'mode') {
        metadata[key] = value;
      }
    }

    references.push({
      sourcePath: normalizePath(sourcePath),
      targetPath: resolveDocumentPath(sourcePath, target),
      mode,
      label: decodePart(match[2]),
      metadata: Object.keys(metadata).length ? metadata : undefined,
      sourceRange: { from: match.index, to: match.index + match[0].length },
    });
  }
  return references;
}

function serializeFrontmatterValue(value: unknown) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (Array.isArray(value)) return JSON.stringify(value);
  return JSON.stringify(value);
}

export function updateFrontmatterField(source: string, key: string, value: unknown) {
  const lines = source.split('\n');
  const firstLine = lines[0]?.replace(/^\uFEFF/, '');
  if (firstLine !== '---') {
    return ['---', key + ': ' + serializeFrontmatterValue(value), '---', source].join('\n');
  }

  const closingIndex = lines.findIndex((line, index) => index > 0 && (line.trim() === '---' || line.trim() === '...'));
  if (closingIndex < 0) return source;

  const escapedKey = key.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const fieldPattern = new RegExp('^' + escapedKey + ':(?:\\s*(.*))?$');
  const fieldIndex = lines.findIndex((line, index) => index > 0 && index < closingIndex && fieldPattern.test(line));
  const serialized = serializeFrontmatterValue(value);

  if (fieldIndex < 0) {
    lines.splice(closingIndex, 0, key + ': ' + serialized);
    return lines.join('\n');
  }

  const fieldLine = fieldPattern.exec(lines[fieldIndex]);
  if (fieldLine?.[1]) {
    lines[fieldIndex] = key + ': ' + serialized;
    return lines.join('\n');
  }

  let nestedValueIndex = -1;
  for (let index = fieldIndex + 1; index < closingIndex; index += 1) {
    if (/^\S/.test(lines[index])) break;
    if (/^\s+value:/.test(lines[index])) {
      nestedValueIndex = index;
      break;
    }
  }
  if (nestedValueIndex >= 0) lines[nestedValueIndex] = '  value: ' + serialized;
  else lines.splice(fieldIndex + 1, 0, '  value: ' + serialized);
  return lines.join('\n');
}

function parseFootnotes(source: string, diagnostics: DocumentDiagnostic[]): DocumentFootnote[] {
  const lines = splitLinesWithOffsets(source);
  const definitions = new Map<string, DocumentFootnote>();
  const references = new Map<string, number>();
  for (const match of source.matchAll(/\[\^(\d+)\]/g)) {
    const lineStart = source.lastIndexOf('\n', match.index) + 1;
    if (/^\[\^\d+\]:/.test(source.slice(lineStart, match.index + match[0].length + 1))) continue;
    references.set(match[1], (references.get(match[1]) || 0) + 1);
  }

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\[\^(\d+)\]:\s*(.*)$/.exec(lines[index].text);
    if (!match) continue;
    if (definitions.has(match[1])) {
      diagnostics.push({ severity: 'warning', message: 'duplicate footnote definition: ' + match[1], from: lines[index].from, to: lines[index].to });
      continue;
    }
    let content = match[2];
    let end = lines[index].to;
    while (index + 1 < lines.length && /^\s{2,}\S/.test(lines[index + 1].text)) {
      index += 1;
      content += '\n' + lines[index].text.trim();
      end = lines[index].to;
    }
    definitions.set(match[1], {
      label: match[1],
      content,
      referenceCount: references.get(match[1]) || 0,
      definitionRange: { from: lines[index].from, to: end },
    });
  }

  for (const [label, count] of references) {
    if (!definitions.has(label)) {
      diagnostics.push({ severity: 'warning', message: 'missing footnote definition: ' + label });
      definitions.set(label, { label, content: '', referenceCount: count });
    }
  }
  return [...definitions.values()].sort((left, right) => Number(left.label) - Number(right.label));
}

function stableTextHash(source: string) {
  let hash = 0xcbf29ce484222325n;
  for (const character of source) {
    hash ^= BigInt(character.codePointAt(0) || 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  const first = hash.toString(16).padStart(16, '0');
  const second = BigInt.asUintN(64, hash ^ BigInt(source.length)).toString(16).padStart(16, '0');
  return first + second + first + second;
}

export function parseDocumentAnalysis(source: string, sourcePath = ''): DocumentAnalysis {
  const frontmatter = parseFrontmatter(source);
  const diagnostics = [...frontmatter.diagnostics];
  const footnotes = parseFootnotes(source, diagnostics);
  return {
    sourcePath: normalizePath(sourcePath),
    contentHash: stableTextHash(source),
    frontmatter,
    headings: parseMarkdownHeadings(source.slice(frontmatter.bodyStart)),
    footnotes,
    references: parseDocumentReferences(source, sourcePath),
    diagnostics,
  };
}
