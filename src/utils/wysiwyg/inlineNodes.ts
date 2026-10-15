/**
 * 所见即所得的「行内节点树」抽象。
 *
 * 编辑逻辑不直接依赖 DOM：先把 DOM 转成这个极简结构，序列化与偏移映射都只处理它，
 * 于是这些逻辑可以在 node:test 里用普通对象构造用例（仓库没有 jsdom）。
 */
export interface InlineTextNode {
  type: 'text';
  text: string;
}

export interface InlineElementNode {
  type: 'element';
  /** 小写标签名。 */
  tag: string;
  attrs: Record<string, string>;
  children: InlineNode[];
}

export type InlineNode = InlineTextNode | InlineElementNode;

export interface InlinePoint {
  /** 从块内容根节点出发的子节点下标路径。 */
  path: number[];
  /** 文本节点内部的字符偏移。 */
  offset: number;
}

export function textNode(text: string): InlineTextNode {
  return { type: 'text', text };
}

export function elementNode(tag: string, attrs: Record<string, string>, children: InlineNode[]): InlineElementNode {
  return { type: 'element', tag, attrs, children };
}

/** 递归收集节点树的纯文本（`<strong>a</strong>b` → `ab`）。 */
export function textContentOf(nodes: InlineNode[]): string {
  return nodes.map((node) => node.type === 'text' ? node.text : textContentOf(node.children)).join('');
}

/**
 * 行内序列化时整块跳过的结构：复选框、播放器、代码块、表格、嵌套列表、图表与块级容器。
 * 它们要么由块级序列化负责，要么本身就是只读岛屿——被内联进去会丢内容或产生错误语法。
 */
const ISLAND_TAGS = new Set([
  'input',
  'figure',
  'video',
  'audio',
  'iframe',
  'pre',
  'table',
  'svg',
  'ul',
  'ol',
  'blockquote',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
]);

export function isIslandElement(node: InlineElementNode): boolean {
  if (ISLAND_TAGS.has(node.tag)) return true;
  const className = node.attrs.class ?? '';
  return /(?:^|\s)(?:media-embed|mermaid-container|markmap-|workflow-embed|table-resize-wrap|image-embed-missing|media-embed-missing)(?:[\s-]|$)/.test(className);
}

// ─── DOM 适配（仅浏览器调用） ───────────────────────────────────

const TEXT_NODE_TYPE = 3;
const ELEMENT_NODE_TYPE = 1;

/** DOM → InlineNode[]。 */
export function toInlineNodes(parent: Node): InlineNode[] {
  const nodes: InlineNode[] = [];
  Array.from(parent.childNodes).forEach((child) => {
    if (child.nodeType === TEXT_NODE_TYPE) {
      nodes.push(textNode(child.textContent ?? ''));
      return;
    }
    if (child.nodeType !== ELEMENT_NODE_TYPE) return;
    const element = child as Element;
    const attrs: Record<string, string> = {};
    element.getAttributeNames().forEach((name) => {
      attrs[name.toLowerCase()] = element.getAttribute(name) ?? '';
    });
    // 复选框的勾选态是 DOM 属性而不是特性：用户点击后 attribute 不会更新，必须读属性。
    if (element instanceof HTMLInputElement && element.type === 'checkbox') {
      attrs.checked = element.checked ? 'true' : '';
    }
    nodes.push(elementNode(element.tagName.toLowerCase(), attrs, toInlineNodes(element)));
  });
  return nodes;
}

/** 路径 → DOM 节点（空路径返回 parent 自身）。 */
export function nodeAtPath(parent: Node, path: number[]): Node | null {
  let current: Node | null = parent;
  for (const index of path) {
    if (!current) return null;
    current = current.childNodes[index] ?? null;
  }
  return current;
}

/** DOM 节点 → 路径（节点必须位于 parent 之内）。 */
export function pathOfNode(parent: Node, target: Node): number[] | null {
  const path: number[] = [];
  let current: Node | null = target;
  while (current && current !== parent) {
    const parentNode: Node | null = current.parentNode;
    if (!parentNode) return null;
    const index = Array.prototype.indexOf.call(parentNode.childNodes, current) as number;
    if (index < 0) return null;
    path.unshift(index);
    current = parentNode;
  }
  return current === parent ? path : null;
}
