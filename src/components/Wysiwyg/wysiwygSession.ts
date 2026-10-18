/**
 * 所见即所得编辑会话。
 *
 * 只做状态与算法，不碰 React：DOM 元素由外壳提供，结构变化通过 `onChange` 通知外壳重渲染。
 * 「输入」走 DOM 本地改写（记脏 → 防抖写回），「结构操作 / 外部修改」走文档级源码替换
 * （重新分块 → 重渲染 → 恢复光标），两条路径共用同一个块模型。
 */
import {
  removeBlockFromSource,
  replaceBlockSource,
  splitMarkdownDocument,
  type WysiwygBlock,
  type WysiwygDocument,
} from '../../utils/wysiwyg/blocks.ts';
import {
  serializeBlockMarkdown,
  type BlockSerializeOptions,
  type BlockSerializeResult,
  type BlockContainerOffset,
} from '../../utils/wysiwyg/blockSerialize.ts';
import { blockOffsetFromPoint, pointFromBlockOffset, type ContainerInput } from '../../utils/wysiwyg/offsetMap.ts';
import { toInlineNodes } from '../../utils/wysiwyg/inlineNodes.ts';
import {
  adjustListIndent,
  arrowLeavesBlock,
  contentStartOffset,
  exitEmptyItem,
  mergeBlocks,
  mergeForward,
  retypeBlock,
  setHeadingLevel,
  splitBlock,
  stripBlockPrefix,
  type BlockArrowDirection,
  type BlockRetypeTarget,
} from '../../utils/wysiwyg/blockOps.ts';
import { createUndoStack } from '../../utils/wysiwyg/undoStack.ts';
import { extractFenceInfo, extractFenceLanguage, extractFenceMarker, formatFence, withFenceLanguage } from '../../utils/wysiwyg/codeFence.ts';
import { htmlToMarkdown, shouldConvertHtmlToMarkdown } from '../../utils/htmlToMarkdown.ts';
import { prepareMarkdownPaste } from '../../utils/markdownPaste.ts';
import { pointInContainer, rangeInContainer } from './domCaret.ts';
import { navigateTableCell, parseTableAt } from '../../utils/markdownTable.ts';
import { caretAtVisualEdge, caretOnVisualLine } from './caretGeometry.ts';
import { escapeInlineText, serializeInlineNodes } from '../../utils/wysiwyg/inlineSerialize.ts';
import { INLINE_MARKER_TAGS, matchInlineMarker } from '../../utils/wysiwyg/inlineMarkers.ts';

export interface WysiwygSessionSnapshot {
  document: WysiwygDocument;
  /** 本次渲染不重建 DOM 的块索引；由输入触发的写回会设置它。 */
  skipRenderIndex: number | null;
  /** 结构版本号：外壳用它作为布局效应的依赖。 */
  version: number;
  /** 仅规范化或结构变化时递增，用于避免重复重建已恢复选区的 DOM。 */
  renderRevision: number;
  /** 需要规范化的脏块版本；即使 React 合并中间快照，也能让该块重建 DOM。 */
  blockRenderRevisions: ReadonlyMap<number, number>;
}

export interface WysiwygSessionOptions {
  onSourceChange: (source: string) => void;
  /** 粘贴图片的落地方（镜像编辑器里已有的图床 / .assets 链路）。 */
  insertClipboardImage: (file: File) => Promise<boolean>;
}

/** DOM 访问器：外壳挂载后才注入（外壳在渲染期不能读 ref，构造时会话拿不到元素）。 */
export interface WysiwygSessionAccessors {
  getSurface: () => HTMLElement | null;
  getBlockElement: (index: number) => HTMLElement | null;
  /** 折叠块与尚未渲染的块不同：方向键只跳过明确隐藏的块。 */
  isBlockHidden?: (index: number) => boolean;
  /** 编辑/外部定位需要目标可见；返回 true 表示已请求展开并等待下一次渲染。 */
  revealBlock?: (index: number) => boolean;
}

const NO_ACCESSORS: WysiwygSessionAccessors = {
  getSurface: () => null,
  getBlockElement: () => null,
};

const WRITE_BACK_DELAY = 250;
/** 编辑态序列化：允许把刚敲出的块标记当作语法传给重新解析。 */
const EDITING_SERIALIZE_OPTIONS: BlockSerializeOptions = { allowBlockMarkers: true };

/** 路径 → DOM 节点（空路径返回元素自身）。 */
function pathToNode(element: HTMLElement, path: number[]): Node | null {
  let current: Node | null = element;
  for (const index of path) {
    if (!current) return null;
    current = current.childNodes[index] ?? null;
  }
  return current;
}

/**
 * 失焦时焦点是否已经交给了别的元素。
 *
 * `relatedTarget` 是接收焦点的元素：用户点向另一个块或面板控件时它是那个元素；
 * 只有元素被重渲染移除而导致的失焦才是 null。前者不能把焦点抢回来，后者必须恢复。
 */
function focusMovedToAnotherTarget(relatedTarget: Node | null | undefined): boolean {
  return Boolean(relatedTarget && relatedTarget.nodeType === 1);
}

interface CollectedBlock {
  block: WysiwygBlock;
  element: HTMLElement;
  serialized: BlockSerializeResult;
}

export class WysiwygSession {
  private document: WysiwygDocument;
  private snapshot: WysiwygSessionSnapshot;
  private readonly undo = createUndoStack();
  private readonly options: WysiwygSessionOptions;
  private writeBackTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingIndex: number | null = null;
  private composing = false;
  private skipRenderIndex: number | null = null;
  private version = 0;
  private renderRevision = 0;
  private blockRenderRevisions = new Map<number, number>();
  private readonly dirtyBlockIndices = new Set<number>();
  private lastCaret = 0;
  private pendingCaret: number | null = null;
  private pendingSelectionEnd: number | null = null;
  private awaitingRender = false;
  /** 渲染后是否把焦点拉回待恢复的光标；用户主动点去别处时为 false。 */
  private restoreFocus = true;
  /** 变更通知由外壳在挂载后注入（避免外壳在渲染期读取会话实例）。 */
  private notify: () => void = () => undefined;
  private accessors: WysiwygSessionAccessors = NO_ACCESSORS;

  constructor(source: string, options: WysiwygSessionOptions) {
    this.options = options;
    this.document = splitMarkdownDocument(source);
    this.snapshot = { document: this.document, skipRenderIndex: null, version: 0, renderRevision: 0, blockRenderRevisions: this.blockRenderRevisions };
  }

  /** 注入变更监听：外壳挂载时调用，卸载时可传回空实现。 */
  setChangeListener(listener: () => void): void {
    this.notify = listener;
  }

  /** 注入 DOM 访问器：外壳挂载时调用（渲染期不能读 ref，因此不能走构造函数）。 */
  setAccessors(accessors: WysiwygSessionAccessors): void {
    this.accessors = accessors;
  }

  getSnapshot(): WysiwygSessionSnapshot { return this.snapshot; }
  getSource(): string { return this.document.source; }
  getVisibleSource(): string {
    const collected = this.pendingIndex === null ? null : this.collectBlock(this.pendingIndex);
    if (!collected) return this.document.source;
    const { block, serialized } = collected;
    return this.document.source.slice(0, block.offset) + serialized.markdown + this.document.source.slice(block.offset + block.length);
  }
  getBlocks(): WysiwygBlock[] { return this.document.blocks; }

  // ── 输入与写回 ─────────────────────────────────────────────

  markComposing(composing: boolean, index?: number): void {
    this.composing = composing;
    if (index !== undefined) this.pendingIndex = index;
    if (composing) {
      if (this.writeBackTimer !== null) {
        clearTimeout(this.writeBackTimer);
        this.writeBackTimer = null;
      }
      return;
    }
    if (this.pendingIndex !== null) this.scheduleWriteBack(this.pendingIndex);
  }

  handleInput(index: number): void {
    this.pendingIndex = index;
    if (this.composing) return;
    this.renderInlineMarker(index);
    this.scheduleWriteBack(index);
  }

  /**
   * 输入即渲染：光标前刚好闭合了一个行内标记时，当场把它换成真正的行内元素。
   *
   * 不做这一步的话，`**粗体**` 会以字面字符写回源码（`*` 是必须转义的字符，源码成了
   * `\*\*粗体\*\*`），此后无论怎么重渲染都变不成粗体。转换只改 DOM，源码仍由正常
   * 写回生成，因此改完 DOM 与改完源码必然一致。
   *
   * 组合输入期间不介入：输入法选字过程中文本还会被替换，提前改写会打断候选。
   */
  private renderInlineMarker(index: number): void {
    const surface = this.accessors.getSurface();
    const host = this.accessors.getBlockElement(index);
    if (!surface || !host) return;
    const selection = surface.ownerDocument.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (!range.collapsed || !host.contains(range.startContainer)) return;
    // 光标落在元素边界上时拿不到完整文本，等下一个字符。
    const textNode = range.startContainer;
    if (textNode.nodeType !== 3) return;
    // 已经处于代码里就不再解释标记：行内代码要显示字面文本。
    const parentElement = textNode.parentElement;
    if (parentElement && parentElement.closest('code, pre')) return;
    const text = textNode.textContent ?? '';
    const match = matchInlineMarker(text, range.startOffset);
    if (!match) return;
    const tagName = INLINE_MARKER_TAGS[match.kind];
    // 同种标记不能套自己：`**a**` 在已有的粗体里敲下会得到 `<strong><strong>a</strong></strong>`，
    // 回写成源码是 `****a****`，重新解析已经不再是粗体了。
    if (parentElement?.closest(tagName) || (match.kind === 'strong-em' && parentElement?.closest('strong'))) return;

    const document_ = textNode.ownerDocument;
    const wrapper = document_.createElement(tagName);
    if (match.kind === 'strong-em') {
      const strong = document_.createElement('strong');
      strong.textContent = match.content;
      wrapper.appendChild(strong);
    } else wrapper.textContent = match.content;
    const fragment = document_.createDocumentFragment();
    if (match.from > 0) fragment.append(document_.createTextNode(text.slice(0, match.from)));
    fragment.append(wrapper);
    const tail = text.slice(match.to);
    if (tail.length > 0) fragment.append(document_.createTextNode(tail));
    // 用 replaceChild 而不是 replaceWith：参数类型就是 Node，不必依赖 ChildNode 断言。
    const parent = textNode.parentNode;
    if (!parent) return;
    parent.replaceChild(fragment, textNode);

    // 光标停在标记之后，用户可以继续输入。
    const caret = document_.createRange();
    caret.setStartAfter(wrapper);
    caret.collapse(true);
    selection.removeAllRanges();
    selection.addRange(caret);
  }

  private scheduleWriteBack(index: number): void {
    this.pendingIndex = index;
    if (this.writeBackTimer !== null) clearTimeout(this.writeBackTimer);
    this.writeBackTimer = setTimeout(() => {
      this.writeBackTimer = null;
      this.flushWriteBack();
    }, WRITE_BACK_DELAY);
  }

  /** 立即写回挂起的编辑：失焦、结构操作、外部调用前、卸载前都要调用。 */
  flushWriteBack(): void {
    if (this.writeBackTimer !== null) {
      clearTimeout(this.writeBackTimer);
      this.writeBackTimer = null;
    }
    const index = this.pendingIndex;
    this.pendingIndex = null;
    if (index !== null) this.writeBackBlock(index);
  }

  /** 外部调用（工具栏、AI、图床）前的准备：先落盘，保证源码与偏移一致。 */
  prepareExternalEdit(): void { this.flushWriteBack(); }

  /** 失焦时把用户敲出的标记规范化为真正的排版。 */
  normalizeBlock(index: number, nextFocus?: Node | null): void {
    this.flushWriteBack();
    if (this.skipRenderIndex !== index) return;
    this.skipRenderIndex = null;
    this.pendingCaret = this.locateCaretOffset();
    this.pendingSelectionEnd = null;
    // 失焦往往是用户点去了另一个块或面板：重渲染不能把焦点抢回来，
    // 否则 mousedown 期间会把用户刚点中的目标又拽回离开的块。
    this.restoreFocus = !focusMovedToAnotherTarget(nextFocus);
    this.emit();
  }

  private writeBackBlock(index: number): void {
    const collected = this.collectBlock(index);
    if (!collected) return;
    if (collected.serialized.markdown === collected.block.source) return;
    this.commit(collected.block, collected.serialized.markdown);
  }

  /**
   * 用新的块源码替换该块。
   *
   * 写回让块类型或块数变化时（例如刚敲出 `# ` 变成标题）必须规范化重渲染并把光标恢复到
   * 写回前的位置；否则保留 DOM（光标本来就在正确位置，重建反而会丢光标）。
   */
  private commit(block: WysiwygBlock, nextBlockSource: string): void {
    const index = this.document.blocks.indexOf(block);
    if (index >= 0) this.dirtyBlockIndices.add(index);
    const caretBefore = this.locateCaretOffset();
    this.pushUndo({ coalesce: true });

    const next = replaceBlockSource(this.document, block, nextBlockSource);
    const kindChanged = index >= 0 && next.blocks[index]?.kind !== block.kind;
    const countChanged = next.blocks.length !== this.document.blocks.length;
    this.document = next;
    this.pendingSelectionEnd = null;

    if (kindChanged || countChanged) {
      this.skipRenderIndex = null;
      this.pendingCaret = caretBefore;
    } else {
      this.skipRenderIndex = index;
      this.pendingCaret = null;
    }
    this.persist();
    this.emit();
  }

  // ── 结构操作 ───────────────────────────────────────────────

  /** 回车：拆分块。未处理时返回 false，交回浏览器。 */
  handleEnter(index: number): boolean {
    const collected = this.collectBlock(index);
    if (!collected) return false;
    const caret = this.caretOffsetInBlock(collected);
    if (caret === null) return false;
    const kind = splitMarkdownDocument(collected.serialized.markdown).blocks[0]?.kind ?? collected.block.kind;
    const balanced = this.splitContentAtSelection(collected);
    const source = balanced?.source ?? collected.serialized.markdown;
    const caretAt = balanced?.caret ?? caret;
    if (balanced?.empty && balanced.continuation?.exitPrefix !== undefined && !source.slice(caretAt).trim()) {
      const prefix = balanced.continuation.exitPrefix;
      const lineStart = source.lastIndexOf('\n', Math.max(0, caretAt - 1)) + 1;
      const lines = source.slice(0, lineStart).split(/\r?\n/);
      while (lines.length && /^[ \t>]*$/.test(lines.at(-1)!)) lines.pop();
      const head = lines.join(this.document.eol);
      const next = /^(?:[ \t]*>[ \t]*)+$/.test(prefix)
        ? `${head}${this.document.eol}${prefix.trimEnd()}${this.document.eol}${prefix}`
        : prefix.trim() ? source.slice(0, lineStart) + prefix
          : head + (head ? this.document.eol.repeat(2) : '') + prefix;
      this.checkpointBlock(collected);
      return this.applyBlockSource(collected.block, next + source.slice(caretAt), collected.block.offset + next.length);
    }
    // 空块退块：空列表项 / 空引用行上再按回车，离开列表或引用，而不是继续堆空项。
    const exited = exitEmptyItem({ source, kind, caret: caretAt });
    if (exited) {
      this.checkpointBlock(collected);
      return this.applyBlockSource(collected.block, exited.source, collected.block.offset + exited.caret);
    }
    if (balanced?.continuation) {
      const { prefix, separator } = balanced.continuation;
      this.checkpointBlock(collected);
      const insertion = `${separator}${prefix}`;
      return this.applyBlockSource(collected.block,
        source.slice(0, caretAt) + insertion + source.slice(caretAt),
        collected.block.offset + caretAt + insertion.length);
    }
    const result = splitBlock({ source, kind, caret: caretAt });
    // 表格、代码块、分隔线不在块尾拆行：拆开后的两半会被重新解析成别的东西（表格会碎成段落 + 列表项）。
    // 必须先判空再记撤销点，否则一次无效的回车会留下一个空的撤销步骤。
    if (!result) return false;
    this.checkpointBlock(collected);
    const tailPrefix = kind === 'list' || kind === 'blockquote' ? contentStartOffset(result.tail, kind) : 0;
    return this.applyBlockSource(
      collected.block,
      `${result.head}${result.separator}${result.tail}`,
      collected.block.offset + result.head.length + result.separator.length + tailPrefix,
    );
  }

  /** 退格：删空块、去前缀、与前一段落合并。未处理时返回 false。 */
  handleBackspace(index: number): boolean {
    const collected = this.collectBlock(index);
    if (!collected) return false;
    const caret = this.caretOffsetInBlock(collected);
    if (caret === null) return false;
    const contentStart = contentStartOffset(collected.serialized.markdown, collected.block.kind);
    if (caret > contentStart) return false;

    if (collected.serialized.markdown.slice(contentStart).trim().length === 0) {
      this.checkpointBlock(collected);
      const removed = removeBlockFromSource(this.document, index);
      // 删掉空块后光标回到上一块的末尾（"上升一行"）。留在删除点等于把光标交给
      // 下一块的开头——视觉上是下一行的内容跳到光标位置，而不是光标上移一行。
      const previous = this.document.blocks[index - 1];
      return this.applySource(removed.source, previous ? previous.offset + previous.length : removed.caret);
    }

    const stripped = stripBlockPrefix(collected.serialized.markdown, collected.block.kind);
    if (stripped) {
      this.checkpointBlock(collected);
      return this.applyBlockSource(collected.block, stripped.source, collected.block.offset + stripped.caret);
    }

    const previous = this.document.blocks[index - 1];
    if (!previous) return false;
    const previousElement = this.accessors.getBlockElement(index - 1);
    if (!previousElement || !previous.editable) return false;
    let previousMarkdown: string;
    try {
      previousMarkdown = serializeBlockMarkdown(previous.kind, toInlineNodes(previousElement), EDITING_SERIALIZE_OPTIONS).markdown;
    } catch {
      return false;
    }
    const merged = mergeBlocks(previousMarkdown, collected.serialized.markdown);
    if (!merged) return false;

    this.checkpointBlock(collected);
    const source = this.document.source.slice(0, previous.offset)
      + merged.source
      + this.document.source.slice(collected.block.offset + collected.block.length);
    return this.applySource(source, previous.offset + merged.caret);
  }

  /** 光标是否在块内容开头（含前缀之后的位置）。 */
  isCaretAtBlockStart(index: number): boolean {
    const collected = this.collectBlock(index);
    if (!collected) return false;
    const caret = this.caretOffsetInBlock(collected);
    if (caret === null) return false;
    return caret <= contentStartOffset(collected.serialized.markdown, collected.block.kind);
  }

  /** 光标是否在块内容末尾。 */
  isCaretAtBlockEnd(index: number): boolean {
    const collected = this.collectBlock(index);
    if (!collected) return false;
    const caret = this.caretOffsetInBlock(collected);
    return caret !== null && caret >= collected.serialized.markdown.length;
  }

  /**
   * 块尾 Delete：与退格互为镜像。
   *
   * 顺序：空块直接删掉 → 否则把下一段正文吸进当前块。后一块带前缀（标题 / 列表 / 引用）
   * 或本身不可编辑时返回 false，交回浏览器（跨块合并会丢掉前缀，不能硬拼）。
   */
  handleDelete(index: number): boolean {
    const collected = this.collectBlock(index);
    if (!collected || !collected.block.editable) return false;
    const caret = this.caretOffsetInBlock(collected);
    if (caret === null) return false;
    const markdown = collected.serialized.markdown;
    if (caret < markdown.length) return false;

    if (markdown.trim().length === 0) {
      this.checkpointBlock(collected);
      const removed = removeBlockFromSource(this.document, index);
      return this.applySource(removed.source, removed.caret);
    }

    const next = this.document.blocks[index + 1];
    if (!next || !next.editable) return false;
    const nextElement = this.accessors.getBlockElement(index + 1);
    if (!nextElement) return false;
    let nextMarkdown: string;
    try {
      nextMarkdown = serializeBlockMarkdown(next.kind, toInlineNodes(nextElement), EDITING_SERIALIZE_OPTIONS).markdown;
    } catch {
      return false;
    }
    const merged = mergeForward(markdown, nextMarkdown);
    if (!merged) return false;

    this.checkpointBlock(collected);
    const source = this.document.source.slice(0, collected.block.offset)
      + merged.source
      + this.document.source.slice(next.offset + next.length);
    return this.applySource(source, collected.block.offset + merged.caret);
  }

  /** Tab / Shift+Tab：列表层级调整。 */
  handleIndent(index: number, direction: 'indent' | 'outdent'): boolean {
    const collected = this.collectBlock(index);
    if (!collected || (collected.block.kind !== 'list' && collected.block.kind !== 'blockquote')) return false;
    const caret = this.caretOffsetInBlock(collected);
    if (caret === null) return false;
    const result = adjustListIndent(collected.serialized.markdown, 'list', direction, caret);
    if (!result) return false;
    this.checkpointBlock(collected);
    return this.applyBlockSource(
      collected.block,
      result.source,
      collected.block.offset + result.caret,
    );
  }

  /** Ctrl+0..6：设置标题级别。 */
  handleHeadingLevel(level: number): boolean {
    const index = this.blockIndexAtOffset(this.getSelectionOffsets().from);
    if (index === null) return false;
    const collected = this.collectBlock(index);
    if (!collected) return false;
    const caret = this.caretOffsetInBlock(collected);
    if (caret === null) return false;
    // 表格里的 Ctrl+1..6 不是「改标题」，而是把整张表的前缀换掉：单元格自己负责编辑，
    // 这里拿到 null 就交回浏览器（在 checkpoint 之前返回，不留下空的撤销步骤）。
    const result = setHeadingLevel(collected.serialized.markdown, collected.block.kind, level);
    if (!result) return false;
    const innerCaret = Math.max(0, caret - contentStartOffset(collected.serialized.markdown, collected.block.kind));
    const targetKind = level > 0 ? 'heading' : 'paragraph';
    this.checkpointBlock(collected);
    return this.applyBlockSource(
      collected.block,
      result.source,
      collected.block.offset + contentStartOffset(result.source, targetKind) + innerCaret,
    );
  }

  /** 块菜单「转换为」：换掉行首前缀（段落 / 标题 / 列表 / 引用）。 */
  setBlockKind(index: number, target: BlockRetypeTarget): boolean {
    const collected = this.collectBlock(index);
    if (!collected) return false;
    const result = retypeBlock(collected.serialized.markdown, target);
    if (result.source === collected.serialized.markdown) return false;
    this.checkpointBlock(collected);
    return this.applyBlockSource(collected.block, result.source, collected.block.offset + result.caret);
  }

  /**
   * 方向键跨块：光标贴到块的上下/左右边界时，把光标交给相邻的可编辑块。
   *
   * 每个块是独立的 contenteditable，浏览器原生不会把光标送到兄弟块，所以不接管的话
   * 块尾按 ↓ 会原地不动。只有真正贴着内容边界才接管，块内行间移动仍然交给浏览器。
   * 未处理时返回 false，调用方不要 preventDefault。
   */
  handleArrow(index: number, direction: BlockArrowDirection): boolean {
    const collected = this.collectBlock(index);
    if (!collected || !collected.block.editable) return false;
    const caret = this.caretOffsetInBlock(collected);
    if (caret === null) return false;
    const selection = this.accessors.getSurface()?.ownerDocument.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (range?.collapsed === false) return false;
    const visualEdge = range ? caretAtVisualEdge(collected.element, range, direction) : null;
    if (!(visualEdge ?? arrowLeavesBlock({
      kind: collected.block.kind,
      markdown: collected.serialized.markdown,
      caret,
      direction,
    }))) return false;

    return this.moveToAdjacentBlock(index, direction);
  }

  /** 表格内仅在单元格的视觉/文字边界跨格；表格外边界接到相邻正文。 */
  handleTableArrow(index: number, direction: BlockArrowDirection): boolean {
    const host = this.accessors.getBlockElement(index);
    const selection = this.accessors.getSurface()?.ownerDocument.getSelection();
    if (!host || !selection?.rangeCount || this.document.blocks[index]?.kind !== 'table') return false;
    const range = selection.getRangeAt(0);
    const element = range.startContainer.nodeType === 1 ? range.startContainer as Element : range.startContainer.parentElement;
    const cell = element?.closest<HTMLTableCellElement>('td,th');
    if (!cell || !host.contains(cell) || !caretAtVisualEdge(cell, range, direction)) return false;
    this.flushWriteBack();
    const current = this.getSelectionOffsets().from;
    const table = parseTableAt(this.document.source, current);
    const row = (cell.parentElement as HTMLTableRowElement).rowIndex;
    const sourceCell = table?.rows.filter((_, index) => index !== 1)[row]?.cells[cell.cellIndex];
    if (!sourceCell) return false;
    const offset = direction === 'left' ? sourceCell.from : direction === 'right' ? sourceCell.to : current;
    const key = { left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown' } as const;
    const navigation = navigateTableCell(this.document.source, offset, key[direction]);
    if (navigation?.kind === 'move') {
      this.setSelectionOffsets(navigation.cursor);
      return true;
    }
    return this.moveToAdjacentBlock(index, direction);
  }

  private moveToAdjacentBlock(index: number, direction: BlockArrowDirection): boolean {

    const forward = direction === 'down' || direction === 'right';
    const targetIndex = this.adjacentEditableBlock(index, forward ? 1 : -1);
    if (targetIndex === null) return false;
    const target = this.document.blocks[targetIndex];
    const targetElement = this.accessors.getBlockElement(targetIndex);
    if (!target || !targetElement) return false;

    // 去下一块落在内容开头（跳过前缀），去上一块落在末尾——与源码模式的方向一致。
    let local: number;
    try {
      const markdown = serializeBlockMarkdown(target.kind, toInlineNodes(targetElement), EDITING_SERIALIZE_OPTIONS).markdown;
      local = forward ? contentStartOffset(markdown, target.kind) : markdown.length;
    } catch {
      return false;
    }
    if (direction === 'up' || direction === 'down') {
      const selection = this.accessors.getSurface()?.ownerDocument.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      if (range && typeof range.getBoundingClientRect === 'function') {
        const landing = caretOnVisualLine(targetElement, range.getBoundingClientRect().left, forward);
        const offset = landing ? this.offsetOfDomPoint(landing.startContainer, landing.startOffset) : null;
        if (offset !== null) local = offset - target.offset;
      }
    }
    // 这里只移动光标，不改源码：setSelectionOffsets 在非等待渲染时直接落选区。
    // applySelection 会自己聚焦最近的 contenteditable；围栏块则走 zeditor-code-selection，
    // 所以不能改用 focus()，它会把不可编辑的目标改送到第一个可编辑块。
    this.setSelectionOffsets(target.offset + local);
    return true;
  }

  /** 相邻的可编辑块：跳过表格、代码块、分隔线这些自带交互表面的只读块。 */
  private adjacentEditableBlock(index: number, step: 1 | -1): number | null {
    const blocks = this.document.blocks;
    for (let cursor = index + step; cursor >= 0 && cursor < blocks.length; cursor += step) {
      if (blocks[cursor].editable && !this.accessors.isBlockHidden?.(cursor)) return cursor;
    }
    return null;
  }

  /** 右键菜单的撤销 / 重做可用态。 */
  canUndo(): boolean { return this.undo.canUndo(); }
  canRedo(): boolean { return this.undo.canRedo(); }

  /** Ctrl+Z / Ctrl+Shift+Z。 */
  handleUndo(): boolean {
    this.flushWriteBack();
    const snapshot = this.undo.undo({
      source: this.document.source,
      caret: this.locateCaretOffset() ?? this.lastCaret,
      timestamp: Date.now(),
    });
    return snapshot ? this.applySource(snapshot.source, snapshot.caret) : false;
  }

  handleRedo(): boolean {
    this.flushWriteBack();
    const snapshot = this.undo.redo({
      source: this.document.source,
      caret: this.locateCaretOffset() ?? this.lastCaret,
      timestamp: Date.now(),
    });
    return snapshot ? this.applySource(snapshot.source, snapshot.caret) : false;
  }

  // ── 外部修改与粘贴 ─────────────────────────────────────────

  /** 整篇替换（撤销、粘贴、AI、菜单命令、时间线恢复）。 */
  applySource(source: string, caret: number | null): boolean {
    if (source === this.document.source) {
      if (caret !== null) this.setSelectionOffsets(caret);
      return false;
    }
    this.document = splitMarkdownDocument(source);
    this.skipRenderIndex = null;
    this.pendingCaret = caret;
    this.pendingSelectionEnd = null;
    this.persist();
    this.emit();
    return true;
  }

  /** 区间替换：工具栏、AI、图床插入、粘贴都走这里。 */
  replaceRange(from: number, to: number, text: string, caret?: number): void {
    this.prepareExternalEdit();
    this.pushUndo({ coalesce: false });
    this.applySource(this.document.source.slice(0, from) + text + this.document.source.slice(to), caret ?? from + text.length);
  }

  /** 删除块（悬停操作条「删除」）。 */
  deleteBlock(index: number): boolean {
    this.flushWriteBack();
    if (!this.document.blocks[index]) return false;
    this.pushUndo({ coalesce: false });
    const removed = removeBlockFromSource(this.document, index);
    return this.applySource(removed.source, removed.caret);
  }

  /** 在指定块之后插入一个空段落并落光标（悬停操作条「在下方插入」）。 */
  insertParagraphAfter(index: number): boolean {
    this.flushWriteBack();
    const block = this.document.blocks[index];
    if (!block) return false;
    this.pushUndo({ coalesce: false });
    const insertAt = block.offset + block.length;
    const gap = `${this.document.eol}${this.document.eol}`;
    return this.applySource(
      this.document.source.slice(0, insertAt) + gap + this.document.source.slice(insertAt),
      insertAt + gap.length,
    );
  }

  /** 在指定块之后插入一段 Markdown 并落光标（块菜单「在下方插入」）。空模板退化为插入段落。 */
  insertBlockAfter(index: number, markdown: string, selectionStart = 0, selectionEnd = selectionStart): boolean {
    if (markdown.length === 0) return this.insertParagraphAfter(index);
    this.flushWriteBack();
    const block = this.document.blocks[index];
    if (!block) return false;
    this.pushUndo({ coalesce: false });
    const insertAt = block.offset + block.length;
    const gap = `${this.document.eol}${this.document.eol}`;
    const normalized = markdown.replace(/\r\n|\n|\r/g, this.document.eol);
    const text = `${gap}${normalized}${gap}`;
    const normalizeOffset = (offset: number) => markdown.slice(0, offset).replace(/\r\n|\n|\r/g, this.document.eol).length;
    const from = insertAt + gap.length + normalizeOffset(selectionStart);
    const applied = this.applySource(
      this.document.source.slice(0, insertAt) + text + this.document.source.slice(insertAt),
      from,
    );
    if (selectionEnd !== selectionStart) this.setSelectionOffsets(from, insertAt + gap.length + normalizeOffset(selectionEnd));
    return applied;
  }

  /** 用新的块源码替换（块源码就地编辑保存）。 */
  replaceBlock(index: number, source: string): boolean {
    this.flushWriteBack();
    const block = this.document.blocks[index];
    if (!block) return false;
    if (source === block.source) return false;
    this.pushUndo({ coalesce: false });
    return this.applyBlockSource(block, source, block.offset);
  }

  /** 调整块顺序，保留原位置的间隔与未渲染源码。 */
  moveBlock(from: number, to: number): boolean {
    this.flushWriteBack();
    const blocks = this.document.blocks;
    if (from === to || !blocks[from] || !blocks[to]) return false;
    const reordered = [...blocks];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved);
    let source = '';
    let cursor = 0;
    let caret = 0;
    blocks.forEach((block, index) => {
      source += this.document.source.slice(cursor, block.offset);
      if (reordered[index] === moved) caret = source.length;
      source += reordered[index].source;
      cursor = block.offset + block.length;
    });
    source += this.document.source.slice(cursor);
    this.pushUndo({ coalesce: false });
    return this.applySource(source, caret);
  }

  duplicateBlock(index: number): boolean {
    this.flushWriteBack();
    const block = this.document.blocks[index];
    if (!block) return false;
    const at = block.offset + block.length;
    const gap = this.document.eol.repeat(2);
    this.pushUndo({ coalesce: false });
    return this.applySource(this.document.source.slice(0, at) + gap + block.source + this.document.source.slice(at), at + gap.length);
  }

  /** 代码块即时写回，输入时保留原生 textarea 的光标。 */
  writeCodeBlock(index: number, code: string, language?: string): boolean {
    const block = this.document.blocks[index];
    if (!block || block.kind !== 'fence') return false;
    // 围栏信息串可能除语言外还带 title= / 行高亮等属性，回写必须原样保留（只换语言时替换首个词）。
    const info = extractFenceInfo(block.source);
    const next = formatFence(code, extractFenceLanguage(block.source), {
      marker: extractFenceMarker(block.source),
      indent: block.source.match(/^[ \t]*/)?.[0] ?? '',
      info: language === undefined ? info : withFenceLanguage(info, language),
    });
    if (next === block.source) return false;
    this.commit(block, next);
    return true;
  }

  /** 来自 store 的外部变更（内容与本会话源码不同才生效）。 */
  syncExternalSource(source: string): void {
    if (source === this.document.source) return;
    this.flushWriteBack();
    if (source === this.document.source) return;
    this.document = splitMarkdownDocument(source);
    this.skipRenderIndex = null;
    this.undo.clear();
    this.emit();
  }

  /** 粘贴：图片走既有上传链路，HTML 转 Markdown，纯文本按 Markdown 源码插入。 */
  handlePaste(event: ClipboardEvent): boolean {
    const data = event.clipboardData;
    if (!data) return false;
    this.prepareExternalEdit();

    const image = Array.from(data.items).find(item => item.type.startsWith('image/'));
    const file = image?.getAsFile();
    if (file) {
      void this.options.insertClipboardImage(file);
      return true;
    }

    const { from, to } = this.getSelectionOffsets();
    const html = data.getData('text/html');
    const text = data.getData('text/plain');
    const index = this.blockIndexAtOffset(from);
    if (text && index !== null && this.document.blocks[index]?.kind === 'table') {
      this.replaceRange(from, to, escapeInlineText(text.replace(/\r?\n/g, ' '), { escapeLineStart: false, escapePipes: true }));
      return true;
    }
    if (html && shouldConvertHtmlToMarkdown(html, text)) {
      this.replaceRange(from, to, prepareMarkdownPaste(htmlToMarkdown(html), this.document.source, from, to));
      return true;
    }
    if (!text) return false;
    this.replaceRange(from, to, prepareMarkdownPaste(text, this.document.source, from, to));
    return true;
  }

  // ── 选区与映射 ─────────────────────────────────────────────

  getSelectionOffsets(): { from: number; to: number } {
    if (this.awaitingRender && this.pendingCaret !== null) {
      const to = this.pendingSelectionEnd ?? this.pendingCaret;
      return { from: Math.min(this.pendingCaret, to), to: Math.max(this.pendingCaret, to) };
    }
    const surface = this.accessors.getSurface();
    const active = surface?.ownerDocument.activeElement;
    if (active?.matches('textarea.wysiwyg-code-editor')) {
      const textarea = active as HTMLTextAreaElement;
      const host = textarea.closest('.wysiwyg-block-shell')?.querySelector<HTMLElement>('[data-block-index]');
      const block = this.document.blocks[Number(host?.dataset.blockIndex)];
      if (block?.kind === 'fence') {
        const prefix = block.source.indexOf('\n') + 1;
        return { from: block.offset + prefix + textarea.selectionStart, to: block.offset + prefix + textarea.selectionEnd };
      }
    }
    const selection = surface?.ownerDocument.getSelection();
    if (!surface || !selection || selection.rangeCount === 0) return { from: this.lastCaret, to: this.lastCaret };
    const range = selection.getRangeAt(0);
    const from = this.offsetOfDomPoint(range.startContainer, range.startOffset) ?? this.lastCaret;
    const to = range.collapsed ? from : (this.offsetOfDomPoint(range.endContainer, range.endOffset) ?? from);
    return { from: Math.min(from, to), to: Math.max(from, to) };
  }

  setSelectionOffsets(from: number, to = from): void {
    this.lastCaret = from;
    this.pendingCaret = from;
    this.pendingSelectionEnd = to;
    const startIndex = this.blockIndexAtOffset(from);
    const endIndex = this.blockIndexAtOffset(to);
    const revealedStart = startIndex !== null && this.accessors.revealBlock?.(startIndex);
    const revealedEnd = endIndex !== null && this.accessors.revealBlock?.(endIndex);
    if (revealedStart || revealedEnd) { this.awaitingRender = true; return; }
    if (!this.awaitingRender) this.applySelection(from, to);
  }

  getCaretOffset(): number { return this.pendingCaret ?? this.lastCaret; }

  /** The active edit's selection must exist before restoring it into new DOM. */
  getRenderTargetOffset(): number {
    return this.pendingCaret === null || !this.restoreFocus ? 0 : Math.max(this.pendingCaret, this.pendingSelectionEnd ?? this.pendingCaret);
  }

  /** 焦点必须落在块宿主上；外层只负责滚动，不再可编辑。 */
  focus(): void {
    if (this.awaitingRender) return;
    const { from, to } = this.getSelectionOffsets();
    if (this.domRangeOfOffset(this.pendingCaret ?? from)) {
      this.applySelection(this.pendingCaret ?? from, this.pendingSelectionEnd ?? to);
      return;
    }
    const index = this.blockIndexAtOffset(from);
    const targetIndex = index !== null && this.document.blocks[index]?.editable
      ? index
      : this.document.blocks.findIndex(block => block.editable);
    if (targetIndex < 0) return;
    // preventScroll：滚动交给显式的 revealElement / 光标恢复逻辑，浏览器隐式
    // scrollIntoView 在长文档里会带来数百毫秒的布局成本（打开文档时尤其明显）。
    this.accessors.getBlockElement(targetIndex)?.focus({ preventScroll: true });
    if (targetIndex === index) this.applySelection(from, to);
  }

  /** 渲染完成后由外壳调用：把待恢复的光标落到新 DOM 上。 */
  restoreCaretAfterRender(): void {
    if (this.pendingCaret === null) { this.awaitingRender = false; return; }
    const startIndex = this.blockIndexAtOffset(this.pendingCaret);
    const endIndex = this.blockIndexAtOffset(this.pendingSelectionEnd ?? this.pendingCaret);
    if (this.restoreFocus) {
      const revealedStart = startIndex !== null && this.accessors.revealBlock?.(startIndex);
      const revealedEnd = endIndex !== null && this.accessors.revealBlock?.(endIndex);
      if (revealedStart || revealedEnd) { this.awaitingRender = true; return; }
    }
    if (this.restoreFocus && this.accessors.getSurface()
      && ((startIndex !== null && !this.accessors.getBlockElement(startIndex))
        || (endIndex !== null && !this.accessors.getBlockElement(endIndex)))) {
      this.awaitingRender = true;
      return;
    }
    this.awaitingRender = false;
    const caret = this.pendingCaret;
    const selectionEnd = this.pendingSelectionEnd ?? caret;
    const restoreFocus = this.restoreFocus;
    this.restoreFocus = true;
    this.pendingCaret = null;
    this.pendingSelectionEnd = null;
    this.lastCaret = caret;
    // 焦点已经交给别处：只记住偏移，等下一次聚焦时再落光标。
    // 此刻写选区会把用户刚点击的位置顶掉。
    if (!restoreFocus) return;
    const index = this.blockIndexAtOffset(caret);
    if (index !== null && this.document.blocks[index]?.editable) {
      this.accessors.getBlockElement(index)?.focus({ preventScroll: true });
    }
    this.applySelection(caret, selectionEnd);
  }

  /** 鼠标点击位置 → 块索引与文档偏移（行内目标定位用）。 */
  blockPositionOfEvent(event: MouseEvent): { index: number; offset: number; blockStart: number } | null {
    const target = event.target;
    if (!(target instanceof Node)) return null;
    const element = target.nodeType === 1 ? target as HTMLElement : target.parentElement;
    const host = element?.closest<HTMLElement>('[data-block-index]');
    const rawIndex = host?.dataset.blockIndex;
    if (rawIndex === undefined) return null;
    const index = Number(rawIndex);
    const collected = this.collectBlock(index) ?? this.collectBlockForOffset(index);
    if (!collected) return null;
    const local = this.containerOffsetOfPoint(collected, target, 0);
    if (local === null) return null;
    return { index, offset: collected.block.offset + local, blockStart: collected.block.offset };
  }

  /** 控制器用：块索引 → 元素（滚动定位）。 */
  locateElementOfOffset(offset: number): HTMLElement | null {
    const index = this.blockIndexAtOffset(offset);
    if (index !== null) this.accessors.revealBlock?.(index);
    return index === null ? null : this.accessors.getBlockElement(index);
  }

  /** 控制器用：文档偏移 → 折叠选区（弹窗定位）。 */
  rangeOfOffset(offset: number): Range | null {
    return this.domRangeOfOffset(offset);
  }

  /** 控制器与结构操作共用：偏移所在块索引。 */
  blockIndexAtOffset(offset: number): number | null {
    const blocks = this.document.blocks;
    if (blocks.length === 0) return null;
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (offset >= block.offset && offset <= block.offset + block.length) return index;
      if (offset < block.offset) return Math.max(0, index - 1);
    }
    return blocks.length - 1;
  }

  // ── 内部实现 ───────────────────────────────────────────────

  /** 按 DOM 选区拆开行内树，Range 会为两侧保留完整的 strong/em/link 包装。 */
  private splitContentAtSelection(collected: CollectedBlock): { source: string; caret: number; continuation?: BlockContainerOffset['continuation']; empty: boolean } | null {
    const owner = this.accessors.getSurface()?.ownerDocument;
    const selection = owner?.getSelection();
    if (!owner?.createRange || !selection?.rangeCount) return null;
    const range = selection.getRangeAt(0);
    // 列表父项的 DOM 包含整棵子列表，但其行内源码不包含子列表。
    // 先找最深的文本容器，避免把子项内的回车错误应用到父项。
    const entries = [...collected.serialized.containers].sort((left, right) => right.path.length - left.path.length);
    for (const entry of entries) {
      const container = pathToNode(collected.element, entry.path);
      if (!container?.contains(range.startContainer) || !container.contains(range.endContainer)) continue;
      const options = { escapeLineStart: entry.escapeLineStart, escapePipes: entry.escapePipes };
      const before = owner.createRange();
      before.selectNodeContents(container);
      before.setEnd(range.startContainer, range.startOffset);
      const after = owner.createRange();
      after.selectNodeContents(container);
      after.setStart(range.endContainer, range.endOffset);
      const head = serializeInlineNodes(toInlineNodes(before.cloneContents()), options);
      const tail = serializeInlineNodes(toInlineNodes(after.cloneContents()), options);
      const originalLength = serializeInlineNodes(toInlineNodes(container), options).length;
      return {
        source: collected.serialized.markdown.slice(0, entry.contentOffset) + head + tail + collected.serialized.markdown.slice(entry.contentOffset + originalLength),
        caret: entry.contentOffset + head.length,
        continuation: entry.continuation,
        empty: originalLength === 0,
      };
    }
    return null;
  }

  private applyBlockSource(block: WysiwygBlock, nextBlockSource: string, caret: number): boolean {
    this.document = replaceBlockSource(this.document, block, nextBlockSource);
    this.skipRenderIndex = null;
    this.pendingCaret = caret;
    this.pendingSelectionEnd = null;
    this.persist();
    this.emit();
    return true;
  }

  /** 结构操作前，先保留尚未防抖写回的文字，再建立结构操作的撤销边界。 */
  private checkpointBlock(collected: CollectedBlock): void {
    const index = this.document.blocks.indexOf(collected.block);
    if (index >= 0) this.dirtyBlockIndices.add(index);
    const visibleSource = replaceBlockSource(this.document, collected.block, collected.serialized.markdown).source;
    if (visibleSource !== this.document.source) this.pushUndo({ coalesce: true });
    this.pushUndo({ coalesce: false, source: visibleSource });
    if (this.pendingIndex !== null && this.document.blocks[this.pendingIndex] === collected.block) {
      if (this.writeBackTimer !== null) clearTimeout(this.writeBackTimer);
      this.writeBackTimer = null;
      this.pendingIndex = null;
    }
  }

  private pushUndo(options: { coalesce: boolean; source?: string }): void {
    this.undo.push({
      source: options.source ?? this.document.source,
      caret: this.locateCaretOffset() ?? this.lastCaret,
      timestamp: Date.now(),
    }, options);
  }

  private persist(): void {
    this.options.onSourceChange(this.document.source);
  }

  private emit(): void {
    this.version += 1;
    if (this.skipRenderIndex === null) {
      this.renderRevision += 1;
      this.awaitingRender = true;
      if (this.dirtyBlockIndices.size > 0) {
        this.blockRenderRevisions = new Map(this.blockRenderRevisions);
        for (const index of this.blockRenderRevisions.keys()) {
          if (index >= this.document.blocks.length) this.blockRenderRevisions.delete(index);
        }
        for (const index of this.dirtyBlockIndices) {
          if (index < this.document.blocks.length) this.blockRenderRevisions.set(index, this.renderRevision);
        }
        this.dirtyBlockIndices.clear();
      }
    }
    this.snapshot = { document: this.document, skipRenderIndex: this.skipRenderIndex, version: this.version, renderRevision: this.renderRevision, blockRenderRevisions: this.blockRenderRevisions };
    this.notify();
  }

  private collectBlock(index: number): CollectedBlock | null {
    const block = this.document.blocks[index];
    const element = this.accessors.getBlockElement(index);
    if (!block || !element || (!block.editable && block.kind !== 'table')) return null;
    try {
      return { block, element, serialized: serializeBlockMarkdown(block.kind, toInlineNodes(element), EDITING_SERIALIZE_OPTIONS) };
    } catch {
      return null;
    }
  }

  /** 与 collectBlock 相同，但允许不可编辑的块（仅用于定位）。 */
  private collectBlockForOffset(index: number): CollectedBlock | null {
    const block = this.document.blocks[index];
    const element = this.accessors.getBlockElement(index);
    if (!block || !element) return null;
    try {
      const serialized = serializeBlockMarkdown(block.kind, toInlineNodes(element), EDITING_SERIALIZE_OPTIONS);
      if (block.kind === 'table') {
        const table = parseTableAt(block.source, 0);
        const cells = table?.rows.filter((_, row) => row !== 1).flatMap(row => row.cells);
        if (cells?.length === serialized.containers.length) {
          serialized.containers.forEach((container, cell) => { container.contentOffset = cells[cell].from; });
        }
      }
      return { block, element, serialized };
    } catch {
      return null;
    }
  }

  /** 元素内光标 → 块源码偏移。 */
  private caretOffsetInBlock(collected: CollectedBlock): number | null {
    const surface = this.accessors.getSurface();
    const selection = surface?.ownerDocument.getSelection();
    if (!surface || !selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    return this.containerOffsetOfPoint(collected, range.startContainer, range.startOffset);
  }

  private containerOffsetOfPoint(collected: CollectedBlock, node: Node, offset: number): number | null {
    for (const container of collected.serialized.containers) {
      const containerNode = pathToNode(collected.element, container.path);
      if (!containerNode || !containerNode.contains(node)) continue;
      const point = pointInContainer(containerNode as HTMLElement, node, offset);
      if (!point) continue;
      const input: ContainerInput = { nodes: toInlineNodes(containerNode), path: container.path };
      const local = blockOffsetFromPoint(collected.serialized, input, point);
      if (local !== null) return local;
    }
    return null;
  }

  /** DOM 位置 → 全文档偏移。 */
  private offsetOfDomPoint(node: Node, offset: number): number | null {
    const element = node.nodeType === 1 ? node as HTMLElement : node.parentElement;
    const host = element?.closest<HTMLElement>('[data-block-index]');
    const rawIndex = host?.dataset.blockIndex;
    if (rawIndex === undefined) return null;
    const collected = this.collectBlockForOffset(Number(rawIndex));
    if (!collected || !collected.element.contains(node)) return null;
    const local = this.containerOffsetOfPoint(collected, node, offset);
    if (local === null) return null;
    return collected.block.offset + local;
  }

  /** 全文档光标偏移（撤销快照用）。 */
  private locateCaretOffset(): number | null {
    const surface = this.accessors.getSurface();
    if (surface?.ownerDocument.activeElement?.matches('textarea.wysiwyg-code-editor')) return this.getSelectionOffsets().from;
    const selection = surface?.ownerDocument.getSelection();
    if (!surface || !selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    return this.offsetOfDomPoint(range.startContainer, range.startOffset);
  }

  private applySelection(from: number, to: number): void {
    const surface = this.accessors.getSurface();
    if (!surface) return;
    const active = surface.ownerDocument.activeElement as HTMLElement | null;
    const preserveFocus = Boolean(active?.matches('input,textarea') && !surface.contains(active));
    const start = this.domRangeOfOffset(from);
    if (!start) {
      const index = this.blockIndexAtOffset(from);
      const block = index === null ? null : this.document.blocks[index];
      if (block?.kind === 'fence' && index !== null) {
        const prefix = block.source.indexOf('\n') + 1;
        this.accessors.getBlockElement(index)?.dispatchEvent(new CustomEvent('zeditor-code-selection', { detail: { from: Math.max(0, from - block.offset - prefix), to: Math.max(0, to - block.offset - prefix), preserveFocus } }));
      }
      return;
    }
    const startElement = start.startContainer.nodeType === 1 ? start.startContainer as HTMLElement : start.startContainer.parentElement;
    startElement?.closest<HTMLElement>('[contenteditable="true"]')?.focus({ preventScroll: true });
    const selection = surface.ownerDocument.getSelection();
    if (!selection) return;
    const range = surface.ownerDocument.createRange();
    range.setStart(start.startContainer, start.startOffset);
    const end = to === from ? null : this.domRangeOfOffset(to);
    if (end) range.setEnd(end.startContainer, end.startOffset);
    else range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    if (preserveFocus) active?.focus({ preventScroll: true });
  }

  private domRangeOfOffset(offset: number): Range | null {
    const index = this.blockIndexAtOffset(offset);
    if (index === null) return null;
    const collected = this.collectBlockForOffset(index);
    if (!collected) return null;
    const local = offset - collected.block.offset;
    let fallback: Range | null = null;
    for (const container of collected.serialized.containers) {
      const containerNode = pathToNode(collected.element, container.path);
      if (!containerNode) continue;
      const input: ContainerInput = { nodes: toInlineNodes(containerNode), path: container.path };
      if (local < container.contentOffset && fallback) continue;
      const point = pointFromBlockOffset(collected.serialized, input, local);
      if (!point) continue;
      const range = rangeInContainer(containerNode as HTMLElement, point);
      if (local <= container.contentOffset) return range;
      fallback = range;
    }
    return fallback;
  }
}
