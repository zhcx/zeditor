import { useEffect, useRef, useCallback, useState, lazy, Suspense } from 'react';
import { useAppStore } from './stores/appStore';
import { useAIStore } from './stores/aiStore';
import { useWebDavStore } from './stores/webdavStore';
import { useS3Store } from './stores/s3Store';
import { TabsBar } from './components/TabsBar/TabsBar';
import { Toolbar } from './components/Toolbar/Toolbar';
import { Editor } from './components/Editor/Editor';
import { Preview } from './components/Preview/Preview';
import { StatusBar } from './components/StatusBar/StatusBar';
import { Sidebar } from './components/Sidebar/Sidebar';
import { TitleBar } from './components/TitleBar/TitleBar';
import { ActivityBar } from './components/ActivityBar/ActivityBar';
import { UiLanguageBridge } from './i18n/UiLanguageBridge';

// 条件渲染的重型面板按需加载：设置面板、AI 对话、导出与确认对话框等都
// 不在首帧出现，懒加载可以显著缩小启动关键路径的入口 chunk。
const SettingsPanel = lazy(() => import('./components/Settings/SettingsPanel').then(m => ({ default: m.SettingsPanel })));
const AICompanionPopup = lazy(() => import('./components/AI/AICompanionPopup').then(m => ({ default: m.AICompanionPopup })));
const AITranslationPopup = lazy(() => import('./components/AI/AITranslationPopup').then(m => ({ default: m.AITranslationPopup })));
const AIDiffConfirmDialog = lazy(() => import('./components/AI/AIDiffConfirmDialog').then(m => ({ default: m.AIDiffConfirmDialog })));
const AIChatbotPanel = lazy(() => import('./components/Chatbot/AIChatbotPanel').then(m => ({ default: m.AIChatbotPanel })));
const ImmersiveOutline = lazy(() => import('./components/Immersive/ImmersiveOutline').then(m => ({ default: m.ImmersiveOutline })));
const UnsavedChangesDialog = lazy(() => import('./components/UnsavedChangesDialog/UnsavedChangesDialog').then(m => ({ default: m.UnsavedChangesDialog })));
const ConverterDialog = lazy(() => import('./components/ConverterDialog/ConverterDialog').then(m => ({ default: m.ConverterDialog })));
const PresentationView = lazy(() => import('./components/Presentation/PresentationView').then(m => ({ default: m.PresentationView })));
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { message, save as chooseSaveFile } from '@tauri-apps/plugin-dialog';
import { createElementScrollViewport, getSyncedScrollTop, type ObservableScrollViewport, type ScrollAnchor, type ScrollRange } from './utils/scrollSync';
import { getImmersiveWorkspacePolicy } from './utils/immersiveWorkspace';
import { guardWindowClose, type CloseGuardTab, type UnsavedChangesAction } from './utils/windowCloseGuard';
import { resolveSaveBaseName } from './utils/saveName';
import { findActiveSourceElement } from './utils/activeSourceLine';
import { isMediaFilePath } from './utils/media';
import { insertMediaFromPath } from './services/mediaAssets';
import './styles/main.css';
import './styles/workbench.css';
import { contentFontStack } from './utils/appearanceSettings';

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
  const converterDialog = useAppStore(state => state.converterDialog);
  const { proofreadResults, setProofreadPanelVisible, translationPosition, translationOriginal, translationResult, setTranslationVisible, chatbotVisible, setChatbotVisible, companionVisible, pendingEdit } = useAIStore();

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
  const [activityView, setActivityView] = useState<'explorer' | 'search'>('explorer');
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
  const closeCancelled = useRef(false);
  const [closeSaving, setCloseSaving] = useState(false);
  const [presentationVisible, setPresentationVisible] = useState(false);
  const closePresentation = useCallback(() => setPresentationVisible(false), []);
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
    if (action === 'cancel') closeCancelled.current = true;
    if (action === 'save') setCloseSaving(true);
    else setClosePromptTabs(null);
    resolve?.(action);
  }, []);

  const requestAppClose = useCallback(async (installerPath?: string) => {
    if (!('__TAURI_INTERNALS__' in window) || closeGuardInProgress.current) return;
    closeGuardInProgress.current = true;
    closeCancelled.current = false;

    try {
      const result = await guardWindowClose(useAppStore.getState().tabs, {
        promptAction: promptUnsavedChanges,
        getTabs: () => useAppStore.getState().tabs,
        isCancelled: () => closeCancelled.current,
        chooseSavePath: async tab => {
          // 与 TabsBar/另存为保持一致：未命名文档先尝试 AI 文件名建议。
          const fullTab = useAppStore.getState().tabs.find(item => item.id === tab.id);
          const baseName = await resolveSaveBaseName(tab.title, fullTab?.content || '');
          const selected = await chooseSaveFile({
            title: `保存“${tab.title}”`,
            defaultPath: `${baseName}.md`,
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
        if (installerPath) {
          try {
            await invoke('finalize_update_install', { installerPath });
          } catch (error) {
            await message(`安装失败：${String(error)}`, { title: '更新失败', kind: 'error' });
          }
          return;
        }
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
      setClosePromptTabs(null);
      setCloseSaving(false);
    }
  }, [promptUnsavedChanges]);

  useEffect(() => {
    const install = (event: Event) => {
      const path = (event as CustomEvent<string>).detail;
      if (typeof path === 'string') void requestAppClose(path);
    };
    window.addEventListener('zeditor-install-update', install);
    return () => window.removeEventListener('zeditor-install-update', install);
  }, [requestAppClose]);

  // 演示模式：监听来自菜单/工具栏的演示请求事件
  useEffect(() => {
    const startPresentation = () => setPresentationVisible(true);
    window.addEventListener('zeditor-presentation-request', startPresentation);
    return () => window.removeEventListener('zeditor-presentation-request', startPresentation);
  }, []);

  useEffect(() => {
    const interval = settings.editor.auto_save_interval;
    if (!Number.isFinite(interval) || interval <= 0) return;
    let running = false;
    const timer = window.setInterval(async () => {
      if (running || closeGuardInProgress.current || useAppStore.getState().isSaving) return;
      running = true;
      try {
        for (const tab of useAppStore.getState().tabs) {
          if (tab.modified && tab.path) await useAppStore.getState().saveTab(tab.id, tab.path);
        }
      } catch (error) {
        useAIStore.getState().setStatus('error', `自动保存失败：${String(error)}`);
      } finally {
        running = false;
      }
    }, Math.max(1000, interval));
    return () => window.clearInterval(timer);
  }, [settings.editor.auto_save_interval]);

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
    void loadSettings().then(() => {
      useWebDavStore.getState().initialize(useAppStore.getState().settings.webdav);
      useS3Store.getState().initialize(useAppStore.getState().settings.s3);
    });
  }, [loadSettings]);

  // 应用就绪后淡出内置启动页。原生窗口由 Rust 侧在 setup 中立即显示
  // （背景色与主题一致），这里不再负责 show，避免把窗口可见性绑定到
  // 前端加载进度；1.5s 超时兜底防止极端情况下启动页滞留。
  useEffect(() => {
    const hideBootSplash = () => {
      document.getElementById('boot-splash')?.classList.add('boot-splash-hide');
    };
    const removeBootSplash = () => document.getElementById('boot-splash')?.remove();

    const fallbackTimer = window.setTimeout(hideBootSplash, 1500);
    let removeTimer = 0;
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => {
      window.clearTimeout(fallbackTimer);
      hideBootSplash();
      removeTimer = window.setTimeout(removeBootSplash, 300);
    }));
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(fallbackTimer);
      window.clearTimeout(removeTimer);
    };
  }, []);

  const currentFile = useAppStore(state => state.currentFile);
  useEffect(() => {
    useWebDavStore.getState().setCurrentDocument(currentFile);
    useS3Store.getState().setCurrentDocument(currentFile);
  }, [currentFile]);

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
    const root = document.documentElement;
    root.style.setProperty('--font-sans', contentFontStack(settings.appearance.ui_font_family));
    root.style.setProperty('--font-content', contentFontStack(settings.appearance.font_family));
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
        // 视频 / 音频按素材处理：复制到文档资源目录并插入媒体语法，
        // 而不是当作文档打开。
        if (isMediaFilePath(path)) {
          await insertMediaFromPath(path);
          continue;
        }
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

  // Pointer Events with capture keep the drag attached to the divider even when
  // the pointer leaves the window, which makes resizing feel continuous instead
  // of dropping input at the webview edge.
  const beginPanelDrag = useCallback((e: React.PointerEvent, flag: React.MutableRefObject<boolean>, ref: React.RefObject<HTMLDivElement | null>) => {
    e.preventDefault();
    flag.current = true;
    const handle = ref.current;
    handle?.setPointerCapture?.(e.pointerId);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    // Block scroll chaining while a split is being resized so wheel/touchpad
    // gestures cannot fight the drag.
    document.documentElement.style.overscrollBehavior = 'none';
    dragBounds.current = handle?.parentElement?.getBoundingClientRect() || null;
    layoutWidth.current = (handle?.closest('.app-body') as HTMLElement | null)?.clientWidth ?? null;
    document.documentElement.classList.add('panel-resizing');
  }, []);

  const handleSplitPointerDown = useCallback((e: React.PointerEvent) => {
    beginPanelDrag(e, isDragging, dividerRef);
  }, [beginPanelDrag]);

  const handleSplitPointerMove = useCallback((e: PointerEvent) => {
    if (!isDragging.current) return;

    scheduleDragFrame('split', e.clientX);
  }, [scheduleDragFrame]);

  const handleSidebarPointerDown = useCallback((e: React.PointerEvent) => {
    beginPanelDrag(e, isDraggingSidebar, sidebarDividerRef);
  }, [beginPanelDrag]);

  const handleSidebarPointerMove = useCallback((e: PointerEvent) => {
    if (!isDraggingSidebar.current) return;

    scheduleDragFrame('sidebar', e.clientX);
  }, [scheduleDragFrame]);

  const handleProofreadPointerDown = useCallback((e: React.PointerEvent) => {
    beginPanelDrag(e, isDraggingProofread, proofreadDividerRef);
  }, [beginPanelDrag]);

  const handleProofreadPointerMove = useCallback((e: PointerEvent) => {
    if (!isDraggingProofread.current) return;

    scheduleDragFrame('proofread', e.clientX);
  }, [scheduleDragFrame]);

  const handleChatbotPointerDown = useCallback((e: React.PointerEvent) => {
    beginPanelDrag(e, isDraggingChatbot, chatbotDividerRef);
  }, [beginPanelDrag]);

  const handleChatbotPointerMove = useCallback((e: PointerEvent) => {
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

  const selectActivityView = useCallback((view: 'explorer' | 'search') => {
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

  const handlePointerUp = useCallback(() => {
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
    document.documentElement.style.overscrollBehavior = '';
    document.documentElement.classList.remove('panel-resizing');
  }, [setChatbotPanelWidth, setProofreadPanelWidth, setSidebarWidth, setSplitRatio]);

  useEffect(() => {
    document.addEventListener('pointermove', handleSplitPointerMove);
    document.addEventListener('pointermove', handleSidebarPointerMove);
    document.addEventListener('pointermove', handleProofreadPointerMove);
    document.addEventListener('pointermove', handleChatbotPointerMove);
    document.addEventListener('pointerup', handlePointerUp);
    document.addEventListener('pointercancel', handlePointerUp);
    return () => {
      document.removeEventListener('pointermove', handleSplitPointerMove);
      document.removeEventListener('pointermove', handleSidebarPointerMove);
      document.removeEventListener('pointermove', handleProofreadPointerMove);
      document.removeEventListener('pointermove', handleChatbotPointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
      document.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [handleSplitPointerMove, handleSidebarPointerMove, handleProofreadPointerMove, handleChatbotPointerMove, handlePointerUp]);

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
    // 跳转定位采用「目标块吸附到窗格上部固定锚点」的模型：双向行为一致、
    // 目标永远落在可预期的位置，替代原先的镜像对齐公式——长短段混排时
    // 两侧互相回算容易产生越顶/抖动，且目标常被压在窗格最顶端。
    const REVEAL_TOP_OFFSET = 88;
    const revealViewportTo = (
      viewport: ObservableScrollViewport,
      desiredTop: number,
      maxTop: number,
    ) => {
      const nextTop = Math.max(0, Math.min(desiredTop - REVEAL_TOP_OFFSET, maxTop));
      if (Math.abs(viewport.getScrollTop() - nextTop) < 0.5) return;
      markProgrammaticWrite(viewport);
      viewport.setScrollTop(nextTop);
    };
    const alignEditorLineWithPreview = (lineNumber: number, direction: 'editor-to-preview' | 'preview-to-editor') => {
      const target = findActiveSourceElement(previewScrollElement, lineNumber);
      if (!target) return;

      stopPendingScrollSync();

      if (direction === 'editor-to-preview') {
        const previewMax = Math.max(0, previewViewport.getScrollHeight() - previewViewport.getClientHeight());
        // 目标块在预览文档坐标系中的绝对 top（含已滚动距离）。
        const blockDocumentTop = target.getBoundingClientRect().top
          - previewScrollElement.getBoundingClientRect().top
          + previewViewport.getScrollTop();
        revealViewportTo(previewViewport, blockDocumentTop, previewMax);
        return;
      }

      const editorMax = Math.max(0, editorViewport.getScrollHeight() - editorViewport.getClientHeight());
      revealViewportTo(editorViewport, editorView.getTopForLineNumber(lineNumber), editorMax);
    };
    const revealPreviewLine = (lineNumber: number) => alignEditorLineWithPreview(lineNumber, 'editor-to-preview');
    const revealEditorLine = (lineNumber: number) => alignEditorLineWithPreview(lineNumber, 'preview-to-editor');
    revealPreviewLineRef.current = revealPreviewLine;
    revealEditorLineRef.current = revealEditorLine;

    // 程序化滚动的回声抑制窗口：由本模块发起的滚动（同步对齐、段落跳转）
    // 在窗口期内触发的事件一律忽略。此前按「实际落点与期望值之差」判断，
    // 一旦被边界钳制或平滑动画改变落点，就会把自己的写入当作用户滚动
    // 反向同步回来——锚点是段落粒度，编辑器因此肉眼可见地整行跳动。
    const PROGRAMMATIC_SUPPRESS_MS = 260;
    const markProgrammaticWrite = (viewport: ObservableScrollViewport) => {
      programmaticScrollTargets.set(viewport, performance.now() + PROGRAMMATIC_SUPPRESS_MS);
    };

    const syncScroll = (
      source: ObservableScrollViewport,
      target: ObservableScrollViewport,
      anchors: ScrollAnchor[],
      range: ScrollRange,
    ) => {
      const suppressUntil = programmaticScrollTargets.get(source);
      if (suppressUntil !== undefined) {
        if (performance.now() < suppressUntil) return;
        programmaticScrollTargets.delete(source);
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

        markProgrammaticWrite(latestTarget);
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
              onPointerDown={handleSidebarPointerDown}
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
                onPointerDown={handleSplitPointerDown}
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
                        onPointerDown={handleProofreadPointerDown}
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
                <Suspense fallback={null}>
                  <ImmersiveOutline
                    mode={mode}
                    collapsed={immersiveOutlineCollapsed}
                    previewScrollElement={immersivePreviewScrollElement}
                    onToggle={() => setImmersiveOutlineCollapsed((collapsed) => !collapsed)}
                  />
                </Suspense>
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
              onPointerDown={handleChatbotPointerDown}
            />
            <div className={`chatbot-side-panel ${immersivePolicy.active ? 'immersive-chatbot-panel' : ''}`} style={{ width: chatbotPanelWidth }}>
              <Suspense fallback={null}>
                <AIChatbotPanel />
              </Suspense>
            </div>
          </>
          )}
          </div>
        </div>
      </div>
      <StatusBar />
      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsPanel />
        </Suspense>
      )}
      {companionVisible && (
        <Suspense fallback={null}>
          <AICompanionPopup />
        </Suspense>
      )}
      {translationPosition && (
        <Suspense fallback={null}>
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
        </Suspense>
      )}
      {pendingEdit && (
        <Suspense fallback={null}>
          <AIDiffConfirmDialog />
        </Suspense>
      )}
      {converterDialog && (
        <Suspense fallback={null}>
          <ConverterDialog
            action={converterDialog}
            onClose={() => useAppStore.getState().showConverterDialog(null)}
          />
        </Suspense>
      )}
      {closePromptTabs && (
        <Suspense fallback={null}>
          <UnsavedChangesDialog tabs={closePromptTabs} busy={closeSaving} onAction={resolveClosePrompt} />
        </Suspense>
      )}
      {presentationVisible && (
        <Suspense fallback={null}>
          <PresentationView onExit={closePresentation} />
        </Suspense>
      )}
    </div>
  );
}

export default App;
