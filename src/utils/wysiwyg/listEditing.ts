import { markdownRenderer } from '../markdownPipeline.ts';
import { computeLineStarts } from './textLines.ts';

const MARKER = /^((?:[ \t]*>[ \t]?)*)([ \t]*)([-*+]|\d+[.)])[ \t]+/;

interface Item { from: number; to: number; parent: Item | null; list: number; marker: RegExpExecArray }

/** 解析实际列表项边界，缩进时连同续段与后代一起移动，不改动相邻项。 */
export function changeListIndent(source: string, direction: 'indent' | 'outdent', caret: number): { source: string; caret: number } | null {
  const starts = computeLineStarts(source);
  const items: Item[] = [];
  const parents: Item[] = [];
  const lists: number[] = [];
  const tokens = markdownRenderer.parse(source, {});
  tokens.forEach((token, index) => {
    if (token.type === 'bullet_list_open' || token.type === 'ordered_list_open') lists.push(index);
    if (token.type === 'bullet_list_close' || token.type === 'ordered_list_close') lists.pop();
    if (token.type === 'list_item_close') parents.pop();
    if (token.type !== 'list_item_open' || !token.map) return;
    const from = starts[token.map[0]] ?? source.length;
    const marker = MARKER.exec(source.slice(from));
    if (!marker) return;
    const item: Item = { from, to: starts[token.map[1]] ?? source.length, parent: parents.at(-1) ?? null, list: lists.at(-1) ?? 0, marker };
    items.push(item);
    parents.push(item);
  });
  const item = items.filter(item => item.from <= caret && (caret < item.to || item.to === source.length)).at(-1);
  if (!item) return null;
  const previous = items.filter(other => other.list === item.list && other.parent === item.parent && other.from < item.from).at(-1);
  let delta: number;
  if (direction === 'indent') {
    if (!previous) return null;
    delta = previous.marker[0].length - previous.marker[1].length - item.marker[2].length;
  } else {
    delta = (item.parent?.marker[2].length ?? 0) - item.marker[2].length;
    if (delta >= 0) return null;
  }
  const edits: Array<{ from: number; to: number; text: string }> = [];
  for (const start of starts) {
    if (start < item.from || start >= item.to || /^[\r\n]/.test(source.slice(start, start + 1))) continue;
    const from = start + (source.startsWith(item.marker[1], start) ? item.marker[1].length : 0);
    const indent = /^[ \t]*/.exec(source.slice(from))![0];
    edits.push({ from, to: from + (delta < 0 ? Math.min(-delta, indent.length) : 0), text: delta > 0 ? ' '.repeat(delta) : '' });
  }
  // 新的有序子列表从 1 开始，才能紧随父项段落而不中断列表结构。
  if (direction === 'indent' && /^\d/.test(item.marker[3])) {
    const from = item.from + item.marker[1].length + item.marker[2].length;
    edits.push({ from, to: from + item.marker[3].length, text: `1${item.marker[3].at(-1)}` });
  }
  let next = source;
  let nextCaret = caret;
  for (const edit of edits.sort((left, right) => right.from - left.from || right.to - left.to)) {
    next = next.slice(0, edit.from) + edit.text + next.slice(edit.to);
    if (caret >= edit.to) nextCaret += edit.text.length - (edit.to - edit.from);
  }
  return { source: next, caret: nextCaret };
}
