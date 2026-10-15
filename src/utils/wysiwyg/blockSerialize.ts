/**
 * 块级 DOM → Markdown 序列化。
 *
 * 一个块整体重写（列表里改一项就重新生成整张列表），换来的是不需要为「引用里的第二段」
 * 这类子结构维护源码区间——块的其它部分本来就不属于本次编辑。返回的 containers 记录
 * 每个文本容器内容在块源码中的起始偏移，供光标映射使用。
 */
import { serializeInlineNodes } from './inlineSerialize.ts';
import { textContentOf, type InlineElementNode, type InlineNode } from './inlineNodes.ts';
import type { WysiwygBlockKind } from './blocks.ts';

export interface BlockContainerOffset {
  /** 文本容器在块节点树中的路径（`[]` 表示块内容本身就是容器，如段落）。 */
  path: number[];
  /** 容器内容在生成的 Markdown 中的起始偏移。 */
  contentOffset: number;
  /**
   * 该容器内容是否按「行首」规则转义。偏移映射必须沿用这里的取值：重新推断会算出
   * 不同的转义长度（例如 `# ` 是否被转义），导致光标整体错位。
   */
  escapeLineStart: boolean;
}

export interface BlockSerializeResult {
  markdown: string;
  containers: BlockContainerOffset[];
}

export interface BlockSerializeOptions {
  /**
   * 把段落开头的块标记（`# `、`- `、`> `、`1. `、` ``` `、`---`）当作语法而不是字面量。
   * 编辑实时回写时必须开启：用户刚敲出的标记要留给重新解析去改变块类型。
   */
  allowBlockMarkers?: boolean;
}

const EDITABLE_BLOCK_KINDS = new Set<WysiwygBlockKind>(['paragraph', 'heading', 'blockquote', 'list']);

/**
 * 行首块标记：用户刚敲出来的块级标记要留给重新解析去改变块类型，不能被转义成字面量。
 */
const BLOCK_MARKER_PATTERN = /^(?:#{1,6}[ \t]+|[-*+][ \t]+|\d+[.)][ \t]+|>[ \t]?|```|~~~|---|\*\*\*|___)/;

interface Writer {
  text(): string;
  length(): number;
  containers: BlockContainerOffset[];
  /** 记录一个文本容器的起始偏移：必须在写入内容之前调用。 */
  openContainer(path: number[], contentOffset: number, escapeLineStart: boolean): void;
  write(chunk: string): void;
  /** 确保下一次写入从新行开始（已经在新行时什么都不做）。 */
  ensureNewline(): void;
}

function createWriter(): Writer {
  const parts: string[] = [];
  const containers: BlockContainerOffset[] = [];
  let size = 0;
  const endsWithNewline = () => parts.length > 0 && parts[parts.length - 1].endsWith('\n');
  return {
    containers,
    text: () => parts.join(''),
    length: () => size,
    openContainer: (path, contentOffset, escapeLineStart) => { containers.push({ path, contentOffset, escapeLineStart }); },
    write: (chunk) => { parts.push(chunk); size += chunk.length; },
    ensureNewline: () => {
      if (size === 0 || endsWithNewline()) return;
      parts.push('\n');
      size += 1;
    },
  };
}

function isElement(node: InlineNode, tags: string[]): node is InlineElementNode {
  return node.type === 'element' && tags.includes(node.tag);
}

function headingLevel(node: InlineNode): number {
  if (node.type !== 'element') return 0;
  const match = /^h([1-6])$/.exec(node.tag);
  return match ? Number(match[1]) : 0;
}

/**
 * 写入一个文本容器：先记偏移，再写内容——顺序反了偏移就会指向标记之前。
 * `singleLine` 用于引用块内：多行段落会破坏 `> ` 行前缀，软换行降级为空格
 * （`\n` → 空格是 1:1 替换，容器内的偏移映射仍然成立）。
 */
function writeContainer(
  writer: Writer,
  path: number[],
  nodes: InlineNode[],
  escapeLineStart: boolean,
  singleLine = false,
  allowBlockMarkers = false,
): void {
  // 段落里刚敲出的块标记不转义，其余情况保持行首转义（`#不是标题` 仍然是普通文本）。
  const lineStart = escapeLineStart && !(allowBlockMarkers && BLOCK_MARKER_PATTERN.test(textContentOf(nodes)));
  writer.openContainer(path, writer.length(), lineStart);
  const markdown = serializeInlineNodes(nodes, { escapeLineStart: lineStart });
  writer.write(singleLine ? markdown.replace(/\n/g, ' ') : markdown);
}

function writeHeading(writer: Writer, index: number, node: InlineElementNode): void {
  writer.write(`${'#'.repeat(headingLevel(node))} `);
  writeContainer(writer, [index], node.children, false);
}

function writeBlockquote(writer: Writer, nodes: InlineNode[]): void {
  nodes.forEach((node, index) => {
    if (writer.length() > 0) writer.write('\n>\n');
    writer.write('> ');
    const level = headingLevel(node);
    if (level > 0 && node.type === 'element') {
      writer.write(`${'#'.repeat(level)} `);
      writeContainer(writer, [index], node.children, false, true);
      return;
    }
    if (isElement(node, ['p'])) {
      writeContainer(writer, [index], node.children, false, true);
      return;
    }
    writeContainer(writer, [index], [node], false, true);
  });
}

/** 任务项：`null` 表示不是任务项；`true` / `false` 表示勾选状态。 */
function checkboxState(item: InlineElementNode): boolean | null {
  const input = item.children.find(
    (child): child is InlineElementNode => isElement(child, ['input']) && child.attrs.type === 'checkbox',
  );
  return input ? input.attrs.checked === 'true' : null;
}

/** 列表项中参与行内文本的子节点：复选框本身不进源码（由标记 `[x]` 表达）。 */
function itemTextNodes(item: InlineElementNode): InlineNode[] {
  return item.children.filter((child) => !isElement(child, ['input']));
}

function writeList(writer: Writer, listPath: number[], list: InlineElementNode, depth: number): void {
  const ordered = list.tag === 'ol';
  let ordinal = 1;
  list.children.forEach((child, childIndex) => {
    if (!isElement(child, ['li'])) return;
    writer.ensureNewline();
    const indent = '  '.repeat(depth);
    const task = checkboxState(child);
    const marker = task === null ? (ordered ? `${ordinal}.` : '-') : task ? '- [x]' : '- [ ]';
    writer.write(`${indent}${marker} `);
    writeContainer(writer, [...listPath, childIndex], itemTextNodes(child), false, true);
    ordinal += 1;

    const nestedIndex = child.children.findIndex(candidate => isElement(candidate, ['ul', 'ol']));
    if (nestedIndex >= 0) {
      writer.ensureNewline();
      writeList(writer, [...listPath, childIndex, nestedIndex], child.children[nestedIndex] as InlineElementNode, depth + 1);
    }
  });
}

/** 块节点树 → 块源码；不可编辑的块类型直接抛错，调用方据此走只读分支。 */
export function serializeBlockMarkdown(
  kind: WysiwygBlockKind,
  nodes: InlineNode[],
  options: BlockSerializeOptions = {},
): BlockSerializeResult {
  if (!EDITABLE_BLOCK_KINDS.has(kind)) throw new Error('该块不支持就地编辑');

  const writer = createWriter();
  const allowMarkers = options.allowBlockMarkers === true;
  const headingIndex = nodes.findIndex(node => headingLevel(node) > 0);
  const listIndex = nodes.findIndex(node => isElement(node, ['ul', 'ol']));
  const singleParagraph = nodes.length === 1 && isElement(nodes[0], ['p']) ? nodes[0] : null;

  if (kind === 'heading' && headingIndex >= 0) {
    writeHeading(writer, headingIndex, nodes[headingIndex] as InlineElementNode);
  } else if (kind === 'blockquote') {
    writeBlockquote(writer, nodes);
  } else if (kind === 'list' && listIndex >= 0) {
    writeList(writer, [listIndex], nodes[listIndex] as InlineElementNode, 0);
  } else if (singleParagraph) {
    writeContainer(writer, [0], singleParagraph.children, true, false, allowMarkers);
  } else {
    writeContainer(writer, [], nodes, true, false, allowMarkers);
  }

  return { markdown: writer.text(), containers: writer.containers };
}
