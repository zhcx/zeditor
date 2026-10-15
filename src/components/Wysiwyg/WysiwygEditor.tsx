import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { open as openExternal } from '@tauri-apps/plugin-shell';
import { useAppStore } from '../../stores/appStore';
import { useAIStore } from '../../stores/aiStore';
import { renderMarkdownSource } from '../../utils/markdownPipeline';
import { sanitizeRenderedHtml } from '../../utils/safeHtml';
import { enhanceRenderedMarkdown } from '../../utils/markdownEnhancers';
import type { WysiwygBlockKind, WysiwygDocument } from '../../utils/wysiwyg/blocks';
import { extractFenceCode, extractFenceLanguage } from '../../utils/wysiwyg/codeFence';
import { findInlineTargetAt, type InlineTarget } from '../../utils/inlineTargets';
import type { ImageSpec } from '../../utils/imageSyntax';
import { ImagePropertiesModal } from '../Editor/ImagePropertiesModal';
import { InlinePopup } from '../Editor/InlinePopup';
import { WysiwygSession, type WysiwygSessionSnapshot } from './wysiwygSession';
import { createWysiwygController } from './WysiwygController';
import { WysiwygCodeBlock } from './WysiwygCodeBlock';
import { BlockActions } from './BlockActions';
import { SourcePopup } from './SourcePopup';
import { imageSpecMarkdown, inlineTargetMarkdown } from './inlineEditing';

/** 渲染结果按「块类型 + 块源码」缓存：只有被编辑的块需要重新渲染。 */
const blockHtmlCache = new Map<string, string>();
/** 缓存上界：长文档连续编辑会不断产生新键，超限直接整体丢弃，避免内存无界增长。 */
const BLOCK_HTML_CACHE_LIMIT = 600;

function renderBlockHtml(kind: WysiwygBlockKind, source: string): string {
  const key = `${kind}\u0000${source}`;
  const cached = blockHtmlCache.get(key);
  if (cached !== undefined) return cached;
  if (blockHtmlCache.size >= BLOCK_HTML_CACHE_LIMIT) blockHtmlCache.clear();
  const html = sanitizeRenderedHtml(renderMarkdownSource(source));
  blockHtmlCache.set(key, html);
  return html;
}

function sourcePopupTitle(kind: WysiwygBlockKind): string {
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
  documentPath: string | null;
  workflowViewerEnabled: boolean;
  scrollRoot: HTMLElement | null;
  theme: string;
  registerElement: (index: number, element: HTMLElement | null) => void;
  onInput: (index: number) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>, index: number) => void;
  onBlurBlock: (index: number) => void;
  onCompositionChange: (composing: boolean) => void;
  onCommitCode: (index: number, code: string, language?: string) => void;
  onInlineClick: (event: React.MouseEvent<HTMLElement>) => void;
  onEditSource: (index: number) => void;
  onDeleteBlock: (index: number) => void;
  onInsertAfter: (index: number) => void;
}

const WysiwygBlockView = memo(function WysiwygBlockView({
  index, kind, source, startLine, editable, skipRender, documentPath, workflowViewerEnabled,
  scrollRoot, theme, registerElement, onInput, onKeyDown, onBlurBlock, onCompositionChange,
  onCommitCode, onInlineClick, onEditSource, onDeleteBlock, onInsertAfter,
}: WysiwygBlockViewProps) {
  const hostRef = useRef<HTMLElement>(null);

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
    if (!host) return undefined;
    // 由用户输入触发的写回：DOM 就是最新的，重建反而会丢光标。
    if (skipRender) return undefined;
    host.innerHTML = renderBlockHtml(kind, source);
    return enhanceRenderedMarkdown(host, {
      scrollRoot,
      source,
      documentPath,
      workflowViewerEnabled,
      theme,
      // 回写要保留原始图片语法：解析失败时不要把 <img> 换成提示文本。
      keepUnresolvedImages: true,
    });
  }, [documentPath, kind, scrollRoot, skipRender, source, theme, workflowViewerEnabled]);

  return (
    <div className="wysiwyg-block-shell">
      <section
        ref={hostRef}
        className={`wysiwyg-block ${editable ? 'is-editable' : 'is-readonly'}`}
        data-block-index={index}
        data-block-kind={kind}
        data-source-line={startLine}
        contentEditable={editable}
        suppressContentEditableWarning
        spellCheck={false}
        onInput={() => onInput(index)}
        onKeyDown={(event) => onKeyDown(event, index)}
        onBlur={() => onBlurBlock(index)}
        onCompositionStart={() => onCompositionChange(true)}
        onCompositionEnd={() => onCompositionChange(false)}
        onClick={onInlineClick}
      />
      {kind === 'fence' && (
        <WysiwygCodeBlock
          index={index}
          code={extractFenceCode(source)}
          language={extractFenceLanguage(source)}
          onCommit={onCommitCode}
        />
      )}
      <BlockActions
        index={index}
        kind={kind}
        editable={editable}
        onEditSource={onEditSource}
        onDelete={onDeleteBlock}
        onInsertAfter={onInsertAfter}
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
  if (!('__TAURI_INTERNALS__' in window) || !useAppStore.getState().currentFile) return false;
  const dataUrl = await fileAsDataUrl(file);
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
  const { content, currentFile, settings, markEditorBootReady, setEditorView } = useAppStore(useShallow(state => ({
    content: state.content,
    currentFile: state.currentFile,
    settings: state.settings,
    markEditorBootReady: state.markEditorBootReady,
    setEditorView: state.setEditorView,
  })));
  const surfaceRef = useRef<HTMLDivElement>(null);
  const blockElementsRef = useRef(new Map<number, HTMLElement>());
  const [scrollRoot, setScrollRoot] = useState<HTMLElement | null>(null);
  const theme = document.documentElement.dataset.theme || 'vscode-dark';

  // 会话只建一次；它是普通对象，不受 React 状态更新影响。放在 useState 里而不是
  // useRef 里，是因为 react-hooks/refs 禁止在渲染期读 ref。
  const [session] = useState(() => new WysiwygSession(useAppStore.getState().content, {
    getTabId: () => useAppStore.getState().activeTabId,
    insertClipboardImage,
  }));
  const [snapshot, setSnapshot] = useState<WysiwygSessionSnapshot>(() => session.getSnapshot());
  const [sourcePopup, setSourcePopup] = useState<{ index: number; title: string } | null>(null);
  const [imageTarget, setImageTarget] = useState<{ target: InlineTarget; spec: ImageSpec } | null>(null);
  const [inlineTarget, setInlineTarget] = useState<{ target: InlineTarget; anchor: { left: number; top: number } } | null>(null);

  const registerElement = useCallback((index: number, element: HTMLElement | null) => {
    if (element) blockElementsRef.current.set(index, element);
    else blockElementsRef.current.delete(index);
  }, []);

  // DOM 访问器与变更监听都在挂载后注入：渲染期读 ref 会触发 react-hooks/refs。
  useEffect(() => {
    setScrollRoot(surfaceRef.current);
    session.setAccessors({
      getSurface: () => surfaceRef.current,
      getBlockElement: (index) => blockElementsRef.current.get(index) ?? null,
    });
    session.setChangeListener(() => setSnapshot(session.getSnapshot()));
    return () => {
      session.setChangeListener(() => undefined);
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
      focus: () => surfaceRef.current?.focus(),
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
  }, [session, snapshot?.version]);

  // 查找替换在所见即所得下不可用：引导用户切回源码对照模式。
  useEffect(() => {
    const onFindRequest = () => {
      useAIStore.getState().setStatus('error', '查找替换在源码对照模式下可用：按 Ctrl+Alt+M 切回后再试');
    };
    window.addEventListener('zeditor-editor-find', onFindRequest);
    return () => window.removeEventListener('zeditor-editor-find', onFindRequest);
  }, []);

  // 卸载前落盘，避免丢失最后一次输入。
  useEffect(() => () => session.flushWriteBack(), [session]);

  const handleBlockKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>, index: number) => {
    const modified = event.ctrlKey || event.metaKey;
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
    if (event.key === 'Delete' && !event.nativeEvent.isComposing && session.isCaretAtBlockEnd(index)) {
      // 块尾的删除不跨块合并：跨块合并会破坏块结构，留给后续评估。
      event.preventDefault();
    }
  }, [session]);

  // 点击行内结构（链接 / 公式 / 图片）：用点击位置反查源码目标，复用既有弹窗。
  const handleInlineClick = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (!(settings.editor.inline_popups ?? true)) return;
    const position = session.blockPositionOfEvent(event.nativeEvent);
    if (!position) return;
    const target = findInlineTargetAt(useAppStore.getState().content, position.offset);
    if (!target) return;
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
      return;
    }
    // 链接保留浏览器行为（外部链接由系统浏览器打开），只对公式 / 脚注 / Wiki 弹编辑窗。
    if (target.kind === 'link') return;
    setInlineTarget({ target, anchor });
  }, [session, settings.editor.inline_popups]);

  const handleEditSource = useCallback((index: number) => {
    const block = session.getBlocks()[index];
    setSourcePopup({ index, title: sourcePopupTitle(block?.kind ?? 'other') });
  }, [session]);

  const blockDocument: WysiwygDocument = snapshot.document;
  const blockKeys = useMemo(
    () => blockDocument.blocks.map((block, index) => `${index}:${block.kind}`),
    [blockDocument],
  );
  const isEmpty = blockDocument.blocks.length === 0;
  const popupBlock = sourcePopup ? blockDocument.blocks[sourcePopup.index] ?? null : null;

  return (
    <div
      className="wysiwyg-surface"
      ref={surfaceRef}
      contentEditable
      suppressContentEditableWarning
      spellCheck={settings.editor.spell_check}
      onBlur={() => session.flushWriteBack()}
      onBeforeInput={(event) => {
        const type = (event.nativeEvent as InputEvent).inputType || '';
        // 浏览器自带的撤销会绕过我们的快照栈。
        if (type === 'historyUndo' || type === 'historyRedo') {
          event.preventDefault();
          if (type === 'historyUndo') session.handleUndo();
          else session.handleRedo();
          return;
        }
        // 根节点本身不是编辑面：落在根上的输入会让文本游离在块外。
        if (event.target === surfaceRef.current) event.preventDefault();
      }}
      onPaste={(event) => {
        if (session.handlePaste(event.nativeEvent)) event.preventDefault();
      }}
      style={{ fontFamily: settings.appearance.font_family }}
    >
      <article className="wysiwyg-document preview-document markdown-body">
        {blockDocument.blocks.map((block, index) => (
          <WysiwygBlockView
            key={blockKeys[index]}
            index={index}
            kind={block.kind}
            source={block.source}
            startLine={block.startLine}
            editable={block.editable}
            skipRender={snapshot.skipRenderIndex === index}
            documentPath={currentFile}
            workflowViewerEnabled={settings.workflow?.render_in_preview !== false}
            scrollRoot={scrollRoot}
            theme={theme}
            registerElement={registerElement}
            onInput={(position) => session.handleInput(position)}
            onKeyDown={handleBlockKeyDown}
            onBlurBlock={(position) => session.normalizeBlock(position)}
            onCompositionChange={(composing) => session.markComposing(composing)}
            onCommitCode={(position, code, language) => { session.writeCodeBlock(position, code, language); }}
            onInlineClick={handleInlineClick}
            onEditSource={handleEditSource}
            onDeleteBlock={(position) => session.deleteBlock(position)}
            onInsertAfter={(position) => session.insertParagraphAfter(position)}
          />
        ))}
      </article>
      {isEmpty && (
        <div className="wysiwyg-empty-state">
          <strong>开始写作</strong>
          <span>输入内容即可看到排版结果，Markdown 标记会自动隐藏。</span>
        </div>
      )}
      {sourcePopup && popupBlock && (
        <SourcePopup
          title={sourcePopup.title}
          source={popupBlock.source}
          onApply={(next) => {
            session.replaceBlock(sourcePopup.index, next);
            setSourcePopup(null);
            surfaceRef.current?.focus();
          }}
          onClose={() => {
            setSourcePopup(null);
            surfaceRef.current?.focus();
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
          autoFocus={false}
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
