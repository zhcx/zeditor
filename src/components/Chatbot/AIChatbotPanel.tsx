import { useEffect, useRef, useState, useCallback, useMemo, type PointerEvent as ReactPointerEvent } from 'react';
import { useAIStore, type ChatMessage, type ReasoningEffort, type WorkspaceContextPayload } from '../../stores/aiStore';
import { AI_PROVIDER_DEFINITIONS, useAppStore, type AIProviderId } from '../../stores/appStore';
import { WorkspaceContextPanel } from './WorkspaceContextPanel';
import { formatWebSearchContext, formatWebSearchMarkdown, performWebSearch, type WebSearchResponse } from '../../services/webSearch';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import MarkdownIt from 'markdown-it';
import { readStoredStringArray } from '../../utils/storage';
import { sanitizeRenderedHtml } from '../../utils/safeHtml';
import { AgentPanel, RuntimeTabs } from './AgentPanel';
import { ChatSelectMenu } from './ChatSelectMenu';
import type { AIRuntime } from '../../types/agent';
import { parseAIProviderProfiles } from '../../utils/aiProviderProfiles';
import { buildAutomaticEditorContext, formatAssistantInsertion } from '../../utils/assistantEditor';

const md = new MarkdownIt({ html: false, breaks: true, linkify: true });

const reasoningLabels: Record<ReasoningEffort, string> = {
  off: '关闭',
  fast: '快速',
  balanced: '均衡',
  deep: '深度',
};

interface PendingAttachment {
  type: 'image' | 'text' | 'file';
  name: string;
  dataUrl?: string;
  content?: string;
}

function ComposerIcon({ type }: { type: 'attach' | 'document' | 'image' | 'chat' | 'send' | 'stop' | 'search' | 'reasoning' | 'chevronDown' | 'newChat' | 'history' }) {
  if (type === 'attach') {
    return <svg className={`composer-icon composer-icon-${type}`} viewBox="0 0 16 16" aria-hidden="true"><path d="M5.2 8.8 9.7 4.3a2.35 2.35 0 1 1 3.3 3.3l-5.4 5.4a3.6 3.6 0 0 1-5.1-5.1l5-5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
  }
  if (type === 'document') {
    return <svg className={`composer-icon composer-icon-${type}`} viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.8h5l3 3v9.4H4zM9 1.8v3.3h3M6 8h4M6 10.5h4" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  }
  if (type === 'image') {
    return <svg className={`composer-icon composer-icon-${type}`} viewBox="0 0 16 16" aria-hidden="true"><rect x="1.8" y="2.5" width="12.4" height="11" rx="1" fill="none" stroke="currentColor" strokeWidth="1.25" /><circle cx="5.2" cy="6" r="1.1" fill="none" stroke="currentColor" strokeWidth="1.1" /><path d="m2.8 12 3.4-3.3 2.2 2 2.2-2.4 2.7 2.8" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  }
  if (type === 'chat') {
    return <svg className={`composer-icon composer-icon-${type}`} viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2.5h12v8H7l-3.5 3v-3H2z" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" /><path d="M5 6.5h6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>;
  }
  if (type === 'send') {
    return <svg className={`composer-icon composer-icon-${type}`} viewBox="0 0 16 16" aria-hidden="true"><path d="m2.2 2.5 11.2 5.1-11.2 5.1 2-5.1z" fill="currentColor" /><path d="M4.2 7.6h8.2" fill="none" stroke="var(--bg-elevated)" strokeWidth="1.15" strokeLinecap="round" /></svg>;
  }
  if (type === 'stop') {
    return <svg className={`composer-icon composer-icon-${type}`} viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" /></svg>;
  }
  if (type === 'search') {
    return <svg className={`composer-icon composer-icon-${type}`} viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="m10.2 10.2 3.2 3.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>;
  }
  if (type === 'reasoning') {
    return <svg className={`composer-icon composer-icon-${type}`} viewBox="0 0 16 16" aria-hidden="true"><path d="M2.3 10.9a5.7 5.7 0 1 1 11.4 0" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" /><path d="M8 10.8 10.65 7.9M4.4 11.05h.01M11.6 11.05h.01" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" /><path d="M3.5 13.1h9" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" /></svg>;
  }
  if (type === 'newChat') {
    return <svg className={`composer-icon composer-icon-${type}`} viewBox="0 0 16 16" aria-hidden="true"><path d="M2.4 2.8h8.7v7H6.4l-2.7 2.3V9.8H2.4zM12.2 5.2v5.6M9.4 8h5.6" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  }
  if (type === 'history') {
    return <svg className={`composer-icon composer-icon-${type}`} viewBox="0 0 16 16" aria-hidden="true"><path d="M3.1 4.5A5.5 5.5 0 1 1 2.5 8M3.1 4.5V1.8M3.1 4.5h2.7M8 4.7v3.6l2.4 1.4" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  }
  return <svg className={`composer-icon composer-icon-${type}`} viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function ReasoningOptionIcon({ effort }: { effort: ReasoningEffort }) {
  if (effort === 'off') {
    return <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.2" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="m4.3 4.3 7.4 7.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>;
  }
  if (effort === 'fast') {
    return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m9.45 1.8-4.55 6h3.15L6.9 14.2l4.6-6H8.3z" fill="currentColor" /></svg>;
  }
  if (effort === 'balanced') {
    return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 5.2h10M3 8h10M3 10.8h10" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" /><path d="M5 3.4v9.2M11 3.4v9.2" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity=".65" /></svg>;
  }
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.1 7.4c-.55-1.65.55-3.35 2.2-3.45.52-1.3 2.86-1.36 3.4 0 1.8-.05 2.8 1.95 1.8 3.35 1.12.72.72 2.53-.5 2.7-.35 1.45-2.45 1.85-3.2.55-1.28.75-2.9-.3-2.45-1.7-1.05-.22-1.55-.9-1.25-1.45Z" fill="none" stroke="currentColor" strokeWidth="1.05" strokeLinejoin="round" /><path d="M6.7 6.1v1.1M9.4 5.9v1.15M7.9 8.6v1.15" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" /></svg>;
}

export function AIChatbotPanel() {
  const [runtime, setRuntime] = useState<AIRuntime>(() => {
    try { return localStorage.getItem('zeditor.ai-runtime') === 'agent' ? 'agent' : 'api'; }
    catch { return 'api'; }
  });
  const handleRuntimeChange = (next: AIRuntime) => {
    setRuntime(next);
    try { localStorage.setItem('zeditor.ai-runtime', next); } catch { /* ignored */ }
  };
  return runtime === 'agent'
    ? <AgentPanel onRuntimeChange={handleRuntimeChange} />
    : <ApiChatPanel onRuntimeChange={handleRuntimeChange} />;
}

function ApiChatPanel({ onRuntimeChange }: { onRuntimeChange: (runtime: AIRuntime) => void }) {
  const {
    chatbotMessages,
    chatbotConversations,
    activeChatConversationId,
    chatbotLoading,
    stopChatMessage,
    setChatbotVisible,
    sendChatMessage,
    clearChatHistory,
    newChatConversation,
    selectChatConversation,
    reasoningEffort,
    setReasoningEffort,
    linkedDocument,
    setLinkedDocument,
    toggleLinkDocument,
  } = useAIStore();

  const { settings, activeTabId, tabs, content, currentFile } = useAppStore();
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const automaticContext = useMemo(() => buildAutomaticEditorContext({
    id: activeTabId,
    title: activeTab?.title || '当前文档',
    path: currentFile,
    content,
  }), [activeTab?.title, activeTabId, content, currentFile]);
  const currentDocumentKey = automaticContext?.key || `${activeTabId || currentFile || 'untitled'}:untitled`;
  const workspaceConfig = useMemo(() => {
    try {
      const roots = readStoredStringArray('zeditor.workspace-roots');
      const key = roots[0] ? `zeditor.workspace-ai-config:${roots[0]}` : '';
      if (!key) return { key };
      const saved = JSON.parse(localStorage.getItem(key) || '{}') as { provider?: AIProviderId; model?: string };
      return { key, ...saved };
    } catch {
      return { key: '' };
    }
  }, []);
  const workspaceConfigKey = workspaceConfig.key;
  const [chatProvider, setChatProvider] = useState<AIProviderId>(() => workspaceConfig.provider || settings.ai.provider);
  const [chatModel, setChatModel] = useState(() => workspaceConfig.model || settings.ai.model);
  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerResizeRef = useRef({ active: false, startY: 0, startHeight: 84 });
  const [inputValue, setInputValue] = useState('');
  const [composerHeight, setComposerHeight] = useState(84);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [webSearchActive, setWebSearchActive] = useState(false);
  const [webSearchLoading, setWebSearchLoading] = useState(false);
  const [workspaceContext, setWorkspaceContext] = useState<WorkspaceContextPayload | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyRef = useRef<HTMLDivElement>(null);
  const automaticDocumentKeyRef = useRef<string | null>(null);
  const dismissedDocumentKeyRef = useRef<string | null>(null);
  const webSearchEnabled = settings.web_search.enabled;
  useEffect(() => {
    if (!workspaceConfigKey) return;
    try {
      localStorage.setItem(workspaceConfigKey, JSON.stringify({ provider: chatProvider, model: chatModel }));
    } catch { /* Storage may be unavailable in restricted WebViews. */ }
  }, [workspaceConfigKey, chatProvider, chatModel]);
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [chatbotMessages, webSearchLoading]);

  useEffect(() => {
    if (automaticDocumentKeyRef.current !== currentDocumentKey) {
      automaticDocumentKeyRef.current = currentDocumentKey;
      dismissedDocumentKeyRef.current = null;
      setLinkedDocument(automaticContext ? {
        title: automaticContext.context.label,
        path: automaticContext.context.path,
        content: automaticContext.context.content,
      } : null);
      return;
    }
    if (!automaticContext || dismissedDocumentKeyRef.current === currentDocumentKey) return;
    const next = automaticContext.context;
    if (
      linkedDocument?.title !== next.label
      || linkedDocument.path !== next.path
      || linkedDocument.content !== next.content
    ) {
      setLinkedDocument({ title: next.label, path: next.path, content: next.content });
    }
  }, [automaticContext, currentDocumentKey, linkedDocument, setLinkedDocument]);

  const toggleCurrentDocumentLink = () => {
    if (linkedDocument) {
      dismissedDocumentKeyRef.current = currentDocumentKey;
      setLinkedDocument(null);
      return;
    }
    dismissedDocumentKeyRef.current = null;
    if (automaticContext) {
      setLinkedDocument({
        title: automaticContext.context.label,
        path: automaticContext.context.path,
        content: automaticContext.context.content,
      });
    } else {
      toggleLinkDocument();
    }
  };

  useEffect(() => {
    if (!historyOpen) return;
    const closeHistory = (event: MouseEvent) => {
      if (!historyRef.current?.contains(event.target as Node)) setHistoryOpen(false);
    };
    window.addEventListener('mousedown', closeHistory);
    return () => window.removeEventListener('mousedown', closeHistory);
  }, [historyOpen]);

  const handleSend = useCallback(async () => {
    const text = inputValue.trim();
    if ((!text && pendingAttachments.length === 0) || chatbotLoading || webSearchLoading) return;

    const attachments = pendingAttachments.length > 0 ? [...pendingAttachments] : undefined;
    // Give instant feedback before any network-bound search work begins.
    setPendingAttachments([]);
    setInputValue('');
    setComposerHeight(84);

    let searchPreview: WebSearchResponse | undefined;
    let searchContext: string | undefined;
    if (webSearchEnabled && webSearchActive && text) {
      setWebSearchLoading(true);
      try {
        const search = await performWebSearch(text, settings.web_search);
        searchPreview = search;
        searchContext = formatWebSearchContext(search);
      } catch (error) {
        setInputValue(text);
        if (attachments) setPendingAttachments(attachments);
        window.alert(`网络搜索失败：${String(error)}`);
        return;
      } finally {
        setWebSearchLoading(false);
      }
    }
    sendChatMessage(text, attachments, { provider: chatProvider, model: chatModel, searchContext, searchPreview, workspaceContext });
  }, [inputValue, pendingAttachments, chatbotLoading, sendChatMessage, chatProvider, chatModel, settings.web_search, webSearchActive, webSearchEnabled, webSearchLoading, workspaceContext]);

  const providerProfiles = useMemo(
    () => parseAIProviderProfiles(settings.ai.provider_profiles),
    [settings.ai.provider_profiles],
  );

  const selectedProfile = providerProfiles[chatProvider];
  const selectedDefinition = AI_PROVIDER_DEFINITIONS.find((item) => item.id === chatProvider);
  const availableProviders = AI_PROVIDER_DEFINITIONS.filter((provider) =>
    provider.id === settings.ai.provider || Boolean(providerProfiles[provider.id]?.api_key),
  );
  const chatModels = Array.from(new Set([
    ...(selectedProfile?.models || []),
    selectedProfile?.model,
    chatProvider === settings.ai.provider ? settings.ai.model : undefined,
  ].filter((model): model is string => Boolean(model))));

  const handleChatProviderChange = (provider: AIProviderId) => {
    const profile = providerProfiles[provider];
    setChatProvider(provider);
    setChatModel(profile?.model || AI_PROVIDER_DEFINITIONS.find((item) => item.id === provider)?.model || '');
  };

  const handleComposerResizeStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    composerResizeRef.current = {
      active: true,
      startY: event.clientY,
      startHeight: composerHeight,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [composerHeight]);

  const handleComposerResizeMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = composerResizeRef.current;
    if (!resize.active) return;
    // The composer stays docked to the bottom: dragging its top edge upward
    // increases the writing area, which matches standard chat-app behavior.
    const nextHeight = Math.max(72, Math.min(280, resize.startHeight + resize.startY - event.clientY));
    setComposerHeight(nextHeight);
  }, []);

  const handleComposerResizeEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    composerResizeRef.current.active = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const isEnter = e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter';
    if (!isEnter || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    e.stopPropagation();
    void handleSend();
  };

  const handleAttach = async () => {
    try {
      const selected = await open({
        multiple: true,
        filters: [
          { name: '图片和文本', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'txt', 'md', 'json', 'yaml', 'yml', 'xml', 'csv', 'log'] },
        ],
      });

      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];

      const newAttachments: PendingAttachment[] = [];

      for (const path of paths) {
        const ext = path.split('.').pop()?.toLowerCase() || '';
        const name = path.split(/[/\\]/).pop() || path;
        const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext);

        if (isImage) {
          const dataUrl = await invoke<string>('read_file_base64', { path });
          newAttachments.push({ type: 'image', name, dataUrl });
        } else {
          const content = await invoke<string>('get_text_attachment_content', { path });
          newAttachments.push({ type: 'text', name, content });
        }
      }

      setPendingAttachments(prev => [...prev, ...newAttachments]);
    } catch (err) {
      console.error('Failed to attach file:', err);
    }
  };

  const removeAttachment = (index: number) => {
    setPendingAttachments(prev => prev.filter((_, i) => i !== index));
  };

  const [reasoningMenuOpen, setReasoningMenuOpen] = useState(false);
  const reasoningMenuRef = useRef<HTMLDivElement>(null);

  // Close reasoning menu on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (reasoningMenuRef.current && !reasoningMenuRef.current.contains(e.target as Node)) {
        setReasoningMenuOpen(false);
      }
    };
    if (reasoningMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [reasoningMenuOpen]);

  return (
    <div className="chatbot-panel">
      <div className="chatbot-header">
        <RuntimeTabs active="api" onChange={onRuntimeChange} />
        <div className="chatbot-header-main">
          <div className="chatbot-header-identity">
            <span className="chatbot-header-mark" aria-hidden="true">AI</span>
            <div>
              <div className="chatbot-header-title-row">
                <h4>AI 对话</h4>
                {workspaceConfigKey && (
                  <span className="workspace-ai-scope" title="服务商与模型偏好仅保存于当前工作区">
                    <span className="workspace-ai-scope-dot" aria-hidden="true" />
                    当前工作区
                  </span>
                )}
              </div>
              <span className="chatbot-header-subtitle">智能写作助手</span>
            </div>
          </div>
          <div className="chatbot-header-actions">
            <button className="chatbot-header-action" onClick={newChatConversation} disabled={chatbotLoading} title="新建 AI 对话" aria-label="新建 AI 对话">
              <ComposerIcon type="newChat" />
            </button>
            <div className="chatbot-history" ref={historyRef}>
              <button className={`chatbot-header-action ${historyOpen ? 'active' : ''}`} onClick={() => setHistoryOpen((open) => !open)} title="对话历史" aria-label="打开 AI 对话历史" aria-expanded={historyOpen}>
                <ComposerIcon type="history" />
              </button>
              {historyOpen && (
                <div className="chatbot-history-popover" role="dialog" aria-label="AI 对话历史">
                  <header><strong>对话历史</strong><span>{chatbotConversations.length} 条</span></header>
                  <div className="chatbot-history-list">
                    {chatbotConversations.map((conversation) => (
                      <button
                        key={conversation.id}
                        className={conversation.id === activeChatConversationId ? 'active' : ''}
                        onClick={() => { selectChatConversation(conversation.id); setHistoryOpen(false); }}
                      >
                        <strong>{conversation.title}</strong>
                        <span>{new Date(conversation.updatedAt).toLocaleString()} · {conversation.messages.filter((message) => message.role === 'user').length} 轮</span>
                      </button>
                    ))}
                    {chatbotConversations.length === 0 && <div className="chatbot-history-empty">暂无历史对话</div>}
                  </div>
                </div>
              )}
            </div>
            <button className="chatbot-close-btn" onClick={() => setChatbotVisible(false)} title="关闭" aria-label="关闭 AI 对话">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
            </button>
          </div>
        </div>
        <div className="chatbot-ai-selectors">
          <span className="chatbot-selector-label chatbot-provider-label">服务商</span>
          <span className="chatbot-selector-label chatbot-model-label">模型</span>
          <ChatSelectMenu
            className="chatbot-provider-select"
            value={chatProvider}
            label={selectedDefinition?.label || chatProvider}
            options={availableProviders.map((provider) => ({ value: provider.id, label: provider.label }))}
            onChange={(value) => handleChatProviderChange(value as AIProviderId)}
            ariaLabel="选择 AI 服务商"
          />
          <ChatSelectMenu
            className="chatbot-model-select"
            value={chatModel}
            label={chatModel || '请先配置模型'}
            options={chatModels.map((model) => ({ value: model, label: model }))}
            onChange={setChatModel}
            ariaLabel={selectedDefinition ? `${selectedDefinition.label} 模型` : '选择模型'}
            disabled={chatModels.length === 0}
          />
        </div>
      </div>

      <div className="chatbot-messages" ref={listRef}>
        {chatbotMessages.length === 0 ? (
          <div className="chatbot-empty">
            <div className="chatbot-empty-icon"><ComposerIcon type="chat" /></div>
            <div className="chatbot-empty-text">开始 AI 对话</div>
            <div className="chatbot-empty-hint">
              向 AI 提问关于当前文档的内容，或寻求写作帮助
            </div>
          </div>
        ) : (
          chatbotMessages.map((msg) => (
            <ChatBubble key={msg.id} message={msg} />
          ))
        )}
        {chatbotLoading && chatbotMessages[chatbotMessages.length - 1]?.role === 'user' && (
          <div className="chatbot-message assistant">
            <div className="chatbot-avatar assistant-avatar">AI</div>
            <div className="chatbot-bubble assistant-bubble thinking">
              <span className="chatbot-typing-dot" />
              <span className="chatbot-typing-dot" />
              <span className="chatbot-typing-dot" />
            </div>
          </div>
        )}
        {webSearchLoading && (
          <div className="chatbot-message assistant">
            <div className="chatbot-avatar assistant-avatar">AI</div>
            <div className="chatbot-bubble assistant-bubble thinking">
              <span className="chatbot-searching-label">正在联网搜索</span>
              <span className="chatbot-typing-dot" />
              <span className="chatbot-typing-dot" />
              <span className="chatbot-typing-dot" />
            </div>
          </div>
        )}
      </div>

      {pendingAttachments.length > 0 && (
        <div className="chatbot-attachment-bar">
          {pendingAttachments.map((att, i) => (
            <div key={i} className="chatbot-attachment-chip">
              <ComposerIcon type={att.type === 'image' ? 'image' : 'document'} />
              <span className="chatbot-attachment-name">{att.name}</span>
              <button className="chatbot-attachment-remove" onClick={() => removeAttachment(i)}>×</button>
            </div>
          ))}
        </div>
      )}

      {linkedDocument && (
        <div className="chatbot-linked-doc-bar">
          <span className="chatbot-linked-doc-icon"><ComposerIcon type="document" /></span>
          <span className="chatbot-linked-doc-name">{linkedDocument.title}</span>
          <button className="chatbot-linked-doc-unlink" onClick={toggleCurrentDocumentLink} title="取消关联">×</button>
        </div>
      )}

      <WorkspaceContextPanel
        linkedDocument={linkedDocument}
        query={inputValue}
        providerLabel={selectedDefinition?.label || chatProvider}
        onChange={setWorkspaceContext}
      />

      <div className="chatbot-input-area">
        <div
          className="chatbot-composer-resize-handle"
          role="separator"
          aria-label="调整输入框高度"
          aria-orientation="horizontal"
          title="向上拖动可增大输入框"
          onPointerDown={handleComposerResizeStart}
          onPointerMove={handleComposerResizeMove}
          onPointerUp={handleComposerResizeEnd}
          onPointerCancel={handleComposerResizeEnd}
        />
        <div className="chatbot-input-toolbar">
          <button className="chatbot-toolbar-btn" onClick={handleAttach} title="上传附件">
            <span className="chatbot-toolbar-icon"><ComposerIcon type="attach" /></span>
          </button>
          <button
            className={`chatbot-toolbar-btn chatbot-link-btn ${linkedDocument ? 'linked' : ''}`}
            onClick={toggleCurrentDocumentLink}
            title={linkedDocument ? '取消关联文档' : '关联当前文档'}
          >
            <span className="chatbot-toolbar-icon"><ComposerIcon type="document" /></span>
          </button>
          <button
            className={`chatbot-toolbar-btn web-search-btn ${webSearchEnabled && webSearchActive ? 'active' : ''}`}
            onClick={() => setWebSearchActive((active) => !active)}
            disabled={!webSearchEnabled}
            aria-pressed={webSearchEnabled && webSearchActive}
            title={webSearchEnabled ? (webSearchActive ? '网络搜索已开启，发送消息时将先搜索' : '开启网络搜索') : '请先在设置中启用网络搜索'}
          >
            <span className="chatbot-toolbar-icon"><ComposerIcon type="search" /></span>
            <span className="chatbot-tool-label">{webSearchActive ? '已开启' : '搜索'}</span>
          </button>
          <div className="reasoning-dropdown" ref={reasoningMenuRef}>
            <button
              className={`chatbot-toolbar-btn reasoning-btn reasoning-${reasoningEffort}`}
              onClick={() => setReasoningMenuOpen(!reasoningMenuOpen)}
              title="思考强度"
            >
            <span className="reasoning-symbol" aria-hidden="true"><ComposerIcon type="reasoning" /></span>
              <span className="reasoning-label">{reasoningLabels[reasoningEffort]}</span>
              <span className="reasoning-arrow" aria-hidden="true"><ComposerIcon type="chevronDown" /></span>
            </button>
            {reasoningMenuOpen && (
              <div className="reasoning-menu">
                {(Object.keys(reasoningLabels) as ReasoningEffort[]).map((effort) => (
                  <button
                    key={effort}
                    className={`reasoning-menu-item ${effort === reasoningEffort ? 'active' : ''}`}
                    onClick={() => { setReasoningEffort(effort); setReasoningMenuOpen(false); }}
                  >
                    <span className={`reasoning-menu-icon reasoning-menu-icon-${effort}`}><ReasoningOptionIcon effort={effort} /></span>
                    <span className="reasoning-menu-label">{reasoningLabels[effort]}</span>
                    <span className="reasoning-menu-desc">
                      {effort === 'off' ? '不额外设置' : effort === 'fast' ? '快速响应' : effort === 'balanced' ? '均衡兼顾' : '深度思考'}
                    </span>
                    {effort === reasoningEffort && <span className="reasoning-menu-check">✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="chatbot-toolbar-spacer" />
          <button
            className="chatbot-send-btn"
            disabled={webSearchLoading || (!chatbotLoading && (!inputValue.trim() && pendingAttachments.length === 0))}
            onClick={chatbotLoading ? stopChatMessage : handleSend}
            title={chatbotLoading ? '终止生成' : webSearchLoading ? '正在联网搜索' : '发送消息'}
          >
            <span className="chatbot-toolbar-icon"><ComposerIcon type={chatbotLoading ? 'stop' : 'send'} /></span>
          </button>
        </div>
        <textarea
          ref={textareaRef}
          className="chatbot-textarea"
          placeholder="输入消息… (Enter 发送, Shift+Enter 换行)"
          rows={4}
          style={{ height: composerHeight }}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDownCapture={handleKeyDown}
          aria-keyshortcuts="Enter"
        />
      </div>

      <div className="chatbot-footer">
        <span className="chatbot-footer-hint">Enter 发送 · Shift+Enter 换行</span>
        {chatbotMessages.length > 0 && (
          <button className="chatbot-clear-btn" onClick={clearChatHistory}>
            清空对话
          </button>
        )}
      </div>
    </div>
  );
}

function WebSearchPreview({ response }: { response: WebSearchResponse }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const copySources = async () => {
    await navigator.clipboard.writeText(formatWebSearchMarkdown(response));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  return (
    <section className="chatbot-search-preview" aria-label="网络搜索结果">
      <div className="chatbot-search-preview-header">
        <div className="chatbot-search-preview-title">
          <span className="chatbot-search-preview-icon" aria-hidden="true"><ComposerIcon type="search" /></span>
          <div>
            <strong>网络搜索</strong>
            <span>{response.provider === 'tavily' ? 'Tavily' : 'SearXNG'} · {response.results.length} 条来源</span>
          </div>
        </div>
        <button
          className="chatbot-search-preview-toggle"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          {expanded ? '收起' : '展开'}
        </button>
        <button className="chatbot-search-preview-toggle" onClick={() => void copySources()} title="复制为 Markdown 脚注来源">
          {copied ? '已复制' : '导出来源'}
        </button>
      </div>
      {expanded && (
        <div className="chatbot-search-preview-content">
          {response.answer && <div className="chatbot-search-answer">{response.answer}</div>}
          <div className="chatbot-search-result-list">
            {response.results.map((result, index) => (
              <a
                className="chatbot-search-result-card"
                href={result.url}
                key={`${result.url}-${index}`}
                target="_blank"
                rel="noreferrer"
              >
                <span className="chatbot-search-result-index">{String(index + 1).padStart(2, '0')}</span>
                <span className="chatbot-search-result-body">
                  <strong>{result.title || result.url}</strong>
                  {result.content && <span>{result.content.replace(/\s+/g, ' ').trim()}</span>}
                  <small>{getSearchDomain(result.url)} · {result.published_at ? `发布：${result.published_at}` : '发布时间未提供'} · 访问：{response.accessed_at}</small>
                </span>
                <span className="chatbot-search-result-arrow" aria-hidden="true">↗</span>
              </a>
            ))}
            {response.results.length === 0 && <div className="chatbot-search-empty">没有找到相关结果</div>}
          </div>
        </div>
      )}
    </section>
  );
}

function getSearchDomain(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function ChatBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  const time = new Date(message.timestamp);
  const timeStr = time.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const [copied, setCopied] = useState(false);
  const [reasoningExpanded, setReasoningExpanded] = useState(false);
  const userToggledRef = useRef(false);

  const { chatbotLoading, chatbotStreamingPhase, chatbotMessages } = useAIStore();
  const { editorView, content, setContent } = useAppStore();
  const isStreaming = chatbotLoading && !isUser &&
    chatbotMessages.length > 0 &&
    chatbotMessages[chatbotMessages.length - 1].id === message.id;

  // Auto-expand reasoning during reasoning phase, auto-collapse when content starts
  useEffect(() => {
    if (!isStreaming) return;
    if (chatbotStreamingPhase === 'reasoning') {
      if (!userToggledRef.current) {
        setReasoningExpanded(true);
      }
    } else if (chatbotStreamingPhase === 'content') {
      if (!userToggledRef.current) {
        setReasoningExpanded(false);
      }
    }
  }, [isStreaming, chatbotStreamingPhase]);

  const handleToggleReasoning = () => {
    userToggledRef.current = true;
    setReasoningExpanded(!reasoningExpanded);
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignored */ }
  };

  const insertIntoEditor = () => {
    if (!message.content) return;
    if (editorView) {
      const range = editorView.getSelection();
      const before = editorView.getText(0, range.from);
      const insertedText = formatAssistantInsertion(message.content, before);
      editorView.replaceRange(range.from, range.to, insertedText, { from: range.from + insertedText.length, to: range.from + insertedText.length });
      editorView.focus();
      return;
    }
    setContent(`${content}${formatAssistantInsertion(message.content, content)}`);
  };

  const renderedHtml = useMemo(() => {
    if (!message.content) return '';
    return sanitizeRenderedHtml(md.render(message.content));
  }, [message.content]);

  const renderedReasoning = useMemo(() => {
    if (!message.reasoning) return '';
    return sanitizeRenderedHtml(md.render(message.reasoning));
  }, [message.reasoning]);

  return (
    <div className={`chatbot-message ${isUser ? 'user' : 'assistant'}`}>
      {!isUser && <div className="chatbot-avatar assistant-avatar">AI</div>}
      <div className="chatbot-message-body">
        <div className={`chatbot-bubble ${isUser ? 'user-bubble' : 'assistant-bubble'}`}>
          {message.reasoning && (
            <div className={`chatbot-reasoning ${reasoningExpanded ? 'expanded' : ''}`}>
              <button
                className="chatbot-reasoning-toggle"
                onClick={handleToggleReasoning}
              >
                <span className="chatbot-reasoning-arrow">{reasoningExpanded ? '▼' : '▶'}</span>
                <span>{isStreaming && chatbotStreamingPhase === 'reasoning' ? '正在思考…' : '思考过程'}</span>
              </button>
              {reasoningExpanded && (
                <div
                  className="chatbot-reasoning-content"
                  dangerouslySetInnerHTML={{ __html: renderedReasoning }}
                />
              )}
            </div>
          )}
          {message.content ? (
            <div
              className="chatbot-bubble-content"
              dangerouslySetInnerHTML={{ __html: renderedHtml }}
            />
          ) : isStreaming ? (
            <div className="chatbot-bubble-content">
              <span className="chatbot-typing-dot" />
              <span className="chatbot-typing-dot" />
              <span className="chatbot-typing-dot" />
            </div>
          ) : null}
          <div className="chatbot-bubble-footer">
            {!isUser && message.content && (
              <>
                <button className="chatbot-insert-btn" onClick={insertIntoEditor} title="插入当前编辑器">插入编辑器</button>
                <button className="chatbot-copy-btn" onClick={handleCopy} title="复制">
                  {copied ? '✓' : '📋'}
                </button>
              </>
            )}
          </div>
        </div>
        {message.search && <WebSearchPreview response={message.search} />}
        <div className={`chatbot-message-time ${isUser ? 'user' : 'assistant'}`}>
          {timeStr}
        </div>
      </div>
      {isUser && <div className="chatbot-avatar user-avatar">我</div>}
    </div>
  );
}
