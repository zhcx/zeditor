import { AppIcon } from '../Icons/AppIcon';
import type { IconName } from '../Icons/iconGeometry';
import { useShallow } from 'zustand/react/shallow';
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore, type Settings } from '../../stores/appStore';
import { useAIStore, type AIEditMode } from '../../stores/aiStore';
import { WebDavStatusItem } from '../WebDav/WebDavStatusItem';
import { encodingLabel } from '../../utils/textEncoding';
import { formatShortcut } from '../../utils/platformShortcuts';

type WritingStyle = Settings['ai']['writing_style'];

const WRITING_STYLES: Array<{ value: WritingStyle; label: string }> = [
  { value: 'formal', label: '正式' },
  { value: 'casual', label: '活泼' },
  { value: 'academic', label: '学术' },
  { value: 'creative', label: '创意' },
  { value: 'custom', label: '自定义' },
];

const EDIT_MODES: Array<{ value: AIEditMode; label: string }> = [
  { value: 'ask', label: '询问' },
  { value: 'suggest', label: '建议' },
];

const StatusGlyphNames = {"ai":"assistant","proofread":"fileCheck","success":"checkCircle","error":"error"} as const satisfies Record<string, IconName>;

function StatusGlyph({ name }: { name: 'ai' | 'proofread' | 'success' | 'error' }) {
  return <AppIcon name={StatusGlyphNames[name]} />;
}

export function StatusBar() {
  const activeEncoding = useAppStore(state => state.tabs.find(tab => tab.id === state.activeTabId)?.encoding || 'utf-8');
  const modified = useAppStore(state => state.tabs.find(tab => tab.id === state.activeTabId)?.modified ?? false);
  const {
    wordCount, mode, currentFile, isSaving, uploadStatus, uploadProgress, uploadMessage,
    conversionStatus, conversionMessage, settings, saveSettings, content, editorView,
    setSettingsOpen, setSettingsTab,
  } = useAppStore(useShallow(state => ({ wordCount: state.wordCount, mode: state.mode, currentFile: state.currentFile, isSaving: state.isSaving, uploadStatus: state.uploadStatus, uploadProgress: state.uploadProgress, uploadMessage: state.uploadMessage, conversionStatus: state.conversionStatus, conversionMessage: state.conversionMessage, settings: state.settings, saveSettings: state.saveSettings, content: state.content, editorView: state.editorView, setSettingsOpen: state.setSettingsOpen, setSettingsTab: state.setSettingsTab })));
  const {
    status: aiStatus,
    statusMessage: aiStatusMessage,
    errorCount,
    editMode,
    setEditMode,
    setProofreadPanelVisible,
    checkProofread,
    rewriteSelection,
    translateText,
    summarizeText,
    generateOutline,
    proposeEdit,
  } = useAIStore(useShallow(state => ({ status: state.status, statusMessage: state.statusMessage, errorCount: state.errorCount, editMode: state.editMode, setEditMode: state.setEditMode, setProofreadPanelVisible: state.setProofreadPanelVisible, checkProofread: state.checkProofread, rewriteSelection: state.rewriteSelection, translateText: state.translateText, summarizeText: state.summarizeText, generateOutline: state.generateOutline, proposeEdit: state.proposeEdit })));
  const [aiMenuOpen, setAiMenuOpen] = useState(false);
  const [companionMenuOpen, setCompanionMenuOpen] = useState(false);
  const aiMenuRef = useRef<HTMLDivElement>(null);
  const companionMenuRef = useRef<HTMLDivElement>(null);
  const selection = editorView?.getSelection();
  const hasSelection = Boolean(selection && !selection.empty);
  const companionEnabled = settings.ai.enabled && settings.ai.auto_suggest;
  const companionStyleLabel = WRITING_STYLES.find(({ value }) => value === settings.ai.writing_style)?.label || '正式';
  const [mcpRunning, setMcpRunning] = useState(false);
  const [mcpConnected, setMcpConnected] = useState(0);

  // MCP 桥接状态：绿色 = 运行中且有 AI 助手连接，灰绿 = 运行中等待连接，灰色 = 未运行。
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    invoke<{ running: boolean; connected: number }>('mcp_bridge_status')
      .then((status) => {
        setMcpRunning(Boolean(status.running));
        setMcpConnected(Number(status.connected || 0));
      })
      .catch(() => undefined);
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ event?: string; data?: { running?: boolean; connected?: number } }>).detail;
      if (detail?.data?.running !== undefined) setMcpRunning(Boolean(detail.data.running));
      if (detail?.data?.connected !== undefined) setMcpConnected(Number(detail.data.connected));
      if (detail?.event === 'connected') setMcpConnected((count) => count + 1);
      if (detail?.event === 'disconnected') setMcpConnected((count) => Math.max(0, count - 1));
    };
    window.addEventListener('zeditor-mcp-status', handler);
    return () => window.removeEventListener('zeditor-mcp-status', handler);
  }, []);

  useEffect(() => {
    if (!aiMenuOpen && !companionMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (aiMenuOpen && !aiMenuRef.current?.contains(target)) setAiMenuOpen(false);
      if (companionMenuOpen && !companionMenuRef.current?.contains(target)) setCompanionMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setAiMenuOpen(false);
        setCompanionMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [aiMenuOpen, companionMenuOpen]);

  const updateAISettings = (nextAI: Settings['ai']) => {
    const latest = useAppStore.getState().settings;
    return saveSettings({ ...latest, ai: nextAI });
  };

  const openAIControl = async () => {
    setCompanionMenuOpen(false);
    if (!settings.ai.enabled) {
      await updateAISettings({ ...useAppStore.getState().settings.ai, enabled: true });
      useAIStore.getState().setStatus('success', 'AI 助手已开启');
    }
    setAiMenuOpen((open) => !open || !settings.ai.enabled);
  };

  const setAIEnabled = async (enabled: boolean) => {
    await updateAISettings({ ...useAppStore.getState().settings.ai, enabled });
    if (!enabled) setAiMenuOpen(false);
  };

  const setCompanionEnabled = async (enabled: boolean) => {
    const latestAI = useAppStore.getState().settings.ai;
    await updateAISettings({
      ...latestAI,
      enabled: enabled ? true : latestAI.enabled,
      auto_suggest: enabled,
    });
    useAIStore.getState().setStatus('success', enabled ? 'AI 伴写已开启' : 'AI 伴写已关闭');
  };

  const setCompanionStyle = async (writingStyle: WritingStyle) => {
    await updateAISettings({ ...useAppStore.getState().settings.ai, writing_style: writingStyle });
  };

  const handleProofread = async () => {
    const currentSelection = editorView?.getSelection();
    const selectedText = currentSelection && !currentSelection.empty
      ? editorView?.getText(currentSelection.from, currentSelection.to) || ''
      : '';
    setAiMenuOpen(false);
    setCompanionMenuOpen(false);
    // 校对模式（AI / Markdown 静态检查）由 aiStore.checkProofread 依据设置决定，
    // 这里不再自动启用 AI。
    await checkProofread(selectedText || content, selectedText && currentSelection ? currentSelection.from : 0);
  };

  const handleRewrite = async () => {
    const currentSelection = editorView?.getSelection();
    if (!editorView || !currentSelection || currentSelection.empty) return;
    const selectedText = editorView.getText(currentSelection.from, currentSelection.to);
    setAiMenuOpen(false);
    const rewritten = await rewriteSelection(selectedText);
    if (rewritten && rewritten !== selectedText) {
      proposeEdit({
        kind: 'polish',
        reason: 'AI 重写：用于语言润色与表达优化，不应将其视为事实修改。',
        before: selectedText,
        after: rewritten,
        from: currentSelection.from,
        to: currentSelection.to,
      });
    }
  };

  const handleTranslate = async () => {
    const currentSelection = editorView?.getSelection();
    if (!editorView || !currentSelection || currentSelection.empty) return;
    const selectedText = editorView.getText(currentSelection.from, currentSelection.to);
    const coords = editorView.coordsAtPos(currentSelection.from);
    setAiMenuOpen(false);
    const result = await translateText(selectedText);
    if (result?.includes('|||')) {
      const [original, translated] = result.split('|||');
      if (translated && translated !== selectedText) {
        useAIStore.getState().setTranslationVisible(true, coords ? { x: coords.left, y: coords.bottom } : null, original, translated);
      }
    }
  };

  const handleSummarize = async () => {
    setAiMenuOpen(false);
    const summary = await summarizeText(content);
    if (summary) proposeEdit({ kind: 'structure', reason: 'AI 摘要：自动提炼原文，关键结论与数字请人工复核。', before: '', after: `## 摘要\n\n${summary}\n\n---\n\n`, from: 0, to: 0 });
  };

  const handleOutline = async () => {
    const currentSelection = editorView?.getSelection();
    const position = currentSelection?.from ?? content.length;
    setAiMenuOpen(false);
    const outline = await generateOutline(content);
    if (outline) proposeEdit({ kind: 'structure', reason: 'AI 大纲：根据现有文档组织结构，内容准确性仍需人工确认。', before: currentSelection ? content.slice(currentSelection.from, currentSelection.to) : '', after: outline, from: position, to: currentSelection?.to ?? position });
  };

  const openAISettings = () => {
    setAiMenuOpen(false);
    setSettingsTab('ai');
    setSettingsOpen(true);
  };

  const openCloudSettings = () => {
    setSettingsTab('cloud');
    setSettingsOpen(true);
  };

  // 状态栏直接开 / 关某个同步后端，复用设置保存链路（同 updateAISettings）。
  const updateCloudProvider = async (provider: 'webdav' | 's3', enabled: boolean) => {
    const latest = useAppStore.getState().settings;
    if (provider === 'webdav') {
      await saveSettings({ ...latest, webdav: { ...latest.webdav, enabled } });
    } else {
      await saveSettings({ ...latest, s3: { ...latest.s3, enabled } });
    }
  };

  return (
    <div className="statusbar">
      <div className="statusbar-left">
        <span className="status-item status-mode-label">{mode === 'split' ? '分屏模式' : mode === 'zen' ? '沉浸写作' : '沉浸阅读'}</span>
        <span className="status-divider" aria-hidden="true" />
        <span className="status-item status-save-state" data-state={isSaving ? 'saving' : modified ? 'modified' : 'ready'} aria-live="polite"><span className="status-save-dot" aria-hidden="true" />{isSaving ? '保存中...' : modified ? '未保存修改' : currentFile ? '已保存' : '已就绪'}</span>
        <span className="status-divider" aria-hidden="true" />
        <div className="status-ai-control" ref={aiMenuRef}>
          <button
            type="button"
            className={`status-item status-button status-ai-trigger${settings.ai.enabled ? ' is-enabled' : ''}${aiMenuOpen ? ' active' : ''}`}
            aria-haspopup="menu"
            aria-expanded={aiMenuOpen}
            title={settings.ai.enabled ? '打开 AI 功能菜单' : '开启并使用 AI 助手'}
            onClick={() => void openAIControl()}
          >
            <StatusGlyph name="ai" />
            <span>{settings.ai.enabled ? 'AI' : '开启 AI'}</span>
            <span className="status-ai-chevron" aria-hidden="true"><AppIcon name="chevronUp" size={14} /></span>
          </button>
          {aiMenuOpen && (
            <div className="status-ai-menu" role="menu" aria-label="AI 功能">
              <div className="status-ai-menu-header">
                <div><strong>AI 写作助手</strong><small>{settings.ai.model || '尚未配置模型'}</small></div>
                <button type="button" className="status-ai-power" onClick={() => void setAIEnabled(false)}>关闭</button>
              </div>
              <div className="status-ai-actions">
                <button type="button" role="menuitem" onClick={() => { setAiMenuOpen(false); window.dispatchEvent(new CustomEvent('zeditor-ai-palette')); }}><span><AppIcon name="sparkles" /></span><strong>AI 指令面板</strong><small>{formatShortcut('Ctrl+J')} · 搜索指令或输入自定义要求</small></button>
                <button type="button" role="menuitem" disabled={!hasSelection} title={!hasSelection ? '请先选择文字' : undefined} onClick={() => void handleRewrite()}><span><AppIcon name="penLine" /></span><strong>重写选中</strong><small>{hasSelection ? '润色当前选区' : '请先选择文字'}</small></button>
                <button type="button" role="menuitem" disabled={!hasSelection} title={!hasSelection ? '请先选择文字' : undefined} onClick={() => void handleTranslate()}><span><AppIcon name="languages" /></span><strong>翻译选中</strong><small>{hasSelection ? '翻译当前选区' : '请先选择文字'}</small></button>
                <button type="button" role="menuitem" onClick={() => void handleSummarize()}><span><AppIcon name="summary" /></span><strong>生成摘要</strong><small>提炼当前文档</small></button>
                <button type="button" role="menuitem" onClick={() => void handleOutline()}><span><AppIcon name="outline" /></span><strong>生成大纲</strong><small>整理文档结构</small></button>
              </div>
              <div className="status-ai-options">
                <div className="status-ai-option-row"><span>操作模式</span><span className="status-ai-segments">{EDIT_MODES.map(({ value, label }) => <button key={value} type="button" className={editMode === value ? 'selected' : ''} onClick={() => setEditMode(value)}>{label}</button>)}</span></div>
              </div>
              <button type="button" className="status-ai-settings" onClick={openAISettings}>打开 AI 设置</button>
            </div>
          )}
        </div>
        <span className="status-divider" aria-hidden="true" />
        <button
          type="button"
          className={`status-item status-button status-proofread-trigger${aiStatus === 'proofreading' ? ' is-running' : ''}`}
          title={`${hasSelection ? '校对选中文字' : '校对全文'}${settings.ai.enabled && settings.ai.proofread_with_ai !== false ? '' : '（Markdown 检查）'}`}
          onClick={() => void handleProofread()}
        >
          <StatusGlyph name="proofread" />
          <span>{aiStatus === 'proofreading' ? '校对中' : '校对文字'}</span>
        </button>
        <span className="status-divider" aria-hidden="true" />
        <div className="status-companion-control" ref={companionMenuRef}>
          <button
            type="button"
            className={`status-item status-button status-companion-trigger${companionEnabled ? ' is-enabled' : ''}${companionMenuOpen ? ' active' : ''}`}
            aria-haspopup="menu"
            aria-expanded={companionMenuOpen}
            title={companionEnabled ? `AI 伴写已开启，当前风格：${companionStyleLabel}` : 'AI 伴写已关闭'}
            onClick={() => {
              setAiMenuOpen(false);
              setCompanionMenuOpen((open) => !open);
            }}
          >
            <span className="status-companion-dot" aria-hidden="true" />
            <span>伴写</span>
            <span className="status-companion-value">{companionEnabled ? companionStyleLabel : '关闭'}</span>
            <span className="status-companion-chevron" aria-hidden="true"><AppIcon name="chevronUp" size={14} /></span>
          </button>
          {companionMenuOpen && (
            <div className="status-style-menu status-companion-menu" role="menu" aria-label="AI 伴写设置">
              <div className="status-companion-menu-header">
                <div><strong>AI 伴写</strong><small>{companionEnabled ? '已开启' : '已关闭'}</small></div>
                <button
                  type="button"
                  className={`status-companion-toggle${companionEnabled ? ' is-enabled' : ''}`}
                  onClick={() => void setCompanionEnabled(!companionEnabled)}
                >
                  {companionEnabled ? '关闭' : '开启'}
                </button>
              </div>
              <div className="status-style-menu-title">伴写风格</div>
              {WRITING_STYLES.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={settings.ai.writing_style === value}
                  className={`status-style-option${settings.ai.writing_style === value ? ' selected' : ''}`}
                  onClick={() => void setCompanionStyle(value)}
                >
                  <span className="status-style-check" aria-hidden="true">{settings.ai.writing_style === value ? <AppIcon name="check" size={14} /> : ''}</span>
                  <span>{label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <span className="status-divider" aria-hidden="true" />
        <WebDavStatusItem
          settings={settings.webdav}
          s3Settings={settings.s3}
          onOpenSettings={openCloudSettings}
          onToggleProvider={(provider, enabled) => void updateCloudProvider(provider, enabled)}
        />
      </div>
      <div className="statusbar-center">
        {aiStatus !== 'idle' ? (
          <div className="ai-status">
            {(aiStatus === 'loading' || aiStatus === 'proofreading' || aiStatus === 'companion') && <span className="status-item ai-checking"><span className="ai-spinner" />{aiStatusMessage || '处理中...'}</span>}
            {aiStatus === 'error' && <span className="status-item ai-error"><StatusGlyph name="error" />{aiStatusMessage || 'AI服务异常'}</span>}
            {aiStatus === 'success' && errorCount > 0 && <button type="button" className="status-item status-button ai-result clickable" onClick={() => setProofreadPanelVisible(true)}><StatusGlyph name="success" />发现 {errorCount} 处问题，点击查看</button>}
            {aiStatus === 'success' && errorCount === 0 && aiStatusMessage && <span className="status-item ai-success"><StatusGlyph name="success" />{aiStatusMessage}</span>}
          </div>
        ) : conversionStatus !== 'idle' ? (
          <div className="conversion-status">
            {conversionStatus === 'converting' && <span className="status-item conversion-working"><span className="ai-spinner" />{conversionMessage}</span>}
            {conversionStatus === 'success' && <span className="status-item conversion-success"><StatusGlyph name="success" />{conversionMessage}</span>}
            {conversionStatus === 'error' && <span className="status-item conversion-error"><StatusGlyph name="error" />{conversionMessage}</span>}
          </div>
        ) : uploadStatus !== 'idle' ? (
          <div className="upload-status">
            {uploadStatus === 'uploading' && <><span className="status-item">上传中...</span><div className="progress-bar"><div className="progress-fill" style={{ width: `${uploadProgress}%` }} /></div><span className="status-item">{uploadProgress}%</span></>}
            {uploadStatus === 'success' && <span className="status-item upload-success"><StatusGlyph name="success" />上传成功</span>}
            {uploadStatus === 'error' && <span className="status-item upload-error"><StatusGlyph name="error" />上传失败: {uploadMessage}</span>}
          </div>
        ) : <span className="status-item status-file-name" title={currentFile || '尚未保存到文件'}>{currentFile ? currentFile.split(/[\\/]/).pop() : '未保存'}</span>}
      </div>
      <div className="statusbar-right">
        {settings.mcp.enabled && (
          <>
            <button
              type="button"
              className={`status-item status-button status-mcp${mcpRunning ? ' is-running' : ''}`}
              title={`MCP 服务器：${mcpRunning ? `运行中${mcpConnected > 0 ? ` · ${mcpConnected} 个 AI 助手已连接` : ' · 等待连接'}` : '未运行'}（点击打开设置）`}
              onClick={() => { setSettingsTab('mcp'); setSettingsOpen(true); }}
            >
              <span className={`status-mcp-dot${mcpRunning ? (mcpConnected > 0 ? ' connected' : ' running') : ''}`} aria-hidden="true" />
              <span>MCP</span>
            </button>
            <span className="status-divider" aria-hidden="true" />
          </>
        )}
        <span className="status-item status-statistics" title={wordCount}>{wordCount}</span><span className="status-divider" aria-hidden="true" /><button type="button" className="status-item status-button status-encoding" aria-label="文字编码" title="选择保存编码或用指定编码重新打开（桌面版）" disabled={!('__TAURI_INTERNALS__' in window)} onClick={() => { const tab = useAppStore.getState().getActiveTab(); if (tab) useAppStore.getState().setEncodingDialog({ mode: 'save', tabId: tab.id }); }}>{encodingLabel(activeEncoding)}<AppIcon name="chevronUp" size={12} /></button>
      </div>
    </div>
  );
}
