/**
 * Obsidian 风格 Wiki 链接（双向链接）的纯函数工具。
 *
 * 支持：
 * - `[[笔记]]`
 * - `[[笔记|显示文字]]`
 * - `[[笔记#标题]]`
 * - `[[笔记#标题|显示文字]]`
 * - `[[#本文标题]]` / `[[#^块id]]`（省略笔记名时指向当前文档）
 *
 * 预览渲染、所见即所得回写与点击跳转共用同一套解析与显示规则，避免三处漂移。
 */
import { createHeadingAnchorBase } from './headingAnchors.ts';
import { parseMarkdownHeadings } from './markdownOutline.ts';

export interface WikiLinkParts {
  /** 笔记名或相对路径；省略时表示当前文档内的锚点。 */
  target: string;
  /** `#` 后的标题文字，或 `^` 开头的块 id。 */
  anchor: string | null;
  /** `|` 后的显示文字。 */
  label: string | null;
}

/** 匹配 `[[...]]`：内容不允许换行与方括号。 */
export const WIKI_LINK_PATTERN = /\[\[([^[\]\r\n]+?)\]\]/g;

/** 解析完整源码 `[[…]]`（也接受只传内部文本，便于回写时复用）。 */
export function parseWikiLink(raw: string): WikiLinkParts | null {
  const wrapped = raw.match(/^\[\[([\s\S]*)\]\]$/);
  const body = wrapped ? wrapped[1] : raw;
  if (!body || body.includes('[') || body.includes(']') || body.includes('\n') || body.includes('\r')) return null;

  const pipe = body.indexOf('|');
  const labelPart = pipe >= 0 ? body.slice(pipe + 1) : null;
  const pathPart = pipe >= 0 ? body.slice(0, pipe) : body;
  const hash = pathPart.indexOf('#');
  const target = (hash >= 0 ? pathPart.slice(0, hash) : pathPart).trim();
  const anchor = hash >= 0 ? pathPart.slice(hash + 1).trim() : '';
  const label = labelPart === null ? '' : labelPart.trim();

  // 只有 `[[#标题]]` 也合法：目标是当前文档。
  if (!target && !anchor) return null;
  return {
    target,
    anchor: anchor || null,
    label: label || null,
  };
}

/** 光标前刚闭合的 wiki 链接（输入即渲染用）。 */
export function matchWikiLinkAt(
  text: string,
  caret: number,
): { from: number; to: number; parts: WikiLinkParts } | null {
  if (caret < 4 || text.charAt(caret - 1) !== ']' || text.charAt(caret - 2) !== ']') return null;
  const from = text.lastIndexOf('[[', caret - 2);
  if (from < 0) return null;
  const parts = parseWikiLink(text.slice(from, caret));
  return parts ? { from, to: caret, parts } : null;
}

/** 没有别名时页面内显示的文字；带锚点时用 Obsidian 的「笔记 > 标题」写法。 */
export function wikiLinkDisplayText(parts: WikiLinkParts): string {
  if (parts.label) return parts.label;
  // 只写了 `#标题` 时指向当前文档，显示标题本身即可。
  if (!parts.target) return parts.anchor ?? '';
  return parts.anchor ? `${parts.target} > ${parts.anchor}` : parts.target;
}

/**
 * 重建链接源码。显示文字与默认显示相同就不写别名；
 * 含 `|` / `[]` 的文字无法安全放进语法，同样退回默认显示。
 */
export function formatWikiLink(parts: WikiLinkParts, display?: string): string {
  const targetPart = `${parts.target}${parts.anchor ? `#${parts.anchor}` : ''}`;
  const text = (display ?? parts.label ?? '').trim();
  const canAlias = text.length > 0
    && text !== wikiLinkDisplayText({ ...parts, label: null })
    && !text.includes('[') && !text.includes(']') && !text.includes('|');
  return `[[${targetPart}${canAlias ? `|${text}` : ''}]]`;
}

/** `#标题` 在文档中的行号（1 起）；先按原文，再按标题锚点归一化后比较。 */
export function findHeadingForWikiAnchor(content: string, anchor: string): { line: number; text: string } | null {
  const wanted = anchor.replace(/^#/, '').trim();
  if (!wanted) return null;
  const headings = parseMarkdownHeadings(content);
  const lower = wanted.toLocaleLowerCase();
  const exact = headings.find(heading => heading.text.trim().toLocaleLowerCase() === lower);
  if (exact) return exact;
  const normalized = createHeadingAnchorBase(wanted);
  return headings.find(heading => createHeadingAnchorBase(heading.text) === normalized) ?? null;
}

/** `#^块 id` 在文档中的行号（1 起）；块 id 写在行尾。 */
export function findBlockReferenceLine(content: string, anchor: string): number | null {
  const id = anchor.replace(/^\^/, '').trim();
  if (!id) return null;
  const pattern = new RegExp(`(?:^|\\s)\\^${escapeRegExp(id)}\\s*$`);
  const lines = content.split(/\r?\n/);
  const index = lines.findIndex(line => pattern.test(line));
  return index >= 0 ? index + 1 : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
