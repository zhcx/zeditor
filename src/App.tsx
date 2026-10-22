import { PanelDivider } from './components/Layout/PanelDivider';
import { fitPanelWidths } from './utils/panelSizing';
import { AppIcon } from './components/Icons/AppIcon';
import { useShallow } from 'zustand/react/shallow';
import { useEffect, useRef, useCallback, useState, lazy, Suspense } from 'react';
import { useAppStore, type WorkspaceMode, type PersistentWorkspaceMode } from './stores/appStore';
import { useAIStore } from './stores/aiStore';
import { useWebDavStore } from './stores/webdavStore';
import { useS3Store } from './stores/s3Store';
import { TabsBar } from './components/TabsBar/TabsBar';
import { Toolbar } from './components/Toolbar/Toolbar';
// 编辑器内核单独加载，使标题栏、资源管理器和预览先完成渲染。
const Editor = lazy(() => import('./components/Editor/Editor').then(m => ({ default: m.Editor })));
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
const RecoveryDialog = lazy(() => import('./components/Recovery/RecoveryDialog').then(m => ({ default: m.RecoveryDialog })));
const FileConflictDialog = lazy(() => import('./components/FileConflict/FileConflictDialog').then(m => ({ default: m.FileConflictDialog })));
const ConverterDialog = lazy(() => import('./components/ConverterDialog/ConverterDialog').then(m => ({ default: m.ConverterDialog })));
const PresentationView = lazy(() => import('./components/Presentation/PresentationView').then(m => ({ default: m.PresentationView })));
const AIPalette = lazy(() => import('./components/AIPalette/AIPalette').then(m => ({ default: m.AIPalette })));
const DocumentSwitcher = lazy(() => import('./components/DocumentSwitcher/DocumentSwitcher').then(m => ({ default: m.DocumentSwitcher })));
const WysiwygEditor = lazy(() => import('./components/Wysiwyg/WysiwygEditor').then(m => ({ default: m.WysiwygEditor })));
const ModeChooserDialog = lazy(() => import('./components/Onboarding/ModeChooserDialog').then(m => ({ default: m.ModeChooserDialog })));
const EncodingDialog = lazy(() => import('./components/Encoding/EncodingDialog').then(m => ({ default: m.EncodingDialog })));
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { initMcpDispatcher } from './services/mcpDispatcher';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { message, save as chooseSaveFile } from '@tauri-apps/plugin-dialog';
import { createElementScrollViewport, getMirroredScrollTop, getSyncedScrollTop, getViewportRatio, type ObservableScrollViewport, type ScrollAnchor, type ScrollRange } from './utils/scrollSync';
import { getImmersiveWorkspacePolicy } from './utils/immersiveWorkspace';
import { guardWindowClose, type CloseGuardTab, type UnsavedChangesAction } from './utils/windowCloseGuard';
import { resolveSaveBaseName } from './utils/saveName';
import { findActiveSourceElement } from './utils/activeSourceLine';
import { isMediaFilePath } from './utils/media';
import { insertMediaFromPath } from './services/mediaAssets';
import { insertImageFromPath } from './services/imageAssets';
import { isImageFilePath } from './utils/imageSyntax';
import './styles/main.css';
import './styles/workbench.css';
import './styles/comfort.css';
import './styles/icons.css';
import './styles/typography.css';
import './styles/wysiwyg.css';
import './styles/reading-view.css';
import './styles/onboarding.css';
// macOS 原生外观层：以 html[data-platform='macos'] 作用域，其他平台不受影响。
// 必须最后加载，才能在既有工作台样式之后覆盖标题栏与控件度量。
import './styles/macos.css';
import { contentFontStack, typographyCssVariables } from './utils/appearanceSettings';
import { resolveEditorDisplay } from './utils/editorDisplay';
import { changedRecoveryTabs, createRecoverySnapshot } from './utils/recovery';
import { LineWidthWheel } from './components/Editor/LineWidthWheel';
import { applyThemeToDocument, toggleThemeMode } from './themes/apply';
import { isMacOS, isNativeMenuActive } from './utils/platform';

interface DragDropPayload {
  paths: string[];
  position: { x: number; y: number };
}

const isTauriRuntime = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/**
 * 把窗口底色与原生外观同步到当前主题。
 *
 * WKWebView 在窗口重绘新区域（缩放、全屏切换）时会先露出自己的不透明白底，
 * 只有把 NSWindow / WebView 的底色也设成主题底色，才看不到这条白带。
 *
 * 注意参数名：@tauri-apps/api 2.11 的 setBackgroundColor 发送的是 `color`，
 * 而 Rust 命令签名是 `value`，直接调用 API 会因缺少 value 静默失败，因此这里
 * 走 invoke，并同时带上两个键以兼容后续版本。
 */
async function syncNativeWindowChrome() {
  if (!isMacOS() || !isTauriRuntime()) return;
  const styles = getComputedStyle(document.documentElement);
  const raw = styles.getPropertyValue('--bg-app').trim() || styles.getPropertyValue('--ui-bg-app').trim();
  const hex = /^#?([\da-f]{3}|[\da-f]{6})$/i.exec(raw)?.[1];
  if (!hex) return;
  const expanded = hex.length === 3 ? hex.split('').map(channel => channel + channel).join('') : hex;
  const rgb = [0, 2, 4].map(offset => Number.parseInt(expanded.slice(offset, offset + 2), 16));
  const color = [...rgb, 255];
  const dark = (document.documentElement.dataset.theme ?? '').endsWith('-dark');
  try {
    await invoke('plugin:window|set_background_color', { label: null, value: color, color });
    await invoke('plugin:window|set_theme', { label: null, value: dark ? 'dark' : 'light' });
  } catch {
    // 非关键装饰：权限缺失时保持系统默认底色，不影响编辑。
  }
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
    recoveryLoaded,
    recoverySnapshots,
    fileConflict,
    loadRecoverySnapshots,
    persistRecoverySnapshot,
    deleteRecoverySnapshot,
    setSplitRatio,
    setSidebarWidth,
    setSidebarVisible,
    setSettingsOpen,
    openFile
  } = useAppStore(useShallow(state => ({ mode: state.mode, settingsOpen: state.settingsOpen, sidebarVisible: state.sidebarVisible, sidebarWidth: state.sidebarWidth, outlineVisible: state.outlineVisible, loadSettings: state.loadSettings, settings: state.settings, splitRatio: state.splitRatio, recoveryLoaded: state.recoveryLoaded, recoverySnapshots: state.recoverySnapshots, fileConflict: state.fileConflict, loadRecoverySnapshots: state.loadRecoverySnapshots, persistRecoverySnapshot: state.persistRecoverySnapshot, deleteRecoverySnapshot: state.deleteRecoverySnapshot, setSplitRatio: state.setSplitRatio, setSidebarWidth: state.setSidebarWidth, setSidebarVisible: state.setSidebarVisible, setSettingsOpen: state.setSettingsOpen, openFile: state.openFile })));
  const editorView = useAppStore(state => state.editorView);
  const activeTabId = useAppStore(state => state.activeTabId);
  const converterDialog = useAppStore(state => state.converterDialog);
  const encodingDialog = useAppStore(state => state.encodingDialog);
  const { proofreadResults, setProofreadPanelVisible, translationPosition, translationOriginal, translationResult, setTranslationVisible, chatbotVisible, setChatbotVisible, companionVisible, pendingEdit } = useAIStore(useShallow(state => ({ proofreadResults: state.proofreadResults, setProofreadPanelVisible: state.setProofreadPanelVisible, translationPosition: state.translationPosition, translationOriginal: state.translationOriginal, translationResult: state.translationResult, setTranslationVisible: state.setTranslationVisible, chatbotVisible: state.chatbotVisible, setChatbotVisible: state.setChatbotVisible, companionVisible: state.companionVisible, pendingEdit: state.pendingEdit })));

  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodyWidth, setBodyWidth] = useState(() => window.innerWidth);
  const [proofreadPreferredWidth, setProofreadPanelWidth] = useState(280);
  const [chatbotPreferredWidth, setChatbotPanelWidth] = useState<number | null>(null);
  const [outlinePreferredWidth, setOutlinePanelWidth] = useState(224);
  const standardMode = mode === 'split' || mode === 'wysiwyg';
  const hasSidebar = standardMode && (sidebarVisible || outlineVisible);
  const hasProofread = standardMode && proofreadResults.length > 0;
  const [previewScrollElement, setPreviewScrollElement] = useState<HTMLDivElement | null>(null);
  /** 设置读取完成前不弹首次选择框，避免闪一下又被持久模式顶掉。 */
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [modeChoiceSaving, setModeChoiceSaving] = useState(false);
  const [previewRenderVersion, setPreviewRenderVersion] = useState(0);
  const [activeEditorLine, setActiveEditorLine] = useState(1);

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
  /** 预览重渲染后请求重建滚动锚点；由分屏同步 effect 注入，避免重建整套监听。 */
  const rebuildScrollAnchorsRef = useRef<() => void>(() => undefined);
  const revealPreviewLineRef = useRef<(lineNumber: number) => void>(() => undefined);
  const revealEditorLineRef = useRef<(lineNumber: number) => void>(() => undefined);
  const closeGuardInProgress = useRef(false);
  const closeCancelled = useRef(false);
  const [closeSaving, setCloseSaving] = useState(false);
  const [presentationVisible, setPresentationVisible] = useState(false);
  const closePresentation = useCallback(() => setPresentationVisible(false), []);
  const [aiPaletteVisible, setAiPaletteVisible] = useState(false);
  const closeAiPalette = useCallback(() => setAiPaletteVisible(false), []);
  const [activityView, setActivityView] = useState<'explorer' | 'search'>('explorer');
  const [documentSwitcherVisible, setDocumentSwitcherVisible] = useState(false);
  // 查询值由 App 持有：输入框本身在标题栏（面板内不再放第二个输入框）。
  const [switcherQuery, setSwitcherQuery] = useState('');
  const switcherInputRef = useRef<HTMLInputElement>(null);
  const closeDocumentSwitcher = useCallback(() => {
    setDocumentSwitcherVisible(false);
    setSwitcherQuery('');
  }, []);

  const saveRecoverySnapshotAs = useCallback(async (snapshotId: string) => {
    const snapshot = useAppStore.getState().recoverySnapshots.find(item => item.id === snapshotId);
    if (!snapshot) return;
    const baseName = resolveSaveBaseName(snapshot.title, snapshot.content);
    const selected = await chooseSaveFile({
      title: '另存恢复的文档',
      defaultPath: `${baseName}.md`,
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
    });
    if (typeof selected !== 'string') return;
    const tabId = useAppStore.getState().addTab({
      title: snapshot.title,
      path: snapshot.path,
      content: snapshot.content,
      encoding: snapshot.encoding,
      modified: true,
      recoveryId: snapshot.id,
      fileVersion: snapshot.fileVersion,
    });
    try {
      await useAppStore.getState().saveTab(tabId, selected);
    } catch (error) {
      useAIStore.getState().setStatus('error', `另存恢复文档失败：${String(error)}`);
    }
  }, []);

  const discardRecoverySnapshot = useCallback((snapshotId: string) => {
    void useAppStore.getState().deleteRecoverySnapshot(snapshotId).catch(error => {
      useAIStore.getState().setStatus('error', `删除恢复快照失败：${String(error)}`);
    });
  }, []);

  const saveConflictCopy = useCallback(async () => {
    const conflict = useAppStore.getState().fileConflict;
    if (!conflict) return;
    const baseName = resolveSaveBaseName(conflict.title, conflict.localContent);
    const selected = await chooseSaveFile({
      title: '另存冲突副本',
      defaultPath: `${baseName}-我的版本.md`,
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
    });
    if (typeof selected !== 'string') return;
    if (selected === conflict.path) {
      useAIStore.getState().setStatus('error', '另存冲突副本请选择不同于原文件的路径。');
      return;
    }
    try {
      await useAppStore.getState().saveTab(conflict.tabId, selected, null);
    } catch (error) {
      useAIStore.getState().setStatus('error', `另存冲突副本失败：${String(error)}`);
    }
  }, []);

  useEffect(() => {
    const openSwitcher = () => { setSwitcherQuery(''); setDocumentSwitcherVisible(true); };
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && !event.isComposing && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        if (document.querySelector('.settings-overlay, .unsaved-dialog-overlay, .modal-overlay, [aria-modal="true"]:not(.document-switcher)')) return;
        setDocumentSwitcherVisible(visible => !visible);
        setSwitcherQuery('');
      }
    };
    window.addEventListener('zeditor-switch-document', openSwitcher);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('zeditor-switch-document', openSwitcher);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  // 面板展开后焦点直接落在标题栏输入框上，输入不再经过面板内部。
  useEffect(() => {
    if (!documentSwitcherVisible) return undefined;
    const frame = window.requestAnimationFrame(() => switcherInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [documentSwitcherVisible]);

  // AI 指令面板：Ctrl/Cmd+J 快捷键或菜单事件打开（VMark 精灵选择器的等价入口）。
  useEffect(() => {
    const openPalette = () => setAiPaletteVisible(true);
    const onKeyDown = (event: KeyboardEvent) => {
      if (isNativeMenuActive()) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'j') {
        event.preventDefault();
        setAiPaletteVisible(visible => !visible);
      }
    };
    window.addEventListener('zeditor-ai-palette', openPalette);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('zeditor-ai-palette', openPalette);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  // 链接检查：菜单「检查链接」/ Ctrl+Alt+V 触发（对齐 VMark 的检查入口），
  // F2 / Shift+F2 在当前检查结果之间循环跳转并用编辑器选中定位。
  useEffect(() => {
    const runCheck = () => { void useAIStore.getState().runLinkCheck(); };
    const navigateResult = (direction: 1 | -1): boolean => {
      const { proofreadResults } = useAIStore.getState();
      const { editorView } = useAppStore.getState();
      if (proofreadResults.length === 0 || !editorView) return false;
      const sorted = [...proofreadResults].sort((left, right) => left.from - right.from);
      const cursor = editorView.getSelection().from;
      const next = direction === 1
        ? sorted.find(result => result.from > cursor) ?? sorted[0]
        : [...sorted].reverse().find(result => result.from < cursor) ?? sorted[sorted.length - 1];
      if (!next) return false;
      useAIStore.getState().setProofreadPanelVisible(true);
      editorView.setSelection(next.from, next.to);
      editorView.revealOffset(next.from);
      editorView.focus();
      return true;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isNativeMenuActive() && (event.ctrlKey || event.metaKey) && event.altKey && !event.shiftKey && event.key.toLowerCase() === 'v') {
        event.preventDefault();
        runCheck();
        return;
      }
      // IME 组合期间不拦截 F2，避免与输入法候选键冲突。
      if (event.key === 'F2' && !event.isComposing) {
        if (navigateResult(event.shiftKey ? -1 : 1)) event.preventDefault();
      }
    };
    window.addEventListener('zeditor-check-links', runCheck);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('zeditor-check-links', runCheck);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);
  const closePromptResolver = useRef<((action: UnsavedChangesAction) => void) | null>(null);
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

  const requestAppClose = useCallback(async (installerPath?: string, closeMode: 'window' | 'quit' = 'window') => {
    if (!isTauriRuntime() || closeGuardInProgress.current) return;
    closeGuardInProgress.current = true;
    closeCancelled.current = false;

    const currentWindow = getCurrentWindow();
    // 从 Dock 菜单或 ⌘Q 退出时窗口可能已隐藏：先抬到前台，
    // 否则未保存确认框会在看不见的窗口里等待。
    if (isMacOS() && closeMode === 'quit') {
      try {
        await currentWindow.show();
        await currentWindow.setFocus();
      } catch {
        // 窗口已销毁时无需恢复。
      }
    }

    try {
      const result = await guardWindowClose(useAppStore.getState().tabs, {
        promptAction: promptUnsavedChanges,
        getTabs: () => useAppStore.getState().tabs,
        isCancelled: () => closeCancelled.current,
        discardTabs: async tabIds => {
          try {
            await useAppStore.getState().discardRecoverySnapshotsForTabs(tabIds);
          } catch (error) {
            await message(`无法清理草稿恢复记录，应用没有关闭：${String(error)}`, {
              title: '恢复记录未能清理',
              kind: 'error',
            });
            throw error;
          }
        },
        chooseSavePath: async tab => {
          // 与另存为保持一致：本地提取文件名，关闭文稿时也不等待 AI。
          const fullTab = useAppStore.getState().tabs.find(item => item.id === tab.id);
          const baseName = resolveSaveBaseName(tab.title, fullTab?.content || '');
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
        // macOS 两种关闭语义：关窗口只隐藏应用（留在 Dock），退出才销毁进程。
        if (isMacOS() && closeMode === 'window') {
          await currentWindow.hide();
          return;
        }
        if (isMacOS()) {
          try {
            await invoke('exit_application');
          } catch (error) {
            console.error('Requesting the native application exit failed.', error);
          }
          return;
        }
        try {
          await currentWindow.destroy();
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

  // Agent 预热：应用启动阶段后台完成 CLI 版本/能力探测（后端按 mtime 缓存）。
  // AI 助手未配置时，伴写、校对等编辑功能会桥接到本地 Agent CLI，预热能让
  // 首次桥接调用省下 1–3 秒探测等待；Agent 面板的首次回合同样受益。
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    const config = settings.agent.backends[settings.agent.backend];
    const tasks: Promise<unknown>[] = [
      invoke('agent_probe_backend', {
        backend: settings.agent.backend,
        executablePath: config?.executable_path?.trim() || null,
      }).catch(() => null),
    ];
    if (!settings.ai.enabled) {
      tasks.push(invoke('agent_probe_backend', { backend: null, executablePath: null }).catch(() => null));
    }
    void Promise.allSettled(tasks);
  }, [settings.agent.backend, settings.agent.backends, settings.ai.enabled]);

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
          if (tab.modified && tab.path && !tab.externalChangePending) await useAppStore.getState().saveTab(tab.id, tab.path);
        }
      } catch (error) {
        useAIStore.getState().setStatus('error', `自动保存失败：${String(error)}`);
      } finally {
        running = false;
      }
    }, Math.max(1000, interval));
    return () => window.clearInterval(timer);
  }, [settings.editor.auto_save_interval]);

  useEffect(() => {
    const checkActiveVersion = () => {
      if (document.visibilityState !== 'visible') return;
      const activeTabId = useAppStore.getState().activeTabId;
      if (activeTabId) void useAppStore.getState().checkFileVersion(activeTabId);
    };
    window.addEventListener('focus', checkActiveVersion);
    document.addEventListener('visibilitychange', checkActiveVersion);
    return () => {
      window.removeEventListener('focus', checkActiveVersion);
      document.removeEventListener('visibilitychange', checkActiveVersion);
    };
  }, []);

  const hasImmersiveOutline = !standardMode && !immersiveOutlineCollapsed;
  const outlineRailWidth = !standardMode && immersiveOutlineCollapsed ? 40 : 0;
  const leftPreferred = hasSidebar ? sidebarWidth : hasImmersiveOutline ? outlinePreferredWidth : 0;
  const proofreadPreferred = hasProofread ? proofreadPreferredWidth : 0;
  const panelSpace = (Number(hasSidebar || hasImmersiveOutline) + Number(hasProofread) + Number(chatbotVisible) + Number(mode === 'split')) * 4;
  const chatPreferred = chatbotVisible
    ? chatbotPreferredWidth ?? Math.max(180, (bodyWidth - leftPreferred - proofreadPreferred - panelSpace - outlineRailWidth) / 3)
    : 0;
  const [leftPanelWidth, proofreadPanelWidth, chatbotPanelWidth] = fitPanelWidths(
    bodyWidth - panelSpace - outlineRailWidth, [leftPreferred, proofreadPreferred, chatPreferred], 240,
  );

  const commitPanelWidth = (panel: 'sidebar' | 'outline' | 'proofread' | 'chatbot', width: number) => {
    // In a constrained window, a deliberate resize starts a new layout from the
    // displayed widths. Refitting old, larger preferences would move the divider
    // again on release. Window resizing alone never changes these preferences.
    const fitted = leftPanelWidth < leftPreferred - 0.5 || proofreadPanelWidth < proofreadPreferred - 0.5 || chatbotPanelWidth < chatPreferred - 0.5;
    if (fitted) {
      if (hasSidebar) setSidebarWidth(panel === 'sidebar' ? width : leftPanelWidth);
      if (hasImmersiveOutline) setOutlinePanelWidth(panel === 'outline' ? width : leftPanelWidth);
      if (hasProofread) setProofreadPanelWidth(panel === 'proofread' ? width : proofreadPanelWidth);
      if (chatbotVisible) setChatbotPanelWidth(panel === 'chatbot' ? width : chatbotPanelWidth);
      return;
    }
    if (panel === 'sidebar') setSidebarWidth(width);
    else if (panel === 'outline') setOutlinePanelWidth(width);
    else if (panel === 'proofread') setProofreadPanelWidth(width);
    else setChatbotPanelWidth(width);
  };

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const observer = new ResizeObserver(([entry]) => setBodyWidth(entry.contentRect.width));
    observer.observe(body);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    void loadSettings().then(async () => {
      const store = useAppStore.getState();
      useWebDavStore.getState().initialize(store.settings.webdav);
      useS3Store.getState().initialize(store.settings.s3);
      // 恢复用户上次选择的编辑方式（未选择过则保持源码对照，并由首次选择框引导）。
      const persisted = store.settings.editor.mode;
      if (persisted === 'split' || persisted === 'wysiwyg') store.setMode(persisted);
      try {
        await loadRecoverySnapshots();
      } catch (error) {
        useAIStore.getState().setStatus('error', `读取草稿恢复记录失败：${String(error)}`);
      }
      setSettingsLoaded(true);
    });
  }, [loadRecoverySnapshots, loadSettings]);

  // 持久化未保存内容，不等待全局设置或标签持久化。
  // 每次输入停顿 900ms 后写入 app config 下的独立恢复快照；Rust 侧负责限额与原子替换。
  useEffect(() => {
    let timer: number | null = null;
    const pendingTabIds = new Set<string>();
    const knownRecoveryIds = new Set(useAppStore.getState().recoverySnapshots.map(snapshot => snapshot.id));
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (!state.recoveryLoaded) return;
      for (const snapshot of state.recoverySnapshots) knownRecoveryIds.add(snapshot.id);
      const changed = previous.recoveryLoaded ? changedRecoveryTabs(state.tabs, previous.tabs) : state.tabs;
      if (changed.length === 0) return;
      for (const tab of changed) pendingTabIds.add(tab.id);
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        const latest = useAppStore.getState();
        const ids = [...pendingTabIds];
        pendingTabIds.clear();
        const pending = ids.map(id => {
          const tab = latest.tabs.find(item => item.id === id);
          if (!tab) return Promise.resolve();
          const snapshot = createRecoverySnapshot(tab);
          const snapshotId = tab.recoveryId || tab.id;
          if (snapshot) {
            knownRecoveryIds.add(snapshotId);
            return persistRecoverySnapshot(snapshot).catch(error => {
              pendingTabIds.add(id);
              throw error;
            });
          }
          if (knownRecoveryIds.has(snapshotId) || tab.recoveryId) {
            return deleteRecoverySnapshot(snapshotId).then(() => { knownRecoveryIds.delete(snapshotId); });
          }
          return Promise.resolve();
        });
        void Promise.all(pending).catch(error => {
          useAIStore.getState().setStatus('error', `写入草稿恢复记录失败：${String(error)}`);
        });
      }, 900);
    });
    return () => {
      unsubscribe();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [deleteRecoverySnapshot, persistRecoverySnapshot]);

  // 应用就绪后淡出内置启动页。原生窗口由 Rust 侧在 setup 中立即显示
  // （背景色与主题一致），这里不再负责 show，避免把窗口可见性绑定到
  // 前端加载进度。
  //
  // 关键在于「就绪」的判定：编辑区是懒加载的，Monaco 的首次布局与文字绘制
  // 又是异步的，而预览的 Markdown 是同步渲染的。若只等 React 首帧（双 rAF）
  // 就淡出，揭开时预览已有内容、编辑区还在加载，看起来就是「预览先出现、
  // 编辑框与资源管理器后出现」。因此这里等编辑区首帧画出 + 字体就绪再揭开，
  // 3s 超时兜底，保证极端情况下启动页不会滞留。
  useEffect(() => {
    let frame = 0;
    let removeTimer = 0;
    let settled = false;
    let fontsReady = false;
    let editorReady = useAppStore.getState().editorBootReady;

    const hideBootSplash = () => {
      document.getElementById('boot-splash')?.classList.add('boot-splash-hide');
    };
    const removeBootSplash = () => document.getElementById('boot-splash')?.remove();
    const scheduleRemoval = () => {
      hideBootSplash();
      removeTimer = window.setTimeout(removeBootSplash, 300);
    };

    const reveal = () => {
      if (settled || !fontsReady || !editorReady) return;
      settled = true;
      window.clearTimeout(fallbackTimer);
      unsubscribe();
      // 双 rAF：确保编辑区那一帧已经提交并真正绘制，再揭开启动页。
      frame = requestAnimationFrame(() => requestAnimationFrame(scheduleRemoval));
    };

    const fallbackTimer = window.setTimeout(() => {
      settled = true;
      unsubscribe();
      scheduleRemoval();
    }, 3000);

    const unsubscribe = useAppStore.subscribe((state) => {
      editorReady = state.editorBootReady;
      reveal();
    });
    void Promise.resolve(document.fonts?.ready).then(() => {
      fontsReady = true;
      reveal();
    });

    return () => {
      unsubscribe();
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

  // macOS：窗口底色与原生外观跟随主题；缩放期间关闭毛玻璃并重新上色，
  // 避免 WKWebView 重绘新区域前露出一条白底。
  useEffect(() => {
    if (!isMacOS() || !isTauriRuntime()) return undefined;
    let resizeTimer: number | null = null;
    const applyChrome = () => { void syncNativeWindowChrome(); };

    applyChrome();
    window.addEventListener('zeditor-theme-change', applyChrome);
    const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
    colorScheme.addEventListener('change', applyChrome);

    const onResize = () => {
      if (resizeTimer === null) {
        document.documentElement.classList.add('window-resizing');
        applyChrome();
      } else {
        window.clearTimeout(resizeTimer);
      }
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        document.documentElement.classList.remove('window-resizing');
      }, 150);
    };
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('zeditor-theme-change', applyChrome);
      colorScheme.removeEventListener('change', applyChrome);
      window.removeEventListener('resize', onResize);
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      document.documentElement.classList.remove('window-resizing');
    };
  }, []);

  // macOS 生命周期：Dock 退出请求走未保存守卫；点按 Dock 图标恢复隐藏的窗口。
  useEffect(() => {
    if (!isMacOS() || !isTauriRuntime()) return undefined;
    const quit = listen('zeditor-quit-requested', () => {
      void requestAppClose(undefined, 'quit');
    });
    const reopened = listen('zeditor-window-reopened', () => {
      const current = getCurrentWindow();
      void current.show().then(() => current.setFocus()).catch(() => undefined);
    });
    return () => {
      void quit.then(fn => fn());
      void reopened.then(fn => fn());
    };
  }, [requestAppClose]);

  // macOS 系统惯例快捷键：⌘, 打开设置，⌃⌘F 切换全屏（与原生菜单同义）。
  useEffect(() => {
    if (!isMacOS()) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key === ',') {
        event.preventDefault();
        setSettingsOpen(true);
        return;
      }
      if (event.ctrlKey && event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        if (!isTauriRuntime()) return;
        const current = getCurrentWindow();
        void current.isFullscreen()
          .then(fullscreen => current.setFullscreen(!fullscreen))
          .catch(() => undefined);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setSettingsOpen]);

  // 沉浸模式是临时态：Esc 回到用户选择的持久模式（默认源码对照）。
  useEffect(() => {
    if (mode === 'split' || mode === 'wysiwyg') return;
    const exitImmersiveWorkspace = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const store = useAppStore.getState();
      store.setMode(store.settings.editor.mode ?? 'split');
    };
    window.addEventListener('keydown', exitImmersiveWorkspace);
    return () => window.removeEventListener('keydown', exitImmersiveWorkspace);
  }, [mode]);

  // Ctrl+Alt+M：在源码对照与所见即所得之间切换；沉浸模式下切到另一种持久模式。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.altKey || event.shiftKey || event.isComposing) return;
      if (event.key.toLowerCase() !== 'm') return;
      event.preventDefault();
      const store = useAppStore.getState();
      // 在两种持久模式之间切换；处于沉浸态时以「持久模式的另一种」为目标。
      const persistent = store.settings.editor.mode === 'wysiwyg' ? 'wysiwyg' : 'split';
      const target: WorkspaceMode = mode === 'wysiwyg'
        ? 'split'
        : mode === 'split'
          ? 'wysiwyg'
          : (persistent === 'wysiwyg' ? 'split' : 'wysiwyg');
      store.setMode(target);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
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
    // Monaco 的行高取整到像素；预览正文沿用同一数值，避免逐行累积偏差。
    root.style.setProperty('--font-content-line-height-px', `${Math.round(settings.appearance.font_size * settings.appearance.line_height)}px`);
    for (const [key, value] of Object.entries(typographyCssVariables({ ui_font_size: settings.appearance.ui_font_size, letter_spacing: settings.appearance.letter_spacing }))) root.style.setProperty(key, value);
  }, [
    settings.appearance.font_family,
    settings.appearance.font_size,
    settings.appearance.line_height,
    settings.appearance.ui_font_family,
    settings.appearance.ui_font_size,
    settings.appearance.letter_spacing,
  ]);

  // 显示增强：限制行宽写到 CSS 变量，折叠与参考线的开关写成 <html> 上的 data-* 标记，
  // 由 reading-view.css / wysiwyg.css 消费；源码模式的折叠与参考线走 Monaco 选项。
  const {
    readable_line_length: readableLineWidth,
    line_width: lineWidth,
    indent_guides: indentGuides,
    fold_indentation: foldIndentation,
  } = settings.editor;
  useEffect(() => {
    const root = document.documentElement;
    const display = resolveEditorDisplay({
      readable_line_length: readableLineWidth,
      line_width: lineWidth,
      indent_guides: indentGuides,
      fold_indentation: foldIndentation,
    });
    root.style.setProperty('--content-width', `${display.lineWidth}%`);
    root.dataset.readableLineWidth = display.readableLineLength ? 'on' : 'off';
    root.dataset.indentGuides = display.indentGuides ? 'on' : 'off';
    root.dataset.foldIndentation = display.foldIndentation ? 'on' : 'off';
  }, [foldIndentation, indentGuides, lineWidth, readableLineWidth]);

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

  // MCP 工具执行器：接收桥接转发的 AI 助手工具调用（设置 → 集成）。
  useEffect(() => {
    void initMcpDispatcher();
  }, []);

  // Listen for Tauri file drop events using webview window
  useEffect(() => {
    // Keep the native drag-and-drop integration out of plain browser previews.
    // Tauri injects this internal bridge for every desktop webview.
    if (!('__TAURI_INTERNALS__' in window)) return undefined;

    const webview = getCurrentWebviewWindow();

    const unlisten = webview.listen<DragDropPayload>('tauri://drag-drop', async (event) => {
      const paths = event.payload.paths;
      for (const path of paths) {
        // 拖入目录：作为工作区根打开（对齐 VMark 的拖放打开工作区），
        // 而不是当作文档读取。探测失败时按文件继续处理。
        try {
          if (await invoke<boolean>('is_directory', { path })) {
            window.dispatchEvent(new CustomEvent('zeditor-open-folder', { detail: { path } }));
            continue;
          }
        } catch {
          // 忽略探测失败，走下方的文件路径。
        }
        // 视频 / 音频按素材处理：复制到文档资源目录并插入媒体语法，
        // 而不是当作文档打开。
        if (isMediaFilePath(path)) {
          await insertMediaFromPath(path);
          continue;
        }
        // 图片同样按素材处理：复制到 .assets 后插入图片语法。
        if (isImageFilePath(path)) {
          await insertImageFromPath(path);
          continue;
        }
        try {
          await openFile(path);
        } catch (error) {
          console.error('Failed to open dropped file:', error);
          if (!String(error).includes('text_encoding_required:')) window.alert(`打开文件失败：${String(error)}`);
        }
      }
    });

    return () => { unlisten.then(fn => fn()); };
  }, [openFile]);

  // 活动栏切换侧栏视图：点当前视图收起侧栏，点另一个视图切换过去。
  const selectActivityView = useCallback((view: 'explorer' | 'search') => {
    if (sidebarVisible && activityView === view) {
      setSidebarVisible(false);
      return;
    }
    setActivityView(view);
    if (!sidebarVisible) setSidebarVisible(true);
  }, [activityView, setSidebarVisible, sidebarVisible]);

  // 命令面板里「搜索当前文档」等入口需要强制切过去，不能复用上面的 toggle 语义；
  // 沉浸/写作模式下侧栏不渲染，因此还要回到分屏模式。
  const revealActivityView = useCallback((view: 'explorer' | 'search') => {
    setActivityView(view);
    setSidebarVisible(true);
    if (mode !== 'split' && mode !== 'wysiwyg') useAppStore.getState().setMode('split');
  }, [mode, setSidebarVisible]);

  useEffect(() => {
    const find = () => {
      if (useAppStore.getState().mode !== 'wysiwyg') return;
      useAppStore.getState().editorView?.flushPendingEdits?.();
      setActivityView('search');
      setSidebarVisible(true);
      requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.document-find-input')?.focus());
    };
    window.addEventListener('zeditor-editor-find', find);
    return () => window.removeEventListener('zeditor-editor-find', find);
  }, [setSidebarVisible]);

  const toggleThemeVariant = useCallback(() => {
    const currentSettings = useAppStore.getState().settings;
    const nextTheme = toggleThemeMode(currentSettings.appearance.theme);
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

  // 首次启动（设置里没有 editor.mode）时引导选择编辑方式；关闭或 Esc 视为选择源码对照。
  const persistedMode = settings.editor.mode;
  const showModeChooser = settingsLoaded && persistedMode !== 'split' && persistedMode !== 'wysiwyg';
  const showRecoveryDialog = settingsLoaded && recoveryLoaded && recoverySnapshots.length > 0 && !showModeChooser && !settingsOpen && !closePromptTabs && !fileConflict;

  const chooseMode = useCallback(async (choice: PersistentWorkspaceMode) => {
    const latest = useAppStore.getState();
    setModeChoiceSaving(true);
    try {
      await latest.saveSettings({ ...latest.settings, editor: { ...latest.settings.editor, mode: choice } });
      latest.setMode(choice);
    } finally {
      setModeChoiceSaving(false);
    }
  }, []);

  useEffect(() => {
    if (!showModeChooser) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      void chooseMode('split');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [chooseMode, showModeChooser]);

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
    // 跳转定位采用「镜像对齐」：点击行在编辑器视口内的相对位置（0 = 贴顶、1 = 贴底），
    // 就是对应块在预览视口内的相对位置——两侧一一对应，而不是把目标一律顶到窗格上沿。
    // 只有一个很小的呼吸位（minOffset）避免目标恰好贴着上沿；文档首尾由范围钳制自然吸附。
    const revealViewportTo = (
      viewport: ObservableScrollViewport,
      nextTop: number,
      maxTop: number,
    ) => {
      const clamped = Math.max(0, Math.min(nextTop, maxTop));
      if (Math.abs(viewport.getScrollTop() - clamped) < 0.5) return;
      markProgrammaticWrite(viewport);
      viewport.setScrollTop(clamped);
    };
    const alignEditorLineWithPreview = (lineNumber: number, direction: 'editor-to-preview' | 'preview-to-editor') => {
      const target = findActiveSourceElement(previewScrollElement, lineNumber);
      if (!target) return;

      stopPendingScrollSync();

      // 目标块在预览文档坐标系中的绝对 top（含已滚动距离）。
      const blockDocumentTop = target.getBoundingClientRect().top
        - previewScrollElement.getBoundingClientRect().top
        + previewViewport.getScrollTop();

      if (direction === 'editor-to-preview') {
        const previewMax = Math.max(0, previewViewport.getScrollHeight() - previewViewport.getClientHeight());
        const ratio = getViewportRatio(
          editorView.getTopForLineNumber(lineNumber),
          editorViewport.getScrollTop(),
          editorViewport.getClientHeight(),
        );
        revealViewportTo(
          previewViewport,
          getMirroredScrollTop(blockDocumentTop, ratio, previewViewport.getClientHeight(), previewMax),
          previewMax,
        );
        return;
      }

      const editorMax = Math.max(0, editorViewport.getScrollHeight() - editorViewport.getClientHeight());
      const ratio = getViewportRatio(
        blockDocumentTop,
        previewViewport.getScrollTop(),
        previewViewport.getClientHeight(),
      );
      revealViewportTo(
        editorViewport,
        getMirroredScrollTop(editorView.getTopForLineNumber(lineNumber), ratio, editorViewport.getClientHeight(), editorMax),
        editorMax,
      );
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
    rebuildScrollAnchorsRef.current = scheduleAnchorRebuild;
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
      if (rebuildScrollAnchorsRef.current === scheduleAnchorRebuild) rebuildScrollAnchorsRef.current = () => undefined;
      if (revealPreviewLineRef.current === revealPreviewLine) revealPreviewLineRef.current = () => undefined;
      if (revealEditorLineRef.current === revealEditorLine) revealEditorLineRef.current = () => undefined;
    };
  }, [mode, editorView, previewScrollElement]);

  // 预览重渲染后重建锚点。此前 previewRenderVersion 是上面 effect 的依赖：
  // 每次渲染都会拆掉并重装两侧滚动监听、3 个 ResizeObserver，还要清空程序化滚动
  // 抑制表——长文档输入时这些重建比锚点本身昂贵得多。scheduleAnchorRebuild 内部
  // 已有 80ms 防抖，连续输入只会在停顿后量一次布局。
  useEffect(() => {
    rebuildScrollAnchorsRef.current();
  }, [previewRenderVersion]);

  return (
    <div className={`app ${immersivePolicy.active ? 'immersive-mode-active' : ''} ${mode === 'zen' ? 'zen-mode' : ''}`}>
      <UiLanguageBridge />
      <TitleBar
        onRequestClose={requestAppClose}
        searchOpen={documentSwitcherVisible}
        searchQuery={switcherQuery}
        onSearchQueryChange={setSwitcherQuery}
        searchInputRef={switcherInputRef}
      />
      <div className="app-workbench">
        <ActivityBar
          chatbotVisible={chatbotVisible}
          settingsOpen={settingsOpen}
          immersive={mode === 'immersive'}
          zen={mode === 'zen'}
          wysiwyg={mode === 'wysiwyg'}
          theme={settings.appearance.theme}
          activeView={activityView}
          sidebarVisible={sidebarVisible}
          onSelectView={selectActivityView}
          onOpenChat={() => setChatbotVisible(!chatbotVisible)}
          onOpenSettings={() => setSettingsOpen(true)}
          onToggleTheme={toggleThemeVariant}
          toolbarPinned={Boolean(settings.editor.pin_toolbar)}
          onToggleToolbar={() => {
            const latest = useAppStore.getState();
            void latest.saveSettings({ ...latest.settings, editor: { ...latest.settings.editor, pin_toolbar: !latest.settings.editor.pin_toolbar } })
              .catch(error => useAIStore.getState().setStatus('error', `保存工具栏设置失败：${String(error)}`));
          }}
          onSelectSplit={() => useAppStore.getState().setMode('split')}
          onSelectWysiwyg={() => useAppStore.getState().setMode('wysiwyg')}
          onSelectImmersive={() => useAppStore.getState().setMode('immersive')}
          onSelectZen={() => useAppStore.getState().setMode('zen')}
          onExitImmersive={() => {
            const store = useAppStore.getState();
            store.setMode(store.settings.editor.mode ?? 'split');
          }}
        />
        <div className="app-workbench-content">
          <div className="app-body" ref={bodyRef}>
          {(mode === 'split' || mode === 'wysiwyg') && (sidebarVisible || outlineVisible) && (
          <>
            <Sidebar style={{ width: leftPanelWidth }} view={activityView} />
            <PanelDivider className="sidebar-divider resizable" label="调整侧栏宽度" side="before"
              onChange={width => commitPanelWidth('sidebar', width)} onReset={() => setSidebarWidth(250)} />
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
                <Suspense fallback={<div className="editor-container editor-pane"><div className="editor-loading-placeholder" role="status">正在加载编辑器…</div></div>}>
                  <Editor
                    className="editor-pane"
                    onActiveLineChange={setActiveEditorLine}
                    onActiveLineReveal={handleEditorLineReveal}
                  />
                </Suspense>
              </section>
              <PanelDivider className="divider resizable" label="调整编辑与预览比例" side="split"
                onChange={setSplitRatio} onReset={() => setSplitRatio(0.5)} />
              <section className="document-pane preview-workspace-pane" style={{ flex: 1 - splitRatio }}>
                <div className="document-pane-tabs">
                  <TabsBar />
                </div>
                {settings.editor.pin_toolbar && (
                  <div className="preview-toolbar-offset preview-pane-actions">
                    <span><span className="preview-live-dot" aria-hidden="true" />实时预览</span>
                    <button type="button" onClick={() => useAppStore.getState().setMode('immersive')} title="隐藏编辑器，专注阅读预览">专注阅读 <span aria-hidden="true"><AppIcon name="arrowUpRight" size={16} /></span></button>
                  </div>
                )}
                <div className="preview-with-panel">
                  <Preview
                    className="preview-pane"
                    style={{ flex: 1 }}
                    activeEditorLine={activeEditorLine}
                    onSourceLineClick={handlePreviewSourceClick}
                    onScrollContainerReady={handlePreviewScrollContainerReady}
                    onContentRendered={handlePreviewContentRendered}
                  />
                </div>
              </section>

            </>
          ) : mode === 'wysiwyg' ? (
            <section className="document-pane wysiwyg-workspace-pane">
              <div className="document-pane-tabs">
                <TabsBar />
              </div>
              {settings.editor.pin_toolbar && (
                <div className="editor-pane-toolbar">
                  <Toolbar />
                </div>
              )}
              <Suspense fallback={<div className="editor-container editor-pane"><div className="editor-loading-placeholder" role="status">正在加载编辑器…</div></div>}>
                <WysiwygEditor key={activeTabId} />
              </Suspense>
            </section>
          ) : (
            <section
              className={`immersive-workspace immersive-${immersivePolicy.kind}`}
              aria-label={mode === 'zen' ? '沉浸写作' : '沉浸阅读'}
            >
              {immersivePolicy.showOutline && (
                <Suspense fallback={null}>
                  <ImmersiveOutline
                    width={leftPanelWidth}
                    mode={mode === 'zen' ? 'zen' : 'immersive'}
                    collapsed={immersiveOutlineCollapsed}
                    previewScrollElement={immersivePreviewScrollElement}
                    onToggle={() => setImmersiveOutlineCollapsed((collapsed) => !collapsed)}
                  />
                </Suspense>
              )}
              {immersivePolicy.showOutline && !immersiveOutlineCollapsed && (
                <PanelDivider className="outline-divider resizable" label="调整大纲宽度" side="before"
                  onChange={width => commitPanelWidth('outline', width)} onReset={() => setOutlinePanelWidth(224)} />
              )}
              <div className="immersive-document-area">
                <header className="immersive-command-strip">
                  {immersivePolicy.showEditorToolbar && settings.editor.pin_toolbar ? (
                    <div className="immersive-writing-toolbar" aria-label="编辑器快捷工具栏">
                      <Toolbar />
                    </div>
                  ) : (
                    <div className="immersive-reading-label">
                      <span aria-hidden="true"><AppIcon name="book" size={16} /></span>
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
                    <Suspense fallback={<div className="editor-container zen-editor-pane"><div className="editor-loading-placeholder" role="status">正在加载编辑器…</div></div>}>
                      <Editor
                        className="zen-editor-pane"
                        onActiveLineChange={setActiveEditorLine}
                        onActiveLineReveal={handleEditorLineReveal}
                      />
                    </Suspense>
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
                  {hasProofread && (
                    <>
                      <PanelDivider className="proofread-divider resizable" label="调整校对栏宽度" side="after"
                        onChange={width => commitPanelWidth('proofread', width)} onReset={() => setProofreadPanelWidth(280)} />
                      <div className="proofread-side-panel" style={{ width: proofreadPanelWidth }}>
                        <div className="proofread-side-header">
                          <h4>校对建议 ({proofreadResults.length})</h4>
                          <button className="close-btn" onClick={() => {
                            setProofreadPanelVisible(false);
                            useAIStore.getState().clearResults();
                          }}><AppIcon name="close" size={16} /></button>
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
                                {result.suggestion !== result.original ? (
                                  <>
                                    <div className="original-text">
                                      <span className="label">原文:</span>
                                      <span className="text strikethrough">{result.original}</span>
                                    </div>
                                    <div className="suggestion-text">
                                      <span className="label">建议:</span>
                                      <span className="text highlight">{result.suggestion}</span>
                                    </div>
                                  </>
                                ) : (
                                  // 静态校对的 report-only 项没有自动修复：只展示问题位置与说明。
                                  <div className="original-text">
                                    <span className="label">问题:</span>
                                    <span className="text">{result.original}</span>
                                  </div>
                                )}
                                <div className="explanation-text">{result.explanation}</div>
                              </div>
                              {result.suggestion !== result.original && (
                                <button
                                  className="apply-fix-btn"
                                  onClick={() => useAIStore.getState().applyProofreadFix(result)}
                                >
                                  应用
                                </button>
                              )}
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
        </main>
          </div>
          {chatbotVisible && (
          <>
            <PanelDivider className={`chatbot-divider resizable ${immersivePolicy.active ? 'immersive-chatbot-divider' : ''}`}
              label="调整 AI 栏宽度" side="after" onChange={width => commitPanelWidth('chatbot', width)} onReset={() => setChatbotPanelWidth(null)} />
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
      <LineWidthWheel />
      {showModeChooser && (
        <Suspense fallback={null}>
          <ModeChooserDialog busy={modeChoiceSaving} onChoose={(choice) => { void chooseMode(choice); }} />
        </Suspense>
      )}
      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsPanel />
        </Suspense>
      )}
      {showRecoveryDialog && (
        <Suspense fallback={null}>
          <RecoveryDialog
            snapshots={recoverySnapshots}
            onRestore={id => { useAppStore.getState().restoreSavedRecoverySnapshot(id); }}
            onSaveCopy={id => { void saveRecoverySnapshotAs(id); }}
            onDiscard={discardRecoverySnapshot}
          />
        </Suspense>
      )}
      {fileConflict && (
        <Suspense fallback={null}>
          <FileConflictDialog
            conflict={fileConflict}
            onReload={() => { void useAppStore.getState().reloadExternalFile(); }}
            onOpenDiskCopy={() => { useAppStore.getState().openExternalVersionCopy(); }}
            onSaveCopy={() => { void saveConflictCopy(); }}
            onOverwrite={() => useAppStore.getState().overwriteExternalFile()}
            onClose={() => useAppStore.getState().dismissFileConflict()}
          />
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
      {documentSwitcherVisible && (
        <Suspense fallback={null}>
          <DocumentSwitcher
            onClose={closeDocumentSwitcher}
            onRevealActivityView={revealActivityView}
            query={switcherQuery}
            onQueryChange={setSwitcherQuery}
            searchInputRef={switcherInputRef}
          />
        </Suspense>
      )}
      {encodingDialog && <Suspense fallback={null}><EncodingDialog key={`${encodingDialog.mode}-${encodingDialog.tabId || encodingDialog.path || encodingDialog.title}`} request={encodingDialog} /></Suspense>}
      <Suspense fallback={null}>
        <AIPalette visible={aiPaletteVisible} onClose={closeAiPalette} />
      </Suspense>
    </div>
  );
}

export default App;
