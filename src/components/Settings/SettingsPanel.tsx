import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { AI_PROVIDER_DEFINITIONS, useAppStore, type AIProviderId, type ConverterModuleStatus, type SettingsTab } from '../../stores/appStore';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { FontFamilyPicker } from './FontFamilyPicker';
import {
  DEFAULT_FONT_SIZE,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  FONT_SIZE_RANGE_THUMB,
  contentFontStack,
  getRangeMarkerGeometry,
} from '../../utils/appearanceSettings';
import { LANGUAGE_OPTIONS, normalizeLanguage } from '../../i18n';
import type { AgentBackendId, AgentBackendStatus } from '../../types/agent';
import { parseAIProviderProfiles } from '../../utils/aiProviderProfiles';
import { WebDavSettings } from '../WebDav/WebDavSettings';
import { S3Settings } from '../WebDav/S3Settings';
import { WebDavHistoryDialog } from '../WebDav/WebDavHistoryDialog';

const isTauriRuntime = () => '__TAURI_INTERNALS__' in window;
const formatModuleSize = (bytes: number) => bytes > 0 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : '—';

const parseEmojiList = (value: string) => {
  const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  const values = segmenter ? [...segmenter.segment(value)].map((item) => item.segment) : Array.from(value);
  return [...new Set(values.filter((item) => item.trim() && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(item)))].slice(0, 24);
};

const DEFAULT_FONT_FAMILIES = [
  'Microsoft YaHei', 'Microsoft YaHei UI', 'SimSun', 'SimHei', 'KaiTi', 'FangSong',
  'DengXian', 'Noto Sans SC', 'Noto Serif SC', 'Source Han Sans SC', 'Source Han Serif SC',
  'PingFang SC', 'Hiragino Sans GB', 'Segoe UI', 'Arial', 'Times New Roman', 'Consolas',
];

type LocalFontAccessWindow = Window & {
  queryLocalFonts?: () => Promise<Array<{ family: string }>>;
};

type SettingToggleProps = {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
};

function SettingToggle({ label, description, checked, onChange }: SettingToggleProps) {
  return (
    <div className="setting-item setting-toggle-item">
      <div className="setting-copy">
        <span>{label}</span>
        <small>{description}</small>
      </div>
      <button
        type="button"
        className={`settings-switch ${checked ? 'is-on' : ''}`}
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
      >
        <span className="settings-switch-thumb" />
      </button>
    </div>
  );
}

const fetchModelsFromApi = async (apiKey: string, apiEndpoint: string): Promise<string[]> => {
  if (isTauriRuntime()) {
    return invoke<string[]>('fetch_ai_models', { apiKey, apiEndpoint });
  }

  const response = await fetch(`${apiEndpoint.replace(/\/+$/, '')}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    throw new Error(`获取模型失败（${response.status}）：${await response.text()}`);
  }

  const payload: unknown = await response.json();
  const data = typeof payload === 'object' && payload !== null && 'data' in payload
    ? (payload as { data?: unknown }).data
    : undefined;
  if (!Array.isArray(data)) throw new Error('模型服务返回了无法识别的数据格式。');

  return data.flatMap(model => {
    if (typeof model === 'string') return [model];
    if (typeof model === 'object' && model !== null && 'id' in model && typeof model.id === 'string') {
      return [model.id];
    }
    return [];
  });
};

function SettingsNavIcon({ type }: { type: SettingsTab }) {
  if (type === 'appearance') {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
  }
  if (type === 'editor') {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2.5h7l3 3v12H5zM12 2.5V6h3M7.5 9h5M7.5 12h5M7.5 15h3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  }
  if (type === 'image') {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.8" y="3.5" width="14.4" height="13" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" /><circle cx="7" cy="7.7" r="1.3" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="m4.5 14 3.4-3.5 2.4 2.1 2.3-2.7 2.9 4.1" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  }
  if (type === 'export') {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v9M6.7 8.7 10 12l3.3-3.3M4 13v3.5h12V13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  }
  if (type === 'web_search') {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.2" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M2.8 10h14.4M10 2.8c2 2 2 12.4 0 14.4M10 2.8c-2 2-2 12.4 0 14.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>;
  }
  if (type === 'explorer') {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M1.8 4.5h5.3l1.5 1.5h8.6v9.5H1.8z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" /><path d="M4.5 13.5h7M4.5 10.5h5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>;
  }
  if (type === 'workflow') {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="3" width="6" height="5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.4" /><rect x="11.5" y="12" width="6" height="5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M5.5 8v2.5h9V12M5.5 10.5h6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  }
  if (type === 'converter') {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 3h7l3 3v11H5zM12 3v3h3M7.5 10h5M10 8v4M7.5 14h5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  }
  if (type === 'cloud') {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.8 15.5h8.5a3 3 0 0 0 .6-5.95 5.1 5.1 0 0 0-10.1.9 3.25 3.25 0 0 0 1 5.05Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>;
  }
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.6 11.5 7l4.4 1.5-4.4 1.5-1.5 4.4L8.5 10 4.1 8.5 8.5 7zM15.5 13l.7 2 .8.3-.8.3-.7 2-.7-2-.8-.3.8-.3z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg>;
}

export function SettingsPanel() {
  const { settings, settingsTab, saveSettings, setSettingsOpen } = useAppStore();
  const [localSettings, setLocalSettings] = useState(settings);
  const [activeTab, setActiveTab] = useState<SettingsTab>(settingsTab);
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchError, setFetchError] = useState('');
  const [fontFamilies, setFontFamilies] = useState(DEFAULT_FONT_FAMILIES);
  const [loadingFonts, setLoadingFonts] = useState(false);
  const [fontNotice, setFontNotice] = useState('可直接输入任意已安装字体名称。');
  const [agentStatuses, setAgentStatuses] = useState<AgentBackendStatus[]>([]);
  const [detectingAgents, setDetectingAgents] = useState(false);
  const [converterStatus, setConverterStatus] = useState<ConverterModuleStatus | null>(null);
  const [converterBusy, setConverterBusy] = useState(false);
  const [converterNotice, setConverterNotice] = useState('');
  const [webdavHistoryOpen, setWebdavHistoryOpen] = useState(false);
  const [s3HistoryOpen, setS3HistoryOpen] = useState(false);
  const fontSizeGeometry = getRangeMarkerGeometry(
    localSettings.appearance.font_size,
    FONT_SIZE_MIN,
    FONT_SIZE_MAX,
    FONT_SIZE_RANGE_THUMB,
  );
  const defaultFontSizeGeometry = getRangeMarkerGeometry(
    DEFAULT_FONT_SIZE,
    FONT_SIZE_MIN,
    FONT_SIZE_MAX,
    FONT_SIZE_RANGE_THUMB,
  );

  const previewContentFontSize = (fontSize: number) => {
    document.documentElement.style.setProperty('--font-content-size', `${fontSize}px`);
    // 同时广播 fontFamily 变更：预览与 AI 面板是普通 DOM（沿用 --font-content
    // 变量，随设置实时更新），但 Monaco 的折行测量以 fontFamily 字符串为缓存
    // 键，必须用真实字体名重新测量，否则换字体后行文字会按旧字体宽度折行、
    // 溢出编辑框。拖动字号预览与更换字体共用此事件。
    window.dispatchEvent(new CustomEvent('zeditor-content-font-size-preview', {
      detail: { fontSize, fontFamily: contentFontStack(localSettings.appearance.font_family) },
    }));
  };

  const handleCancel = () => {
    previewContentFontSize(settings.appearance.font_size);
    setSettingsOpen(false);
  };

  const loadLocalFonts = async () => {
    const queryLocalFonts = (window as LocalFontAccessWindow).queryLocalFonts;
    if (isTauriRuntime()) {
      setLoadingFonts(true);
      try {
        const localFamilies = await invoke<string[]>('get_local_font_families');
        const families = Array.from(new Set([
          ...DEFAULT_FONT_FAMILIES,
          ...localFamilies.filter(Boolean),
        ])).sort((left, right) => left.localeCompare(right, 'zh-CN'));
        setFontFamilies(families);
        setFontNotice(`已读取 ${families.length} 个本机字体，可在下拉建议中选择。`);
      } catch {
        setFontNotice('无法读取系统字体列表；可直接输入已安装字体名称。');
      } finally {
        setLoadingFonts(false);
      }
      return;
    }
    if (!queryLocalFonts) {
      setFontNotice('当前环境不支持读取字体列表；可直接输入已安装字体名称。');
      return;
    }

    setLoadingFonts(true);
    try {
      const localFonts = await queryLocalFonts();
      const families = Array.from(new Set([
        ...DEFAULT_FONT_FAMILIES,
        ...localFonts.map((font) => font.family).filter(Boolean),
      ])).sort((left, right) => left.localeCompare(right, 'zh-CN'));
      setFontFamilies(families);
      setFontNotice(`已读取 ${families.length} 个本机字体，可在下拉建议中选择。`);
    } catch {
      setFontNotice('未获得本机字体访问权限；可直接输入已安装字体名称。');
    } finally {
      setLoadingFonts(false);
    }
  };

  // 解析各服务商保存的 API KEY
  const parseProviderKeys = (): Record<string, string> => {
    try {
      return JSON.parse(localSettings.ai.provider_api_keys || '{}');
    } catch {
      return {};
    }
  };

  const parseProviderProfiles = () => parseAIProviderProfiles(localSettings.ai.provider_profiles);

  const handleSave = () => {
    // 保存前确保当前 API KEY 已记录到映射中
    const keys = { ...parseProviderKeys(), [localSettings.ai.provider]: localSettings.ai.api_key };
    const profiles = {
      ...parseProviderProfiles(),
      [localSettings.ai.provider]: {
        ...(parseProviderProfiles()[localSettings.ai.provider] || {}),
        api_key: localSettings.ai.api_key,
        api_endpoint: localSettings.ai.api_endpoint,
        model: localSettings.ai.model,
        models: models.length > 0 ? models : parseProviderProfiles()[localSettings.ai.provider]?.models,
      },
    };
    const saveData = {
      ...localSettings,
      ai: { ...localSettings.ai, provider_api_keys: JSON.stringify(keys), provider_profiles: JSON.stringify(profiles) },
    };
    setSettingsOpen(false);
    window.setTimeout(() => void saveSettings(saveData), 0);
  };

  const refreshConverterStatus = useCallback(async (checkUpdate = false) => {
    if (!isTauriRuntime()) return;
    setConverterBusy(true);
    setConverterNotice('');
    try {
      const command = checkUpdate ? 'check_converter_module_update' : 'get_converter_module_status';
      setConverterStatus(await invoke<ConverterModuleStatus>(command));
    } catch (error) {
      setConverterNotice(String(error));
    } finally {
      setConverterBusy(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab !== 'converter') return;
    const timer = window.setTimeout(() => void refreshConverterStatus(), 0);
    return () => window.clearTimeout(timer);
  }, [activeTab, refreshConverterStatus]);

  const tabs = [
    { id: 'converter', label: '文档转换', description: '按需安装并管理本地转换模块' },
    { id: 'appearance', label: '外观', description: '主题、界面字体与内容显示' },
    { id: 'editor', label: '编辑器', description: '编辑体验与自动保存' },
    { id: 'image', label: '图床', description: '图片上传与存储服务' },
    { id: 'export', label: '导出', description: '文档导出与版式设置' },
    { id: 'ai', label: 'AI 助手', description: '模型、提示与伴写设置' },
    { id: 'explorer', label: '资源管理器', description: '文件浏览与工作区管理' },
    { id: 'workflow', label: '工作流', description: 'GitHub Actions 工作流查看器与结构化编辑' },
    { id: 'web_search', label: '网络搜索', description: '搜索服务与结果偏好' },
    { id: 'cloud', label: '云同步', description: 'WebDAV 与 S3 自动备份' },
  ] as const;
  const activeTabMeta = tabs.find((tab) => tab.id === activeTab) || tabs[0];

  const s3Providers = [
    { value: 'aliyun-oss', label: '阿里云OSS' },
    { value: 'aws-s3', label: 'AWS S3' },
    { value: 'tencent-cos', label: '腾讯云COS' },
    { value: 'huawei-obs', label: '华为云OBS' },
    { value: 'minio', label: 'MinIO' },
    { value: 'custom', label: '自定义S3' },
  ];

  return (
    <div className="settings-overlay" onClick={handleCancel}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <aside className="settings-navigation">
          <div className="settings-navigation-header">
            <button className="close-btn" onClick={handleCancel} aria-label="关闭设置">
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
            </button>
            <span>设置</span>
          </div>
          <nav className="settings-tabs" aria-label="设置分类">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={`tab-btn ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <SettingsNavIcon type={tab.id} />
              <span>{tab.label}</span>
            </button>
          ))}
          </nav>
        </aside>

        <section className="settings-main">
          <div className="settings-header">
            <div>
              <h2>{activeTabMeta.label}</h2>
              <p>{activeTabMeta.description}</p>
            </div>
          </div>

        <div className="settings-content">
          {activeTab === 'appearance' && (
            <div className="settings-section">
              <div className="setting-item">
                <label>
                  界面显示语言
                  <small>根据系统语言自动选择，也可手动更改</small>
                </label>
                <select
                  aria-label="语言"
                  value={normalizeLanguage(localSettings.appearance.language)}
                  onChange={(event) => {
                    const language = normalizeLanguage(event.target.value);
                    const nextSettings = {
                      ...localSettings,
                      appearance: { ...localSettings.appearance, language },
                    };
                    setLocalSettings(nextSettings);
                    void saveSettings(nextSettings);
                  }}
                >
                  {LANGUAGE_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>{option.nativeLabel}</option>
                  ))}
                </select>
              </div>
              <div className="setting-item">
                <label>主题</label>
                <select
                  value={localSettings.appearance.theme}
                  onChange={(e) =>
                    setLocalSettings({
                      ...localSettings,
                      appearance: { ...localSettings.appearance, theme: e.target.value },
                    })
                  }
                >
                  <option value="vscode-dark">深色主题</option>
                  <option value="vscode-light">浅色主题</option>
                  <option value="system">跟随系统</option>
                </select>
              </div>
              <div className="setting-item font-setting-item">
                <label>
                  界面字体
                  <small>菜单、工具栏、资源管理器与设置界面</small>
                </label>
                <div className="font-setting-control">
                  <FontFamilyPicker
                    value={localSettings.appearance.ui_font_family || 'Microsoft YaHei'}
                    fontFamilies={fontFamilies}
                    onChange={(v) =>
                      setLocalSettings({
                        ...localSettings,
                        appearance: { ...localSettings.appearance, ui_font_family: v },
                      })
                    }
                    placeholder="输入或选择字体…"
                  />
                  <button type="button" className="font-load-btn" onClick={loadLocalFonts} disabled={loadingFonts}>
                    {loadingFonts ? '读取中…' : '读取本机字体'}
                  </button>
                  <small className="font-setting-notice">{fontNotice}</small>
                </div>
              </div>
              <div className="setting-item font-setting-item">
                <label>
                  内容字体
                  <small>编辑器、预览、AI 对话与校对面板</small>
                </label>
                <div className="font-setting-control">
                  <FontFamilyPicker
                    value={localSettings.appearance.font_family}
                    fontFamilies={fontFamilies}
                    onChange={(v) =>
                      setLocalSettings({
                        ...localSettings,
                        appearance: { ...localSettings.appearance, font_family: v },
                      })
                    }
                    placeholder="输入或选择字体…"
                  />
                </div>
              </div>
              <div className="setting-item setting-range-item">
                <div className="setting-range-header">
                  <div className="setting-copy">
                    <span>字号</span>
                    <small>调整编辑器、预览与 AI 对话的文字大小</small>
                  </div>
                  <output>{localSettings.appearance.font_size}px</output>
                </div>
                <input
                  className="settings-range"
                  type="range"
                  min={FONT_SIZE_MIN}
                  max={FONT_SIZE_MAX}
                  step="1"
                  value={localSettings.appearance.font_size}
                  aria-label="字号"
                  aria-valuetext={`${localSettings.appearance.font_size} 像素`}
                  style={{
                    '--range-progress': `${fontSizeGeometry.progressPercent}%`,
                    '--range-thumb-size': `${FONT_SIZE_RANGE_THUMB}px`,
                  } as CSSProperties}
                  onChange={(e) => {
                    const fontSize = Number(e.target.value);
                    setLocalSettings({
                      ...localSettings,
                      appearance: { ...localSettings.appearance, font_size: fontSize },
                    });
                    previewContentFontSize(fontSize);
                  }}
                />
                <div
                  className="settings-range-scale"
                  aria-hidden="true"
                  style={{
                    '--range-default-position': `${defaultFontSizeGeometry.progressPercent}%`,
                    '--range-default-offset': `${defaultFontSizeGeometry.thumbOffsetPx}px`,
                  } as CSSProperties}
                >
                  <span>小</span>
                  <span>默认</span>
                  <span>大</span>
                </div>
              </div>
              <div className="setting-item">
                <label>行高</label>
                <input
                  type="number"
                  step="0.1"
                  min="1.0"
                  max="3.0"
                  value={localSettings.appearance.line_height}
                  onChange={(e) =>
                    setLocalSettings({
                      ...localSettings,
                      appearance: { ...localSettings.appearance, line_height: parseFloat(e.target.value) },
                    })
                  }
                />
              </div>
            </div>
          )}

          {activeTab === 'editor' && (
            <div className="settings-section">
              <div className="setting-item">
                <label>自动保存间隔 (ms)</label>
                <input
                  type="number"
                  min="1000"
                  step="1000"
                  value={localSettings.editor.auto_save_interval}
                  onChange={(e) =>
                    setLocalSettings({
                      ...localSettings,
                      editor: { ...localSettings.editor, auto_save_interval: parseInt(e.target.value) },
                    })
                  }
                />
              </div>
              <div className="setting-item">
                <label>
                  输入法引擎
                  <small>默认使用原生 EditContext；旧版 WebView 输入异常时可回退到传统输入层</small>
                </label>
                <select
                  value={localSettings.editor.input_engine || 'editContext'}
                  onChange={(e) =>
                    setLocalSettings({
                      ...localSettings,
                      editor: { ...localSettings.editor, input_engine: e.target.value as 'textarea' | 'editContext' },
                    })
                  }
                >
                  <option value="editContext">原生 EditContext（默认）</option>
                  <option value="textarea">传统输入层（兼容）</option>
                </select>
              </div>
              <SettingToggle
                label="启用拼写检查"
                description="在编辑时标记可能存在的拼写问题"
                checked={localSettings.editor.spell_check}
                onChange={(checked) => setLocalSettings({
                  ...localSettings,
                  editor: { ...localSettings.editor, spell_check: checked },
                })}
              />
              <SettingToggle
                label="启用自动补全"
                description="根据当前内容提供编辑补全建议"
                checked={localSettings.editor.auto_complete}
                onChange={(checked) => setLocalSettings({
                  ...localSettings,
                  editor: { ...localSettings.editor, auto_complete: checked },
                })}
              />
              <SettingToggle
                label="启用自动配对与 Tab 跳出"
                description="输入括号、引号和 Markdown 标记时自动补全；Tab 可在括号、引号、行内格式与链接字段之间穿梭，代码区域内自动停用"
                checked={Boolean(localSettings.editor.smart_pairs)}
                onChange={(checked) => setLocalSettings({
                  ...localSettings,
                  editor: { ...localSettings.editor, smart_pairs: checked },
                })}
              />
              <SettingToggle
                label="固定显示编辑快捷栏"
                description="关闭后，选中文本时会在选区附近显示快捷编辑栏；输入 / 可打开完整命令菜单"
                checked={Boolean(localSettings.editor.pin_toolbar)}
                onChange={(checked) => setLocalSettings({
                  ...localSettings,
                  editor: { ...localSettings.editor, pin_toolbar: checked },
                })}
              />
              <SettingToggle
                label="启用内联弹窗"
                description="点击链接、图片、公式、脚注或 Wiki 链接时，在原位弹出编辑窗：Ctrl+K 编辑链接，Ctrl+点击直接打开，公式带实时预览"
                checked={Boolean(localSettings.editor.inline_popups ?? true)}
                onChange={(checked) => setLocalSettings({
                  ...localSettings,
                  editor: { ...localSettings.editor, inline_popups: checked },
                })}
              />
              <div className="setting-item emoji-favorites-setting">
                <label>
                  常用表情
                  <small>设置 Emoji 选择器顶部显示的常用表情，最多 24 个</small>
                </label>
                <div className="emoji-favorites-control">
                  <input
                    type="text"
                    value={localSettings.editor.favorite_emojis.join(' ')}
                    onChange={(event) => setLocalSettings({
                      ...localSettings,
                      editor: { ...localSettings.editor, favorite_emojis: parseEmojiList(event.target.value) },
                    })}
                    placeholder="😀 👍 ❤️ 🎉 ✅"
                    aria-label="常用表情列表"
                  />
                  <div className="emoji-favorites-preview" aria-label="常用表情预览">
                    {localSettings.editor.favorite_emojis.map((emoji) => <span key={emoji}>{emoji}</span>)}
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'image' && (
            <div className="settings-section">
              <div className="setting-item">
                <label>图床服务</label>
                <select
                  value={localSettings.image_hosting.active_service}
                  onChange={(e) =>
                    setLocalSettings({
                      ...localSettings,
                      image_hosting: { ...localSettings.image_hosting, active_service: e.target.value },
                    })
                  }
                >
                  <option value="local">本地</option>
                  <option value="cloudinary">Cloudinary</option>
                  <option value="picgo">PicGo</option>
                  <option value="s3">S3/OSS</option>
                </select>
              </div>

              {localSettings.image_hosting.active_service === 'cloudinary' && (
                <>
                  <div className="setting-item">
                    <label>云名称</label>
                    <input
                      type="text"
                      value={localSettings.image_hosting.cloudinary.cloud_name}
                      onChange={(e) =>
                        setLocalSettings({
                          ...localSettings,
                          image_hosting: {
                            ...localSettings.image_hosting,
                            cloudinary: { ...localSettings.image_hosting.cloudinary, cloud_name: e.target.value },
                          },
                        })
                      }
                    />
                  </div>
                  <div className="setting-item">
                    <label>API Key</label>
                    <input
                      type="password"
                      value={localSettings.image_hosting.cloudinary.api_key}
                      onChange={(e) =>
                        setLocalSettings({
                          ...localSettings,
                          image_hosting: {
                            ...localSettings.image_hosting,
                            cloudinary: { ...localSettings.image_hosting.cloudinary, api_key: e.target.value },
                          },
                        })
                      }
                    />
                  </div>
                  <div className="setting-item">
                    <label>API 密钥</label>
                    <input
                      type="password"
                      value={localSettings.image_hosting.cloudinary.api_secret}
                      onChange={(e) =>
                        setLocalSettings({
                          ...localSettings,
                          image_hosting: {
                            ...localSettings.image_hosting,
                            cloudinary: { ...localSettings.image_hosting.cloudinary, api_secret: e.target.value },
                          },
                        })
                      }
                    />
                  </div>
                  <div className="setting-item">
                    <label>上传文件夹</label>
                    <input
                      type="text"
                      placeholder="例如: blog/images"
                      value={localSettings.image_hosting.cloudinary.upload_folder || ''}
                      onChange={(e) =>
                        setLocalSettings({
                          ...localSettings,
                          image_hosting: {
                            ...localSettings.image_hosting,
                            cloudinary: { ...localSettings.image_hosting.cloudinary, upload_folder: e.target.value },
                          },
                        })
                      }
                    />
                  </div>
                </>
              )}

              {localSettings.image_hosting.active_service === 'picgo' && (
                <div className="setting-item">
                  <label>PicGo服务器地址</label>
                  <input
                    type="text"
                    value={localSettings.image_hosting.picgo.server_url}
                    onChange={(e) =>
                      setLocalSettings({
                        ...localSettings,
                        image_hosting: {
                          ...localSettings.image_hosting,
                          picgo: { ...localSettings.image_hosting.picgo, server_url: e.target.value },
                        },
                      })
                    }
                  />
                </div>
              )}

              {localSettings.image_hosting.active_service === 's3' && (
                <>
                  <div className="setting-item">
                    <label>服务商</label>
                    <select
                      value={localSettings.image_hosting.s3.provider}
                      onChange={(e) =>
                        setLocalSettings({
                          ...localSettings,
                          image_hosting: {
                            ...localSettings.image_hosting,
                            s3: { ...localSettings.image_hosting.s3, provider: e.target.value },
                          },
                        })
                      }
                    >
                      {s3Providers.map((p) => (
                        <option key={p.value} value={p.value}>{p.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="setting-item">
                    <label>服务端点</label>
                    <input
                      type="text"
                      placeholder="例如: oss-cn-hangzhou.aliyuncs.com"
                      value={localSettings.image_hosting.s3.endpoint}
                      onChange={(e) =>
                        setLocalSettings({
                          ...localSettings,
                          image_hosting: {
                            ...localSettings.image_hosting,
                            s3: { ...localSettings.image_hosting.s3, endpoint: e.target.value },
                          },
                        })
                      }
                    />
                  </div>
                  <div className="setting-item">
                    <label>存储桶名称</label>
                    <input
                      type="text"
                      value={localSettings.image_hosting.s3.bucket}
                      onChange={(e) =>
                        setLocalSettings({
                          ...localSettings,
                          image_hosting: {
                            ...localSettings.image_hosting,
                            s3: { ...localSettings.image_hosting.s3, bucket: e.target.value },
                          },
                        })
                      }
                    />
                  </div>
                  <div className="setting-item">
                    <label>地域</label>
                    <input
                      type="text"
                      placeholder="例如: cn-hangzhou"
                      value={localSettings.image_hosting.s3.region}
                      onChange={(e) =>
                        setLocalSettings({
                          ...localSettings,
                          image_hosting: {
                            ...localSettings.image_hosting,
                            s3: { ...localSettings.image_hosting.s3, region: e.target.value },
                          },
                        })
                      }
                    />
                  </div>
                  <div className="setting-item">
                    <label>访问密钥 ID</label>
                    <input
                      type="password"
                      value={localSettings.image_hosting.s3.access_key}
                      onChange={(e) =>
                        setLocalSettings({
                          ...localSettings,
                          image_hosting: {
                            ...localSettings.image_hosting,
                            s3: { ...localSettings.image_hosting.s3, access_key: e.target.value },
                          },
                        })
                      }
                    />
                  </div>
                  <div className="setting-item">
                    <label>访问密钥</label>
                    <input
                      type="password"
                      value={localSettings.image_hosting.s3.secret_key}
                      onChange={(e) =>
                        setLocalSettings({
                          ...localSettings,
                          image_hosting: {
                            ...localSettings.image_hosting,
                            s3: { ...localSettings.image_hosting.s3, secret_key: e.target.value },
                          },
                        })
                      }
                    />
                  </div>
                  <div className="setting-item">
                    <label>自定义路径</label>
                    <input
                      type="text"
                      placeholder="例如: blog/images"
                      value={localSettings.image_hosting.s3.custom_path || ''}
                      onChange={(e) =>
                        setLocalSettings({
                          ...localSettings,
                          image_hosting: {
                            ...localSettings.image_hosting,
                            s3: { ...localSettings.image_hosting.s3, custom_path: e.target.value },
                          },
                        })
                      }
                    />
                  </div>
                  <SettingToggle
                    label="使用 HTTPS"
                    description="通过加密连接访问 S3 图床服务"
                    checked={localSettings.image_hosting.s3.use_ssl}
                    onChange={(checked) => setLocalSettings({
                      ...localSettings,
                      image_hosting: {
                        ...localSettings.image_hosting,
                        s3: { ...localSettings.image_hosting.s3, use_ssl: checked },
                      },
                    })}
                  />
                </>
              )}

              {localSettings.image_hosting.active_service === 'local' && (
                <>
                  <div className="setting-item">
                    <label>保存目录</label>
                    <input
                      type="text"
                      value={localSettings.image_hosting.local.save_directory}
                      onChange={(e) =>
                        setLocalSettings({
                          ...localSettings,
                          image_hosting: {
                            ...localSettings.image_hosting,
                            local: { ...localSettings.image_hosting.local, save_directory: e.target.value },
                          },
                        })
                      }
                    />
                  </div>
                  <div className="setting-item">
                    <label>命名规则</label>
                    <select
                      value={localSettings.image_hosting.local.naming_rule}
                      onChange={(e) =>
                        setLocalSettings({
                          ...localSettings,
                          image_hosting: {
                            ...localSettings.image_hosting,
                            local: { ...localSettings.image_hosting.local, naming_rule: e.target.value },
                          },
                        })
                      }
                    >
                      <option value="timestamp">时间戳</option>
                      <option value="uuid">UUID</option>
                      <option value="original">原始名称</option>
                    </select>
                  </div>
                </>
              )}
            </div>
          )}

          {activeTab === 'export' && (
            <div className="settings-section">
              <div className="setting-item">
                <label>PDF边距 (mm)</label>
                <input
                  type="number"
                  min="0"
                  max="50"
                  value={localSettings.export.pdf_margin}
                  onChange={(e) =>
                    setLocalSettings({
                      ...localSettings,
                      export: { ...localSettings.export, pdf_margin: parseFloat(e.target.value) },
                    })
                  }
                />
              </div>
              <div className="setting-item">
                <label>HTML模板</label>
                <select
                  value={localSettings.export.html_template}
                  onChange={(e) =>
                    setLocalSettings({
                      ...localSettings,
                      export: { ...localSettings.export, html_template: e.target.value },
                    })
                  }
                >
                  <option value="default">默认</option>
                  <option value="minimal">极简</option>
                  <option value="academic">学术</option>
                </select>
              </div>
            </div>
          )}

          {activeTab === 'ai' && (
            <div className="settings-section">
              <SettingToggle
                label="启用 AI 助手"
                description="开启对话、改写、校对与智能伴写能力"
                checked={localSettings.ai.enabled}
                onChange={(checked) => setLocalSettings({
                  ...localSettings,
                  ai: { ...localSettings.ai, enabled: checked },
                })}
              />
              {localSettings.ai.enabled && (
                <>
                  <div className="setting-item">
                    <label>AI服务商</label>
                    <select
                      value={localSettings.ai.provider}
                      onChange={(e) => {
                        const oldProvider = localSettings.ai.provider;
                        const newProvider = e.target.value;

                        // 先保存当前服务商的 API KEY
                        const keys = { ...parseProviderKeys(), [oldProvider]: localSettings.ai.api_key };

                        const definition = AI_PROVIDER_DEFINITIONS.find((item) => item.id === newProvider) || AI_PROVIDER_DEFINITIONS[AI_PROVIDER_DEFINITIONS.length - 1];
                        const profiles = parseProviderProfiles();
                        profiles[oldProvider] = {
                          api_key: localSettings.ai.api_key,
                          api_endpoint: localSettings.ai.api_endpoint,
                          model: localSettings.ai.model,
                          models: profiles[oldProvider]?.models,
                        };
                        const nextProfile = profiles[newProvider] || {
                          api_key: keys[newProvider] || '',
                          api_endpoint: definition.endpoint,
                          model: definition.model,
                        };
                        profiles[newProvider] = nextProfile;
                        // 取出该服务商之前保存的 KEY（如有）
                        setLocalSettings({
                          ...localSettings,
                          ai: {
                            ...localSettings.ai,
                            provider: newProvider as AIProviderId,
                            api_key: nextProfile.api_key,
                            api_endpoint: nextProfile.api_endpoint,
                            model: nextProfile.model,
                            provider_api_keys: JSON.stringify(keys),
                            provider_profiles: JSON.stringify(profiles),
                          },
                        });
                        setModels([]);
                        setFetchError('');
                      }}
                    >
                      {AI_PROVIDER_DEFINITIONS.map((provider) => (
                        <option key={provider.id} value={provider.id}>{provider.label}</option>
                      ))}
                      <option value="siliconflow">硅基流动 (SiliconFlow)</option>
                      <option value="custom">自定义</option>
                    </select>
                  </div>

                  <div className="setting-item">
                    <label>API密钥</label>
                    <div className="input-with-toggle">
                      <input
                        type={apiKeyVisible ? 'text' : 'password'}
                        value={localSettings.ai.api_key}
                        onChange={(e) => {
                          const newKey = e.target.value;
                          const keys = { ...parseProviderKeys(), [localSettings.ai.provider]: newKey };
                          setLocalSettings({
                            ...localSettings,
                            ai: {
                              ...localSettings.ai,
                              api_key: newKey,
                              provider_api_keys: JSON.stringify(keys),
                            },
                          });
                        }}
                        placeholder="sk-..."
                      />
                      <button
                        className="toggle-visibility-btn"
                        onClick={() => setApiKeyVisible(!apiKeyVisible)}
                        title={apiKeyVisible ? '隐藏' : '显示'}
                      >
                        {apiKeyVisible ? '🙈' : '👁'}
                      </button>
                    </div>
                  </div>

                  <div className="setting-item">
                    <label>API端点</label>
                    <input
                      type="text"
                      value={localSettings.ai.api_endpoint}
                      onChange={(e) =>
                        setLocalSettings({
                          ...localSettings,
                          ai: { ...localSettings.ai, api_endpoint: e.target.value },
                        })
                      }
                      placeholder="https://api.openai.com/v1"
                    />
                  </div>

                  <div className="setting-item">
                    <label>模型</label>
                    <div className="model-select-row">
                      <select
                        className="model-select"
                        value={localSettings.ai.model}
                        onChange={(e) =>
                          setLocalSettings({
                            ...localSettings,
                            ai: { ...localSettings.ai, model: e.target.value },
                          })
                        }
                      >
                        {models.length > 0 ? (
                          models.map((m) => (
                            <option key={m} value={m}>{m}</option>
                          ))
                        ) : (
                          <option value={localSettings.ai.model}>{localSettings.ai.model || '请输入模型名称'}</option>
                        )}
                      </select>
                      <button
                        className="fetch-models-btn"
                        onClick={async () => {
                          if (!localSettings.ai.api_key) {
                            setFetchError('请先填写 API 密钥');
                            return;
                          }
                          setFetchingModels(true);
                          setFetchError('');
                          try {
                            const result = await fetchModelsFromApi(
                              localSettings.ai.api_key,
                              localSettings.ai.api_endpoint,
                            );
                            setModels(result);
                            if (result.length > 0) {
                              setLocalSettings({
                                ...localSettings,
                                ai: { ...localSettings.ai, model: result[0] },
                              });
                            }
                          } catch (err: unknown) {
                            setFetchError(String(err));
                          } finally {
                            setFetchingModels(false);
                          }
                        }}
                        disabled={fetchingModels}
                      >
                        {fetchingModels ? '获取中...' : '获取模型列表'}
                      </button>
                    </div>
                    {fetchError && <div className="fetch-error">{fetchError}</div>}
                  </div>

                  <div className="setting-item">
                    <label>温度 (0-1)</label>
                    <input
                      type="number"
                      min="0"
                      max="1"
                      step="0.1"
                      value={localSettings.ai.temperature}
                      onChange={(e) =>
                        setLocalSettings({
                          ...localSettings,
                          ai: { ...localSettings.ai, temperature: parseFloat(e.target.value) },
                        })
                      }
                    />
                  </div>
                  <SettingToggle
                    label="自动伴写建议"
                    description="输入停顿后自动生成可选择的续写建议"
                    checked={localSettings.ai.auto_suggest}
                    onChange={(checked) => setLocalSettings({
                      ...localSettings,
                      ai: { ...localSettings.ai, auto_suggest: checked },
                    })}
                  />
                  {localSettings.ai.auto_suggest && (
                    <div className="setting-item">
                      <label>建议延迟 (ms)</label>
                      <input
                        type="number"
                        min="500"
                        max="10000"
                        step="100"
                        value={localSettings.ai.suggest_delay}
                        onChange={(e) =>
                          setLocalSettings({
                            ...localSettings,
                            ai: { ...localSettings.ai, suggest_delay: parseInt(e.target.value) },
                          })
                        }
                      />
                    </div>
                  )}
                  <div className="setting-item">
                    <label>写作风格</label>
                    <select
                      value={localSettings.ai.writing_style}
                      onChange={(e) =>
                        setLocalSettings({
                          ...localSettings,
                          ai: { ...localSettings.ai, writing_style: e.target.value as 'formal' | 'casual' | 'academic' | 'creative' | 'custom' },
                        })
                      }
                    >
                      <option value="formal">正式</option>
                      <option value="casual">活泼</option>
                      <option value="academic">学术</option>
                      <option value="creative">创意</option>
                      <option value="custom">自定义</option>
                    </select>
                  </div>
                  {localSettings.ai.writing_style === 'custom' && (
                    <div className="setting-item">
                      <label>自定义风格提示</label>
                      <input
                        type="text"
                        value={localSettings.ai.custom_style_prompt}
                        onChange={(e) =>
                          setLocalSettings({
                            ...localSettings,
                            ai: { ...localSettings.ai, custom_style_prompt: e.target.value },
                          })
                        }
                        placeholder="例如：请以幽默风趣的方式..."
                      />
                    </div>
                  )}
                </>
              )}
              <div className="settings-subsection-divider" />
              <SettingToggle
                label="启用本地 Agent（Beta）"
                description="调用本机 Claude Code、Codex 或 OpenCode，在隔离 Git worktree 中执行任务"
                checked={localSettings.agent.enabled}
                onChange={(checked) => setLocalSettings({
                  ...localSettings,
                  agent: { ...localSettings.agent, enabled: checked },
                })}
              />
              {localSettings.agent.enabled && (
                <div className="agent-settings-block">
                  <div className="setting-item">
                    <label>默认 Agent</label>
                    <select
                      value={localSettings.agent.backend}
                      onChange={(event) => setLocalSettings({
                        ...localSettings,
                        agent: { ...localSettings.agent, backend: event.target.value as AgentBackendId },
                      })}
                    >
                      <option value="claude_code">Claude Code</option>
                      <option value="codex">Codex</option>
                      <option value="opencode">OpenCode</option>
                    </select>
                  </div>
                  {(Object.keys(localSettings.agent.backends) as AgentBackendId[]).map((backendId) => {
                    const config = localSettings.agent.backends[backendId];
                    const status = agentStatuses.find((item) => item.id === backendId);
                    const label = backendId === 'claude_code' ? 'Claude Code' : backendId === 'codex' ? 'Codex' : 'OpenCode';
                    return (
                      <section className="agent-backend-settings" key={backendId}>
                        <header><strong>{label}</strong><span className={status?.compatible ? 'ready' : ''}>{status ? (status.compatible ? status.version || '可用' : status.diagnostic) : '尚未检测'}</span></header>
                        <div className="setting-item">
                          <label>可执行文件</label>
                          <input
                            type="text"
                            value={config.executable_path}
                            onChange={(event) => setLocalSettings({
                              ...localSettings,
                              agent: {
                                ...localSettings.agent,
                                backends: { ...localSettings.agent.backends, [backendId]: { ...config, executable_path: event.target.value } },
                              },
                            })}
                            placeholder={backendId === 'codex' ? '留空则优先使用官方编辑器扩展或 PATH 中的 codex' : `留空则从 PATH 自动查找 ${backendId === 'claude_code' ? 'claude' : backendId}`}
                          />
                        </div>
                        <div className="agent-backend-options">
                          <div className="setting-item"><label>模型覆盖</label><input type="text" value={config.model} onChange={(event) => setLocalSettings({ ...localSettings, agent: { ...localSettings.agent, backends: { ...localSettings.agent.backends, [backendId]: { ...config, model: event.target.value } } } })} placeholder="使用 CLI 默认模型" /></div>
                          <div className="setting-item"><label>{backendId === 'claude_code' ? 'Agent' : backendId === 'codex' ? 'Profile' : 'Agent 模式'}</label><input type="text" value={config.profile} onChange={(event) => setLocalSettings({ ...localSettings, agent: { ...localSettings.agent, backends: { ...localSettings.agent.backends, [backendId]: { ...config, profile: event.target.value } } } })} placeholder="使用 CLI 默认配置" /></div>
                          {backendId !== 'opencode' && (
                            <div className="setting-item">
                              <label>推理强度</label>
                              <select value={config.reasoning_effort} onChange={(event) => setLocalSettings({ ...localSettings, agent: { ...localSettings.agent, backends: { ...localSettings.agent.backends, [backendId]: { ...config, reasoning_effort: event.target.value } } } })}>
                                <option value="">自动</option>
                                <option value="low">低</option>
                                <option value="medium">中</option>
                                <option value="high">高</option>
                                <option value="xhigh">超高</option>
                                {backendId === 'claude_code' && <option value="max">最大</option>}
                              </select>
                            </div>
                          )}
                        </div>
                      </section>
                    );
                  })}
                  <button
                    className="secondary-btn agent-detect-button"
                    disabled={detectingAgents || !isTauriRuntime()}
                    onClick={async () => {
                      setDetectingAgents(true);
                      try {
                        const overrides = Object.fromEntries(Object.entries(localSettings.agent.backends).map(([id, config]) => [id, config.executable_path]));
                        setAgentStatuses(await invoke<AgentBackendStatus[]>('agent_detect_backends', { overrides }));
                      } finally {
                        setDetectingAgents(false);
                      }
                    }}
                  >
                    {detectingAgents ? '检测中…' : '检测本机 Agent'}
                  </button>
                </div>
              )}
            </div>
          )}

          {activeTab === 'workflow' && (
            <div className="settings-section">
              <SettingToggle
                label="在预览中渲染工作流图"
                description="Markdown 代码块与 .github/workflows 下的 YAML 会渲染为 job 依赖图；关闭后按普通 YAML 文本显示"
                checked={localSettings.workflow?.render_in_preview !== false}
                onChange={(checked) => setLocalSettings({
                  ...localSettings,
                  workflow: {
                    render_in_preview: checked,
                    preserve_format: localSettings.workflow?.preserve_format !== false,
                  },
                })}
              />
              <SettingToggle
                label="保存时保留 YAML 格式"
                description="结构化编辑写回时保留注释、锚点与原有缩进；关闭后输出规范化 YAML（会丢失注释）"
                checked={localSettings.workflow?.preserve_format !== false}
                onChange={(checked) => setLocalSettings({
                  ...localSettings,
                  workflow: {
                    render_in_preview: localSettings.workflow?.render_in_preview !== false,
                    preserve_format: checked,
                  },
                })}
              />
              <div className="setting-item">
                <label>
                  诊断与导出
                  <small>
                    查看器在本地解析工作流并给出 GHA-* 诊断，不执行工作流、不联网；依赖图可导出为 Mermaid、SVG，
                    也支持在右侧面板中修改 job / step 字段后写回编辑器。
                  </small>
                </label>
              </div>
            </div>
          )}

          {activeTab === 'converter' && (
            <div className="settings-section converter-settings">
              <div className="setting-item">
                <label>转换模块状态</label>
                <small>
                  {converterStatus?.state === 'ready' && `已安装 ${converterStatus.installed_version ?? ''}`}
                  {converterStatus?.state === 'update_available' && `可更新：${converterStatus.installed_version} → ${converterStatus.available_version}`}
                  {converterStatus?.state === 'missing' && '尚未安装，首次转换前需要下载对应平台模块'}
                  {converterStatus?.state === 'corrupt' && '模块校验失败，请重新安装'}
                  {converterStatus?.state === 'incompatible' && '当前平台或模块协议不受支持'}
                  {converterStatus?.state === 'error' && '无法读取模块状态'}
                  {!converterStatus && (converterBusy ? '正在读取模块状态…' : '尚未读取模块状态')}
                </small>
              </div>

              <div className="setting-item">
                <label>平台与空间</label>
                <small>
                  {converterStatus
                    ? `${converterStatus.target} · ${
                      converterStatus.installed_size
                        ? `已占用 ${formatModuleSize(converterStatus.installed_size)}`
                        : converterStatus.download_size
                          ? `需下载 ${formatModuleSize(converterStatus.download_size)}`
                          : '未安装'
                    }`
                    : '—'}
                </small>
              </div>

              {converterStatus?.supported_formats.length ? (
                <div className="setting-item">
                  <label>支持格式</label>
                  <small>{converterStatus.supported_formats.map((format) => format.toUpperCase()).join('、')}</small>
                </div>
              ) : null}

              {converterStatus?.unsigned_windows_module && (
                <div className="setting-item converter-signing-notice">
                  <label>Windows 模块签名</label>
                  <small>当前模块未进行 Authenticode/SignPath 代码签名；安装时仍会强制验证发布清单签名和 SHA-256。</small>
                </div>
              )}

              {converterStatus?.message && <div className="setting-item"><small>{converterStatus.message}</small></div>}
              {converterNotice && <div className="setting-item converter-error"><small>{converterNotice}</small></div>}

              <div className="converter-actions">
                <button
                  className="secondary-btn"
                  disabled={converterBusy || !isTauriRuntime()}
                  onClick={async () => {
                    setConverterBusy(true);
                    setConverterNotice('');
                    try {
                      // 先检查更新（预热 HTTPS 连接），再执行安装
                      try { await invoke('check_converter_module_update'); } catch { /* 预热失败不影响安装 */ }
                      await invoke('install_converter_module');
                      await refreshConverterStatus();
                    } catch (error) {
                      setConverterNotice(String(error));
                    } finally {
                      setConverterBusy(false);
                    }
                  }}
                >
                  {converterBusy
                    ? '处理中…'
                    : converterStatus?.state === 'ready'
                      ? '重新安装'
                      : converterStatus?.state === 'update_available'
                        ? '更新模块'
                        : '在线安装'}
                </button>
                <button
                  className="secondary-btn"
                  disabled={converterBusy || !isTauriRuntime()}
                  onClick={async () => {
                    const selected = await open({
                      multiple: false,
                      filters: [{ name: 'Zeditor AnyDoc 转换模块', extensions: ['zip'] }],
                    });
                    if (typeof selected !== 'string') return;
                    setConverterBusy(true);
                    setConverterNotice('');
                    try {
                      await invoke('import_converter_module', { path: selected });
                      await refreshConverterStatus();
                    } catch (error) {
                      setConverterNotice(String(error));
                    } finally {
                      setConverterBusy(false);
                    }
                  }}
                >
                  导入离线包
                </button>
                <button
                  className="secondary-btn converter-remove-button"
                  disabled={converterBusy || !converterStatus?.installed_version}
                  onClick={async () => {
                    const confirmed = await new Promise<boolean>((resolve) => {
                      useAppStore.getState().showConverterDialog({
                        kind: 'confirm',
                        title: '卸载文档转换模块',
                        description: '确定卸载本地文档转换模块吗？以后仍可重新安装或导入。',
                        confirmLabel: '确认卸载',
                        cancelLabel: '取消',
                        onConfirm: () => resolve(true),
                        onCancel: () => resolve(false),
                      });
                    });
                    if (!confirmed) return;
                    setConverterBusy(true);
                    try {
                      await invoke('uninstall_converter_module');
                      await refreshConverterStatus();
                    } catch (error) {
                      setConverterNotice(String(error));
                    } finally {
                      setConverterBusy(false);
                    }
                  }}
                >
                  卸载模块
                </button>
              </div>

              <details className="converter-advanced">
                <summary>高级设置</summary>
                <small>
                  开发调试时可在启动 Zeditor 前设置
                  <code> ANYDOC_CONVERTER_PATH </code>
                  为对应 Python 可执行文件路径。应用不会自动探测或安装 Python 依赖。
                </small>
              </details>
            </div>
          )}

          {activeTab === 'explorer' && (
            <div className="settings-section">
              <div className="setting-item">
                <label>历史记录保留天数</label>
                <small>设置资源管理器「近期记录」中文件/文件夹的保留时间</small>
                <input
                  type="number"
                  min="1"
                  max="365"
                  value={localSettings.explorer.history_retention_days}
                  onChange={(e) =>
                    setLocalSettings({
                      ...localSettings,
                      explorer: { ...localSettings.explorer, history_retention_days: parseInt(e.target.value) || 30 },
                    })
                  }
                />
              </div>
              <SettingToggle
                label="自动刷新文件树"
                description="定时检测文件变更并自动刷新资源管理器"
                checked={localSettings.explorer.auto_refresh}
                onChange={(checked) => setLocalSettings({
                  ...localSettings,
                  explorer: { ...localSettings.explorer, auto_refresh: checked },
                })}
              />
              {localSettings.explorer.auto_refresh && (
                <div className="setting-item">
                  <label>刷新间隔（秒）</label>
                  <small>检测文件变更的频率，设为更短可更快响应外部变更</small>
                  <input
                    type="number"
                    min="1"
                    max="30"
                    value={localSettings.explorer.refresh_interval_seconds}
                    onChange={(e) =>
                      setLocalSettings({
                        ...localSettings,
                        explorer: { ...localSettings.explorer, refresh_interval_seconds: parseInt(e.target.value) || 5 },
                      })
                    }
                  />
                </div>
              )}
            </div>
          )}

          {activeTab === 'web_search' && (
            <div className="settings-section">
              <SettingToggle
                label="启用网络搜索"
                description="允许 AI 对话在发送前检索并引用网络资料"
                checked={localSettings.web_search.enabled}
                onChange={(checked) => setLocalSettings({
                  ...localSettings,
                  web_search: { ...localSettings.web_search, enabled: checked },
                })}
              />

              {localSettings.web_search.enabled && (
                <>
                  <div className="setting-item">
                    <label>首选搜索服务</label>
                    <select
                      value={localSettings.web_search.provider}
                      onChange={(e) => setLocalSettings({
                        ...localSettings,
                        web_search: { ...localSettings.web_search, provider: e.target.value as 'tavily' | 'searxng' },
                      })}
                      title="同时配置多个搜索服务时，优先使用此服务"
                    >
                      <option value="tavily">Tavily（优先）</option>
                      <option value="searxng">SearXNG（优先）</option>
                    </select>
                  </div>

                  {localSettings.web_search.provider === 'tavily' ? (
                    <>
                      <div className="setting-item">
                        <label>Tavily API Key</label>
                        <input type="password" value={localSettings.web_search.tavily_api_key} onChange={(e) => setLocalSettings({ ...localSettings, web_search: { ...localSettings.web_search, tavily_api_key: e.target.value } })} placeholder="tvly-..." />
                      </div>
                      <div className="setting-item">
                        <label>搜索深度</label>
                        <select value={localSettings.web_search.tavily_search_depth} onChange={(e) => setLocalSettings({ ...localSettings, web_search: { ...localSettings.web_search, tavily_search_depth: e.target.value as 'basic' | 'advanced' | 'fast' | 'ultra-fast' } })}>
                          <option value="basic">基础</option>
                          <option value="fast">快速</option>
                          <option value="advanced">高级</option>
                          <option value="ultra-fast">极速</option>
                        </select>
                      </div>
                      <div className="setting-item">
                        <label>最大结果数</label>
                        <input type="number" min="1" max="20" value={localSettings.web_search.tavily_max_results} onChange={(e) => setLocalSettings({ ...localSettings, web_search: { ...localSettings.web_search, tavily_max_results: Number(e.target.value) } })} />
                      </div>
                      <SettingToggle
                        label="请求摘要答案"
                        description="让 Tavily 同时返回基于搜索结果生成的摘要"
                        checked={localSettings.web_search.tavily_include_answer}
                        onChange={(checked) => setLocalSettings({
                          ...localSettings,
                          web_search: { ...localSettings.web_search, tavily_include_answer: checked },
                        })}
                      />
                    </>
                  ) : (
                    <>
                      <div className="setting-item">
                        <label>SearXNG API 地址</label>
                        <input type="url" value={localSettings.web_search.searxng_url} onChange={(e) => setLocalSettings({ ...localSettings, web_search: { ...localSettings.web_search, searxng_url: e.target.value } })} placeholder="http://localhost:8080" />
                      </div>
                      <div className="setting-item">
                        <label>SearXNG API Key（可选）</label>
                        <input type="password" value={localSettings.web_search.searxng_api_key} onChange={(e) => setLocalSettings({ ...localSettings, web_search: { ...localSettings.web_search, searxng_api_key: e.target.value } })} />
                      </div>
                      <div className="setting-item">
                        <label>语言</label>
                        <input type="text" value={localSettings.web_search.searxng_language} onChange={(e) => setLocalSettings({ ...localSettings, web_search: { ...localSettings.web_search, searxng_language: e.target.value } })} placeholder="auto / zh-CN / en" />
                      </div>
                      <div className="setting-item">
                        <label>分类</label>
                        <input type="text" value={localSettings.web_search.searxng_categories} onChange={(e) => setLocalSettings({ ...localSettings, web_search: { ...localSettings.web_search, searxng_categories: e.target.value } })} placeholder="general" />
                      </div>
                      <div className="setting-item">
                        <label>安全搜索</label>
                        <select value={localSettings.web_search.searxng_safesearch} onChange={(e) => setLocalSettings({ ...localSettings, web_search: { ...localSettings.web_search, searxng_safesearch: Number(e.target.value) } })}>
                          <option value={0}>关闭</option><option value={1}>中等</option><option value={2}>严格</option>
                        </select>
                      </div>
                      <div className="setting-item">
                        <label>时间范围</label>
                        <select value={localSettings.web_search.searxng_time_range} onChange={(e) => setLocalSettings({ ...localSettings, web_search: { ...localSettings.web_search, searxng_time_range: e.target.value } })}>
                          <option value="">不限</option><option value="day">一天</option><option value="month">一个月</option><option value="year">一年</option>
                        </select>
                      </div>
                      <div className="setting-item">
                        <label>最大结果数</label>
                        <input type="number" min="1" max="20" value={localSettings.web_search.searxng_max_results} onChange={(e) => setLocalSettings({ ...localSettings, web_search: { ...localSettings.web_search, searxng_max_results: Number(e.target.value) } })} />
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          )}

          {activeTab === 'cloud' && (
            <div className="settings-section">
              <div className="settings-section-title">WebDAV</div>
              <WebDavSettings
                value={localSettings.webdav}
                onChange={(webdav) => setLocalSettings({ ...localSettings, webdav })}
                onBrowseHistory={() => setWebdavHistoryOpen(true)}
              />
              <div className="settings-section-divider" />
              <div className="settings-section-title">S3 对象存储</div>
              <S3Settings
                value={localSettings.s3}
                onChange={(s3) => setLocalSettings({ ...localSettings, s3 })}
                onBrowseHistory={() => setS3HistoryOpen(true)}
              />
            </div>
          )}
        </div>

        <div className="settings-footer">
          <button className="cancel-btn" onClick={handleCancel}>
            取消
          </button>
          <button className="save-btn" onClick={handleSave}>
            保存
          </button>
        </div>
        <WebDavHistoryDialog
          open={webdavHistoryOpen}
          mode="global"
          settings={localSettings.webdav}
          onClose={() => setWebdavHistoryOpen(false)}
        />
        <WebDavHistoryDialog
          open={s3HistoryOpen}
          mode="global"
          provider="s3"
          settings={localSettings.s3}
          onClose={() => setS3HistoryOpen(false)}
        />
        </section>
      </div>
    </div>
  );
}
