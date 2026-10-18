/**
 * 选区与路径/偏移的互转。
 *
 * 会话层只认「块元素 + 容器路径 + 文本偏移」，DOM Range 的语义（容器可能是元素、
 * 偏移可能是子节点下标）在这里被归一化，避免这些细节渗进编辑逻辑。
 */
import { nodeAtPath, pathOfNode, type InlinePoint } from '../../utils/wysiwyg/inlineNodes.ts';

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/** Enter 不能把 Wiki/脚注原子克隆成两个半节点（空 Wiki 克隆也会生成完整链接）。 */
export function snapRangeAroundInlineAtoms(range: Range, host: HTMLElement): void {
  if (typeof range.setStartBefore !== 'function') return;
  const selector = '.wiki-link[data-wiki-target], .footnote-ref[data-footnote-name]';
  const atomOf = (node: Node): Element | null => {
    const element = node.nodeType === ELEMENT_NODE ? node as Element : node.parentElement;
    const atom = element?.closest?.(selector);
    return atom?.matches?.(selector) && host.contains(atom) ? atom : null;
  };
  const start = atomOf(range.startContainer);
  const end = atomOf(range.endContainer);
  if (range.collapsed) {
    if (!start) return;
    if (range.startOffset === 0) range.setStartBefore(start);
    else range.setStartAfter(start);
    range.collapse(true);
    return;
  }
  if (start) range.setStartBefore(start);
  if (end) range.setEndAfter(end);
}

/** 元素节点上的偏移 → 文本节点 + 文本偏移。 */
function normalizePoint(node: Node, offset: number): { node: Node; offset: number } {
  if (node.nodeType === TEXT_NODE) return { node, offset };
  const children = node.childNodes;
  if (offset < children.length) {
    const child = children[offset];
    if (!child) return { node, offset: 0 };
    return child.nodeType === TEXT_NODE ? { node: child, offset: 0 } : normalizePoint(child, 0);
  }
  const last = offset > 0 ? children[offset - 1] : null;
  if (!last) return { node, offset: 0 };
  return last.nodeType === TEXT_NODE
    ? { node: last, offset: last.textContent?.length ?? 0 }
    : normalizePoint(last, last.childNodes.length);
}

/** 选区起点在指定容器内的位置；容器不包含该点时返回 null。 */
export function pointInContainer(container: HTMLElement, node: Node, offset: number): InlinePoint | null {
  if (!container.contains(node)) return null;
  const normalized = normalizePoint(node, offset);
  const path = pathOfNode(container, normalized.node);
  if (!path) return null;
  return { path, offset: normalized.offset };
}

/** 路径 + 偏移 → 折叠选区；路径失效时回退到容器起点。 */
export function rangeInContainer(container: HTMLElement, point: InlinePoint): Range {
  const target = nodeAtPath(container, point.path);
  const range = container.ownerDocument.createRange();
  if (!target) {
    range.setStart(container, 0);
    range.collapse(true);
    return range;
  }
  const max = target.nodeType === TEXT_NODE
    ? (target.textContent?.length ?? 0)
    : target.childNodes.length;
  range.setStart(target, Math.max(0, Math.min(point.offset, max)));
  range.collapse(true);
  return range;
}

/** 选区的矩形；折叠在空节点上时回退到其父元素的矩形。 */
export function rectOfRange(range: Range): DOMRect | null {
  const rect = range.getBoundingClientRect();
  if (rect && (rect.width > 0 || rect.height > 0)) return rect;
  const container = range.startContainer;
  const element = container.nodeType === ELEMENT_NODE ? container as Element : container.parentElement;
  return element?.getBoundingClientRect() ?? null;
}

/** 让元素在滚动容器里居中显示。 */
export function revealElement(element: HTMLElement, scrollRoot: HTMLElement | null): void {
  const target = scrollRoot ?? element.ownerDocument.documentElement;
  const elementRect = element.getBoundingClientRect();
  const rootRect = target.getBoundingClientRect();
  target.scrollTop += elementRect.top - rootRect.top - (rootRect.height - elementRect.height) / 2;
}
