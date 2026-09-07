import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import 'monaco-editor/esm/nls.messages.zh-cn.js';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution';
import MarkdownIt from 'markdown-it';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore, type Settings } from '../../stores/appStore';
import { useAIStore, type ProofreadResult } from '../../stores/aiStore';
import type { EditorController, EditorDispatchSpec, EditorLine } from '../../types/editor';
import { EDITOR_OVERFLOW_OPTIONS, EDITOR_UNICODE_HIGHLIGHT_OPTIONS } from '../../utils/editorLayout';
import { contentFontStack } from '../../utils/appearanceSettings';
import { DocumentSessions, sameDocument } from '../../utils/documentSafety';
import { filterSlashCommands, findSlashCommandTrigger, type SlashCommand } from '../../utils/slashCommands';
import { SlashCommandMenu, type SlashMenuAnchor } from './SlashCommandMenu';
import { ImageOptionsModal, Toolbar } from '../Toolbar/Toolbar';
import { normalizeLanguage, t } from '../../i18n';
import { sanitizeRenderedHtml } from '../../utils/safeHtml';

(self as typeof self & { MonacoEnvironment: { getWorker: () => Worker } }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

interface EditorProps {
  className?: string;
  style?: React.CSSProperties;
  onActiveLineChange?: (lineNumber: number) => void;
  onActiveLineReveal?: (lineNumber: number) => void;
}

const MIN_AUTO_COMPANION_CHARS = 6;
const AUTO_COMPANION_CONTEXT_LIMIT = 800;
const AUTO_COMPANION_MIN_INTERVAL = 1200;

interface SlashMenuState {
  from: number;
  to: number;
  query: string;
  anchor: SlashMenuAnchor;
}

interface EditorContextMenuState {
  x: number;
  y: number;
  submenuDirection: 'left' | 'right';
  hasSelection: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

const contextMenuMarkdown = new MarkdownIt({ html: true, breaks: true, linkify: true, typographer: true });

interface SelectionToolbarState {
  left: number;
  top: number;
  width: number;
  placement: 'above' | 'below';
}

type ContextMenuIconName = 'sparkles' | 'translate' | 'copy' | 'copyAs' | 'paste' | 'text' | 'pdf' | 'document' | 'code' | 'image' | 'folder' | 'undo' | 'redo' | 'select';

function ContextMenuIcon({ name }: { name: ContextMenuIconName }) {
  if (name === 'sparkles') return <svg viewBox="0 0 18 18"><path d="m6.2 2 .7 2.1L9 5l-2.1.8-.7 2.1-.8-2.1L3.3 5l2.1-.9zM12.3 7.2l.9 2.5 2.5.9-2.5.9-.9 2.5-.9-2.5-2.5-.9 2.5-.9z" /></svg>;
  if (name === 'translate') return <svg viewBox="0 0 18 18"><circle cx="9" cy="9" r="6.5" /><path d="M2.5 9h13M9 2.5c1.7 1.8 2.6 4 2.6 6.5S10.7 13.7 9 15.5C7.3 13.7 6.4 11.5 6.4 9S7.3 4.3 9 2.5Z" /></svg>;
  if (name === 'copy') return <svg viewBox="0 0 18 18"><rect x="5.2" y="3.2" width="9" height="11.5" rx="1.5" /><path d="M3.4 12V5.3c0-1 .8-1.8 1.8-1.8" /></svg>;
  if (name === 'copyAs') return <svg viewBox="0 0 18 18"><rect x="5.2" y="4" width="8.8" height="11" rx="1.4" /><path d="M3.2 12V4.8C3.2 3.8 4 3 5 3M15.5 7.2l1.8 1.8-1.8 1.8" /></svg>;
  if (name === 'paste') return <svg viewBox="0 0 18 18"><path d="M6.2 3.7h-2v11h8.6v-2.1" /><rect x="6.2" y="2.5" width="6.5" height="9" rx="1.3" /><path d="M8 2.5V1.4h3v1.1" /></svg>;
  if (name === 'text') return <svg viewBox="0 0 18 18"><path d="M2.4 6.2h5.2M5 6.2v6M10 6.2h5.6M12.8 6.2v6M10.6 12h4.4" /></svg>;
  if (name === 'pdf') return <svg viewBox="0 0 18 18"><path d="M4 1.8h6l3.5 3.5v10.9H4zM10 1.8v3.5h3.5" /><path d="M5.5 12.8h1.2c1.4 0 1.4-2.3 0-2.3H5.5v4M8.7 14.5v-4h1c1.7 0 1.7 4 0 4zM12 14.5v-4h2" /></svg>;
  if (name === 'document') return <svg viewBox="0 0 18 18"><path d="M4 1.8h6l3.5 3.5v10.9H4zM10 1.8v3.5h3.5M6.2 8.3h5.2M6.2 11h5.2M6.2 13.7h3.5" /></svg>;
  if (name === 'code') return <svg viewBox="0 0 18 18"><path d="m6.4 4-4 5 4 5M11.6 4l4 5-4 5M10.2 2.8 7.8 15.2" /></svg>;
  if (name === 'image') return <svg viewBox="0 0 18 18"><rect x="2.4" y="2.8" width="13.2" height="12.4" rx="1.4" /><circle cx="6.2" cy="6.7" r="1.2" /><path d="m3.5 13.5 3.6-3.8 2.5 2.4 2.1-2.2 2.8 3.1" /></svg>;
  if (name === 'folder') return <svg viewBox="0 0 18 18"><path d="M2 5.2h5l1.3 1.5H16v7.8H2zM2 5.2V3.5h5l1.3 1.7" /></svg>;
  if (name === 'undo') return <svg viewBox="0 0 18 18"><path d="M6.5 5 3 8.5 6.5 12M3.4 8.5h6.2c3 0 4.8 1.6 4.8 4.3" /></svg>;
  if (name === 'redo') return <svg viewBox="0 0 18 18"><path d="m11.5 5 3.5 3.5-3.5 3.5M14.6 8.5H8.4c-3 0-4.8 1.6-4.8 4.3" /></svg>;
  return <svg viewBox="0 0 18 18"><path d="M3 4h12M3 9h12M3 14h12" /></svg>;
}

const isTauriRuntime = () => '__TAURI_INTERNALS__' in window;

function imageHostConfigured(settings: Settings) {
  const hosting = settings.image_hosting;
  switch (hosting.active_service) {
    case 'local': return Boolean(hosting.local.save_directory.trim());
    case 'picgo': return Boolean(hosting.picgo.server_url.trim());
    case 'cloudinary': return Boolean(hosting.cloudinary.cloud_name.trim() && hosting.cloudinary.api_key.trim() && hosting.cloudinary.api_secret.trim());
    case 's3': return Boolean(hosting.s3.endpoint.trim() && hosting.s3.bucket.trim() && hosting.s3.access_key.trim() && hosting.s3.secret_key.trim());
    default: return false;
  }
}

function offsetToPosition(model: monaco.editor.ITextModel, offset: number) {
  return model.getPositionAt(Math.max(0, Math.min(offset, model.getValueLength())));
}

function toLine(model: monaco.editor.ITextModel, lineNumber: number): EditorLine {
  const safeLine = Math.max(1, Math.min(lineNumber, model.getLineCount()));
  return {
    number: safeLine,
    from: model.getOffsetAt({ lineNumber: safeLine, column: 1 }),
    to: model.getOffsetAt({ lineNumber: safeLine, column: model.getLineMaxColumn(safeLine) }),
    text: model.getLineContent(safeLine),
  };
}

function createController(editor: monaco.editor.IStandaloneCodeEditor, model: monaco.editor.ITextModel, root: HTMLElement): EditorController {
  const getSelection = () => {
    const selection = editor.getSelection();
    if (!selection) return { from: 0, to: 0, empty: true };
    const from = model.getOffsetAt(selection.getStartPosition());
    const to = model.getOffsetAt(selection.getEndPosition());
    return { from, to, empty: from === to };
  };

  const setSelection = (from: number, to = from) => {
    const start = offsetToPosition(model, from);
    const end = offsetToPosition(model, to);
    editor.setSelection(new monaco.Selection(start.lineNumber, start.column, end.lineNumber, end.column));
  };

  const applyDispatch = (spec: EditorDispatchSpec) => {
    const change = spec?.changes;
    if (change && typeof change.from === 'number') {
      const text = change.insert ?? '';
      editor.executeEdits('zeditor', [{ range: monaco.Range.fromPositions(offsetToPosition(model, change.from), offsetToPosition(model, change.to ?? change.from)), text, forceMoveMarkers: true }]);
    }
    const selected = spec?.selection?.main || spec?.selection;
    const anchor = selected?.anchor ?? selected?.from;
    const head = selected?.head ?? selected?.to ?? anchor;
    if (typeof anchor === 'number') setSelection(anchor, head);
    if (spec?.scrollIntoView && typeof anchor === 'number') editor.revealPositionInCenter(offsetToPosition(model, anchor));
  };

  const controller = {
    scrollDOM: root.querySelector<HTMLElement>('.monaco-scrollable-element.editor-scrollable') || root,
    getScrollTop: () => editor.getScrollTop(),
    getScrollHeight: () => editor.getScrollHeight(),
    getClientHeight: () => editor.getLayoutInfo().height,
    getTopForLineNumber: (lineNumber: number) => editor.getTopForLineNumber(
      Math.max(1, Math.min(lineNumber, model.getLineCount())),
    ),
    setScrollTop: (top: number) => editor.setScrollTop(top, monaco.editor.ScrollType.Immediate),
    onScroll: (listener: () => void) => {
      const disposable = editor.onDidScrollChange((event) => {
        if (event.scrollTopChanged || event.scrollHeightChanged) listener();
      });
      return () => disposable.dispose();
    },
    getValue: () => model.getValue(),
    getSelection,
    getText: (from, to) => model.getValueInRange(monaco.Range.fromPositions(offsetToPosition(model, from), offsetToPosition(model, to))),
    replaceRange: (from, to, text, selection) => {
      editor.executeEdits('zeditor', [{ range: monaco.Range.fromPositions(offsetToPosition(model, from), offsetToPosition(model, to)), text, forceMoveMarkers: true }]);
      if (selection) setSelection(selection.from, selection.to);
    },
    setSelection,
    lineAt: (offset) => toLine(model, offsetToPosition(model, offset).lineNumber),
    line: (lineNumber) => toLine(model, lineNumber),
    coordsAtPos: (offset) => {
      const position = offsetToPosition(model, offset);
      const visible = editor.getScrolledVisiblePosition(position);
      const node = editor.getDomNode();
      if (!visible || !node) return null;
      const rect = node.getBoundingClientRect();
      const left = rect.left + visible.left;
      const bottom = rect.top + visible.top + visible.height;
      return { left, bottom, x: left, y: bottom };
    },
    focus: () => editor.focus(),
    undo: () => editor.trigger('zeditor', 'undo', null),
    redo: () => editor.trigger('zeditor', 'redo', null),
    revealOffset: (offset) => editor.revealPositionInCenter(offsetToPosition(model, offset)),
    dispatch: applyDispatch,
  } as EditorController;

  Object.defineProperty(controller, 'state', {
    enumerable: true,
    get: () => ({
      selection: { main: getSelection() },
      sliceDoc: (from: number, to: number) => controller.getText(from, to),
      doc: {
        length: model.getValueLength(),
        lines: model.getLineCount(),
        lineAt: (offset: number) => controller.lineAt(offset),
        line: (lineNumber: number) => controller.line(lineNumber),
      },
      update: (spec: unknown) => spec,
    }),
  });
  return controller;
}

async function fileAsDataUrl(file: File) {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

const documentModels = new DocumentSessions<monaco.editor.ITextModel>();

export function Editor({ className, style, onActiveLineChange, onActiveLineReveal }: EditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const monacoRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<monaco.editor.ITextModel | null>(null);
  const controllerRef = useRef<EditorController | null>(null);
  const decorationIdsRef = useRef<string[]>([]);
  const autoCompanionTimerRef = useRef<number | null>(null);
  const autoCompanionLastPromptRef = useRef('');
  const autoCompanionLastRequestAtRef = useRef(0);
  const slashMenuRef = useRef<SlashMenuState | null>(null);
  const slashSelectedIndexRef = useRef(0);
  const [slashMenu, setSlashMenu] = useState<SlashMenuState | null>(null);
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const [contextMenu, setContextMenu] = useState<EditorContextMenuState | null>(null);
  const [copyAsOpen, setCopyAsOpen] = useState(false);
  const [showContextImageModal, setShowContextImageModal] = useState(false);
  const [selectionToolbar, setSelectionToolbar] = useState<SelectionToolbarState | null>(null);
  const { content, currentFile, activeTabId, tabs, updateTabContent, settings, setEditorView } = useAppStore();
  const { proofreadResults, rewriteSelection, translateText, setTranslationVisible, setStatus } = useAIStore();
  const slashCommands = useMemo(() => filterSlashCommands(slashMenu?.query || ''), [slashMenu?.query]);
  const language = normalizeLanguage(settings.appearance.language);

  useEffect(() => {
    const handleFindRequest = (event: Event) => {
      const replace = Boolean((event as CustomEvent<{ replace?: boolean }>).detail?.replace);
      slashMenuRef.current = null;
      setSlashMenu(null);
      monacoRef.current?.trigger(
        'zeditor-editor-find',
        replace ? 'editor.action.startFindReplaceAction' : 'actions.find',
        null,
      );
    };
    window.addEventListener('zeditor-editor-find', handleFindRequest);
    return () => window.removeEventListener('zeditor-editor-find', handleFindRequest);
  }, []);

  const runContextMenuAction = useCallback(async (action: 'undo' | 'redo' | 'cut' | 'copy' | 'copyHtml' | 'copyPlain' | 'paste' | 'selectAll') => {
    const editor = monacoRef.current;
    const model = modelRef.current;
    const controller = controllerRef.current;
    setContextMenu(null);
    if (!editor || !model || !controller) return;

    if (action === 'undo' || action === 'redo') {
      editor.trigger('zeditor-context-menu', action, null);
    } else if (action === 'selectAll') {
      editor.setSelection(model.getFullModelRange());
    } else if (action === 'paste') {
      try {
        const text = await navigator.clipboard.readText();
        const selection = controller.getSelection();
        controller.replaceRange(selection.from, selection.to, text, {
          from: selection.from + text.length,
          to: selection.from + text.length,
        });
      } catch {
      editor.trigger('zeditor-context-menu', 'editor.action.clipboardPasteAction', null);
      }
    } else {
      const selection = controller.getSelection();
      const selectedText = controller.getText(selection.from, selection.to);
      if (!selectedText) return;
      const clipboardText = action === 'copyPlain'
        ? selectedText
            .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            .replace(/^#{1,6}\s+/gm, '')
            .replace(/(?:\*\*|__|~~|`)/g, '')
        : action === 'copyHtml'
          ? sanitizeRenderedHtml(contextMenuMarkdown.render(selectedText))
        : selectedText;
      try {
        if (action === 'copyHtml' && typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
          await navigator.clipboard.write([new ClipboardItem({
            'text/html': new Blob([clipboardText], { type: 'text/html' }),
            'text/plain': new Blob([clipboardText], { type: 'text/plain' }),
          })]);
        } else {
          await navigator.clipboard.writeText(clipboardText);
        }
        if (action === 'cut') controller.replaceRange(selection.from, selection.to, '');
      } catch {
        if (action === 'copyHtml') {
          try {
            await navigator.clipboard.writeText(clipboardText);
          } catch {
            // Clipboard permissions can be denied by the host WebView.
          }
        } else {
      editor.trigger('zeditor-context-menu', `editor.action.clipboard${action === 'cut' ? 'Cut' : 'Copy'}Action`, null);
        }
      }
    }
    editor.focus();
  }, []);

  const polishContextSelection = useCallback(async () => {
    const controller = controllerRef.current;
    setContextMenu(null);
    if (!controller) return;
    const selection = controller.getSelection();
    const selectedText = controller.getText(selection.from, selection.to);
    if (!selectedText) return;
    setStatus('loading', '正在润色选中文本...');
    const snapshot = {activeTabId: useAppStore.getState().activeTabId, content: controller.getValue()};
    const polished = await rewriteSelection(selectedText);
    if (!sameDocument(snapshot, useAppStore.getState())) {
      setStatus('error', '文档已变化，请重新发起润色');
      return;
    }
    if (polished) controller.replaceRange(selection.from, selection.to, polished, { from: selection.from, to: selection.from + polished.length });
    controller.focus();
  }, [rewriteSelection, setStatus]);

  const translateContextSelection = useCallback(async () => {
    const controller = controllerRef.current;
    setContextMenu(null);
    if (!controller) return;
    const selection = controller.getSelection();
    const selectedText = controller.getText(selection.from, selection.to);
    if (!selectedText) return;
    const coords = controller.coordsAtPos(selection.from);
    const result = await translateText(selectedText);
    const separatorIndex = result.indexOf('|||');
    if (separatorIndex < 0) return;
    const original = result.slice(0, separatorIndex);
    const translated = result.slice(separatorIndex + 3);
    if (translated && translated !== selectedText) {
      setTranslationVisible(true, coords ? { x: coords.left, y: coords.bottom } : undefined, original, translated);
    }
    controller.focus();
  }, [setTranslationVisible, translateText]);

  const insertContextImage = useCallback((url: string, alt = '图片') => {
    const controller = controllerRef.current;
    if (!controller) return;
    const selection = controller.getSelection();
    const markdown = `![${alt}](${url})`;
    controller.replaceRange(selection.from, selection.to, markdown, { from: selection.from + markdown.length, to: selection.from + markdown.length });
    controller.focus();
    setShowContextImageModal(false);
  }, []);

  const requestExport = useCallback((format: 'pdf' | 'word' | 'html') => {
    setContextMenu(null);
    window.dispatchEvent(new CustomEvent('zeditor-export-request', { detail: { format } }));
  }, []);

  const revealCurrentFile = useCallback(async () => {
    setContextMenu(null);
    if (!currentFile || currentFile.startsWith('web://')) return;
    await invoke('reveal_in_file_manager', { path: currentFile });
  }, [currentFile]);

  const closeSlashMenu = useCallback(() => {
    slashMenuRef.current = null;
    setSlashMenu(null);
  }, []);

  const selectSlashIndex = useCallback((index: number) => {
    slashSelectedIndexRef.current = index;
    setSlashSelectedIndex(index);
  }, []);

  const applySlashCommand = useCallback((command: SlashCommand) => {
    const menu = slashMenuRef.current;
    const controller = controllerRef.current;
    if (!menu || !controller) return;

    const { text, selectionStart = text.length, selectionEnd = selectionStart } = command.insertion;
    slashMenuRef.current = null;
    setSlashMenu(null);
    controller.replaceRange(menu.from, menu.to, text, {
      from: menu.from + selectionStart,
      to: menu.from + selectionEnd,
    });
    controller.focus();
  }, []);

  useEffect(() => {
    const root = editorRef.current;
    if (!root || monacoRef.current || !activeTabId) return;

    const isDark = (document.documentElement.dataset.theme || '').endsWith('-dark');
    const tab = useAppStore.getState().tabs.find(t => t.id === activeTabId);
    if (!tab) return;
    const model = documentModels.get(activeTabId, () => monaco.editor.createModel(tab.content, 'markdown'));
    if (model.getValue() !== tab.content) model.setValue(tab.content);
    const editor = monaco.editor.create(root, {
      model,
      theme: isDark ? 'vs-dark' : 'vs',
      automaticLayout: true,
      // 传真实字体栈而非 'var(--font-content)'：Monaco 的折行测量缓存以
      // fontFamily 字符串为键，CSS 变量字符串不随字体变化，更换字体后会
      // 命中旧测量缓存导致行文字宽度错乱、溢出编辑框。
      fontFamily: contentFontStack(useAppStore.getState().settings.appearance.font_family),
      fontSize: useAppStore.getState().settings.appearance.font_size,
      lineHeight: Math.round(useAppStore.getState().settings.appearance.font_size * useAppStore.getState().settings.appearance.line_height),
      lineNumbers: 'on',
      minimap: { enabled: false },
      overviewRulerLanes: 0,
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      wordWrap: 'on',
      wrappingIndent: 'same',
      renderWhitespace: 'selection',
      occurrencesHighlight: 'off',
      renderLineHighlight: 'line',
      renderLineHighlightOnlyWhenFocus: false,
      scrollBeyondLastLine: false,
      stickyScroll: { enabled: false },
      ...EDITOR_OVERFLOW_OPTIONS,
      smoothScrolling: false,
      padding: { top: 24, bottom: 40 },
      quickSuggestions: false,
      suggestOnTriggerCharacters: false,
      accessibilitySupport: 'off',
      // 默认使用原生 EditContext，让 Monaco 直接维护组合范围与字符边界；
      // 传统 textarea 仅作为旧版 WebView 的兼容回退。
      editContext: useAppStore.getState().settings.editor.input_engine === 'editContext',
      contextmenu: false,
      unicodeHighlight: EDITOR_UNICODE_HIGHLIGHT_OPTIONS,
    });
    const controller = createController(editor, model, root);
    monacoRef.current = editor;
    modelRef.current = model;
    controllerRef.current = controller;
    setEditorView(controller);
    onActiveLineChange?.(editor.getPosition()?.lineNumber || 1);

    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setCopyAsOpen(false);
      const selection = controller.getSelection();
      const menuWidth = 336;
      const submenuWidth = 150;
      const menuHeight = 660;
      const x = Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8));
      setContextMenu({
        x,
        y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
        submenuDirection: x + menuWidth + submenuWidth + 4 <= window.innerWidth ? 'right' : 'left',
        hasSelection: !selection.empty,
        canUndo: model.canUndo(),
        canRedo: model.canRedo(),
      });
    };
    const closeContextMenu = () => setContextMenu(null);
    root.addEventListener('contextmenu', handleContextMenu, true);
    window.addEventListener('mousedown', closeContextMenu);
    window.addEventListener('blur', closeContextMenu);

    const syncEditorViewport = (layout = editor.getLayoutInfo()) => {
      root.style.setProperty('--monaco-vertical-scrollbar-width', `${layout.verticalScrollbarWidth}px`);
      const visibleTextWidth = Math.max(1, layout.contentWidth - layout.verticalScrollbarWidth - 8);
      root.style.setProperty('--monaco-visible-text-width', `${visibleTextWidth}px`);
    };
    syncEditorViewport();
    const layoutDisposable = editor.onDidLayoutChange(syncEditorViewport);

    const clearCompanionTimer = () => {
      if (autoCompanionTimerRef.current !== null) window.clearTimeout(autoCompanionTimerRef.current);
      autoCompanionTimerRef.current = null;
    };

    const refreshSlashMenu = () => {
      const selection = controller.getSelection();
      if (!selection.empty) {
        slashMenuRef.current = null;
        setSlashMenu(null);
        return;
      }

      const position = offsetToPosition(model, selection.to);
      const line = toLine(model, position.lineNumber);
      const trigger = findSlashCommandTrigger(line.text, line.from, selection.to);
      const visible = editor.getScrolledVisiblePosition(position);
      const editorNode = editor.getDomNode();
      if (!trigger || !visible || !editorNode) {
        slashMenuRef.current = null;
        setSlashMenu(null);
        return;
      }

      const editorRect = editorNode.getBoundingClientRect();
      const nextMenu: SlashMenuState = {
        ...trigger,
        anchor: {
          left: editorRect.left + visible.left,
          top: editorRect.top + visible.top,
          bottom: editorRect.top + visible.top + visible.height,
        },
      };
      if (slashMenuRef.current?.query !== nextMenu.query) {
        slashSelectedIndexRef.current = 0;
        setSlashSelectedIndex(0);
      }
      slashMenuRef.current = nextMenu;
      setSlashMenu(nextMenu);
    };

    let selectionPointerActive = false;
    const refreshSelectionToolbar = () => {
      if (selectionPointerActive) {
        setSelectionToolbar(null);
        return;
      }
      const selection = editor.getSelection();
      if (!selection || selection.isEmpty()) {
        setSelectionToolbar(null);
        return;
      }
      const visible = editor.getScrolledVisiblePosition(selection.getStartPosition());
      const editorNode = editor.getDomNode();
      if (!visible || !editorNode) {
        setSelectionToolbar(null);
        return;
      }
      const rect = editorNode.getBoundingClientRect();
      const width = Math.min(720, Math.max(220, rect.width - 16), window.innerWidth - 16);
      const desiredLeft = rect.left + visible.left - width * 0.28;
      const left = Math.max(rect.left + 8, Math.min(desiredLeft, rect.right - width - 8));
      const toolbarHeight = 44;
      const placeAbove = rect.top + visible.top >= toolbarHeight + 12;
      setSelectionToolbar({
        left,
        top: placeAbove ? rect.top + visible.top - 8 : rect.top + visible.top + visible.height + 8,
        width,
        placement: placeAbove ? 'above' : 'below',
      });
    };
    const editorNode = editor.getDomNode();
    const handleSelectionPointerDown = () => {
      selectionPointerActive = true;
      setSelectionToolbar(null);
    };
    const handleSelectionPointerEnd = () => {
      if (!selectionPointerActive) return;
      selectionPointerActive = false;
      window.requestAnimationFrame(refreshSelectionToolbar);
    };
    editorNode?.addEventListener('pointerdown', handleSelectionPointerDown, true);
    window.addEventListener('pointerup', handleSelectionPointerEnd, true);
    window.addEventListener('pointercancel', handleSelectionPointerEnd, true);
    const selectionToolbarResizeObserver = new ResizeObserver(refreshSelectionToolbar);
    selectionToolbarResizeObserver.observe(root);

    const scheduleCompanion = () => {
      const currentSettings = useAppStore.getState().settings;
      const selection = controller.getSelection();
      if (!currentSettings.ai.enabled || !currentSettings.ai.auto_suggest || !selection.empty) {
        clearCompanionTimer();
        return;
      }
      const before = controller.getText(Math.max(0, selection.to - AUTO_COMPANION_CONTEXT_LIMIT), selection.to).trim();
      if (before.length < MIN_AUTO_COMPANION_CHARS) return;
      clearCompanionTimer();
      autoCompanionTimerRef.current = window.setTimeout(() => {
        const latest = controller.getSelection();
        const prompt = controller.getText(Math.max(0, latest.to - AUTO_COMPANION_CONTEXT_LIMIT), latest.to).trim();
        const now = Date.now();
        if (!latest.empty || prompt.length < MIN_AUTO_COMPANION_CHARS || prompt === autoCompanionLastPromptRef.current || now - autoCompanionLastRequestAtRef.current < AUTO_COMPANION_MIN_INTERVAL) return;
        autoCompanionLastPromptRef.current = prompt;
        autoCompanionLastRequestAtRef.current = now;
        useAIStore.getState().setCompanionVisible(true, controller.coordsAtPos(latest.to) || undefined);
        useAIStore.getState().getCompanionSuggestion(prompt);
      }, Math.max(500, currentSettings.ai.suggest_delay || 2000));
    };

    const contentDisposable = editor.onDidChangeModelContent(() => {
      updateTabContent(activeTabId, model.getValue());
      scheduleCompanion();
      refreshSlashMenu();
    });
    const cursorDisposable = editor.onDidChangeCursorSelection(() => {
      onActiveLineChange?.(editor.getPosition()?.lineNumber || 1);
      scheduleCompanion();
      refreshSlashMenu();
      refreshSelectionToolbar();
    });
    const mouseDisposable = editor.onMouseUp((event) => {
      const lineNumber = event.target.position?.lineNumber;
      if (lineNumber) onActiveLineReveal?.(lineNumber);
    });
    const scrollDisposable = editor.onDidScrollChange(() => {
      refreshSlashMenu();
      refreshSelectionToolbar();
    });
    const slashKeyDisposable = editor.onKeyDown((event) => {
      const menu = slashMenuRef.current;
      if (!menu) return;

      const commands = filterSlashCommands(menu.query);
      const key = event.browserEvent.key;
      if (key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        slashMenuRef.current = null;
        setSlashMenu(null);
        return;
      }
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        if (commands.length === 0) return;
        const direction = key === 'ArrowDown' ? 1 : -1;
        const next = (slashSelectedIndexRef.current + direction + commands.length) % commands.length;
        slashSelectedIndexRef.current = next;
        setSlashSelectedIndex(next);
        return;
      }
      if ((key === 'Enter' || key === 'Tab') && commands.length > 0) {
        event.preventDefault();
        event.stopPropagation();
        const command = commands[Math.min(slashSelectedIndexRef.current, commands.length - 1)];
        const { text, selectionStart = text.length, selectionEnd = selectionStart } = command.insertion;
        slashMenuRef.current = null;
        setSlashMenu(null);
        controller.replaceRange(menu.from, menu.to, text, {
          from: menu.from + selectionStart,
          to: menu.from + selectionEnd,
        });
        controller.focus();
      }
    });

    const handleTheme = (event: Event) => {
      const theme = (event as CustomEvent<string>).detail;
      monaco.editor.setTheme(theme.endsWith('-dark') ? 'vs-dark' : 'vs');
    };
    window.addEventListener('zeditor-theme-change', handleTheme);

    const handlePaste = async (event: ClipboardEvent) => {
      const image = Array.from(event.clipboardData?.items || []).find((item) => item.type.startsWith('image/'))?.getAsFile();
      if (!image) return;
      event.preventDefault();

      const store = useAppStore.getState();
      if (!imageHostConfigured(store.settings)) {
        store.setUploadStatus('error', 0, '请先启用并配置图床服务');
        store.setSettingsTab('image');
        store.setSettingsOpen(true);
        return;
      }

      const selection = controller.getSelection();
      store.setUploadStatus('uploading', 15, '正在上传剪贴板图片…');
      try {
        const dataUrl = await fileAsDataUrl(image);
        let url = dataUrl;
        if (isTauriRuntime()) {
          const extension = image.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
          url = await invoke<string>('upload_image_bytes', {
            dataBase64: dataUrl.split(',')[1],
            extension,
            service: store.settings.image_hosting.active_service,
            settings: store.settings,
          });
        }
        const markdown = `![粘贴的图片](${url})`;
        controller.replaceRange(selection.from, selection.to, markdown, { from: selection.from + markdown.length, to: selection.from + markdown.length });
        controller.focus();
        store.setUploadStatus('success', 100, isTauriRuntime() ? '图片已上传并插入' : '图片已嵌入文档');
      } catch (error) {
        store.setUploadStatus('error', 0, String(error));
      }
    };
    root.addEventListener('paste', handlePaste, true);

    return () => {
      clearCompanionTimer();
      root.removeEventListener('paste', handlePaste, true);
      root.removeEventListener('contextmenu', handleContextMenu, true);
      window.removeEventListener('mousedown', closeContextMenu);
      window.removeEventListener('blur', closeContextMenu);
      editorNode?.removeEventListener('pointerdown', handleSelectionPointerDown, true);
      window.removeEventListener('pointerup', handleSelectionPointerEnd, true);
      window.removeEventListener('pointercancel', handleSelectionPointerEnd, true);
    window.removeEventListener('zeditor-theme-change', handleTheme);
      contentDisposable.dispose();
      cursorDisposable.dispose();
      mouseDisposable.dispose();
      scrollDisposable.dispose();
      slashKeyDisposable.dispose();
      layoutDisposable.dispose();
      selectionToolbarResizeObserver.disconnect();
      editor.dispose();
      monacoRef.current = null;
      modelRef.current = null;
      controllerRef.current = null;
      slashMenuRef.current = null;
      setEditorView(null);
    };
  }, [activeTabId, onActiveLineChange, onActiveLineReveal, updateTabContent, setEditorView]);

  useEffect(() => { documentModels.retain(tabs.map(t => t.id)); }, [tabs]);

  useEffect(() => {
    const model = modelRef.current;
    const editor = monacoRef.current;
    if (!model || !editor || model.getValue() === content) return;
    editor.executeEdits('external-update', [{ range: model.getFullModelRange(), text: content, forceMoveMarkers: true }]);
  }, [content]);

  // 桌面设置会异步加载；保存输入引擎后同步更新现有实例，避免界面选择与实际引擎不一致。
  useEffect(() => {
    monacoRef.current?.updateOptions({
      editContext: settings.editor.input_engine !== 'textarea',
    });
  }, [settings.editor.input_engine]);

  useEffect(() => {
    monacoRef.current?.updateOptions({
      fontSize: settings.appearance.font_size,
      lineHeight: Math.round(settings.appearance.font_size * settings.appearance.line_height),
      // 与创建时一致，传真实字体栈：字体名变化会让 Monaco 的测量缓存
      // 失效并重新测量，渲染与折行宽度保持一致，不再溢出编辑框。
      fontFamily: contentFontStack(settings.appearance.font_family),
    });
  }, [settings.appearance.font_family, settings.appearance.font_size, settings.appearance.line_height]);

  useEffect(() => {
    const handleFontSizePreview = (event: Event) => {
      const detail = (event as CustomEvent<{ fontSize?: number; fontFamily?: string }>).detail;
      const fontSize = Number(detail?.fontSize);
      if (!Number.isFinite(fontSize) || fontSize <= 0) return;
      monacoRef.current?.updateOptions({
        fontSize,
        lineHeight: Math.round(fontSize * settings.appearance.line_height),
        // 拖动字号预览与更换字体共用此事件；带上当前字体的真实字体栈，
        // 让 Monaco 重新测量折行宽度，避免字号预览时按旧字体折行溢出。
        fontFamily: detail?.fontFamily || contentFontStack(settings.appearance.font_family),
      });
    };
    window.addEventListener('zeditor-content-font-size-preview', handleFontSizePreview);
    return () => window.removeEventListener('zeditor-content-font-size-preview', handleFontSizePreview);
  }, [settings.appearance.font_family, settings.appearance.line_height]);

  useEffect(() => {
    const editor = monacoRef.current;
    const model = modelRef.current;
    if (!editor || !model) return;
    const decorations: monaco.editor.IModelDeltaDecoration[] = proofreadResults
      .filter((result: ProofreadResult) => result.from >= 0 && result.to > result.from && result.to <= model.getValueLength())
      .map((result: ProofreadResult) => ({
        range: monaco.Range.fromPositions(offsetToPosition(model, result.from), offsetToPosition(model, result.to)),
        options: { inlineClassName: 'monaco-proofread-error', hoverMessage: { value: result.explanation || result.suggestion } },
      }));
    decorationIdsRef.current = editor.deltaDecorations(decorationIdsRef.current, decorations);
  }, [proofreadResults]);

  return (
    <div className={`editor-container monaco-editor-container ${className || ''}`} style={style}>
      <div className="editor-document-card monaco-document-card">
        <div ref={editorRef} className="editor-content monaco-host" />
      </div>
      {selectionToolbar && !settings.editor.pin_toolbar && (
        <div
          className="selection-toolbar"
          data-placement={selectionToolbar.placement}
          style={{ left: selectionToolbar.left, top: selectionToolbar.top, width: selectionToolbar.width }}
          onMouseDown={(event) => event.preventDefault()}
        >
          <Toolbar variant="floating" />
        </div>
      )}
      {slashMenu && (
        <SlashCommandMenu
          anchor={slashMenu.anchor}
          commands={slashCommands}
          selectedIndex={Math.min(slashSelectedIndex, Math.max(0, slashCommands.length - 1))}
          query={slashMenu.query}
          onSelect={applySlashCommand}
          onSelectedIndexChange={selectSlashIndex}
          onClose={closeSlashMenu}
        />
      )}
      {contextMenu && (
        <div
          className="editor-context-menu"
          role="menu"
          aria-label={t('编辑器', language)}
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button type="button" role="menuitem" disabled={!contextMenu.hasSelection} onClick={() => void polishContextSelection()}>
            <span className="editor-context-menu-icon tone-accent"><ContextMenuIcon name="sparkles" /></span><span className="editor-context-menu-label">AI 润色</span>
          </button>
          <button type="button" role="menuitem" disabled={!contextMenu.hasSelection} onClick={() => void translateContextSelection()}>
            <span className="editor-context-menu-icon tone-blue"><ContextMenuIcon name="translate" /></span><span className="editor-context-menu-label">AI 翻译</span>
          </button>
          <div className="editor-context-menu-divider" role="separator" />
          <button type="button" role="menuitem" disabled={!contextMenu.canUndo} onClick={() => void runContextMenuAction('undo')}>
            <span className="editor-context-menu-icon"><ContextMenuIcon name="undo" /></span><span className="editor-context-menu-label">{t('撤销', language)}</span><kbd>Ctrl+Z</kbd>
          </button>
          <button type="button" role="menuitem" disabled={!contextMenu.canRedo} onClick={() => void runContextMenuAction('redo')}>
            <span className="editor-context-menu-icon"><ContextMenuIcon name="redo" /></span><span className="editor-context-menu-label">{t('重做', language)}</span><kbd>Ctrl+Y</kbd>
          </button>
          <div className="editor-context-menu-divider" role="separator" />
          <button type="button" role="menuitem" disabled={!contextMenu.hasSelection} onClick={() => void runContextMenuAction('copy')}>
            <span className="editor-context-menu-icon tone-blue"><ContextMenuIcon name="copy" /></span><span className="editor-context-menu-label">{t('复制', language)}</span><kbd>Ctrl+C</kbd>
          </button>
          <div className="editor-context-copy-as" data-submenu-direction={contextMenu.submenuDirection} onMouseEnter={() => setCopyAsOpen(true)} onMouseLeave={() => setCopyAsOpen(false)}>
            <button type="button" role="menuitem" disabled={!contextMenu.hasSelection} onClick={() => setCopyAsOpen((open) => !open)}>
              <span className="editor-context-menu-icon"><ContextMenuIcon name="copyAs" /></span><span className="editor-context-menu-label">复制为</span><span className="editor-context-menu-chevron">›</span>
            </button>
            {copyAsOpen && contextMenu.hasSelection && (
              <div className="editor-context-submenu" role="menu">
                <button type="button" role="menuitem" onClick={() => void runContextMenuAction('copyHtml')}><span>HTML</span></button>
                <button type="button" role="menuitem" onClick={() => void runContextMenuAction('copyPlain')}><span>纯文本</span></button>
              </div>
            )}
          </div>
          <button type="button" role="menuitem" onClick={() => void runContextMenuAction('paste')}>
            <span className="editor-context-menu-icon tone-green"><ContextMenuIcon name="paste" /></span><span className="editor-context-menu-label">{t('粘贴', language)}</span><kbd>Ctrl+V</kbd>
          </button>
          <button type="button" role="menuitem" onClick={() => void runContextMenuAction('paste')}>
            <span className="editor-context-menu-icon"><ContextMenuIcon name="text" /></span><span className="editor-context-menu-label">粘贴为纯文本</span><kbd>Ctrl+Shift+V</kbd>
          </button>
          <div className="editor-context-menu-divider" role="separator" />
          <button type="button" role="menuitem" onClick={() => requestExport('pdf')}>
            <span className="editor-context-menu-icon tone-red"><ContextMenuIcon name="pdf" /></span><span className="editor-context-menu-label">导出 PDF</span>
          </button>
          <button type="button" role="menuitem" onClick={() => requestExport('word')}>
            <span className="editor-context-menu-icon tone-blue"><ContextMenuIcon name="document" /></span><span className="editor-context-menu-label">导出 Word</span>
          </button>
          <button type="button" role="menuitem" onClick={() => requestExport('html')}>
            <span className="editor-context-menu-icon tone-blue"><ContextMenuIcon name="code" /></span><span className="editor-context-menu-label">导出 HTML</span>
          </button>
          <div className="editor-context-menu-divider" role="separator" />
          <button type="button" role="menuitem" onClick={() => { setContextMenu(null); setShowContextImageModal(true); }}>
            <span className="editor-context-menu-icon tone-gold"><ContextMenuIcon name="image" /></span><span className="editor-context-menu-label">插入图片</span>
          </button>
          <button type="button" role="menuitem" disabled={!currentFile || currentFile.startsWith('web://')} onClick={() => void revealCurrentFile()}>
            <span className="editor-context-menu-icon tone-blue"><ContextMenuIcon name="folder" /></span><span className="editor-context-menu-label">在文件夹中显示</span>
          </button>
        </div>
      )}
      {showContextImageModal && <ImageOptionsModal onClose={() => setShowContextImageModal(false)} onInsert={insertContextImage} />}
    </div>
  );
}
