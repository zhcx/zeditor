import { AppIcon } from '../Icons/AppIcon';
import { useShallow } from 'zustand/react/shallow';
import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import 'katex/dist/katex.min.css';
import { useAppStore } from '../../stores/appStore';
import { findActiveSourceElement } from '../../utils/activeSourceLine';
import { findLocalHeadingTarget } from '../../utils/headingAnchors';
import { isWorkflowLikeFile } from '../../utils/workflowShape';
import {
  findImages,
  formatImageMarkdown,
  withImageSize,
  type ImageSpec,
} from '../../utils/imageSyntax';
import { ImagePropertiesModal } from '../Editor/ImagePropertiesModal';
import { open } from '@tauri-apps/plugin-shell';
import { toggleTaskLine } from '../../utils/taskList';
import { renderMarkdownToHtml } from '../../utils/markdownPipeline';
import { enhanceRenderedMarkdown } from '../../utils/markdownEnhancers';

// 工作流查看器（含 YAML 解析器）只在真的遇到工作流时加载，不进入首帧关键路径。
const WorkflowViewer = lazy(() => import('../WorkflowViewer/WorkflowViewer').then(m => ({ default: m.WorkflowViewer })));

interface PreviewProps {
  className?: string;
  style?: React.CSSProperties;
  onScrollContainerReady?: (element: HTMLDivElement | null) => void;
  onContentRendered?: () => void;
  activeEditorLine?: number;
  onSourceLineClick?: (lineNumber: number) => void;
}

export function Preview({ className, style, onScrollContainerReady, onContentRendered, activeEditorLine = 1, onSourceLineClick }: PreviewProps) {
  const containerRef = useRef<HTMLElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  // CSS variables handle normal Markdown theme changes without touching the
  // document tree. Mermaid SVGs bake their own colors, so only those need a
  // refresh when the theme changes.
  const resolvedThemeRef = useRef(document.documentElement.dataset.theme || 'vscode-dark');
  const contentRef = useRef('');
  const [mermaidThemeVersion, setMermaidThemeVersion] = useState(0);
  const [imageEditorIndex, setImageEditorIndex] = useState<number | null>(null);
  const [imageMenu, setImageMenu] = useState<{ x: number; y: number; index: number } | null>(null);
  // DOM 事件监听里需要 React 回调，用 ref 取最新实现，避免重建整个预览。
  const imageInteractionRef = useRef<{
    openEditor: (index: number) => void;
    openMenu: (event: MouseEvent, index: number) => void;
  }>({ openEditor: () => {}, openMenu: () => {} });
  const { content, settings, currentFile } = useAppStore(useShallow(state => ({ content: state.content, settings: state.settings, currentFile: state.currentFile })));
  const workflowViewerEnabled = settings.workflow?.render_in_preview !== false;
  // Markdown parsing, sanitization and DOM replacement are comparatively
  // expensive. Deferring them keeps Monaco's keystroke updates responsive.
  const deferredContent = useDeferredValue(content);
  const isEmpty = content.trim().length === 0;

  useEffect(() => {
    onScrollContainerReady?.(cardRef.current);
    return () => onScrollContainerReady?.(null);
  }, [onScrollContainerReady]);

  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  // 内联工作流图里的「跳转」需要最新的回调，用 ref 取用避免重建整个预览。
  const workflowJumpRef = useRef(onSourceLineClick);
  useEffect(() => {
    workflowJumpRef.current = onSourceLineClick;
  }, [onSourceLineClick]);

  useEffect(() => {
    const handleThemeChange = (event: Event) => {
      resolvedThemeRef.current = (event as CustomEvent<string>).detail;

      // Avoid reparsing the entire preview on every theme switch. A full
      // render remains necessary only when rendered Mermaid SVG needs new
      // theme colors.
      if (/```mermaid(?:\s|$)/i.test(contentRef.current)) {
        setMermaidThemeVersion((version) => version + 1);
      }
    };

    window.addEventListener('zeditor-theme-change', handleThemeChange);
    return () => window.removeEventListener('zeditor-theme-change', handleThemeChange);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    imageInteractionRef.current = {
      openEditor: (index) => setImageEditorIndex(index),
      openMenu: (event, index) => setImageMenu({ x: event.clientX, y: event.clientY, index }),
    };

    // 渲染与增强都在共享管线里：与所见即所得模式共用同一套规则。
    container.innerHTML = renderMarkdownToHtml(deferredContent);
    onContentRendered?.();

    return enhanceRenderedMarkdown(container, {
      scrollRoot: cardRef.current,
      source: deferredContent,
      documentPath: currentFile,
      workflowViewerEnabled,
      theme: resolvedThemeRef.current,
      onContentRendered,
      onJumpToLine: (line) => workflowJumpRef.current?.(line),
      onOpenImageEditor: (index) => imageInteractionRef.current.openEditor(index),
      onOpenImageMenu: (event, index) => imageInteractionRef.current.openMenu(event, index),
    });
  }, [deferredContent, mermaidThemeVersion, onContentRendered, currentFile, workflowViewerEnabled]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const activeElement = findActiveSourceElement(container, activeEditorLine);
    activeElement?.classList.add('is-active-source-block');

    return () => activeElement?.classList.remove('is-active-source-block');
  }, [activeEditorLine, deferredContent, mermaidThemeVersion]);

  const handleSourceClick = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const clickedElement = event.target instanceof Element ? event.target : null;

    // 播放器自己处理播放、进度与音量点击，预览不再抢走这些操作。
    if (clickedElement?.closest('video, audio')) return;

    // 任务列表交互：点击预览区 checkbox 直接切换编辑器源码中的 [ ] ↔ [x]
    if (clickedElement instanceof HTMLInputElement && clickedElement.matches('input.task-list-item-checkbox')) {
      event.preventDefault();
      const listItem = clickedElement.closest<HTMLElement>('li.task-list-item[data-source-line]');
      const lineNumber = Number(listItem?.dataset.sourceLine);
      const editor = useAppStore.getState().editorView;
      if (Number.isInteger(lineNumber) && lineNumber > 0 && editor
        && editor.getValue() === deferredContent && lineNumber <= editor.state.doc.lines) {
        const line = editor.line(lineNumber);
        // click 发生时浏览器已经切换 checked，源码才是可靠的当前状态。
        const toggled = toggleTaskLine(line.text);
        if (toggled !== line.text) {
          editor.replaceRange(line.from, line.to, toggled);
        }
        return;
      }
      return;
    }

    const localLink = clickedElement?.closest<HTMLAnchorElement>('a[href^="#"]');
    const container = containerRef.current;
    if (localLink && container) {
      const destination = findLocalHeadingTarget(container, localLink.getAttribute('href') || '');
      if (destination) {
        event.preventDefault();
        destination.scrollIntoView({ block: 'start' });
        const destinationLine = Number(destination.dataset.sourceLine);
        if (Number.isFinite(destinationLine) && destinationLine > 0) onSourceLineClick?.(destinationLine);
        return;
      }
    }

    // External links must open in the system browser. Letting the webview
    // follow them would navigate the whole application away from the document.
    const externalLink = clickedElement?.closest<HTMLAnchorElement>('a[href]');
    if (externalLink) {
      const rawHref = externalLink.getAttribute('href') || '';
      if (rawHref && !rawHref.startsWith('#')) {
        event.preventDefault();
        let url: string;
        try {
          url = new URL(rawHref, window.location.href).href;
        } catch {
          url = rawHref;
        }
        if ('__TAURI_INTERNALS__' in window) {
          void open(url).catch(() => window.open(url, '_blank', 'noopener,noreferrer'));
        } else {
          window.open(url, '_blank', 'noopener,noreferrer');
        }
        return;
      }
    }

    const target = clickedElement
      ? clickedElement.closest<HTMLElement>('[data-source-line]')
      : null;
    const lineNumber = Number(target?.dataset.sourceLine);
    if (Number.isFinite(lineNumber) && lineNumber > 0) onSourceLineClick?.(lineNumber);
  }, [onSourceLineClick, deferredContent]);

  const documentImages = useMemo(() => findImages(content), [content]);
  const editingImage = imageEditorIndex !== null ? documentImages[imageEditorIndex] ?? null : null;
  const menuImage = imageMenu ? documentImages[imageMenu.index] ?? null : null;
  const imageMenuIndex = imageMenu?.index ?? null;

  // 图片编辑始终基于最新源码：DOM 事件里的下标只在本次渲染内有效。
  const applyImageSpec = useCallback((index: number, spec: ImageSpec) => {
    const store = useAppStore.getState();
    const editor = store.editorView;
    const match = findImages(store.content)[index];
    if (!editor || !match) return;
    editor.replaceRange(match.from, match.to, formatImageMarkdown(spec));
    editor.focus();
  }, []);

  const resizeImage = useCallback((index: number, width?: number) => {
    const match = findImages(useAppStore.getState().content)[index];
    if (!match) return;
    applyImageSpec(index, withImageSize({
      alt: match.alt,
      src: match.src,
      ...(match.title ? { title: match.title } : {}),
    }, width));
  }, [applyImageSpec]);

  const deleteImage = useCallback((index: number) => {
    const store = useAppStore.getState();
    const editor = store.editorView;
    const match = findImages(store.content)[index];
    if (!editor || !match) return;
    // 图片独占一行时连行一起删除，避免留下一行空白。
    const line = editor.lineAt(match.from);
    const aloneOnLine = line.text.trim() === match.raw.trim();
    editor.replaceRange(
      aloneOnLine ? line.from : match.from,
      aloneOnLine ? Math.min(line.to + 1, editor.getValue().length) : match.to,
      '',
    );
    editor.focus();
  }, []);

  useEffect(() => {
    if (!imageMenu) return undefined;
    const close = () => setImageMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [imageMenu]);

  const containerStyle: React.CSSProperties = {
    fontFamily: settings.appearance.font_family,
    fontSize: 'var(--font-content-size)',
    lineHeight: settings.appearance.line_height,
  };

  // 独立的工作流文件（`.github/workflows/*.yml` 或内容可识别为工作流的 YAML）：
  // 右侧预览区直接给依赖图与结构化编辑器，左侧编辑器仍然是源码本身，
  // 形成与参考实现一致的分屏工作流视图。
  if (workflowViewerEnabled && isWorkflowLikeFile(currentFile, content)) {
    return (
      <div
        className={`preview-container preview-container-workflow ${className || ''}`}
        style={{ ...containerStyle, ...style }}
      >
        <div ref={cardRef} className="preview-card preview-card-workflow">
          <Suspense fallback={<div className="workflow-viewer-loading">正在加载工作流查看器…</div>}>
            <WorkflowViewer
              source={content}
              editable
              title={currentFile ?? undefined}
              preserveFormat={settings.workflow?.preserve_format !== false}
              onApply={(nextSource) => {
                const editor = useAppStore.getState().editorView;
                if (!editor) return;
                // 结构化编辑的结果写回编辑器，形成一次可撤销的编辑，
                // 由用户按 Ctrl+S 决定何时落盘。
                editor.replaceRange(0, editor.getValue().length, nextSource);
              }}
              onJumpToLine={(line) => {
                const editor = useAppStore.getState().editorView;
                if (!editor) return;
                const target = Math.max(1, Math.min(line, editor.state.doc.lines));
                const info = editor.line(target);
                editor.setSelection(info.from);
                editor.revealOffset(info.from);
                editor.focus();
              }}
            />
          </Suspense>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`preview-container ${className || ''}`}
      style={{ ...containerStyle, ...style }}
    >
      <div ref={cardRef} className={`preview-card ${isEmpty ? 'is-empty' : ''}`}>
        <article ref={containerRef} className="preview-document markdown-body" onClick={handleSourceClick} />
        {isEmpty && (
          <div className="preview-empty-state">
            <span className="preview-empty-mark" aria-hidden="true"><AppIcon name="arrowUpRight" size={16} /></span>
            <strong>预览将在这里显示</strong>
            <span>开始写作后，这里会呈现舒适的阅读排版。</span>
          </div>
        )}
      </div>
      {imageMenu && menuImage && imageMenuIndex !== null && (
        <div
          className="preview-image-menu"
          role="menu"
          aria-label="图片操作"
          style={{
            left: Math.max(8, Math.min(imageMenu.x, window.innerWidth - 180)),
            top: Math.max(8, Math.min(imageMenu.y, window.innerHeight - 230)),
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button type="button" role="menuitem" onClick={() => { resizeImage(imageMenuIndex, 240); setImageMenu(null); }}>小 (240px)</button>
          <button type="button" role="menuitem" onClick={() => { resizeImage(imageMenuIndex, 420); setImageMenu(null); }}>中 (420px)</button>
          <button type="button" role="menuitem" onClick={() => { resizeImage(imageMenuIndex, 640); setImageMenu(null); }}>大 (640px)</button>
          <button type="button" role="menuitem" onClick={() => { resizeImage(imageMenuIndex, undefined); setImageMenu(null); }}>原始尺寸</button>
          <div className="preview-image-menu-divider" role="separator" />
          <button type="button" role="menuitem" onClick={() => { setImageEditorIndex(imageMenuIndex); setImageMenu(null); }}>编辑属性…</button>
          <button type="button" role="menuitem" onClick={() => { void navigator.clipboard.writeText(menuImage.src); setImageMenu(null); }}>复制路径</button>
          <button type="button" role="menuitem" className="is-danger" onClick={() => { deleteImage(imageMenuIndex); setImageMenu(null); }}>删除图片</button>
        </div>
      )}
      {editingImage && (
        <ImagePropertiesModal
          spec={editingImage}
          onApply={(spec) => {
            if (imageEditorIndex !== null) applyImageSpec(imageEditorIndex, spec);
            setImageEditorIndex(null);
          }}
          onClose={() => setImageEditorIndex(null)}
        />
      )}
    </div>
  );
}
