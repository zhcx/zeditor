/**
 * 所见即所得编辑会话。
 *
 * 只做状态与算法，不碰 React：DOM 元素由外壳提供，结构变化通过 `onChange` 通知外壳重渲染。
 * 「输入」走 DOM 本地改写（记脏 → 防抖写回），「结构操作 / 外部修改」走文档级源码替换
 * （重新分块 → 重渲染 → 恢复光标），两条路径共用同一个块模型。
 */
import { useAppStore } from '../../stores/appStore';
import {
  removeBlockFromSource,
  replaceBlockSource,
  splitMarkdownDocument,
  type WysiwygBlock,
  type WysiwygDocument,
} from '../../utils/wysiwyg/blocks';
import {
  serializeBlockMarkdown,
  type BlockSerializeOptions,
  type BlockSerializeResult,
} from '../../utils/wysiwyg/blockSerialize';
import { blockOffsetFromPoint, pointFromBlockOffset, type ContainerInput } from '../../utils/wysiwyg/offsetMap';
import { toInlineNodes } from '../../utils/wysiwyg/inlineNodes';
import {
  adjustListIndent,
  contentStartOffset,
  mergeBlocks,
  setHeadingLevel,
  splitBlock,
  stripBlockPrefix,
} from '../../utils/wysiwyg/blockOps';
import { createUndoStack } from '../../utils/wysiwyg/undoStack';
import { htmlToMarkdown, shouldConvertHtmlToMarkdown } from '../../utils/htmlToMarkdown';
import { prepareMarkdownPaste } from '../../utils/markdownPaste';
import { pointInContainer, rangeInContainer } from './domCaret';

export interface WysiwygSessionSnapshot {
  document: WysiwygDocument;
  /** 本次渲染不重建 DOM 的块索引；由输入触发的写回会设置它。 */
  skipRenderIndex: number | null;
  /** 结构版本号：外壳用它作为布局效应的依赖。 */
  version: number;
}

export interface WysiwygSessionOptions {
  getTabId: () => string | null;
  /** 粘贴图片的落地方（镜像编辑器里已有的图床 / .assets 链路）。 */
  insertClipboardImage: (file: File) => Promise<boolean>;
}

/** DOM 访问器：外壳挂载后才注入（外壳在渲染期不能读 ref，构造时会话拿不到元素）。 */
export interface WysiwygSessionAccessors {
  getSurface: () => HTMLElement | null;
  getBlockElement: (index: number) => HTMLElement | null;
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
  private lastCaret = 0;
  private pendingCaret: number | null = null;
  /** 变更通知由外壳在挂载后注入（避免外壳在渲染期读取会话实例）。 */
  private notify: () => void = () => undefined;
  private accessors: WysiwygSessionAccessors = NO_ACCESSORS;

  constructor(source: string, options: WysiwygSessionOptions) {
    this.options = options;
    this.document = splitMarkdownDocument(source);
    this.snapshot = { document: this.document, skipRenderIndex: null, version: 0 };
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
  getBlocks(): WysiwygBlock[] { return this.document.blocks; }

  // ── 输入与写回 ─────────────────────────────────────────────

  markComposing(composing: boolean): void { this.composing = composing; }

  handleInput(index: number): void {
    if (this.composing) return;
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
  normalizeBlock(index: number): void {
    this.flushWriteBack();
    if (this.skipRenderIndex !== index) return;
    this.skipRenderIndex = null;
    this.pendingCaret = this.locateCaretOffset();
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
    const caretBefore = this.locateCaretOffset();
    this.pushUndo({ coalesce: true });

    const next = replaceBlockSource(this.document, block, nextBlockSource);
    const kindChanged = index >= 0 && next.blocks[index]?.kind !== block.kind;
    const countChanged = next.blocks.length !== this.document.blocks.length;
    this.document = next;

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
    this.pushUndo({ coalesce: false });
    const result = splitBlock({ source: collected.serialized.markdown, kind: collected.block.kind, caret });
    return this.applyBlockSource(
      collected.block,
      `${result.head}${result.separator}${result.tail}`,
      collected.block.offset + result.head.length + result.separator.length,
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
      this.pushUndo({ coalesce: false });
      const removed = removeBlockFromSource(this.document, index);
      return this.applySource(removed.source, removed.caret);
    }

    const stripped = stripBlockPrefix(collected.serialized.markdown, collected.block.kind);
    if (stripped) {
      this.pushUndo({ coalesce: false });
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

    this.pushUndo({ coalesce: false });
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

  /** Tab / Shift+Tab：列表层级调整。 */
  handleIndent(index: number, direction: 'indent' | 'outdent'): boolean {
    const collected = this.collectBlock(index);
    if (!collected || collected.block.kind !== 'list') return false;
    const caret = this.caretOffsetInBlock(collected);
    if (caret === null) return false;
    const result = adjustListIndent(collected.serialized.markdown, collected.block.kind, direction);
    if (!result) return false;
    const innerCaret = Math.max(0, caret - contentStartOffset(collected.serialized.markdown, collected.block.kind));
    this.pushUndo({ coalesce: false });
    return this.applyBlockSource(
      collected.block,
      result.source,
      collected.block.offset + contentStartOffset(result.source, 'list') + innerCaret,
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
    const result = setHeadingLevel(collected.serialized.markdown, collected.block.kind, level);
    const innerCaret = Math.max(0, caret - contentStartOffset(collected.serialized.markdown, collected.block.kind));
    const targetKind = level > 0 ? 'heading' : 'paragraph';
    this.pushUndo({ coalesce: false });
    return this.applyBlockSource(
      collected.block,
      result.source,
      collected.block.offset + contentStartOffset(result.source, targetKind) + innerCaret,
    );
  }

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
    const surface = this.accessors.getSurface();
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
    this.applySelection(from, to);
  }

  getCaretOffset(): number { return this.lastCaret; }

  /** 渲染完成后由外壳调用：把待恢复的光标落到新 DOM 上。 */
  restoreCaretAfterRender(): void {
    if (this.pendingCaret === null) return;
    const caret = this.pendingCaret;
    this.pendingCaret = null;
    this.lastCaret = caret;
    this.applySelection(caret, caret);
  }

  /** 控制器用：块索引 → 元素（滚动定位）。 */
  locateElementOfOffset(offset: number): HTMLElement | null {
    const index = this.blockIndexAtOffset(offset);
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

  private applyBlockSource(block: WysiwygBlock, nextBlockSource: string, caret: number): boolean {
    this.document = replaceBlockSource(this.document, block, nextBlockSource);
    this.skipRenderIndex = null;
    this.pendingCaret = caret;
    this.persist();
    this.emit();
    return true;
  }

  private pushUndo(options: { coalesce: boolean }): void {
    this.undo.push({
      source: this.document.source,
      caret: this.locateCaretOffset() ?? this.lastCaret,
      timestamp: Date.now(),
    }, options);
  }

  private persist(): void {
    const tabId = this.options.getTabId();
    if (!tabId) return;
    useAppStore.getState().updateTabContent(tabId, this.document.source);
  }

  private emit(): void {
    this.version += 1;
    this.snapshot = { document: this.document, skipRenderIndex: this.skipRenderIndex, version: this.version };
    this.notify();
  }

  private collectBlock(index: number): CollectedBlock | null {
    const block = this.document.blocks[index];
    const element = this.accessors.getBlockElement(index);
    if (!block || !element || !block.editable) return null;
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
      return { block, element, serialized: serializeBlockMarkdown(block.kind, toInlineNodes(element), EDITING_SERIALIZE_OPTIONS) };
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
    const selection = surface?.ownerDocument.getSelection();
    if (!surface || !selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    return this.offsetOfDomPoint(range.startContainer, range.startOffset);
  }

  private applySelection(from: number, to: number): void {
    const surface = this.accessors.getSurface();
    if (!surface) return;
    const start = this.domRangeOfOffset(from);
    if (!start) return;
    const selection = surface.ownerDocument.getSelection();
    if (!selection) return;
    const range = surface.ownerDocument.createRange();
    range.setStart(start.startContainer, start.startOffset);
    const end = to === from ? null : this.domRangeOfOffset(to);
    if (end) range.setEnd(end.startContainer, end.startOffset);
    else range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
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
