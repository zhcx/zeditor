/**
 * 行内 DOM → Markdown 序列化。
 *
 * 核心是 emitInlineMarkdown：它一边拼 Markdown，一边记下每个片段对应的 DOM 位置，
 * 序列化结果与偏移映射因此共用同一份规则，不会出现两处实现漂移。
 */
import {
  isIslandElement,
  textContentOf,
  type InlineElementNode,
  type InlineNode,
} from './inlineNodes.ts';
import { formatWikiLink } from '../wikiLinks.ts';

export interface MarkdownPiece {
  /** 该片段输出的 Markdown 文本。 */
  text: string;
  /** 产生该片段的节点路径；标记片段（如 `**`）归属于它包裹的元素。 */
  path: number[];
  /** text 片段对应节点内的原文，可按字映射；syntax 片段没有对应文本。 */
  kind: 'text' | 'syntax';
  /** Wiki、脚注和 BR 的光标定位在节点两侧；BR 之后可以是没有文本节点的空行。 */
  atomic?: boolean;
  /** text 片段：原文起始下标。 */
  textFrom?: number;
  /** text 片段：原文结束下标（不含）。 */
  textTo?: number;
  /**
   * text 片段：逐字转义结果。偏移映射必须用它而不是重新调用 escapeInlineText——
   * 片段是否处于行首由上下文决定，重新转义会算出不同的长度，导致光标错位。
   */
  steps?: Array<{ from: number; escaped: string }>;
}

export interface SerializeOptions {
  preserveFootnoteDefinition?: boolean;
  escapePipes?: boolean;
  /** 内容是否位于行首（段落为 true，带 `# `/`- ` 前缀的块为 false）。 */
  escapeLineStart?: boolean;
}

const ALWAYS_ESCAPED = new Set(['\\', '*', '_', '`', '[', ']', '~', '$']);
const LINE_START_ESCAPED = new Set(['#', '>', '-', '+', '=', '~', '*', '_', '!']);

/** 逐字给出转义结果，保留「原文位置 ↔ 输出位置」的对应。 */
export function escapeSteps(text: string, options: SerializeOptions = {}): Array<{ from: number; escaped: string }> {
  const escapeLineStart = options.escapeLineStart !== false;
  const steps: Array<{ from: number; escaped: string }> = [];
  let atLineStart = escapeLineStart;
  let digits = 0;
  const definition = options.preserveFootnoteDefinition ? /^ {0,3}\[\^[^\]\r\n]+\]:/.exec(text) : null;
  const definitionEnd = definition ? definition[0].length : 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    let escaped = char;
    if (char === '\n') {
      atLineStart = true;
      digits = 0;
      steps.push({ from: index, escaped });
      continue;
    }
    if (index < definitionEnd) {
      escaped = char;
    } else if (ALWAYS_ESCAPED.has(char) || (options.escapePipes && char === '|')) {
      escaped = `\\${char}`;
    } else if (atLineStart && LINE_START_ESCAPED.has(char)) {
      escaped = `\\${char}`;
    } else if (atLineStart && /[0-9]/.test(char)) {
      digits = digits * 10 + Number(char);
    } else if (atLineStart && digits > 0 && (char === '.' || char === ')')) {
      escaped = `\\${char}`;
    } else if (char !== ' ' && char !== '\t') {
      digits = 0;
    }
    if (char !== ' ' && char !== '\t') atLineStart = false;
    steps.push({ from: index, escaped });
  }
  return steps;
}

export function escapeInlineText(text: string, options: SerializeOptions = {}): string {
  return escapeSteps(text, options).map(step => step.escaped).join('');
}

const EMPHASIS_MARKERS: Record<string, { open: string; close: string }> = {
  u: { open: '<u>', close: '</u>' },
  sup: { open: '<sup>', close: '</sup>' },
  sub: { open: '<sub>', close: '</sub>' },
  mark: { open: '<mark>', close: '</mark>' },
  strong: { open: '**', close: '**' },
  b: { open: '**', close: '**' },
  em: { open: '*', close: '*' },
  i: { open: '*', close: '*' },
  del: { open: '~~', close: '~~' },
  s: { open: '~~', close: '~~' },
  strike: { open: '~~', close: '~~' },
};

function codeDelimiter(raw: string): string {
  const runs = Array.from(raw.matchAll(/`+/g), match => match[0].length + 1);
  return '`'.repeat(Math.max(1, ...runs));
}

function imageMarkdown(node: InlineElementNode, options: SerializeOptions): string {
  // 表格单元格里必须转义竖线（GFM 同样要求行内代码与链接文本内的竖线转义），否则会被拆成两列。
  const pipe = (value: string) => options.escapePipes ? value.replace(/\|/g, '\\|') : value;
  const alt = pipe((node.attrs.alt ?? '').replace(/]/g, '\\]'));
  // 增强管线改写 src 之前会把原始路径记在 data-md-src：回写必须用它，否则文档里会写进 asset 地址。
  const src = pipe(node.attrs['data-md-src'] ?? node.attrs.src ?? '');
  const size: string[] = [];
  if (node.attrs.width) size.push(`width=${node.attrs.width}`);
  if (node.attrs.height) size.push(`height=${node.attrs.height}`);
  return `![${alt}](${src})${size.length > 0 ? `{${size.join(' ')}}` : ''}`;
}

function linkTarget(node: InlineElementNode): string {
  const href = node.attrs.href ?? '';
  const title = node.attrs.title;
  return title ? `(${href} "${title.replace(/"/g, '\\"')}")` : `(${href})`;
}

/** 下一段内容是否位于行首：整块开头用调用方给的规则，其余看上一片段的结尾。 */
function endsAtLineStart(out: MarkdownPiece[], options: SerializeOptions): boolean {
  if (out.length === 0) return options.escapeLineStart !== false;
  return out[out.length - 1].text.endsWith('\n');
}

function emitNode(node: InlineNode, path: number[], options: SerializeOptions, out: MarkdownPiece[]): void {
  if (node.type === 'text') {
    if (node.text.length === 0) return;
    const steps = escapeSteps(node.text, { ...options, escapeLineStart: endsAtLineStart(out, options) });
    out.push({
      text: steps.map(step => step.escaped).join(''),
      path,
      kind: 'text',
      textFrom: 0,
      textTo: node.text.length,
      steps,
    });
    return;
  }

  if (isIslandElement(node)) return;

  if (node.tag === 'br') {
    if (node.attrs['data-wysiwyg-placeholder'] !== undefined) return;
    out.push({ text: '\n', path, kind: 'syntax', atomic: true });
    return;
  }

  if (node.tag === 'img') {
    out.push({ text: imageMarkdown(node, options), path, kind: 'syntax' });
    return;
  }

  if (node.tag === 'span' && node.attrs['data-tex'] !== undefined) {
    out.push({ text: `$${node.attrs['data-tex']}$`, path, kind: 'syntax' });
    return;
  }

  // Wiki 链接：渲染后的 DOM 只剩显示文字，必须用 data 属性还原成 `[[…]]`。
  // 显示文字被就地改写时作为别名写回，保证「改别名」也能保存。
  if (node.tag === 'span' && node.attrs['data-wiki-target'] !== undefined) {
    let text = formatWikiLink({
      target: node.attrs['data-wiki-target'],
      anchor: node.attrs['data-wiki-anchor'] || null,
      label: null,
    }, textContentOf(node.children));
    // 表格单元格里别名分隔符 `|` 必须转义，否则会被当成列分隔符。
    if (options.escapePipes) text = text.replace(/\|/g, '\\|');
    out.push({ text, path, kind: 'syntax', atomic: true });
    return;
  }

  // 脚注引用：渲染后是 <sup data-footnote-name>，回写成 `[^name]`。
  if (node.tag === 'sup' && node.attrs['data-footnote-name'] !== undefined) {
    out.push({ text: `[^${node.attrs['data-footnote-name']}]`, path, kind: 'syntax', atomic: true });
    return;
  }

  if (node.tag === 'code') {
    // 行内代码内容不做转义，整体作为一个片段输出：内容里的反引号由围栏长度处理。
    // 例外：表格单元格里的竖线必须转义，否则会被当成列分隔符（GFM 要求含行内代码在内一起转义）。
    const raw = textContentOf(node.children);
    if (raw.length === 0) return;
    const escaped = options.escapePipes ? raw.replace(/\|/g, '\\|') : raw;
    const delimiter = codeDelimiter(raw);
    const pad = raw.startsWith('`') || raw.endsWith('`') ? ' ' : '';
    out.push({ text: `${delimiter}${pad}${escaped}${pad}${delimiter}`, path, kind: 'syntax' });
    return;
  }

  const emphasis = EMPHASIS_MARKERS[node.tag];
  if (emphasis) {
    const start = out.length;
    out.push({ text: emphasis.open, path, kind: 'syntax' });
    node.children.forEach((child, index) => emitNode(child, [...path, index], options, out));
    out.push({ text: emphasis.close, path, kind: 'syntax' });
    // 用户删光内容后留下的空标记不写进源码（`****` 不是有效的强调）。
    if (out.length === start + 2) out.splice(start, 2);
    return;
  }

  if (node.tag === 'a') {
    out.push({ text: '[', path, kind: 'syntax' });
    node.children.forEach((child, index) => emitNode(child, [...path, index], options, out));
    out.push({ text: `]${linkTarget(node)}`, path, kind: 'syntax' });
    return;
  }

  // 未知标签（浏览器插入的 span 等）：只保留子节点内容，避免把无意义标签写进源码。
  node.children.forEach((child, index) => emitNode(child, [...path, index], options, out));
}

/** 序列化行内节点；返回带位置的片段列表。 */
export function emitInlineMarkdown(nodes: InlineNode[], options: SerializeOptions = {}): MarkdownPiece[] {
  const pieces: MarkdownPiece[] = [];
  nodes.forEach((node, index) => emitNode(node, [index], options, pieces));
  return pieces;
}

export function serializeInlineNodes(nodes: InlineNode[], options: SerializeOptions = {}): string {
  return emitInlineMarkdown(nodes, options).map(piece => piece.text).join('');
}
