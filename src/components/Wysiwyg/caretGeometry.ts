import type { BlockArrowDirection } from '../../utils/wysiwyg/blockOps.ts';
import { toInlineNodes } from '../../utils/wysiwyg/inlineNodes.ts';
import { serializeInlineNodes } from '../../utils/wysiwyg/inlineSerialize.ts';

interface VerticalRect { top: number; bottom: number }

/** 字形的高度可能不同；比较行框是否重叠，避免把一行中的上下标误当成另一行。 */
export function isVisualLineEdge(caret: VerticalRect, rects: VerticalRect[], direction: 'up' | 'down'): boolean | null {
  if (rects.length === 0 || caret.bottom <= caret.top) return null;
  const edge = direction === 'up'
    ? rects.reduce((first, rect) => rect.top < first.top ? rect : first)
    : rects.reduce((last, rect) => rect.bottom > last.bottom ? rect : last);
  return Math.min(caret.bottom, edge.bottom) - Math.max(caret.top, edge.top) > 1;
}

function editableLineRects(container: HTMLElement): DOMRect[] {
  const owner = container.ownerDocument;
  if (!owner.createTreeWalker) return [];
  const walker = owner.createTreeWalker(container, 5);
  const rects: DOMRect[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const lineBreak = node.nodeType === 1 && (node as Element).tagName === 'BR';
    if (!lineBreak && (node.nodeType !== 3 || !(node.textContent ?? '').trim())) continue;
    const range = owner.createRange();
    if (lineBreak) range.selectNode(node);
    else range.selectNodeContents(node);
    rects.push(...Array.from(range.getClientRects()).filter(rect => rect.height > 0 && (lineBreak || rect.width > 0)));
  }
  return rects;
}

/** 无真实布局（纯逻辑测试、隐藏表面）时返回 null，让调用方使用偏移边界。 */
export function caretAtVisualEdge(container: HTMLElement, range: Range, direction: BlockArrowDirection): boolean | null {
  if (!range.collapsed || !container.contains(range.startContainer)) return false;
  if (typeof range.cloneRange !== 'function') return null;
  if (direction === 'left' || direction === 'right') {
    const probe = range.cloneRange();
    // 段落宿主末尾的渲染器换行不属于可编辑正文。
    const content = container.querySelector?.(':scope > p, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6') ?? container;
    probe.selectNodeContents(content);
    if (direction === 'left') probe.setEnd(range.startContainer, range.startOffset);
    else probe.setStart(range.startContainer, range.startOffset);
    const text = probe.toString();
    if (/\S/.test(text)) return false;
    return serializeInlineNodes(toInlineNodes(probe.cloneContents())).length === 0;
  }
  return isVisualLineEdge(range.getBoundingClientRect(), editableLineRects(container), direction);
}

/** 上下跨块时保留水平位置；命中失败交回源码偏移映射。 */
export function caretOnVisualLine(container: HTMLElement, x: number, first: boolean): Range | null {
  const owner = container.ownerDocument;
  if (!owner.caretRangeFromPoint) return null;
  const rects = editableLineRects(container);
  const edge = first ? rects[0] : rects.at(-1);
  if (!edge) return null;
  const bounds = container.getBoundingClientRect();
  const range = owner.caretRangeFromPoint(Math.max(bounds.left + 1, Math.min(x, bounds.right - 1)), (edge.top + edge.bottom) / 2);
  return range && container.contains(range.startContainer) ? range : null;
}
