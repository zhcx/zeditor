import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { open as openExternal } from '@tauri-apps/plugin-shell';
import { useAppStore } from '../../stores/appStore';
import { renderMarkdownSource } from '../../utils/markdownPipeline';
import { sanitizeRenderedHtml } from '../../utils/safeHtml';
import { enhanceRenderedMarkdown } from '../../utils/markdownEnhancers';
import type { WysiwygBlockKind, WysiwygDocument } from '../../utils/wysiwyg/blocks';
import { createBlockHtmlRenderer } from '../../utils/wysiwyg/blockHtml';
import { nextBlockRenderBudget } from '../../utils/wysiwyg/renderBudget';
import { extractFenceCode, extractFenceLanguage } from '../../utils/wysiwyg/codeFence';
import { insertTable } from '../../utils/markdownTable';
import { hasTrailingEmptyQuoteLine } from '../../utils/wysiwyg/blockOps';
import { findInlineTargetAt, type InlineTarget } from '../../utils/inlineTargets';
import type { ImageSpec } from '../../utils/imageSyntax';
import { ImagePropertiesModal } from '../Editor/ImagePropertiesModal';
import { InlinePopup } from '../Editor/InlinePopup';
import { EditorContextMenu, type EditorContextMenuState } from '../Editor/EditorContextMenu';
import { ImageOptionsModal } from '../Toolbar/Toolbar';
import { WysiwygSession, type WysiwygSessionSnapshot } from './wysiwygSession';
import { createWysiwygController } from './WysiwygController';
import { WysiwygCodeBlock } from './WysiwygCodeBlock';
import { BlockActions, type BlockInsertKind, type BlockRetypeTarget } from './BlockActions';
import { BlockSourceEditor } from './BlockSourceEditor';
import { imageSpecMarkdown, inlineTargetMarkdown } from './inlineEditing';
import { WysiwygChrome } from './WysiwygChrome';
import { ProofreadHighlights } from './ProofreadHighlights';
import { AppIcon } from '../Icons/AppIcon';
import { formatShortcut } from '../../utils/platformShortcuts';

/** 渲染结果按「块类型 + 块源码」缓存：只有被编辑的块需要重新渲染。 */
const renderBlockHtml = createBlockHtmlRenderer(source => sanitizeRenderedHtml(renderMarkdownSource(source)));

function sourceEditorTitle(kind: WysiwygBlockKind): string {
  if (kind === 'table') return '编辑表格源码';
  if (kind === 'fence') return '编辑代码块源码';
  if (kind === 'html') return '编辑 HTML 块';
  return '编辑块源码';
}

interface WysiwygBlockViewProps {
  index: number;
  kind: WysiwygBlockKind;
  source: string;
  startLine: number;
  editable: boolean;
  skipRender: boolean;
  renderRevision: number;
  documentPath: string | null;
  workflowViewerEnabled: boolean;
  scrollRoot: HTMLElement | null;
  theme: string;
  registerElement: (index: number, element: HTMLElement | null) => void;
  onInput: (index: number) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>, index: number) => void;
  onBlurBlock: (index: number, nextFocus: Node | null) => void;
  onCompositionChange: (composing: boolean, index: number) => void;
  onCommitCode: (index: number, code: string, language?: string) => void;
  onInlineClick: (event: React.MouseEvent<HTMLElement>) => boolean;
  onApplyBlockSource: (index: number, source: string) => void;
  onEndSourceEditing: (index: number) => void;
  onDeleteBlock: (index: number) => void;
  onInsertAfter: (index: number, kind: BlockInsertKind) => void;
  onMove: (from: number, to: number) => void;
  onDuplicate: (index: number) => void;
  onRetype: (index: number, target: BlockRetypeTarget) => void;
  count: number;
}

/**
 * 手柄对齐的测量要读 getBoundingClientRect / getComputedStyle，属于强制同步布局。
 * 打开大文档时逐块测量会累积成数百次布局（实测占打开耗时的三分之一以上），
 * 因此：只测进入视口附近的块、同一帧内的测量合并到一次 rAF、块内容未变则跳过。
 */
const pendingHandleMeasures = new Set<() => void>();
let handleMeasureFrame = 0;
function scheduleHandleMeasure(measure: () => void) {
  pendingHandleMeasures.add(measure);
  if (handleMeasureFrame) return;
  handleMeasureFrame = window.requestAnimationFrame(() => {
    handleMeasureFrame = 0;
    const pending = [...pendingHandleMeasures];
    pendingHandleMeasures.clear();
    for (const run of pending) run();
  });
}

const handleMeasureRunners = new WeakMap<Element, () => void>();
let handleMeasureObserver: IntersectionObserver | null = null;

/** 块进入视口附近时才安排测量，并返回取消函数。 */
function observeHandleMeasure(target: Element, measure: () => void) {
  if (typeof IntersectionObserver === 'undefined') {
    scheduleHandleMeasure(measure);
    return () => {};
  }
  if (!handleMeasureObserver) {
    handleMeasureObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const run = handleMeasureRunners.get(entry.target);
        if (run) scheduleHandleMeasure(run);
      }
    }, { rootMargin: '500px 0px' });
  }
  handleMeasureRunners.set(target, measure);
  handleMeasureObserver.observe(target);
  return () => {
    handleMeasureRunners.delete(target);
    handleMeasureObserver?.unobserve(target);
  };
}

const WysiwygBlockView = memo(function WysiwygBlockView({
  index, kind, source, startLine, editable, skipRender, renderRevision, documentPath, workflowViewerEnabled,
  scrollRoot, theme, registerElement, onInput, onKeyDown, onBlurBlock, onCompositionChange,
  onCommitCode, onInlineClick, onApplyBlockSource, onEndSourceEditing, onDeleteBlock, onInsertAfter, onMove, onDuplicate, onRetype, count,
}: WysiwygBlockViewProps) {
  const hostRef = useRef<HTMLElement>(null);
  const renderedSourceRef = useRef<string | null>(null);
  const renderedRevisionRef = useRef<number | null>(null);
  const [codeEditing, setCodeEditing] = useState(kind === 'fence' && extractFenceCode(source).length === 0);
  const [codeSelection, setCodeSelection] = useState<{ from: number; to: number; preserveFocus?: boolean } | null>(null);
  // 非文本块（表格 / 图表 / 公式 / HTML 等）的就地源码编辑开关。
  const [sourceEditing, setSourceEditing] = useState(false);

  // 注册与内容渲染都必须放在 useLayoutEffect：React 先跑子节点的 layout effect、再跑父节点，
  // 而父节点正是在 layout effect 里恢复光标——用 useEffect（被动效应）会晚于光标恢复执行，
  // 光标会落到还没渲染内容的旧 DOM 上。索引变化也要重新登记（重新分块后索引会平移）。
  useLayoutEffect(() => {
    const host = hostRef.current;
    registerElement(index, host);
    return () => registerElement(index, null);
  }, [index, registerElement]);
  useLayoutEffect(() => {
    const host = hostRef.current;
    const revealCode = (event: Event) => { setCodeEditing(true); setCodeSelection((event as CustomEvent<{ from: number; to: number; preserveFocus?: boolean }>).detail); };
    host?.addEventListener('zeditor-code-selection', revealCode);
    return () => host?.removeEventListener('zeditor-code-selection', revealCode);
  }, []);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    // 由用户输入触发的写回：DOM 就是最新的，重建反而会丢光标。
    if (skipRender) {
      // DOM 已由输入改写；失焦后仍需规范化，即便源码恰好回到了上次渲染值。
      renderedSourceRef.current = null;
      return undefined;
    }
    // StrictMode 会重复运行 layout effect；同一轮不能在恢复光标后再次清空 DOM。
    if ((!editable && kind !== 'table') || renderedSourceRef.current !== source || renderedRevisionRef.current !== renderRevision) {
      const html = renderBlockHtml(kind, source);
      if (kind === 'table') {
        // Changing contentEditable on connected cells makes Chromium repeatedly
        // update its editing/layout state. Prepare every cell off-document and
        // insert the finished fragment once, including under StrictMode replay.
        const template = host.ownerDocument.createElement('template');
        template.innerHTML = html;
        template.content.querySelectorAll<HTMLTableRowElement>('tr').forEach((row, rowIndex) => {
          Array.from(row.cells).forEach((cell, column) => {
            cell.contentEditable = 'true';
            cell.tabIndex = 0;
            cell.setAttribute('role', 'textbox');
            cell.setAttribute('aria-label', `第 ${rowIndex + 1} 行第 ${column + 1} 列`);
          });
        });
        host.replaceChildren(template.content);
      } else {
        host.innerHTML = html;
      }
      renderedSourceRef.current = source;
      renderedRevisionRef.current = renderRevision;
    }
    const cleanup = enhanceRenderedMarkdown(host, {
      scrollRoot,
      source,
      documentPath,
      workflowViewerEnabled,
      theme,
      // 回写要保留原始图片语法：解析失败时不要把 <img> 换成提示文本。
      keepUnresolvedImages: true,
    });
    if (kind === 'blockquote' || kind === 'list') {
      // markdown-it 不给空的引用行生成段落（`> a\n>\n> ` 只剩一个 <p>），
      // 于是回车拆出的新引用段落在 DOM 里没有落点。这里补一个空段落，
      // 与文档级空段落一样由序列化还原成同一个空引用行。
      const depth = (source.split(/\r?\n/).at(-1)?.match(/>/g) ?? []).length;
      const quote = Array.from(host.querySelectorAll('blockquote')).filter(element => {
        let level = 0;
        for (let parent: Element | null = element; parent && parent !== host; parent = parent.parentElement) {
          if (parent.tagName === 'BLOCKQUOTE') level += 1;
        }
        return level === depth;
      }).at(-1);
      const trailing = quote ? Array.from(quote.children).at(-1) : undefined;
      const alreadyEmpty = trailing?.tagName === 'P' && trailing.textContent === '' && !trailing.querySelector('img,video,audio,iframe,svg,table');
      if (quote && hasTrailingEmptyQuoteLine(source) && !alreadyEmpty) quote.appendChild(host.ownerDocument.createElement('p'));
    }
    if (editable || kind === 'table') {
      // 空列表项需要真正的光标占位；只有 CSS 高度时 Chromium 会把输入移到前一项。
      host.querySelectorAll('li:empty, p:empty, h1:empty, h2:empty, h3:empty, h4:empty, h5:empty, h6:empty, th:empty, td:empty').forEach(container => {
        const placeholder = host.ownerDocument.createElement('br');
        placeholder.dataset.wysiwygPlaceholder = 'true';
        container.appendChild(placeholder);
      });
    }
    // 块手柄的垂直中心要落在块首行的行盒中心上：段落、各级标题、列表项、表格首格
    // 的行高与位移各不相同，CSS 无法从壳上得知，这里测量首个文本盒（优先真正的
    // 段落 / 列表项 / 标题 / 代码行，而不是它的容器），把「到首行中心的两倍距离」
    // 写到壳的自定义属性，手柄按它居中。
    // 测量要读布局，因此只在块进入视口附近时执行，同一帧内合并；内容未变就跳过。
    const shell = host.parentElement;
    let measuredKey = '';
    const measureHandleOffset = (force = false) => {
      if (!(shell instanceof HTMLElement)) return;
      const key = `${kind}\u0000${source}\u0000${renderRevision}`;
      if (!force && key === measuredKey) return;
      const first = kind === 'table'
        ? host.querySelector('th, td')
        : host.querySelector('p, li, h1, h2, h3, h4, h5, h6, pre code') ?? host.firstElementChild;
      if (!(first instanceof HTMLElement)) {
        shell.style.removeProperty('--wysiwyg-first-line');
        measuredKey = key;
        return;
      }
      const styles = window.getComputedStyle(first);
      const measured = Number.parseFloat(styles.lineHeight);
      const lineHeight = Number.isFinite(measured) ? measured : Number.parseFloat(styles.fontSize) * 1.2;
      const padding = Number.parseFloat(styles.paddingTop) || 0;
      // 基准是壳而不是块：围栏块的代码工具栏在块之外、壳之内（体积上是块的一部分），
      // 代码区整体被它推下去，用块作基准会漏掉这段位移。
      const offset = first.getBoundingClientRect().top - shell.getBoundingClientRect().top + padding;
      shell.style.setProperty('--wysiwyg-first-line', `${offset * 2 + lineHeight}px`);
      measuredKey = key;
    };
    const stopObservingHandle = shell instanceof HTMLElement ? observeHandleMeasure(shell, measureHandleOffset) : () => {};
    // 手柄是悬停才出现的：鼠标进入块时强制重测一次，保证真正要用的那一刻位置一定准确
    // （观察器只负责提前给视口附近的块铺好位置）。
    const requeueHandleMeasure = () => scheduleHandleMeasure(() => measureHandleOffset(true));
    shell?.addEventListener('pointerenter', requeueHandleMeasure);
    return () => {
      stopObservingHandle();
      shell?.removeEventListener('pointerenter', requeueHandleMeasure);
      cleanup();
    };
  }, [documentPath, editable, kind, renderRevision, scrollRoot, skipRender, source, theme, workflowViewerEnabled]);

  return (
    <div className={`wysiwyg-block-shell${kind === 'fence' ? ' has-code' : ''}`}>
      {kind === 'fence' && <WysiwygCodeBlock index={index} code={extractFenceCode(source)} language={extractFenceLanguage(source)} onCommit={(position, code, language) => { onCommitCode(position, code, language); if (!codeEditing) onBlurBlock(index, null); }} editing={codeEditing} selection={codeSelection} onEditingChange={editing => { setCodeEditing(editing); if (!editing) onBlurBlock(index, null); }} />}
      {sourceEditing && (
        <BlockSourceEditor
          title={sourceEditorTitle(kind)}
          source={source}
          onApply={(next) => { setSourceEditing(false); onApplyBlockSource(index, next); }}
          onClose={() => { setSourceEditing(false); onEndSourceEditing(index); }}
        />
      )}
      <section
        ref={hostRef}
        className={`wysiwyg-block ${editable ? 'is-editable' : 'is-readonly'}${kind === 'fence' && codeEditing ? ' is-code-editing' : ''}${sourceEditing ? ' is-source-editing' : ''}`}
        data-block-index={index}
        data-block-kind={kind}
        data-source-line={startLine}
        contentEditable={editable}
        suppressContentEditableWarning
        spellCheck={false}
        onInput={() => onInput(index)}
        onFocus={(event) => { if (kind === 'table' && (event.target as Element).closest('td,th')) onInput(index); }}
        onKeyDown={(event) => onKeyDown(event, index)}
        onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onBlurBlock(index, event.relatedTarget as Node | null); }}
        onCompositionStart={() => onCompositionChange(true, index)}
        onCompositionEnd={() => onCompositionChange(false, index)}
        onClick={(event) => {
          if (kind === 'fence') { setCodeEditing(true); return; }
          const handled = onInlineClick(event);
          // 没有其他交互面的只读块（HTML 块、解析不出结构的块）：点击直接就地编辑源码，
          // 不必先展开悬停菜单。媒体与公式有自己的交互，不在此列。
          if (!handled && !editable && (kind === 'html' || kind === 'other')) setSourceEditing(true);
        }}
      />
      <BlockActions
        index={index}
        kind={kind}
        editable={editable}
        onEditSource={() => setSourceEditing(true)}
        onDelete={onDeleteBlock}
        onInsertAfter={onInsertAfter}
        onMove={onMove}
        onDuplicate={onDuplicate}
        onRetype={onRetype}
        count={count}
      />
    </div>
  );
});

/** Ctrl+B / Ctrl+I：把选区包进行内标记（与工具栏一致：改源码后规范化重渲染）。 */
function wrapSelection(marker: 'strong' | 'em'): void {
  const delimiters = marker === 'strong' ? '**' : '*';
  const editor = useAppStore.getState().editorView;
  if (!editor) return;
  const { from, to } = editor.getSelection();
  if (from === to) return;
  const text = editor.getText(from, to);
  editor.replaceRange(from, to, `${delimiters}${text}${delimiters}`);
}

function fileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('读取剪贴板图片失败'));
    reader.readAsDataURL(file);
  });
}

/** 剪贴板图片：沿用编辑器里已有的 .assets / 图床上传链路（它会通过当前编辑器插入语法）。 */
async function insertClipboardImage(file: File): Promise<boolean> {
  const dataUrl = await fileAsDataUrl(file);
  if (!('__TAURI_INTERNALS__' in window) || !useAppStore.getState().currentFile) {
    const editor = useAppStore.getState().editorView;
    if (!editor) return false;
    const selection = editor.getSelection();
    editor.replaceRange(selection.from, selection.to, `![粘贴的图片](${dataUrl})`);
    editor.focus();
    return true;
  }
  const { insertImageFromBytes } = await import('../../services/imageAssets');
  const { clipboardImageExtension } = await import('../../utils/imageSyntax');
  return insertImageFromBytes(dataUrl.split(',')[1], clipboardImageExtension(file.type), '粘贴的图片');
}

function openUrl(url: string): void {
  let target = url;
  try {
    target = new URL(url, window.location.href).href;
  } catch {
    // 保持原样
  }
  if ('__TAURI_INTERNALS__' in window) {
    void openExternal(target).catch(() => window.open(target, '_blank', 'noopener,noreferrer'));
    return;
  }
  window.open(target, '_blank', 'noopener,noreferrer');
}

export function WysiwygEditor() {
  const { content, currentFile, settings, activeTabId, markEditorBootReady, setEditorView } = useAppStore(useShallow(state => ({
    content: state.content,
    currentFile: state.currentFile,
    settings: state.settings,
    activeTabId: state.activeTabId,
    markEditorBootReady: state.markEditorBootReady,
    setEditorView: state.setEditorView,
  })));
  const surfaceRef = useRef<HTMLDivElement>(null);
  const blockElementsRef = useRef(new Map<number, HTMLElement>());
  const [scrollRoot, setScrollRoot] = useState<HTMLElement | null>(null);
  const theme = document.documentElement.dataset.theme || 'vscode-dark';

  // 会话只建一次；它是普通对象，不受 React 状态更新影响。放在 useState 里而不是
  // useRef 里，是因为 react-hooks/refs 禁止在渲染期读 ref。
  const [session] = useState(() => {
    const store = useAppStore.getState();
    const tabId = store.activeTabId;
    return new WysiwygSession(store.content, {
      onSourceChange: (source) => {
        if (tabId) useAppStore.getState().updateTabContent(tabId, source);
      },
      insertClipboardImage,
    });
  });
  const [snapshot, setSnapshot] = useState<WysiwygSessionSnapshot>(() => session.getSnapshot());
  const [imageTarget, setImageTarget] = useState<{ target: InlineTarget; spec: ImageSpec } | null>(null);
  const [inlineTarget, setInlineTarget] = useState<{ target: InlineTarget; anchor: { left: number; top: number }; autoFocus?: boolean } | null>(null);
  const [contextMenu, setContextMenu] = useState<EditorContextMenuState | null>(null);
  const [imageInsertOpen, setImageInsertOpen] = useState(false);

  // 打开大文档时先渲染首屏附近的块，其余按帧补齐：首屏绘制时间与总块数解耦，
  // 打开看起来更快，补齐在随后的几帧内完成。预算跟着标签走——切到别的文档时
  // 自动退回首屏值，不需要额外的重置副作用。
  const [renderState, setRenderState] = useState({ tabId: activeTabId, budget: 0 });
  const initialBudget = nextBlockRenderBudget(snapshot.document.blocks, 0, 60);
  const renderBudget = renderState.tabId === activeTabId ? Math.max(initialBudget, renderState.budget) : initialBudget;
  const requiredBudget = (session.blockIndexAtOffset(session.getRenderTargetOffset()) ?? 0) + 1;
  // An active edit (for example, a long paste) must mount through its caret now.
  // Store the expanded budget so a later menu render cannot remove those blocks.
  if (requiredBudget > renderBudget) setRenderState({ tabId: activeTabId, budget: requiredBudget });
  useEffect(() => {
    const total = snapshot.document.blocks.length;
    if (renderBudget >= total) return;
    // 在帧回调里递增：effect 内同步 setState 会触发级联渲染（react-hooks/set-state-in-effect）。
    const frame = window.requestAnimationFrame(() => setRenderState({ tabId: activeTabId, budget: nextBlockRenderBudget(snapshot.document.blocks, renderBudget) }));
    return () => window.cancelAnimationFrame(frame);
  }, [activeTabId, renderBudget, snapshot.document.blocks]);

  const registerElement = useCallback((index: number, element: HTMLElement | null) => {
    if (element) blockElementsRef.current.set(index, element);
    else blockElementsRef.current.delete(index);
  }, []);

  // DOM 访问器与变更监听都在挂载后注入：渲染期读 ref 会触发 react-hooks/refs。
  useLayoutEffect(() => {
    setScrollRoot(surfaceRef.current);
    session.setAccessors({
      getSurface: () => surfaceRef.current,
      getBlockElement: (index) => blockElementsRef.current.get(index) ?? null,
    });
    session.setChangeListener(() => setSnapshot(session.getSnapshot()));
    return () => {
      session.setChangeListener(() => undefined);
      // 退出时兜底；模式、标签切换和保存已在 store 入口同步写回。
      session.flushWriteBack();
      session.setAccessors({
        getSurface: () => null,
        getBlockElement: () => null,
      });
    };
  }, [session]);

  // 控制器接管 store.editorView：工具栏、AI、状态栏、大纲随即生效。
  useEffect(() => {
    const controller = createWysiwygController({
      session,
      getScrollDOM: () => surfaceRef.current,
      getCaretRange: () => {
        const selection = window.getSelection();
        return selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
      },
      focus: () => session.focus(),
    });
    setEditorView(controller);
    markEditorBootReady();
    return () => {
      session.flushWriteBack();
      // 只有当 store 里仍指向自己时才清空，避免与源码对照模式的挂载竞争。
      if (useAppStore.getState().editorView === controller) setEditorView(null);
    };
  }, [markEditorBootReady, session, setEditorView]);

  // 外部内容变化（AI、时间线、切换标签）同步进会话。
  useEffect(() => {
    session.syncExternalSource(content);
  }, [content, session]);

  // 结构变化后恢复光标；子节点的 layout effect 先跑，此时 DOM 已是新内容。
  useLayoutEffect(() => {
    session.restoreCaretAfterRender();
  }, [session, snapshot?.version, renderBudget]);

  // 卸载前落盘，避免丢失最后一次输入。
  useEffect(() => () => session.flushWriteBack(), [session]);

  const handleBlockKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>, index: number) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const modified = event.ctrlKey || event.metaKey;
    if (modified && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      const editor = useAppStore.getState().editorView;
      if (!editor) return;
      const selection = editor.getSelection();
      let target = findInlineTargetAt(editor.getValue(), selection.from);
      if (target?.kind !== 'link') {
        const label = editor.getText(selection.from, selection.to) || '链接文字';
        editor.replaceRange(selection.from, selection.to, `[${label}](https://)`);
        target = findInlineTargetAt(editor.getValue(), selection.from + 1);
      }
      if (target?.kind === 'link') {
        const rect = event.currentTarget.getBoundingClientRect();
        setInlineTarget({ target, anchor: { left: rect.left, top: rect.top }, autoFocus: true });
      }
      return;
    }
    if (modified && !event.altKey && !event.shiftKey && /^[0-6]$/.test(event.key)) {
      event.preventDefault();
      session.handleHeadingLevel(Number(event.key));
      return;
    }
    if (modified && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'b') {
      event.preventDefault();
      wrapSelection('strong');
      return;
    }
    if (modified && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'i') {
      event.preventDefault();
      wrapSelection('em');
      return;
    }
    if (modified && !event.altKey && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) session.handleRedo();
      else session.handleUndo();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      if (session.handleEnter(index)) event.preventDefault();
      return;
    }
    if (event.key === 'Tab') {
      // contenteditable 里 Tab 默认会把焦点移走，必须自己接管。
      event.preventDefault();
      session.handleIndent(index, event.shiftKey ? 'outdent' : 'indent');
      return;
    }
    if (event.key === 'Backspace' && !event.nativeEvent.isComposing) {
      if (session.handleBackspace(index) || session.isCaretAtBlockStart(index)) event.preventDefault();
      return;
    }
    if (event.key === 'Delete' && !event.nativeEvent.isComposing) {
      // 与退格镜像：块尾的 Delete 把下一段吸进当前块（只吸不带块前缀的段落）。
      if (session.handleDelete(index)) event.preventDefault();
      return;
    }
    if (
      !modified && !event.altKey && !event.shiftKey && !event.nativeEvent.isComposing
      && event.key.startsWith('Arrow')
    ) {
      // 块是各自独立的 contenteditable，贴边时浏览器无处可去（块尾按 ↓ 原地不动），
      // 这里把光标交给相邻块；Shift/Alt/Ctrl 组合键是原生选择与按词移动，不能接管。
      const direction = event.key.slice(5).toLowerCase();
      if (direction === 'up' || direction === 'down' || direction === 'left' || direction === 'right') {
        if (session.handleArrow(index, direction)) event.preventDefault();
      }
      return;
    }
  }, [session]);

  // 点击行内结构（链接 / 公式 / 图片）：用点击位置反查源码目标，复用既有弹窗。
  // 返回值告诉块视图点击是否已被消化——未消化时只读块会改为进入就地源码编辑。
  const handleInlineClick = useCallback((event: React.MouseEvent<HTMLElement>): boolean => {
    if (window.getSelection()?.isCollapsed === false) return false;
    if (!(settings.editor.inline_popups ?? true)) return false;
    const displayMath = (event.target as Element).closest('.katex-block');
    if (displayMath) {
      const host = displayMath.closest<HTMLElement>('[data-block-index]');
      const block = session.getBlocks()[Number(host?.dataset.blockIndex)];
      const target = block ? findInlineTargetAt(session.getSource(), block.offset) : null;
      if (target?.kind === 'math') {
        setInlineTarget({ target, anchor: { left: event.clientX, top: event.clientY } });
        return true;
      }
    }
    const position = session.blockPositionOfEvent(event.nativeEvent);
    if (!position) return false;
    const target = findInlineTargetAt(useAppStore.getState().content, position.offset);
    if (!target) return false;
    const anchor = { left: event.clientX, top: event.clientY };
    if (target.kind === 'image') {
      setImageTarget({
        target,
        spec: {
          alt: target.alt?.text ?? '',
          src: target.src?.text ?? '',
          ...(target.title ? { title: target.title } : {}),
          ...(target.attrs ? { attributes: target.attrs } : {}),
        } as ImageSpec,
      });
      return true;
    }
    // contenteditable 里浏览器不会跟随链接：`Ctrl/Cmd+点击` 打开，普通点击进入编辑弹窗。
    if (target.kind === 'link' && (event.ctrlKey || event.metaKey)) {
      const url = target.url?.text ?? '';
      if (url) {
        event.preventDefault();
        openUrl(url);
      }
      return true;
    }
    setInlineTarget({ target, anchor });
    return true;
  }, [session, settings.editor.inline_popups]);

  const handleApplyBlockSource = useCallback((index: number, next: string) => {
    session.replaceBlock(index, next);
    session.focus();
  }, [session]);

  const handleEndSourceEditing = useCallback(() => { session.focus(); }, [session]);

  const handleInput = useCallback((index: number) => session.handleInput(index), [session]);
  const handleBlurBlock = useCallback((index: number, nextFocus: Node | null) => session.normalizeBlock(index, nextFocus), [session]);
  const handleCompositionChange = useCallback((composing: boolean, index: number) => session.markComposing(composing, index), [session]);
  const handleCommitCode = useCallback((index: number, code: string, language?: string) => { session.writeCodeBlock(index, code, language); }, [session]);
  const handleDeleteBlock = useCallback((index: number) => { session.deleteBlock(index); }, [session]);
  const handleInsertAfter = useCallback((index: number, kind: BlockInsertKind) => {
    const template = kind === 'table' ? insertTable(3, 3).text
      : kind === 'code' ? '```\n```'
      : kind === 'quote' ? '> '
      : kind === 'divider' ? '---'
      : '';
    session.insertBlockAfter(index, template);
    session.focus();
  }, [session]);

  const handleRetypeBlock = useCallback((index: number, target: BlockRetypeTarget) => {
    session.setBlockKind(index, target);
    session.focus();
  }, [session]);
  const handleMoveBlock = useCallback((from: number, to: number) => { session.moveBlock(from, to); }, [session]);
  const handleDuplicateBlock = useCallback((index: number) => { session.duplicateBlock(index); }, [session]);

  const blockDocument: WysiwygDocument = snapshot.document;
  const emptyDocument = blockDocument.source.trim().length === 0;

  return (
    <div
      className="wysiwyg-surface"
      ref={surfaceRef}
      spellCheck={settings.editor.spell_check}
      onBlur={() => session.flushWriteBack()}
      onClick={(event) => {
        // 块外的留白不是编辑宿主；点击后落到末尾的空段落。
        if (event.target !== event.currentTarget && !(event.target instanceof HTMLElement && event.target.classList.contains('wysiwyg-document'))) return;
        const blocks = session.getBlocks();
        const lastIndex = blocks.length - 1;
        const last = blocks[lastIndex];
        if (!last) return;
        const lastElement = blockElementsRef.current.get(lastIndex);
        if (lastElement && event.clientY < lastElement.getBoundingClientRect().bottom) return;
        if (last.kind === 'paragraph' && last.source.trim().length === 0) {
          session.setSelectionOffsets(last.offset);
          session.focus();
        } else {
          session.insertParagraphAfter(lastIndex);
        }
      }}
      onBeforeInput={(event) => {
        const type = (event.nativeEvent as InputEvent).inputType || '';
        // 浏览器自带的撤销会绕过我们的快照栈。
        if (type === 'historyUndo' || type === 'historyRedo') {
          event.preventDefault();
          if (type === 'historyUndo') session.handleUndo();
          else session.handleRedo();
          return;
        }
      }}
      onPaste={(event) => {
        if ((event.target as Element).closest('textarea,input')) return;
        if (session.handlePaste(event.nativeEvent)) event.preventDefault();
      }}
      onContextMenu={(event) => {
        // 与源码对照模式同一套右键菜单：先把光标挪到点击处（不在选区内时），
        // 菜单里的格式与表格动作才能作用在用户真正指向的位置。
        const position = session.blockPositionOfEvent(event.nativeEvent);
        const current = session.getSelectionOffsets();
        if (position && (current.from === current.to || position.offset < current.from || position.offset > current.to)) {
          session.setSelectionOffsets(position.offset);
        }
        const selection = session.getSelectionOffsets();
        const menuWidth = 336;
        const submenuWidth = 178;
        const menuHeight = 660;
        const x = Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8));
        const y = Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8));
        const index = session.blockIndexAtOffset(selection.to);
        const block = index === null ? null : session.getBlocks()[index];
        event.preventDefault();
        setContextMenu({
          x,
          y,
          submenuDirection: x + menuWidth + submenuWidth + 4 <= window.innerWidth ? 'right' : 'left',
          hasSelection: selection.from !== selection.to,
          canUndo: session.canUndo(),
          canRedo: session.canRedo(),
          inTable: block?.kind === 'table',
        });
      }}
      style={{ fontFamily: settings.appearance.font_family }}
    >
      <article className="wysiwyg-document preview-document markdown-body">
        {blockDocument.blocks.slice(0, renderBudget).map((block, index) => (
          <WysiwygBlockView
            key={`${index}:${block.kind}`}
            index={index}
            kind={block.kind}
            source={block.source}
            startLine={block.startLine}
            editable={block.editable}
            skipRender={snapshot.skipRenderIndex === index}
            renderRevision={snapshot.blockRenderRevisions.get(index) ?? 0}
            count={blockDocument.blocks.length}
            documentPath={currentFile}
            workflowViewerEnabled={settings.workflow?.render_in_preview !== false}
            scrollRoot={scrollRoot}
            theme={theme}
            registerElement={registerElement}
            onInput={handleInput}
            onKeyDown={handleBlockKeyDown}
            onBlurBlock={handleBlurBlock}
            onCompositionChange={handleCompositionChange}
            onCommitCode={handleCommitCode}
            onInlineClick={handleInlineClick}
            onApplyBlockSource={handleApplyBlockSource}
            onEndSourceEditing={handleEndSourceEditing}
            onDeleteBlock={handleDeleteBlock}
            onInsertAfter={handleInsertAfter}
            onMove={handleMoveBlock}
            onDuplicate={handleDuplicateBlock}
            onRetype={handleRetypeBlock}
          />
        ))}
      </article>
      {emptyDocument && (
        <div className="editor-empty-guide" aria-hidden="true">
          <AppIcon name="pen" size={20} />
          <strong>从一个想法开始</strong>
          <p>写下文字，让思路自然展开。</p>
          <div><span><kbd>/</kbd> 插入内容</span><span><kbd>{formatShortcut('Ctrl P')}</kbd> 切换文档</span></div>
        </div>
      )}
      <WysiwygChrome session={session} surface={scrollRoot} version={snapshot.version} pinned={Boolean(settings.editor.pin_toolbar)} />
      <ProofreadHighlights session={session} version={snapshot.version} renderedBlocks={renderBudget} />
      {contextMenu && (
        <EditorContextMenu
          state={contextMenu}
          onClose={() => setContextMenu(null)}
          onInsertImage={() => setImageInsertOpen(true)}
        />
      )}
      {imageInsertOpen && (
        <ImageOptionsModal
          onClose={() => setImageInsertOpen(false)}
          onInsert={(url, alt) => {
            setImageInsertOpen(false);
            const editor = useAppStore.getState().editorView;
            const selection = editor?.getSelection();
            if (!editor || !selection) return;
            editor.replaceRange(selection.from, selection.to, `![${alt ?? '图片'}](${url})`);
            editor.focus();
          }}
        />
      )}
      {imageTarget && (
        <ImagePropertiesModal
          spec={imageTarget.spec}
          onApply={(spec) => {
            session.replaceRange(imageTarget.target.from, imageTarget.target.to, imageSpecMarkdown(spec));
            setImageTarget(null);
          }}
          onClose={() => setImageTarget(null)}
        />
      )}
      {inlineTarget && (
        <InlinePopup
          target={inlineTarget.target}
          anchor={inlineTarget.anchor}
          autoFocus={inlineTarget.autoFocus ?? false}
          language={settings.appearance.language}
          onApply={(fields) => {
            session.replaceRange(inlineTarget.target.from, inlineTarget.target.to, inlineTargetMarkdown(inlineTarget.target, fields));
            setInlineTarget(null);
          }}
          onOpen={openUrl}
          onCopy={(text) => { void navigator.clipboard.writeText(text); }}
          onDelete={() => {
            session.replaceRange(inlineTarget.target.from, inlineTarget.target.to, '');
            setInlineTarget(null);
          }}
          onJumpToDefinition={() => {
            const definition = inlineTarget.target.definition;
            if (definition) session.setSelectionOffsets(definition.from);
            setInlineTarget(null);
          }}
          onClose={() => setInlineTarget(null)}
        />
      )}
    </div>
  );
}
