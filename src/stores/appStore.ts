import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { EditorController } from '../types/editor';
import { formatTextStatistics } from '../utils/textStatistics';
import { DEFAULT_FONT_SIZE, DEFAULT_LINE_HEIGHT } from '../utils/appearanceSettings';
import { applySavedTab } from '../utils/tabPersistence';
import { detectSystemLanguage, normalizeLanguage, type AppLanguage } from '../i18n';
import type { AgentSettings } from '../types/agent';
import type { ConverterDialogAction } from '../components/ConverterDialog/ConverterDialog';
import { isConvertibleDocumentName } from '../utils/documentFormats';
import { isTextFileName } from '../utils/fileIcon';

const isTauriRuntime = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  const browserSettingsKey = 'zeditor.browser.settings';
let settingsMutationVersion = 0;
let settingsSaveQueue: Promise<unknown> = Promise.resolve();
let converterDialogResolve: ((value: boolean) => void) | null = null;

const cacheSettingsForStartup = (settings: Settings) => {
  try {
    localStorage.setItem(browserSettingsKey, JSON.stringify(settings));
  } catch { /* Storage can be unavailable in restricted webviews. */ }
};

export interface Settings {
  appearance: {
    theme: string;
    language: AppLanguage;
    /** UI chrome font. Older saved settings omit this and fall back to YaHei. */
    ui_font_family?: string;
    font_family: string;
    font_size: number;
    line_height: number;
  };
  editor: {
    auto_save_interval: number;
    spell_check: boolean;
    auto_complete: boolean;
    /** Keep the command bar visible above the editor instead of selection-only. */
    pin_toolbar?: boolean;
    favorite_emojis: string[];
  };
  image_hosting: {
    active_service: string;
    cloudinary: {
      cloud_name: string;
      api_key: string;
      api_secret: string;
      upload_folder?: string;
    };
    picgo: {
      server_url: string;
      use_cli: boolean;
      cli_path?: string;
    };
    s3: {
      provider: string;
      endpoint: string;
      bucket: string;
      region: string;
      access_key: string;
      secret_key: string;
      custom_path?: string;
      use_ssl: boolean;
    };
    local: {
      save_directory: string;
      naming_rule: string;
    };
  };
  export: {
    pdf_margin: number;
    html_template: string;
  };
  web_search: WebSearchSettings;
  ai: {
    enabled: boolean;
    provider: AIProviderId;
    api_key: string;
    api_endpoint: string;
    model: string;
    temperature: number;
    auto_suggest: boolean;
    suggest_delay: number;
    writing_style: 'formal' | 'casual' | 'academic' | 'creative' | 'custom';
    custom_style_prompt: string;
    provider_api_keys: string;
    provider_profiles: string;
  };
  agent: AgentSettings;
  explorer: ExplorerSettings;
}

export interface ExplorerSettings {
  history_retention_days: number;
  auto_refresh: boolean;
  refresh_interval_seconds: number;
}

export interface WebSearchSettings {
  enabled: boolean;
  provider: 'tavily' | 'searxng';
  tavily_api_key: string;
  tavily_search_depth: 'basic' | 'advanced' | 'fast' | 'ultra-fast';
  tavily_include_answer: boolean;
  tavily_max_results: number;
  searxng_url: string;
  searxng_api_key: string;
  searxng_language: string;
  searxng_categories: string;
  searxng_safesearch: number;
  searxng_time_range: string;
  searxng_max_results: number;
}

export type AIProviderId =
  | 'openai'
  | 'anthropic'
  | 'deepseek'
  | 'siliconflow'
  | 'mimo'
  | 'volcengine'
  | 'longcat'
  | 'zhipu'
  | 'minimax'
  | 'kimi'
  | 'custom';

export interface AIProviderDefinition {
  id: AIProviderId;
  label: string;
  endpoint: string;
  model: string;
  supportsThinking?: boolean;
}

export interface AIProviderProfile {
  api_key: string;
  api_endpoint: string;
  model: string;
  models?: string[];
}

export const AI_PROVIDER_DEFINITIONS: AIProviderDefinition[] = [
  { id: 'openai', label: 'OpenAI', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'anthropic', label: 'Anthropic (Claude)', endpoint: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-20250514' },
  { id: 'deepseek', label: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1', model: 'deepseek-chat', supportsThinking: true },
  { id: 'siliconflow', label: '硅基流动 (SiliconFlow)', endpoint: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen3-35B-A3B', supportsThinking: true },
  { id: 'mimo', label: '小米 MiMo', endpoint: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.5-pro', supportsThinking: true },
  { id: 'volcengine', label: '火山引擎 / 豆包', endpoint: 'https://ark.cn-beijing.volces.com/api/v3', model: 'ep-请输入接入点ID' },
  { id: 'longcat', label: '美团 LongCat', endpoint: 'https://api.longcat.chat/openai/v1', model: 'LongCat-2.0', supportsThinking: true },
  { id: 'zhipu', label: '智谱 AI', endpoint: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.7', supportsThinking: true },
  { id: 'minimax', label: 'MiniMax', endpoint: 'https://api.minimaxi.com/v1', model: 'MiniMax-M2.7', supportsThinking: true },
  { id: 'kimi', label: 'Kimi / Moonshot', endpoint: 'https://api.moonshot.cn/v1', model: 'kimi-k2.5', supportsThinking: true },
  { id: 'custom', label: '自定义 OpenAI 兼容', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
];

export interface Tab {
  id: string;
  title: string;
  path: string | null;
  content: string;
  modified: boolean;
}

export interface TimelineEntry {
  id: string;
  content: string;
  timestamp: number;
  label: string;
  operation: string;
}

export type UploadStatus = 'idle' | 'uploading' | 'success' | 'error';
export type ConversionStatus = 'idle' | 'converting' | 'success' | 'error';
export type SettingsTab = 'appearance' | 'editor' | 'image' | 'export' | 'ai' | 'web_search' | 'explorer' | 'converter';

export interface ConverterModuleStatus {
  state: 'missing' | 'installing' | 'ready' | 'update_available' | 'incompatible' | 'corrupt' | 'error';
  target: string;
  installed_version: string | null;
  available_version: string | null;
  protocol_version: number | null;
  installed_size: number;
  download_size: number | null;
  supported_formats: string[];
  unsigned_windows_module: boolean;
  error_code: string | null;
  message: string | null;
}

interface ConverterInstallProgress {
  stage: 'downloading' | 'verifying' | 'installing' | 'complete';
  downloaded: number;
  total: number;
  percent: number;
}

interface AppState {
  content: string;
  mode: 'split' | 'immersive' | 'zen';
  splitRatio: number;
  currentFile: string | null;
  settings: Settings;
  sidebarVisible: boolean;
  sidebarWidth: number;
  outlineVisible: boolean;
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  isSaving: boolean;
  wordCount: string;
  activeImageService: 'cloudinary' | 'picgo' | 's3' | 'local';
  editorView: EditorController | null;
  tabs: Tab[];
  activeTabId: string | null;
  timeline: Record<string, TimelineEntry[]>;
  uploadStatus: UploadStatus;
  uploadProgress: number;
  uploadMessage: string;
  conversionStatus: ConversionStatus;
  conversionMessage: string;
  converterDialog: ConverterDialogAction | null;
  pdfReaderPath: string | null;

  setContent: (content: string) => void;
  setMode: (mode: 'split' | 'immersive' | 'zen') => void;
  setSplitRatio: (ratio: number) => void;
  setCurrentFile: (file: string | null) => void;
  setSettings: (settings: Settings) => void;
  setSidebarVisible: (visible: boolean) => void;
  setSidebarWidth: (width: number) => void;
  setOutlineVisible: (visible: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setSettingsTab: (tab: SettingsTab) => void;
  setActiveImageService: (service: 'cloudinary' | 'picgo' | 's3' | 'local') => void;
  setEditorView: (view: EditorController | null) => void;
  loadSettings: () => Promise<void>;
  saveSettings: (settings: Settings) => Promise<void>;
  openFile: (path: string) => Promise<void>;
  openPdfReader: (path: string) => void;
  closePdfReader: () => void;
  convertDocument: (path: string) => Promise<void>;
  saveFile: (path: string) => Promise<void>;
  saveTab: (tabId: string, path: string) => Promise<void>;
  updateWordCount: () => void;

  addTab: (tab?: Partial<Tab>) => string;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  updateTabContent: (id: string, content: string) => void;
  updateTabTitle: (id: string, path: string) => void;
  restoreTimelineEntry: (tabId: string, entryId: string) => void;
  deleteTimelineEntry: (tabId: string, entryId: string) => void;
  cleanupTimeline: () => void;
  getActiveTab: () => Tab | undefined;
  setUploadStatus: (status: UploadStatus, progress?: number, message?: string) => void;
  setConversionStatus: (status: ConversionStatus, message?: string) => void;
  showConverterDialog: (action: ConverterDialogAction | null) => void;
  resetWorkspaceFolders: () => void;
  refreshWorkspaceFolder: (path: string) => Promise<boolean>;
}

const defaultSettings: Settings = {
  appearance: {
    theme: 'vscode-dark',
    language: detectSystemLanguage(),
    ui_font_family: 'Microsoft YaHei',
    font_family: 'Microsoft YaHei',
    font_size: DEFAULT_FONT_SIZE,
    line_height: DEFAULT_LINE_HEIGHT,
  },
  editor: {
    auto_save_interval: 30000,
    spell_check: false,
    auto_complete: true,
    pin_toolbar: false,
    favorite_emojis: ['😀', '👍', '❤️', '🎉', '✅', '⚠️', '💡', '🚀'],
  },
  image_hosting: {
    active_service: 'local',
    cloudinary: {
      cloud_name: '',
      api_key: '',
      api_secret: '',
      upload_folder: '',
    },
    picgo: {
      server_url: 'http://127.0.0.1:36677',
      use_cli: false,
    },
    s3: {
      provider: 'aliyun-oss',
      endpoint: '',
      bucket: '',
      region: '',
      access_key: '',
      secret_key: '',
      custom_path: '',
      use_ssl: true,
    },
    local: {
      save_directory: './assets/images',
      naming_rule: 'timestamp',
    },
  },
  export: {
    pdf_margin: 20,
    html_template: 'default',
  },
  web_search: {
    enabled: false,
    provider: 'tavily',
    tavily_api_key: '',
    tavily_search_depth: 'basic',
    tavily_include_answer: true,
    tavily_max_results: 5,
    searxng_url: 'http://localhost:8080',
    searxng_api_key: '',
    searxng_language: 'auto',
    searxng_categories: 'general',
    searxng_safesearch: 1,
    searxng_time_range: '',
    searxng_max_results: 5,
  },
  ai: {
    enabled: false,
    provider: 'openai',
    api_key: '',
    api_endpoint: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    temperature: 0.7,
    auto_suggest: false,
    suggest_delay: 2000,
    writing_style: 'formal',
    custom_style_prompt: '',
    provider_api_keys: '{}',
    provider_profiles: '{}',
  },
  agent: {
    enabled: false,
    backend: 'claude_code',
    backends: {
      claude_code: { executable_path: '', model: '', profile: '', reasoning_effort: '' },
      codex: { executable_path: '', model: '', profile: '', reasoning_effort: '' },
      opencode: { executable_path: '', model: '', profile: '', reasoning_effort: '' },
    },
  },
  explorer: {
    history_retention_days: 30,
    auto_refresh: true,
    refresh_interval_seconds: 5,
  },
};

const normalizeSettings = (saved: Settings): Settings => ({
  ...defaultSettings,
  ...saved,
  appearance: {
    ...defaultSettings.appearance,
    ...saved.appearance,
    language: normalizeLanguage(saved.appearance?.language),
  },
  editor: { ...defaultSettings.editor, ...saved.editor },
  image_hosting: { ...defaultSettings.image_hosting, ...saved.image_hosting },
  export: { ...defaultSettings.export, ...saved.export },
  web_search: { ...defaultSettings.web_search, ...saved.web_search },
  ai: { ...defaultSettings.ai, ...saved.ai },
  agent: {
    ...defaultSettings.agent,
    ...saved.agent,
    backends: {
      claude_code: { ...defaultSettings.agent.backends.claude_code, ...saved.agent?.backends?.claude_code },
      codex: { ...defaultSettings.agent.backends.codex, ...saved.agent?.backends?.codex },
      opencode: { ...defaultSettings.agent.backends.opencode, ...saved.agent?.backends?.opencode },
    },
  },
  explorer: { ...defaultSettings.explorer, ...saved.explorer },
});

const initialSettings = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(browserSettingsKey) || 'null') as Settings | null;
    return saved ? normalizeSettings(saved) : defaultSettings;
  } catch {
    return defaultSettings;
  }
})();

const generateId = () => Math.random().toString(36).substring(2, 9);
const TIMELINE_LIMIT = 40;
const TIMELINE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const TIMELINE_CAPTURE_DELAY = 1500;
const timelineCaptureTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingTimelineBaselines = new Map<string, string>();
let uploadStatusResetTimer: ReturnType<typeof setTimeout> | null = null;
let conversionStatusResetTimer: ReturnType<typeof setTimeout> | null = null;

const formatTimelineText = (text: string) => text
  .replace(/\r?\n/g, '↵')
  .replace(/\t/g, '⇥');

const shortenTimelineLabel = (text: string, limit = 38) => {
  const characters = Array.from(text);
  return characters.length > limit ? `${characters.slice(0, limit - 1).join('')}…` : text;
};

const pruneTimelineEntries = (entries: TimelineEntry[], now = Date.now()) => entries
  .filter(entry => now - entry.timestamp <= TIMELINE_RETENTION_MS)
  .sort((a, b) => b.timestamp - a.timestamp)
  .slice(0, TIMELINE_LIMIT);

const pruneTimeline = (timeline: Record<string, TimelineEntry[]>, now = Date.now()) => Object.fromEntries(
  Object.entries(timeline)
    .map(([tabId, entries]) => [tabId, pruneTimelineEntries(entries, now)] as const)
    .filter(([, entries]) => entries.length > 0),
);

const describeTimelineOperation = (previous: string, next: string) => {
  let prefixLength = 0;
  const sharedLength = Math.min(previous.length, next.length);
  while (prefixLength < sharedLength && previous[prefixLength] === next[prefixLength]) prefixLength += 1;

  let suffixLength = 0;
  while (
    suffixLength < previous.length - prefixLength
    && suffixLength < next.length - prefixLength
    && previous[previous.length - 1 - suffixLength] === next[next.length - 1 - suffixLength]
  ) suffixLength += 1;

  const removed = previous.slice(prefixLength, previous.length - suffixLength);
  const inserted = next.slice(prefixLength, next.length - suffixLength);
  if (removed && inserted) return `替换：${formatTimelineText(removed)} → ${formatTimelineText(inserted)}`;
  if (inserted) return `插入：${formatTimelineText(inserted)}`;
  if (removed) return `删除：${formatTimelineText(removed)}`;
  return '编辑快照';
};

const initialTab: Tab = {
  id: generateId(),
  title: '未命名',
  path: null,
  content: '',
  modified: false,
};

export const useAppStore = create<AppState>((set, get) => ({
  content: '',
  mode: 'split',
  splitRatio: 0.5,
  currentFile: null,
  settings: initialSettings,
  sidebarVisible: true,
  sidebarWidth: 220,
  outlineVisible: false,
  settingsOpen: false,
  settingsTab: 'appearance',
  isSaving: false,
  wordCount: formatTextStatistics(''),
  activeImageService: 'local',
  editorView: null,
  tabs: [initialTab],
  activeTabId: initialTab.id,
  timeline: {},
  uploadStatus: 'idle',
  uploadProgress: 0,
  uploadMessage: '',
  conversionStatus: 'idle',
  conversionMessage: '',
  converterDialog: null,
  pdfReaderPath: null,

  setContent: (content) => {
    const { activeTabId, tabs } = get();
    const activeTab = tabs.find(tab => tab.id === activeTabId);
    if (activeTabId && activeTab) {
      if (activeTab.content !== content) {
        if (!pendingTimelineBaselines.has(activeTabId)) {
          pendingTimelineBaselines.set(activeTabId, activeTab.content);
        }
        const pendingTimer = timelineCaptureTimers.get(activeTabId);
        if (pendingTimer) clearTimeout(pendingTimer);
        timelineCaptureTimers.set(activeTabId, setTimeout(() => {
          timelineCaptureTimers.delete(activeTabId);
          const baseline = pendingTimelineBaselines.get(activeTabId);
          pendingTimelineBaselines.delete(activeTabId);
          const { tabs: latestTabs, timeline: latestTimeline } = get();
          const latestTab = latestTabs.find((tab) => tab.id === activeTabId);
          if (baseline === undefined || !latestTab || latestTab.content === baseline) return;

          const operation = describeTimelineOperation(baseline, latestTab.content);
          const now = Date.now();
          const nextTimeline = pruneTimeline(latestTimeline, now);
          set({
            timeline: {
              ...nextTimeline,
              [activeTabId]: pruneTimelineEntries([
                {
                  id: generateId(),
                  content: baseline,
                  timestamp: now,
                  label: shortenTimelineLabel(operation),
                  operation,
                },
                ...(nextTimeline[activeTabId] || []),
              ], now),
            },
          });
        }, TIMELINE_CAPTURE_DELAY));
      }
      set({
        content,
        tabs: tabs.map(tab =>
          tab.id === activeTabId
            ? { ...tab, content, modified: true }
            : tab
        ),
      });
    } else {
      set({ content });
    }
    get().updateWordCount();
  },

  setMode: (mode) => set({ mode }),

  setSplitRatio: (ratio) => set({ splitRatio: Math.max(0.1, Math.min(0.9, ratio)) }),

  setCurrentFile: (file) => set({ currentFile: file }),

  setSettings: (settings) => {
    settingsMutationVersion += 1;
    cacheSettingsForStartup(settings);
    set({ settings });
  },

  setSidebarVisible: (visible) => set({ sidebarVisible: visible }),
  setSidebarWidth: (width) => set({ sidebarWidth: Math.max(150, Math.min(400, width)) }),
  setOutlineVisible: (visible) => set({ outlineVisible: visible }),

  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setSettingsTab: (tab) => set({ settingsTab: tab }),

  setActiveImageService: (service) => set({ activeImageService: service }),

  setEditorView: (view) => set({ editorView: view }),

  loadSettings: async () => {
    const loadVersion = settingsMutationVersion;
    if (!isTauriRuntime()) {
      try {
        const saved = JSON.parse(localStorage.getItem(browserSettingsKey) || 'null') as Settings | null;
        if (saved && loadVersion === settingsMutationVersion) set({ settings: normalizeSettings(saved) });
      } catch (error) {
        console.warn('Failed to load browser settings:', error);
      }
      return;
    }
    try {
      const settings = await invoke<Settings>('get_settings');
      // Do not let a slow desktop read overwrite a theme/font choice the user
      // made immediately after the window appeared.
      if (loadVersion !== settingsMutationVersion) return;
      const normalized = normalizeSettings(settings);
      cacheSettingsForStartup(normalized);
      set({ settings: normalized });
    } catch (error) {
      console.error('Failed to load settings:', error);
      if (loadVersion === settingsMutationVersion) set({ settings: defaultSettings });
    }
  },

  saveSettings: async (settings) => {
    settingsMutationVersion += 1;
    cacheSettingsForStartup(settings);
    // Apply the new settings before desktop persistence completes. UI actions
    // such as the activity-bar theme toggle should respond on the same click.
    set({ settings });
    if (!isTauriRuntime()) {
      return;
    }
    const persist = settingsSaveQueue.then(() => invoke('save_settings', { settings }));
    settingsSaveQueue = persist.catch(() => undefined);
    try {
      await persist;
    } catch (error) {
      console.error('Failed to save settings:', error);
    }
  },

  openFile: async (path) => {
    if (/\.pdf$/i.test(path)) {
      get().openPdfReader(path);
      return;
    }
    if (!isTextFileName(path) && isConvertibleDocumentName(path)) {
      await get().convertDocument(path);
      return;
    }
    try {
      const fileContent = await invoke<string>('get_file_content', { path });
      const { tabs, activeTabId } = get();
      const existingTab = tabs.find(t => t.path === path);

      if (existingTab) {
        set({
          content: existingTab.content,
          currentFile: path,
          activeTabId: existingTab.id,
        });
      } else {
        const activeTab = tabs.find(t => t.id === activeTabId);
        if (activeTab && !activeTab.modified && !activeTab.path) {
          const newTabs = tabs.map(t =>
            t.id === activeTabId
              ? { ...t, content: fileContent, path, title: path.split(/[\\/]/).pop() || path, modified: false }
              : t
          );
          set({
            tabs: newTabs,
            content: fileContent,
            currentFile: path,
            activeTabId,
          });
        } else {
          const newTab: Tab = {
            id: generateId(),
            title: path.split(/[\\/]/).pop() || path,
            path,
            content: fileContent,
            modified: false,
          };
          set({
            tabs: [...tabs, newTab],
            content: fileContent,
            currentFile: path,
            activeTabId: newTab.id,
          });
        }
      }
      get().updateWordCount();
    } catch (error) {
      console.error('Failed to open file:', error);
    }
  },

  openPdfReader: (path) => set({ pdfReaderPath: path }),

  closePdfReader: () => set({ pdfReaderPath: null }),

  convertDocument: async (path) => {
    const sourceName = path.split(/[\\/]/).pop() || path;
    get().setConversionStatus('converting', `正在转换：${sourceName}`);
    try {
      if (isTauriRuntime()) {
        let status = await invoke<ConverterModuleStatus>('get_converter_module_status');
        if (status.state !== 'ready' && status.state !== 'update_available') {
          try {
            status = await invoke<ConverterModuleStatus>('check_converter_module_update');
          } catch {
            // Installation will show the actionable network or signature error.
          }
          const downloadSize = status.download_size
            ? `，约 ${(status.download_size / 1024 / 1024).toFixed(1)} MB`
            : '';

          // 使用主题一致的弹窗替代原生 window.confirm
          const shouldInstall = await new Promise<boolean>((resolve) => {
            converterDialogResolve = resolve;
            get().showConverterDialog({
              kind: 'confirm',
              title: '需要安装文档转换模块',
              description: `当前文档需要转换模块才能导入。首次使用需要从 GitHub 下载对应平台组件${downloadSize}，是否继续？`,
              confirmLabel: '立即安装',
              cancelLabel: '稍后安装',
              onConfirm: () => resolve(true),
              onCancel: () => resolve(false),
            });
          });

          if (!shouldInstall) {
            get().showConverterDialog({
              kind: 'error',
              title: '已取消安装',
              description: '可在”设置 → 文档转换”中稍后在线安装或导入离线包。',
              confirmLabel: '知道了',
              onConfirm: () => {},
            });
            throw new Error('已取消安装文档转换模块。');
          }
          get().setConversionStatus('converting', '正在准备文档转换模块…');
          const unlisten = await listen<ConverterInstallProgress>('converter-install-progress', ({ payload }) => {
            const message = payload.stage === 'downloading'
              ? `正在下载文档转换模块：${payload.percent}%`
              : payload.stage === 'verifying'
                ? '正在校验文档转换模块…'
                : payload.stage === 'installing'
                  ? '正在安装文档转换模块…'
                  : '文档转换模块安装完成';
            get().setConversionStatus('converting', message);
          });
          try {
            await invoke('install_converter_module');
          } finally {
            unlisten();
          }
          get().setConversionStatus('converting', `正在转换：${sourceName}`);
        }
      }
      const markdown = await invoke<string>('convert_document', { path });
      const title = sourceName.replace(/\.[^.]+$/, '') + '.md';
      const newTab: Tab = {
        id: generateId(),
        title,
        path: null,
        content: markdown,
        // Converted content has not been saved as a Markdown file yet.
        modified: true,
      };
      const { tabs } = get();
      set({
        tabs: [...tabs, newTab],
        activeTabId: newTab.id,
        content: markdown,
        currentFile: null,
      });
      get().updateWordCount();
      get().setConversionStatus('success', `导入成功：${title}`);
    } catch (error) {
      // 转换失败时显示弹窗
      const errorMsg = String(error);
      get().setConversionStatus('error', `导入失败：${errorMsg}`);
      get().showConverterDialog({
        kind: 'error',
        title: '文档转换失败',
        description: errorMsg.startsWith('converter_module_missing')
          ? '未找到文档转换模块，且未配置 Python 回退方案。请安装转换模块或配置 Python 环境。'
          : errorMsg,
        confirmLabel: '知道了',
        onConfirm: () => {},
      });
      throw error;
    }
  },

  saveTab: async (tabId, path) => {
    const tab = get().tabs.find(item => item.id === tabId);
    if (!tab) throw new Error('找不到要保存的标签页');

    set({ isSaving: true });
    try {
      await invoke('save_file_content', { path, content: tab.content });
      set(state => ({
        tabs: applySavedTab(state.tabs, tabId, path, tab.content),
        currentFile: state.activeTabId === tabId ? path : state.currentFile,
      }));
    } finally {
      set({ isSaving: false });
    }
  },

  saveFile: async (path) => {
    const { activeTabId } = get();
    if (!activeTabId) return;
    try {
      await get().saveTab(activeTabId, path);
    } catch (error) {
      console.error('Failed to save file:', error);
    }
  },

  updateWordCount: () => {
    const { content } = get();
    set({ wordCount: formatTextStatistics(content) });
  },

  addTab: (tab?: Partial<Tab>) => {
    const { tabs } = get();
    const id = generateId();
    const newTab: Tab = {
      id,
      title: tab?.title || '未命名',
      path: tab?.path || null,
      content: tab?.content || '',
      modified: tab?.modified || false,
    };
    set({
      tabs: [...tabs, newTab],
      activeTabId: id,
      content: newTab.content,
      currentFile: newTab.path,
    });
    get().updateWordCount();
    return id;
  },

  closeTab: (id) => {
    const { tabs, activeTabId, timeline } = get();
    const tabIndex = tabs.findIndex(t => t.id === id);
    const newTabs = tabs.filter(t => t.id !== id);
    const pendingTimer = timelineCaptureTimers.get(id);
    if (pendingTimer) clearTimeout(pendingTimer);
    timelineCaptureTimers.delete(id);
    pendingTimelineBaselines.delete(id);
    const nextTimeline = { ...timeline };
    delete nextTimeline[id];

    if (newTabs.length === 0) {
      const newTab: Tab = {
        id: generateId(),
        title: '未命名',
        path: null,
        content: '',
        modified: false,
      };
      set({ tabs: [newTab], activeTabId: newTab.id, content: '', currentFile: null, timeline: nextTimeline });
    } else if (id === activeTabId) {
      const newActiveIndex = Math.min(tabIndex, newTabs.length - 1);
      const newActiveTab = newTabs[newActiveIndex];
      set({
        tabs: newTabs,
        activeTabId: newActiveTab.id,
        content: newActiveTab.content,
        currentFile: newActiveTab.path,
        timeline: nextTimeline,
      });
    } else {
      set({ tabs: newTabs, timeline: nextTimeline });
    }
    get().updateWordCount();
  },

  setActiveTab: (id) => {
    const { tabs } = get();
    const tab = tabs.find(t => t.id === id);
    if (tab) {
      set({
        activeTabId: id,
        content: tab.content,
        currentFile: tab.path,
      });
      get().updateWordCount();
    }
  },

  updateTabContent: (id, content) => {
    const { tabs } = get();
    set({
      tabs: tabs.map(t =>
        t.id === id ? { ...t, content, modified: true } : t
      ),
    });
  },

  updateTabTitle: (id, path) => {
    const { tabs } = get();
    set({
      tabs: tabs.map(t =>
        t.id === id ? { ...t, path, title: path.split(/[\\/]/).pop() || path, modified: false } : t
      ),
    });
  },

  getActiveTab: () => {
    const { tabs, activeTabId } = get();
    return tabs.find(t => t.id === activeTabId);
  },

  setUploadStatus: (status, progress = 0, message = '') => {
    if (uploadStatusResetTimer) clearTimeout(uploadStatusResetTimer);
    uploadStatusResetTimer = null;
    set({
      uploadStatus: status,
      uploadProgress: progress,
      uploadMessage: message,
    });
    if (status === 'success' || status === 'error') {
      uploadStatusResetTimer = setTimeout(() => {
        uploadStatusResetTimer = null;
        if (get().uploadStatus === status) {
          set({ uploadStatus: 'idle', uploadProgress: 0, uploadMessage: '' });
        }
      }, 3000);
    }
  },

  restoreTimelineEntry: (tabId, entryId) => {
    const { tabs, timeline, activeTabId } = get();
    const entry = timeline[tabId]?.find(item => item.id === entryId);
    const tab = tabs.find(item => item.id === tabId);
    if (!entry || !tab) return;

    const rollbackEntry: TimelineEntry = {
      id: generateId(),
      content: tab.content,
      timestamp: Date.now(),
      label: '回退前快照',
      operation: '回退前快照：保留执行回退之前的完整文档内容。',
    };
    const pendingTimer = timelineCaptureTimers.get(tabId);
    if (pendingTimer) clearTimeout(pendingTimer);
    timelineCaptureTimers.delete(tabId);
    pendingTimelineBaselines.delete(tabId);
    set({
      content: activeTabId === tabId ? entry.content : get().content,
      timeline: {
        ...pruneTimeline(timeline),
        [tabId]: pruneTimelineEntries([rollbackEntry, ...(timeline[tabId] || [])]),
      },
      tabs: tabs.map(item => item.id === tabId ? { ...item, content: entry.content, modified: true } : item),
    });
    get().updateWordCount();
  },

  deleteTimelineEntry: (tabId, entryId) => {
    set(({ timeline }) => {
      const remaining = (timeline[tabId] || []).filter(entry => entry.id !== entryId);
      const nextTimeline = { ...timeline };
      if (remaining.length > 0) nextTimeline[tabId] = remaining;
      else delete nextTimeline[tabId];
      return { timeline: nextTimeline };
    });
  },

  cleanupTimeline: () => set(({ timeline }) => ({ timeline: pruneTimeline(timeline) })),

  resetWorkspaceFolders: () => {
    // Placeholder — the Sidebar component manages workspaceFolders state.
    // This signals the component to reload by dispatching a custom event.
    window.dispatchEvent(new CustomEvent('zeditor-reset-explorer'));
  },

  refreshWorkspaceFolder: async (path) => {
    window.dispatchEvent(new CustomEvent('zeditor-refresh-folder', { detail: { path } }));
    return true;
  },

  showConverterDialog: (action) => {
    set({ converterDialog: action });
    if (!action && converterDialogResolve) {
      converterDialogResolve(false);
      converterDialogResolve = null;
    }
  },

  setConversionStatus: (status, message = '') => {
    if (conversionStatusResetTimer) clearTimeout(conversionStatusResetTimer);
    conversionStatusResetTimer = null;
    set({ conversionStatus: status, conversionMessage: message });
    if (status === 'success' || status === 'error') {
      conversionStatusResetTimer = setTimeout(() => {
        conversionStatusResetTimer = null;
        if (get().conversionStatus === status) {
          set({ conversionStatus: 'idle', conversionMessage: '' });
        }
      }, 4000);
    }
  },
}));
