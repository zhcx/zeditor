import { useEffect, useRef, useCallback, useState } from 'react';
import { useAppStore } from './stores/appStore';
import { useAIStore } from './stores/aiStore';
import { TabsBar } from './components/TabsBar/TabsBar';
import { Toolbar } from './components/Toolbar/Toolbar';
import { Editor } from './components/Editor/Editor';
import { Preview } from './components/Preview/Preview';
import { SettingsPanel } from './components/Settings/SettingsPanel';
import { StatusBar } from './components/StatusBar/StatusBar';
import { Sidebar } from './components/Sidebar/Sidebar';
import { AICompanionPopup } from './components/AI/AICompanionPopup';
import { AITranslationPopup } from './components/AI/AITranslationPopup';
import { AIDiffConfirmDialog } from './components/AI/AIDiffConfirmDialog';
import { AIChatbotPanel } from './components/Chatbot/AIChatbotPanel';
import { ImmersiveOutline } from './components/Immersive/ImmersiveOutline';
import { TitleBar } from './components/TitleBar/TitleBar';
import { ActivityBar } from './components/ActivityBar/ActivityBar';
import { UnsavedChangesDialog } from './components/UnsavedChangesDialog/UnsavedChangesDialog';
import { ConverterDialog } from './components/ConverterDialog/ConverterDialog';
import { PdfReaderPanel } from './components/PdfReader/PdfReaderPanel';
import { UiLanguageBridge } from './i18n/UiLanguageBridge';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { message, save as chooseSaveFile } from '@tauri-apps/plugin-dialog';
import { createElementScrollViewport, getAlignedScrollTop, getSyncedScrollTop, type ObservableScrollViewport, type ScrollAnchor, type ScrollRange } from './utils/scrollSync';
import { getImmersiveWorkspacePolicy } from './utils/immersiveWorkspace';
import { guardWindowClose, type CloseGuardTab, type UnsavedChangesAction } from './utils/windowCloseGuard';
import { findActiveSourceElement } from './utils/activeSourceLine';
import './styles/main.css';
import './styles/workbench.css';

interface DragDropPayload {
  paths: string[];
  position: { x: number; y: number };
}

const DEFAULT_EDITOR_RATIO = 0.5;
const SUPPORTED_THEMES = new Set(['vscode-light', 'vscode-dark']);
let themeSwitchFrame: number | null = null;

function resolveThemePreference(preference: string) {
  if (preference === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'vscode-dark' : 'vscode-light';
  }
  if (preference === 'dark') return 'vscode-dark';
  if (preference === 'light') return 'vscode-light';
  if (SUPPORTED_THEMES.has(preference)) return preference;
  // 已下线主题（claude-*/notion-*）按明暗迁移到对应的新主题。
  return preference.endsWith('-light') ? 'vscode-light' : 'vscode-dark';
}

function applyThemeToDocument(preference: string) {
  const resolvedTheme = resolveThemePreference(preference);
  const root = document.documentElement;

  if (themeSwitchFrame !== null) window.cancelAnimationFrame(themeSwitchFrame);
  root.classList.add('theme-switching');
  root.setAttribute('data-theme', resolvedTheme);
  root.style.colorScheme = resolvedTheme.endsWith('-dark') ? 'dark' : 'light';
  window.dispatchEvent(new CustomEvent('zeditor-theme-change', { detail: resolvedTheme }));
  themeSwitchFrame = window.requestAnimationFrame(() => {
    root.classList.remove('theme-switching');
    themeSwitchFrame = null;
  });

  return resolvedTheme;
}

function App() {
  const {
    mode,
    settingsOpen,
    sidebarVisible,
    sidebarWidth,
    outlineVisible,
    loadSettings,
    settings,
    splitRatio,
    setSplitRatio,
    setSidebarWidth,
    setSidebarVisible,
    setSettingsOpen,
    openFile
  } = useAppStore();
  const editorView = useAppStore(state => state.editorView);
  const { proofreadResults, setProofreadPanelVisible, translationPosition, translationOriginal, translationResult, setTranslationVisible, chatbotVisible, setChatbotVisible } = useAIStore();

  const dividerRef = useRef<HTMLDivElement>(null);
  const sidebarDividerRef = useRef<HTMLDivElement>(null);
  const proofreadDividerRef = useRef<HTMLDivElement>(null);
  const chatbotDividerRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const isDraggingSidebar = useRef(false);
  const isDraggingProofread = useRef(false);
  const isDraggingChatbot = useRef(false);
  const dragFrame = useRef<number | null>(null);
  const pendingDrag = useRef<{ type: 'split' | 'sidebar' | 'proofread' | 'chatbot'; clientX: number } | null>(null);
  const dragBounds = useRef<DOMRect | null>(null);
  const layoutWidth = useRef<number | null>(null);
  const [proofreadPanelWidth, setProofreadPanelWidth] = useState(280);
  const [chatbotPanelWidth, setChatbotPanelWidth] = useState(340);
  const [previewScrollElement, setPreviewScrollElement] = useState<HTMLDivElement | null>(null);
  const [previewRenderVersion, setPreviewRenderVersion] = useState(0);
  const [activeEditorLine, setActiveEditorLine] = useState(1);
  const [activityView, setActivityView] = useState<'explorer' | 'search' | 'graph' | 'library'>('explorer');
  const [immersiveOutlineCollapsed, setImmersiveOutlineCollapsed] = useState(false);
  const [immersivePreviewScrollElement, setImmersivePreviewScrollElement] = useState<HTMLDivElement | null>(null);
  const [closePromptTabs, setClosePromptTabs] = useState<CloseGuardTab[] | null>(null);
  const scrollSyncFrame = useRef<number | null>(null);
  const pendingScrollSync = useRef<{
    source: ObservableScrollViewport;
    target: ObservableScrollViewport;
    anchors: ScrollAnchor[];
    range: ScrollRange;
  } | null>(null);
  const programmaticScrollTargetsRef = useRef(new Map<ObservableScrollViewport, number>());
  const revealPreviewLineRef = useRef<(lineNumber: number) => void>(() => undefined);
  const revealEditorLineRef = useRef<(lineNumber: number) => void>(() => undefined);
  const closeGuardInProgress = useRef(false);
  const closePromptResolver = useRef<((action: UnsavedChangesAction) => void) | null>(null);
  const dragValues = useRef({ splitRatio, sidebarWidth, proofreadPanelWidth, chatbotPanelWidth });
  const immersivePolicy = getImmersiveWorkspacePolicy(mode, chatbotVisible);

  const promptUnsavedChanges = useCallback((tabs: CloseGuardTab[]) => new Promise<UnsavedChangesAction>((resolve) => {
    closePromptResolver.current = resolve;
    setClosePromptTabs(tabs);
  }), []);

  const resolveClosePrompt = useCallback((action: UnsavedChangesAction) => {
    const resolve = closePromptResolver.current;
    closePromptResolver.current = null;
    setClosePromptTabs(null);
    resolve?.(action);
  }, []);

  const requestAppClose = useCallback(async () => {
    if (!('__TAURI_INTERNALS__' in window) || closeGuardInProgress.current) return;
    closeGuardInProgress.current = true;

    try {
      const result = await guardWindowClose(useAppStore.getState().tabs, {
        promptAction: promptUnsavedChanges,
        chooseSavePath: async tab => {
          const selected = await chooseSaveFile({
            title: `保存“${tab.title}”`,
            defaultPath: tab.title === '未命名' ? '未命名.md' : tab.title,
            filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
          });
          return typeof selected === 'string' ? selected : null;
        },
        saveTab: async (tabId, path) => {
          try {
            await useAppStore.getState().saveTab(tabId, path);
          } catch (error) {
            await message(`保存失败：${String(error)}`, {
              title: '无法保存文件',
              kind: 'error',
            });
            throw error;
          }
        },
      });

      if (result === 'close') {
        try {
          await getCurrentWindow().destroy();
        } catch (error) {
          // A capability/configuration regression must never trap the user in
          // the close prompt. Ask the native application event loop to exit as
          // a final fallback and log the rejected window command for diagnosis.
          console.error('Destroying the application window failed; using native exit.', error);
          await invoke('exit_application');
        }
      }
    } finally {
      closeGuardInProgress.current = false;
    }
  }, [promptUnsavedChanges]);

  const balanceDocumentPanes = useCallback((proofreadWidth = proofreadPanelWidth, chatWidth = chatbotPanelWidth) => {
    const appBody = dividerRef.current?.closest('.app-body') as HTMLElement | null;
    const divider = dividerRef.current;
    if (!appBody || !divider) return;

    const hasProofreadPanel = proofreadResults.length > 0;
    const sidebarSpace = (sidebarVisible || outlineVisible) ? sidebarWidth + 6 : 0;
    const proofreadSpace = hasProofreadPanel ? proofreadWidth + 8 : 0;
    const chatbotSpace = chatbotVisible ? chatWidth + 8 : 0;
    // During a drag the container width is fixed; reuse its captured bounds to
    // avoid a synchronous layout read on every animation frame.
    const appBodyWidth = layoutWidth.current ?? appBody.clientWidth;
    const mainWidth = appBodyWidth - sidebarSpace - chatbotSpace;
    const documentWidth = mainWidth - proofreadSpace;
    if (mainWidth <= 0 || documentWidth <= 0) return;

    const ratio = Math.max(0.1, Math.min(0.9, (documentWidth * DEFAULT_EDITOR_RATIO) / mainWidth));
    const editor = divider.previousElementSibling as HTMLElement | null;
    const preview = divider.nextElementSibling as HTMLElement | null;
    if (editor) editor.style.flex = String(ratio);
    if (preview) preview.style.flex = String(1 - ratio);
    dragValues.current.splitRatio = ratio;
  }, [chatbotPanelWidth, chatbotVisible, outlineVisible, proofreadPanelWidth, proofreadResults.length, sidebarVisible, sidebarWidth]);

  const scheduleDragFrame = useCallback((type: 'split' | 'sidebar' | 'proofread' | 'chatbot', clientX: number) => {
    pendingDrag.current = { type, clientX };
    if (dragFrame.current !== null) return;

    dragFrame.current = window.requestAnimationFrame(() => {
      dragFrame.current = null;
      const drag = pendingDrag.current;
      const bounds = dragBounds.current;
      if (!drag || !bounds) return;

      if (drag.type === 'split') {
        const sidebarOffset = sidebarVisible ? sidebarWidth : 0;
        const ratio = Math.max(0.1, Math.min(0.9,
          (drag.clientX - bounds.left - sidebarOffset) / (bounds.width - sidebarOffset),
        ));
        const divider = dividerRef.current;
        const editor = divider?.previousElementSibling as HTMLElement | null;
        const preview = divider?.nextElementSibling as HTMLElement | null;
        if (editor) editor.style.flex = String(ratio);
        if (preview) preview.style.flex = String(1 - ratio);
        dragValues.current.splitRatio = ratio;
      } else if (drag.type === 'sidebar') {
        const width = Math.max(150, Math.min(400, drag.clientX - bounds.left));
        const sidebar = sidebarDividerRef.current?.previousElementSibling as HTMLElement | null;
        if (sidebar) sidebar.style.width = `${width}px`;
        dragValues.current.sidebarWidth = width;
      } else if (drag.type === 'proofread') {
        const width = Math.max(200, Math.min(500, bounds.right - drag.clientX));
        const panel = proofreadDividerRef.current?.nextElementSibling as HTMLElement | null;
        if (panel) panel.style.width = `${width}px`;
        dragValues.current.proofreadPanelWidth = width;
        balanceDocumentPanes(width, dragValues.current.chatbotPanelWidth);
      } else {
        const width = Math.max(200, Math.min(500, bounds.right - drag.clientX));
        const panel = chatbotDividerRef.current?.nextElementSibling as HTMLElement | null;
        if (panel) panel.style.width = `${width}px`;
        dragValues.current.chatbotPanelWidth = width;
        balanceDocumentPanes(dragValues.current.proofreadPanelWidth, width);
      }
    });
  }, [balanceDocumentPanes, sidebarVisible, sidebarWidth]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return undefined;

    let disposed = false;
    let removeListener: (() => void) | undefined;
    const openPaths = async (paths: string[]) => {
      for (const path of paths) await openFile(path);
    };

    // Install the runtime listener before draining startup argv so a second
    // launch cannot slip through the gap while the first window is mounting.
    void listen<string[]>('open-files', () => {
      void invoke<string[]>('take_pending_open_files').then(openPaths).catch(error => {
        console.error('Failed to open files from a later launch:', error);
      });
    }).then(async unlisten => {
      if (disposed) {
        unlisten();
        return;
      }
      removeListener = unlisten;
      const pending = await invoke<string[]>('take_pending_open_files');
      await openPaths(pending);
    }).catch(error => {
      console.error('Failed to initialize file-open integration:', error);
    });

    return () => {
      disposed = true;
      removeListener?.();
    };
  }, [openFile]);

  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return undefined;

    const unlisten = getCurrentWindow().onCloseRequested(event => {
      event.preventDefault();
      void requestAppClose();
    });

    return () => { unlisten.then(fn => fn()); };
  }, [requestAppClose]);

  useEffect(() => {
    if (mode === 'split') return;
    const exitImmersiveWorkspace = (event: KeyboardEvent) => {
      if (event.key === 'Escape') useAppStore.getState().setMode('split');
    };
    window.addEventListener('keydown', exitImmersiveWorkspace);
    return () => window.removeEventListener('keydown', exitImmersiveWorkspace);
  }, [mode]);

  useEffect(() => {
    let wasCompact = false;
    const syncCompactLayout = () => {
      const compact = window.innerWidth < 900;
      if (compact && !wasCompact) {
        // Preserve the editor as the primary surface on narrow desktop
        // windows. The activity bar remains available to reopen the sidebar.
        setSidebarVisible(false);
      }
      wasCompact = compact;
    };

    syncCompactLayout();
    window.addEventListener('resize', syncCompactLayout);
    return () => window.removeEventListener('resize', syncCompactLayout);
  }, [setSidebarVisible]);

  useEffect(() => {
    const toFontStack = (fontFamily?: string) => {
      const family = fontFamily?.replace(/[;{}]/g, '').trim() || 'Microsoft YaHei';
      return `${family}, "Microsoft YaHei", sans-serif`;
    };

    const root = document.documentElement;
    root.style.setProperty('--font-sans', toFontStack(settings.appearance.ui_font_family));
    root.style.setProperty('--font-content', toFontStack(settings.appearance.font_family));
    root.style.setProperty('--font-content-size', `${settings.appearance.font_size}px`);
    root.style.setProperty('--font-content-line-height', String(settings.appearance.line_height));
  }, [
    settings.appearance.font_family,
    settings.appearance.font_size,
    settings.appearance.line_height,
    settings.appearance.ui_font_family,
  ]);

  useEffect(() => {
    const preference = settings.appearance.theme;
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const applyTheme = () => applyThemeToDocument(preference);

    applyTheme();

    if (preference !== 'system') {
      return () => {
        document.documentElement.classList.remove('theme-switching');
      };
    }
    mediaQuery.addEventListener('change', applyTheme);
    return () => {
      mediaQuery.removeEventListener('change', applyTheme);
      document.documentElement.classList.remove('theme-switching');
    };
  }, [settings.appearance.theme]);

  // Listen for Tauri file drop events using webview window
  useEffect(() => {
    // Keep the native drag-and-drop integration out of plain browser previews.
    // Tauri injects this internal bridge for every desktop webview.
    if (!('__TAURI_INTERNALS__' in window)) return undefined;

    const webview = getCurrentWebviewWindow();

    const unlisten = webview.listen<DragDropPayload>('tauri://drag-drop', async (event) => {
      const paths = event.payload.paths;
      for (const path of paths) {
        try {
          await openFile(path);
        } catch (error) {
          console.error('Failed to open dropped file:', error);
          window.alert(`打开文件失败：${String(error)}`);
        }
      }
    });

    return () => { unlisten.then(fn => fn()); };
  }, [openFile]);

  const handleSplitMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    dragBounds.current = dividerRef.current?.parentElement?.getBoundingClientRect() || null;
    layoutWidth.current = (dividerRef.current?.closest('.app-body') as HTMLElement | null)?.clientWidth ?? null;
    document.documentElement.classList.add('panel-resizing');
  }, []);

  const handleSplitMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging.current) return;

    scheduleDragFrame('split', e.clientX);
  }, [scheduleDragFrame]);

  const handleSidebarMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingSidebar.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    dragBounds.current = sidebarDividerRef.current?.parentElement?.getBoundingClientRect() || null;
    layoutWidth.current = (sidebarDividerRef.current?.closest('.app-body') as HTMLElement | null)?.clientWidth ?? null;
    document.documentElement.classList.add('panel-resizing');
  }, []);

  const handleSidebarMouseMove = useCallback((e: MouseEvent) => {
    if (!isDraggingSidebar.current) return;

    scheduleDragFrame('sidebar', e.clientX);
  }, [scheduleDragFrame]);

  const handleProofreadMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingProofread.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    dragBounds.current = proofreadDividerRef.current?.parentElement?.getBoundingClientRect() || null;
    layoutWidth.current = (proofreadDividerRef.current?.closest('.app-body') as HTMLElement | null)?.clientWidth ?? null;
    document.documentElement.classList.add('panel-resizing');
  }, []);

  const handleProofreadMouseMove = useCallback((e: MouseEvent) => {
    if (!isDraggingProofread.current) return;

    scheduleDragFrame('proofread', e.clientX);
  }, [scheduleDragFrame]);

  const handleChatbotMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingChatbot.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    dragBounds.current = chatbotDividerRef.current?.parentElement?.getBoundingClientRect() || null;
    layoutWidth.current = (chatbotDividerRef.current?.closest('.app-body') as HTMLElement | null)?.clientWidth ?? null;
    document.documentElement.classList.add('panel-resizing');
  }, []);

  const handleChatbotMouseMove = useCallback((e: MouseEvent) => {
    if (!isDraggingChatbot.current) return;

    scheduleDragFrame('chatbot', e.clientX);
  }, [scheduleDragFrame]);

  useEffect(() => {
    const rebalancePanels = () => {
      const appBody = dividerRef.current?.closest('.app-body') as HTMLElement | null;
      if (!appBody) return;
      const sidebarSpace = (sidebarVisible || outlineVisible) ? sidebarWidth + 6 : 0;
      const proofreadSpace = proofreadResults.length > 0 ? proofreadPanelWidth + 8 : 0;
      const availableWidth = appBody.clientWidth - sidebarSpace - proofreadSpace;
      const nextChatWidth = chatbotVisible
        ? Math.max(200, Math.min(500, Math.round((availableWidth - 8) / 3)))
        : chatbotPanelWidth;

      if (chatbotVisible && Math.abs(nextChatWidth - chatbotPanelWidth) > 1) {
        setChatbotPanelWidth(nextChatWidth);
        dragValues.current.chatbotPanelWidth = nextChatWidth;
      }
      balanceDocumentPanes(proofreadPanelWidth, nextChatWidth);
      setSplitRatio(dragValues.current.splitRatio);
    };

    const frame = window.requestAnimationFrame(rebalancePanels);
    window.addEventListener('resize', rebalancePanels);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', rebalancePanels);
    };
  }, [balanceDocumentPanes, chatbotPanelWidth, chatbotVisible, outlineVisible, proofreadPanelWidth, proofreadResults.length, setSplitRatio, sidebarVisible, sidebarWidth]);

  const selectActivityView = useCallback((view: 'explorer' | 'search' | 'graph' | 'library') => {
    if (sidebarVisible && activityView === view) {
      setSidebarVisible(false);
      return;
    }
    setActivityView(view);
    if (!sidebarVisible) setSidebarVisible(true);
  }, [activityView, setSidebarVisible, sidebarVisible]);

  const toggleThemeVariant = useCallback(() => {
    const currentSettings = useAppStore.getState().settings;
    const currentTheme = resolveThemePreference(currentSettings.appearance.theme);
    const isDark = currentTheme.endsWith('-dark');
    const family = currentTheme.replace(/-(?:light|dark)$/, '') || 'vscode';
    const nextTheme = `${family}-${isDark ? 'light' : 'dark'}`;
    const nextSettings = {
      ...currentSettings,
      appearance: { ...currentSettings.appearance, theme: nextTheme },
    };

    // Desktop persistence crosses the Tauri bridge and may be delayed. Apply
    // the visual state synchronously so the activity-bar button always gives
    // immediate feedback, then persist the same value in the background.
    applyThemeToDocument(nextTheme);
    void useAppStore.getState().saveSettings(nextSettings);
  }, []);

  const handleMouseUp = useCallback(() => {
    if (isDragging.current) {
      isDragging.current = false;
      setSplitRatio(dragValues.current.splitRatio);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    if (isDraggingSidebar.current) {
      isDraggingSidebar.current = false;
      setSidebarWidth(dragValues.current.sidebarWidth);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    if (isDraggingProofread.current) {
      isDraggingProofread.current = false;
      setProofreadPanelWidth(dragValues.current.proofreadPanelWidth);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    if (isDraggingChatbot.current) {
      isDraggingChatbot.current = false;
      setChatbotPanelWidth(dragValues.current.chatbotPanelWidth);
      setSplitRatio(dragValues.current.splitRatio);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    pendingDrag.current = null;
    dragBounds.current = null;
    layoutWidth.current = null;
    document.documentElement.classList.remove('panel-resizing');
  }, [setChatbotPanelWidth, setProofreadPanelWidth, setSidebarWidth, setSplitRatio]);

  useEffect(() => {
    document.addEventListener('mousemove', handleSplitMouseMove);
    document.addEventListener('mousemove', handleSidebarMouseMove);
    document.addEventListener('mousemove', handleProofreadMouseMove);
    document.addEventListener('mousemove', handleChatbotMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleSplitMouseMove);
      document.removeEventListener('mousemove', handleSidebarMouseMove);
      document.removeEventListener('mousemove', handleProofreadMouseMove);
      document.removeEventListener('mousemove', handleChatbotMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleSplitMouseMove, handleSidebarMouseMove, handleProofreadMouseMove, handleChatbotMouseMove, handleMouseUp]);

  const handlePreviewScrollContainerReady = useCallback((element: HTMLDivElement | null) => {
    setPreviewScrollElement(element);
  }, []);

  const handlePreviewContentRendered = useCallback(() => {
    setPreviewRenderVersion((version) => version + 1);
  }, []);

  const handleEditorLineReveal = useCallback((lineNumber: number) => {
    revealPreviewLineRef.current(lineNumber);
  }, []);

  const handlePreviewSourceClick = useCallback((lineNumber: number) => {
    const editor = useAppStore.getState().editorView;
    if (!editor) return;
    const line = editor.line(lineNumber);
    setActiveEditorLine(line.number);
    editor.setSelection(line.from);
    revealEditorLineRef.current(line.number);
    editor.focus();
  }, []);

  useEffect(() => {
    if (mode !== 'split' || !editorView || !previewScrollElement) return undefined;

    const editorViewport: ObservableScrollViewport = editorView;
    const previewViewport = createElementScrollViewport(previewScrollElement);
    const programmaticScrollTargets = programmaticScrollTargetsRef.current;

    let editorToPreviewAnchors: ScrollAnchor[] = [];
    let previewToEditorAnchors: ScrollAnchor[] = [];
    let editorMax = 0;
    let previewMax = 0;
    const editorToPreviewRange: ScrollRange = { sourceMax: 0, targetMax: 0 };
    const previewToEditorRange: ScrollRange = { sourceMax: 0, targetMax: 0 };
    const rebuildScrollAnchors = () => {
      editorMax = Math.max(0, editorViewport.getScrollHeight() - editorViewport.getClientHeight());
      previewMax = Math.max(0, previewViewport.getScrollHeight() - previewViewport.getClientHeight());
      editorToPreviewRange.sourceMax = editorMax;
      editorToPreviewRange.targetMax = previewMax;
      previewToEditorRange.sourceMax = previewMax;
      previewToEditorRange.targetMax = editorMax;
      const previewBounds = previewScrollElement.getBoundingClientRect();
      const anchorsByLine = new Map<number, ScrollAnchor>();

      previewScrollElement.querySelectorAll<HTMLElement>('[data-source-line]').forEach((element) => {
        const lineNumber = Number(element.dataset.sourceLine);
        if (!Number.isFinite(lineNumber) || anchorsByLine.has(lineNumber)) return;
        const targetTop = element.getBoundingClientRect().top
          - previewBounds.top
          + previewScrollElement.scrollTop;
        anchorsByLine.set(lineNumber, {
          sourceTop: Math.max(0, Math.min(editorView.getTopForLineNumber(lineNumber), editorMax)),
          targetTop: Math.max(0, Math.min(targetTop, previewMax)),
        });
      });

      const nextEditorAnchors = [
        { sourceTop: 0, targetTop: 0 },
        ...anchorsByLine.values(),
        { sourceTop: editorMax, targetTop: previewMax },
      ];
      editorToPreviewAnchors = nextEditorAnchors;
      previewToEditorAnchors = nextEditorAnchors.map((anchor) => ({
        sourceTop: anchor.targetTop,
        targetTop: anchor.sourceTop,
      }));
    };
    rebuildScrollAnchors();

    const stopPendingScrollSync = () => {
      pendingScrollSync.current = null;
      if (scrollSyncFrame.current !== null) {
        window.cancelAnimationFrame(scrollSyncFrame.current);
        scrollSyncFrame.current = null;
      }
    };
    const alignEditorLineWithPreview = (lineNumber: number, direction: 'editor-to-preview' | 'preview-to-editor') => {
      const target = findActiveSourceElement(previewScrollElement, lineNumber);
      if (!target) return;

      const editorBounds = editorView.scrollDOM.getBoundingClientRect();
      const previewBounds = previewScrollElement.getBoundingClientRect();
      const targetBounds = target.getBoundingClientRect();
      const editorLineTop = editorView.getTopForLineNumber(lineNumber);
      stopPendingScrollSync();

      if (direction === 'editor-to-preview') {
        const editorLineScreenTop = editorBounds.top + editorLineTop - editorViewport.getScrollTop();
        const targetContentTop = previewViewport.getScrollTop() + targetBounds.top - previewBounds.top;
        const previewMaxScroll = Math.max(0, previewViewport.getScrollHeight() - previewViewport.getClientHeight());
        const nextTop = getAlignedScrollTop(previewBounds.top, targetContentTop, editorLineScreenTop, previewMaxScroll);
        if (Math.abs(previewViewport.getScrollTop() - nextTop) >= 0.5) {
          programmaticScrollTargets.set(previewViewport, nextTop);
          previewViewport.setScrollTop(nextTop);
        }

        const previewTargetScreenTop = previewBounds.top + targetContentTop - nextTop;
        const editorMaxScroll = Math.max(0, editorViewport.getScrollHeight() - editorViewport.getClientHeight());
        const fallbackEditorTop = getAlignedScrollTop(editorBounds.top, editorLineTop, previewTargetScreenTop, editorMaxScroll);
        if (Math.abs(editorViewport.getScrollTop() - fallbackEditorTop) >= 0.5) {
          programmaticScrollTargets.set(editorViewport, fallbackEditorTop);
          editorViewport.setScrollTop(fallbackEditorTop);
        }
        return;
      }

      const previewTargetScreenTop = targetBounds.top;
      const editorMaxScroll = Math.max(0, editorViewport.getScrollHeight() - editorViewport.getClientHeight());
      const nextTop = getAlignedScrollTop(editorBounds.top, editorLineTop, previewTargetScreenTop, editorMaxScroll);
      if (Math.abs(editorViewport.getScrollTop() - nextTop) >= 0.5) {
        programmaticScrollTargets.set(editorViewport, nextTop);
        editorViewport.setScrollTop(nextTop);
      }

      const editorLineScreenTop = editorBounds.top + editorLineTop - nextTop;
      const targetContentTop = previewViewport.getScrollTop() + targetBounds.top - previewBounds.top;
      const previewMaxScroll = Math.max(0, previewViewport.getScrollHeight() - previewViewport.getClientHeight());
      const fallbackPreviewTop = getAlignedScrollTop(previewBounds.top, targetContentTop, editorLineScreenTop, previewMaxScroll);
      if (Math.abs(previewViewport.getScrollTop() - fallbackPreviewTop) >= 0.5) {
        programmaticScrollTargets.set(previewViewport, fallbackPreviewTop);
        previewViewport.setScrollTop(fallbackPreviewTop);
      }
    };
    const revealPreviewLine = (lineNumber: number) => alignEditorLineWithPreview(lineNumber, 'editor-to-preview');
    const revealEditorLine = (lineNumber: number) => alignEditorLineWithPreview(lineNumber, 'preview-to-editor');
    revealPreviewLineRef.current = revealPreviewLine;
    revealEditorLineRef.current = revealEditorLine;

    const syncScroll = (
      source: ObservableScrollViewport,
      target: ObservableScrollViewport,
      anchors: ScrollAnchor[],
      range: ScrollRange,
    ) => {
      const ignoredTop = programmaticScrollTargets.get(source);
      if (ignoredTop !== undefined) {
        programmaticScrollTargets.delete(source);
        if (Math.abs(source.getScrollTop() - ignoredTop) < 0.5) return;
      }

      pendingScrollSync.current = { source, target, anchors, range };
      if (scrollSyncFrame.current !== null) return;

      scrollSyncFrame.current = window.requestAnimationFrame(() => {
        scrollSyncFrame.current = null;
        const request = pendingScrollSync.current;
        pendingScrollSync.current = null;
        if (!request) return;

        const { source: latestSource, target: latestTarget, anchors: latestAnchors, range: latestRange } = request;
        const nextTop = getSyncedScrollTop(latestSource, latestTarget, latestAnchors, latestRange);

        // A tiny threshold avoids expensive layout work from sub-pixel scroll events
        // while preserving the feel of one-to-one scrolling for long documents.
        if (Math.abs(latestTarget.getScrollTop() - nextTop) < 0.5) return;

        programmaticScrollTargets.set(latestTarget, nextTop);
        latestTarget.setScrollTop(nextTop);
      });
    };

    const syncEditorToPreview = () => syncScroll(
      editorViewport,
      previewViewport,
      editorToPreviewAnchors,
      editorToPreviewRange,
    );
    const syncPreviewToEditor = () => syncScroll(
      previewViewport,
      editorViewport,
      previewToEditorAnchors,
      previewToEditorRange,
    );
    const stopEditorScroll = editorViewport.onScroll(syncEditorToPreview);
    const stopPreviewScroll = previewViewport.onScroll(syncPreviewToEditor);

    let anchorRebuildTimer: number | null = null;
    const scheduleAnchorRebuild = () => {
      if (anchorRebuildTimer !== null) window.clearTimeout(anchorRebuildTimer);
      anchorRebuildTimer = window.setTimeout(() => {
        anchorRebuildTimer = null;
        rebuildScrollAnchors();
        syncEditorToPreview();
      }, 80);
    };
    const geometryObserver = new ResizeObserver(scheduleAnchorRebuild);
    geometryObserver.observe(previewScrollElement);
    const previewDocument = previewScrollElement.querySelector<HTMLElement>('.preview-document');
    if (previewDocument) geometryObserver.observe(previewDocument);
    const editorContent = editorView.scrollDOM.querySelector<HTMLElement>('.lines-content');
    if (editorContent) geometryObserver.observe(editorContent);

    // Rendering Markdown, images or diagrams changes preview geometry. Keep
    // the editor as the source of truth and realign once the new layout exists.
    syncEditorToPreview();

    return () => {
      stopEditorScroll();
      stopPreviewScroll();
      geometryObserver.disconnect();
      if (anchorRebuildTimer !== null) window.clearTimeout(anchorRebuildTimer);

      if (scrollSyncFrame.current !== null) {
        window.cancelAnimationFrame(scrollSyncFrame.current);
        scrollSyncFrame.current = null;
      }

      pendingScrollSync.current = null;
      programmaticScrollTargets.clear();
      if (revealPreviewLineRef.current === revealPreviewLine) revealPreviewLineRef.current = () => undefined;
      if (revealEditorLineRef.current === revealEditorLine) revealEditorLineRef.current = () => undefined;
    };
  }, [mode, editorView, previewScrollElement, previewRenderVersion]);

  return (
    <div className={`app ${immersivePolicy.active ? 'immersive-mode-active' : ''} ${mode === 'zen' ? 'zen-mode' : ''}`}>
      <UiLanguageBridge />
      <TitleBar onRequestClose={requestAppClose} />
      <div className="app-workbench">
        <ActivityBar
          activeView={activityView}
          chatbotVisible={chatbotVisible}
          settingsOpen={settingsOpen}
          immersive={mode === 'immersive'}
          zen={mode === 'zen'}
          theme={settings.appearance.theme}
          onSelectView={selectActivityView}
          onOpenChat={() => setChatbotVisible(!chatbotVisible)}
          onOpenSettings={() => setSettingsOpen(true)}
          onToggleTheme={toggleThemeVariant}
          onSelectImmersive={() => useAppStore.getState().setMode('immersive')}
          onSelectZen={() => useAppStore.getState().setMode('zen')}
          onExitImmersive={() => useAppStore.getState().setMode('split')}
        />
        <div className="app-workbench-content">
          <div className="app-body">
          {mode === 'split' && (sidebarVisible || outlineVisible) && (
          <>
            <Sidebar style={{ width: sidebarWidth }} view={activityView} />
            <div
              ref={sidebarDividerRef}
              className="sidebar-divider resizable"
              onMouseDown={handleSidebarMouseDown}
            />
          </>
          )}
          <div className="workspace-shell">
        <main className={`main-content ${mode}`}>
          {mode === 'split' ? (
            <>
              <section className="document-pane editor-workspace-pane" style={{ flex: splitRatio }}>
                <div className="document-pane-tabs">
                  <TabsBar />
                </div>
                {settings.editor.pin_toolbar && (
                  <div className="editor-pane-toolbar">
                    <Toolbar />
                  </div>
                )}
                <Editor
                  className="editor-pane"
                  onActiveLineChange={setActiveEditorLine}
                  onActiveLineReveal={handleEditorLineReveal}
                />
              </section>
              <div
                ref={dividerRef}
                className="divider resizable"
                onMouseDown={handleSplitMouseDown}
              />
              <section className="document-pane preview-workspace-pane" style={{ flex: 1 - splitRatio }}>
                <div className="document-pane-tabs">
                  <TabsBar />
                </div>
                {settings.editor.pin_toolbar && <div className="preview-toolbar-offset" aria-hidden="true" />}
                <div className="preview-with-panel">
                  <Preview
                    className="preview-pane"
                    style={{ flex: 1 }}
                    activeEditorLine={activeEditorLine}
                    onSourceLineClick={handlePreviewSourceClick}
                    onScrollContainerReady={handlePreviewScrollContainerReady}
                    onContentRendered={handlePreviewContentRendered}
                  />
                  {proofreadResults.length > 0 && (
                    <>
                      <div
                        ref={proofreadDividerRef}
                        className="proofread-divider resizable"
                        onMouseDown={handleProofreadMouseDown}
                      />
                      <div className="proofread-side-panel" style={{ width: proofreadPanelWidth }}>
                        <div className="proofread-side-header">
                          <h4>校对建议 ({proofreadResults.length})</h4>
                          <button className="close-btn" onClick={() => {
                            setProofreadPanelVisible(false);
                            useAIStore.getState().clearResults();
                          }}>×</button>
                        </div>
                        <div className="proofread-side-list">
                          {proofreadResults.map((result, index) => (
                            <div key={index} className="proofread-side-item">
                              <div className="proofread-type-badge" data-type={result.type}>
                                {result.type === 'spelling' ? '错字' :
                                 result.type === 'grammar' ? '语法' :
                                 result.type === 'punctuation' ? '标点' :
                                 result.type === 'markdown' ? 'MD语法' :
                                 result.type === 'layout' ? '排版' : '风格'}
                              </div>
                              <div className="proofread-content">
                                <div className="original-text">
                                  <span className="label">原文:</span>
                                  <span className="text strikethrough">{result.original}</span>
                                </div>
                                <div className="suggestion-text">
                                  <span className="label">建议:</span>
                                  <span className="text highlight">{result.suggestion}</span>
                                </div>
                                <div className="explanation-text">{result.explanation}</div>
                              </div>
                              <button
                                className="apply-fix-btn"
                                onClick={() => useAIStore.getState().applyProofreadFix(result)}
                              >
                                应用
                              </button>
                              <button
                                className="proofread-ignore-btn"
                                onClick={() => useAIStore.getState().ignoreProofreadResult(result)}
                              >
                                忽略
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </section>
            </>
          ) : (
            <section
              className={`immersive-workspace immersive-${immersivePolicy.kind}`}
              aria-label={mode === 'zen' ? '沉浸写作' : '沉浸阅读'}
            >
              {immersivePolicy.showOutline && (
                <ImmersiveOutline
                  mode={mode}
                  collapsed={immersiveOutlineCollapsed}
                  previewScrollElement={immersivePreviewScrollElement}
                  onToggle={() => setImmersiveOutlineCollapsed((collapsed) => !collapsed)}
                />
              )}
              <div className="immersive-document-area">
                <header className="immersive-command-strip">
                  {immersivePolicy.showEditorToolbar && settings.editor.pin_toolbar ? (
                    <div className="immersive-writing-toolbar" aria-label="编辑器快捷工具栏">
                      <Toolbar />
                    </div>
                  ) : (
                    <div className="immersive-reading-label">
                      <span aria-hidden="true">◫</span>
                      <strong>沉浸阅读</strong>
                    </div>
                  )}
                  <div className="immersive-command-actions">
                    <button
                      className={`immersive-control-button ${chatbotVisible ? 'is-active' : ''}`}
                      type="button"
                      onClick={() => setChatbotVisible(!chatbotVisible)}
                      title={chatbotVisible ? '收起 AI 对话' : '打开 AI 对话'}
                      aria-pressed={chatbotVisible}
                    >
                      <span className="immersive-ai-button-mark" aria-hidden="true">AI</span>
                      <span>对话</span>
                    </button>
                    <button
                      className="immersive-control-button"
                      type="button"
                      onClick={() => useAppStore.getState().setMode('split')}
                      title={`退出${mode === 'zen' ? '沉浸写作' : '沉浸阅读'} (Esc)`}
                    >
                      <span aria-hidden="true">↙</span>
                      <span>退出</span>
                    </button>
                  </div>
                </header>
                <div className="immersive-document-surface">
                  {mode === 'zen' ? (
                    <Editor
                      className="zen-editor-pane"
                      onActiveLineChange={setActiveEditorLine}
                      onActiveLineReveal={handleEditorLineReveal}
                    />
                  ) : (
                    <Preview
                      className="immersive-preview"
                      activeEditorLine={activeEditorLine}
                      onSourceLineClick={handlePreviewSourceClick}
                      onScrollContainerReady={setImmersivePreviewScrollElement}
                    />
                  )}
                </div>
              </div>
            </section>
          )}
        </main>
          </div>
          {chatbotVisible && (
          <>
            <div
              ref={chatbotDividerRef}
              className={`chatbot-divider resizable ${immersivePolicy.active ? 'immersive-chatbot-divider' : ''}`}
              onMouseDown={handleChatbotMouseDown}
            />
            <div className={`chatbot-side-panel ${immersivePolicy.active ? 'immersive-chatbot-panel' : ''}`} style={{ width: chatbotPanelWidth }}>
              <AIChatbotPanel />
            </div>
          </>
          )}
          </div>
        </div>
      </div>
      <StatusBar />
      {settingsOpen && <SettingsPanel />}
      <PdfReaderPanel />
      <AICompanionPopup />
      <AITranslationPopup
        originalText={translationOriginal}
        translatedText={translationResult}
        position={translationPosition}
        onClose={() => setTranslationVisible(false)}
        onApply={(text) => {
          const { editorView, content } = useAppStore.getState();
          const selection = editorView?.state.selection.main;
          const from = selection?.from ?? content.length;
          const to = selection?.to ?? content.length;
          useAIStore.getState().proposeEdit({
            kind: 'translation',
            reason: 'AI 翻译：请核对术语、人名和数字等可能影响事实准确性的内容。',
            before: content.slice(from, to),
            after: text,
            from,
            to,
          });
          setTranslationVisible(false);
        }}
      />
      <AIDiffConfirmDialog />
      <ConverterDialog
        action={useAppStore(state => state.converterDialog)}
        onClose={() => useAppStore.getState().showConverterDialog(null)}
      />
      {closePromptTabs && (
        <UnsavedChangesDialog tabs={closePromptTabs} onAction={resolveClosePrompt} />
      )}
    </div>
  );
}

export default App;
