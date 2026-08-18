import { useEffect, useMemo, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import { useAppStore } from '../../stores/appStore';
import { useAIStore } from '../../stores/aiStore';
import { useAgentStore } from '../../stores/agentStore';
import type { AgentApprovalMode, AgentBackendId, AgentEditorContext, AgentTimelineItem } from '../../types/agent';
import { readStoredStringArray } from '../../utils/storage';
import { sanitizeRenderedHtml } from '../../utils/safeHtml';
import { ChatSelectMenu } from './ChatSelectMenu';

const agentMarkdown = new MarkdownIt({ html: false, breaks: true, linkify: true, typographer: true });
agentMarkdown.use(taskLists);

const BACKEND_LABELS: Record<AgentBackendId, string> = {
  claude_code: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

const EFFORT_LABELS: Record<string, string> = {
  '': '自动',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最大',
  ultra: 'Ultra',
};

const normalizeWorkspacePath = (value: string) => {
  let path = value.trim();
  if (path.startsWith('\\\\?\\UNC\\')) path = `\\\\${path.slice(8)}`;
  else if (path.startsWith('\\\\?\\')) path = path.slice(4);
  return path.replace(/[\\/]+$/, '').toLocaleLowerCase();
};

interface AgentPanelProps {
  onRuntimeChange: (runtime: 'api' | 'agent') => void;
}

export function AgentPanel({ onRuntimeChange }: AgentPanelProps) {
  const { settings, content, currentFile, editorView, setContent } = useAppStore();
  const { setChatbotVisible } = useAIStore();
  const {
    backends, modelCatalogs, modelsLoading, sessions, activeSessionId, timeline, pendingApproval, changes, loading, diagnostic,
    initialize, detectBackends, loadModels, startTurn, cancelTurn, respondApproval, setApprovalMode,
    refreshChanges, applyChanges, discardSession, selectSession, newSession,
  } = useAgentStore();
  const [backend, setBackend] = useState<AgentBackendId>(settings.agent.backend);
  const [prompt, setPrompt] = useState('');
  const [approvalMode, setLocalApprovalMode] = useState<AgentApprovalMode>('tiered');
  const [model, setModel] = useState(settings.agent.backends[settings.agent.backend].model);
  const [profile, setProfile] = useState(settings.agent.backends[settings.agent.backend].profile);
  const [reasoningEffort, setReasoningEffort] = useState(settings.agent.backends[settings.agent.backend].reasoning_effort);
  const [contextPaths, setContextPaths] = useState<string[]>([]);
  const [editorContext, setEditorContext] = useState<AgentEditorContext | null>(null);
  const [researchReadOnly, setResearchReadOnly] = useState(true);
  const [selection, setSelection] = useState<{ key: string; excluded: string[] }>({ key: '', excluded: [] });
  const roots = useMemo(() => readStoredStringArray('zeditor.workspace-roots'), []);
  const workspaceRoot = roots[0] || '';
  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const backendConfig = settings.agent.backends[backend];
  const backendStatus = backends.find((item) => item.id === backend);
  const modelCatalog = modelCatalogs[backend];
  const effectiveModel = model || modelCatalog?.current_model || '';
  const effectiveApprovalMode = activeSession?.approval_mode || approvalMode;
  const selectedModel = modelCatalog?.models.find((item) => item.id === effectiveModel);
  const changeKey = changes?.files.map((file) => `${file.status}:${file.path}`).join('|') || '';
  const excludedPaths = selection.key === changeKey ? selection.excluded : [];
  const selectedPaths = changes?.files
    .map((file) => file.path)
    .filter((path) => !excludedPaths.includes(path)) || [];

  useEffect(() => {
    void initialize();
    const overrides = Object.fromEntries(Object.entries(settings.agent.backends)
      .filter(([, config]) => config.executable_path.trim())
      .map(([id, config]) => [id, config.executable_path])) as Partial<Record<AgentBackendId, string>>;
    void detectBackends(overrides);
  }, [detectBackends, initialize, settings.agent.backends]);

  useEffect(() => {
    if (!backendStatus?.compatible || modelCatalog || !workspaceRoot) return;
    void loadModels(backend, backendConfig.executable_path, profile, workspaceRoot);
  }, [backend, backendConfig.executable_path, backendStatus?.compatible, loadModels, modelCatalog, profile, workspaceRoot]);

  const chooseContextFiles = async () => {
    if (!workspaceRoot || loading) return;
    const selected = await open({ multiple: true, directory: false, defaultPath: workspaceRoot });
    const paths = typeof selected === 'string' ? [selected] : selected || [];
    setContextPaths((current) => [...new Set([...current, ...paths])]);
  };

  const changeApprovalMode = async (mode: AgentApprovalMode) => {
    if (mode === 'allow_all_session') {
      const confirmed = window.confirm('本会话后续的命令、网络、MCP 和目录内编辑将不再逐次询问。当前目录边界和禁止 Git push 等硬性限制仍然生效。');
      if (!confirmed) return;
    }
    setLocalApprovalMode(mode);
    if (activeSession) await setApprovalMode(mode);
  };

  const beginNewSession = () => {
    newSession();
    setLocalApprovalMode('tiered');
    setResearchReadOnly(true);
    setEditorContext(null);
    setContextPaths([]);
  };

  const changeBackend = (nextBackend: AgentBackendId) => {
    const config = settings.agent.backends[nextBackend];
    setBackend(nextBackend);
    setModel(config.model);
    setProfile(config.profile);
    setReasoningEffort(config.reasoning_effort);
    beginNewSession();
  };

  const resumeSession = (sessionId: string) => {
    const session = sessions.find((item) => item.id === sessionId);
    if (session && session.backend !== backend) {
      const config = settings.agent.backends[session.backend];
      setBackend(session.backend);
      setModel(config.model);
      setProfile(config.profile);
      setReasoningEffort(config.reasoning_effort);
    }
    if (session) setResearchReadOnly(session.read_only);
    void selectSession(sessionId);
  };

  const referenceEditor = () => {
    const range = editorView?.getSelection();
    const selectedText = range && !range.empty ? editorView?.getText(range.from, range.to) || '' : '';
    const referencedContent = selectedText || content;
    if (!referencedContent) return;
    setEditorContext({
      label: selectedText ? '当前选区' : (currentFile ? fileName(currentFile) : '当前文档'),
      path: currentFile || undefined,
      content: referencedContent,
      selection: Boolean(selectedText),
    });
  };

  const insertIntoEditor = (text: string) => {
    if (!text) return;
    if (editorView) {
      const range = editorView.getSelection();
      editorView.replaceRange(range.from, range.to, text, { from: range.from + text.length, to: range.from + text.length });
      editorView.focus();
      return;
    }
    const separator = content && !content.endsWith('\n') ? '\n\n' : '';
    setContent(`${content}${separator}${text}`);
  };

  const submit = async () => {
    const text = prompt.trim();
    if (!text || !workspaceRoot || loading || !backendStatus?.compatible) return;
    try {
      await startTurn({
        backend,
        workspaceRoot,
        prompt: text,
        executablePath: backendConfig.executable_path,
        model: effectiveModel,
        profile,
        reasoningEffort,
        contextPaths,
        editorContext: editorContext || undefined,
        approvalMode: effectiveApprovalMode,
        readOnly: researchReadOnly,
        sessionId: activeSession?.backend === backend ? activeSession.id : undefined,
      });
      setPrompt('');
      setContextPaths([]);
      setEditorContext(null);
    } catch {
      // The store exposes a stable diagnostic in the panel.
    }
  };

  const modelOptions = [
    ...(!modelCatalog?.current_model ? [{ value: '', label: 'CLI 默认模型', description: modelCatalog?.diagnostic }] : []),
    ...(modelCatalog?.models.map((item) => ({
      value: item.id,
      label: item.display_name,
      description: `${item.description}${item.is_default ? ' · CLI 默认' : ''}`,
    })) || []),
  ];
  if (model && !modelOptions.some((item) => item.value === model)) {
    modelOptions.unshift({ value: model, label: model, description: '自定义模型' });
  }
  const supportedEfforts = selectedModel?.supported_reasoning_efforts.length
    ? selectedModel.supported_reasoning_efforts
    : backend === 'claude_code' ? ['low', 'medium', 'high', 'xhigh', 'max'] : ['low', 'medium', 'high', 'xhigh'];
  const effortOptions = [
    { value: '', label: '自动', description: selectedModel?.default_reasoning_effort ? `模型默认：${EFFORT_LABELS[selectedModel.default_reasoning_effort] || selectedModel.default_reasoning_effort}` : '使用 CLI 或模型默认值' },
    ...supportedEfforts.map((effort) => ({ value: effort, label: EFFORT_LABELS[effort] || effort })),
  ];
  if (reasoningEffort && !effortOptions.some((item) => item.value === reasoningEffort)) {
    effortOptions.push({ value: reasoningEffort, label: EFFORT_LABELS[reasoningEffort] || reasoningEffort });
  }
  const modelLabel = selectedModel?.display_name || effectiveModel || (modelsLoading === backend ? '读取模型…' : 'CLI 默认模型');
  const normalizedWorkspaceRoot = normalizeWorkspacePath(workspaceRoot);
  const workspaceSessions = sessions.filter((session) => normalizeWorkspacePath(session.workspace_root) === normalizedWorkspaceRoot);
  const sessionLabel = activeSession
    ? `${BACKEND_LABELS[activeSession.backend]} · ${new Date(activeSession.updated_at).toLocaleString()}`
    : '新会话';

  if (!settings.agent.enabled) {
    return (
      <div className="agent-panel agent-disabled">
        <RuntimeTabs active="agent" onChange={onRuntimeChange} />
        <div className="agent-empty-state">
          <strong>Agent Beta 尚未启用</strong>
          <span>在“设置 → AI 助手”中启用本地 Agent。</span>
        </div>
      </div>
    );
  }

  return (
    <div className="agent-panel">
      <div className="chatbot-header agent-header">
        <RuntimeTabs active="agent" onChange={onRuntimeChange} />
        <div className="chatbot-header-main">
          <div className="chatbot-header-identity">
            <span className="chatbot-header-mark agent-header-mark" aria-hidden="true">AG</span>
            <div>
              <div className="chatbot-header-title-row">
                <h4>Agent</h4>
                <span className={`agent-header-state ${backendStatus?.compatible ? 'ready' : 'unavailable'}`}>
                  <span aria-hidden="true" />{backendStatus?.compatible ? '已连接' : '不可用'}
                </span>
              </div>
              <span className="chatbot-header-subtitle">本地编程助手</span>
            </div>
          </div>
          <button className="chatbot-close-btn" onClick={() => setChatbotVisible(false)} title="关闭" aria-label="关闭 Agent 对话">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
        </div>
        <div className="chatbot-ai-selectors agent-controls">
          <span className="chatbot-selector-label agent-backend-label">Agent</span>
          <span className="chatbot-selector-label agent-session-label">会话</span>
          <ChatSelectMenu
            className="agent-backend-select"
            value={backend}
            label={BACKEND_LABELS[backend]}
            options={(Object.keys(BACKEND_LABELS) as AgentBackendId[]).map((id) => ({
              value: id,
              label: BACKEND_LABELS[id],
              description: backends.find((item) => item.id === id)?.compatible ? '已发现并兼容' : '未安装或不可用',
            }))}
            onChange={(value) => changeBackend(value as AgentBackendId)}
            ariaLabel="选择 Agent"
          />
          <ChatSelectMenu
            className="agent-session-select"
            value={activeSessionId || ''}
            label={sessionLabel}
            options={[
              { value: '', label: '新会话', description: '开始独立的 Agent 对话' },
              ...workspaceSessions.map((session) => ({
                value: session.id,
                label: `${BACKEND_LABELS[session.backend]} · ${new Date(session.updated_at).toLocaleString()}`,
                description: session.status === 'running' ? '正在运行' : session.status === 'completed' ? '已完成' : '可继续',
              })),
            ]}
            onChange={(value) => value ? resumeSession(value) : beginNewSession()}
            ariaLabel="选择 Agent 会话"
          />
          <button type="button" className="agent-new-session-button" onClick={beginNewSession} disabled={loading} title="新建 Agent 对话" aria-label="新建 Agent 对话">+</button>
        </div>
        <div className={`agent-health ${backendStatus?.compatible ? 'ready' : 'unavailable'}`}>
          <span aria-hidden="true" />
          {backendStatus?.compatible
            ? `${backendStatus.version || '已发现'} · ${activeSession ? (activeSession.direct_write ? '当前目录已授权' : '隔离工作区') : '当前目录待授权'}`
            : backendStatus?.diagnostic || '正在检测运行环境'}
        </div>
      </div>

      <div className="chatbot-messages agent-timeline">
        {!workspaceRoot && <div className="agent-empty-state"><strong>请先打开工作区</strong><span>Agent 将使用打开的当前目录作为会话授权范围。</span></div>}
        {workspaceRoot && timeline.length === 0 && (
          <div className="agent-empty-state"><strong>让 Agent 在当前目录中处理任务</strong><span>Git 根目录使用隔离工作区，其他目录在当前授权范围内直接写入。</span></div>
        )}
        {buildTimelineBlocks(timeline).map((block) => block.type === 'activity' ? (
          <AgentActivity key={block.id} items={block.items} />
        ) : (
          <article key={block.item.id} className={`chatbot-message agent-message ${block.item.kind === 'user' ? 'user' : 'assistant'} agent-message-${block.item.kind}`}>
            {block.item.kind !== 'user' && <div className="chatbot-avatar assistant-avatar agent-avatar">AG</div>}
            <div className="chatbot-message-body">
              <div className={`chatbot-bubble ${block.item.kind === 'user' ? 'user-bubble' : 'assistant-bubble'}`}>
                {block.item.content && <AgentMarkdown content={block.item.content} />}
                {block.item.kind === 'message_delta' && block.item.content && (
                  <div className="agent-message-actions">
                    <button type="button" onClick={() => insertIntoEditor(block.item.content)} title="插入当前编辑器">插入编辑器</button>
                  </div>
                )}
              </div>
            </div>
            {block.item.kind === 'user' && <div className="chatbot-avatar user-avatar">我</div>}
          </article>
        ))}
        {pendingApproval && (
          <section className="agent-approval-card">
            <div><strong>{pendingApproval.title}</strong><span>{pendingApproval.detail}</span></div>
            {pendingApproval.command && <code>{pendingApproval.command}</code>}
            <div className="agent-approval-actions">
              <button onClick={() => void respondApproval('deny')}>拒绝</button>
              <button onClick={() => void respondApproval('allow_once')}>本次允许</button>
              <button onClick={() => void respondApproval('allow_session_kind')}>本会话同类允许</button>
              <button className="primary" onClick={() => void respondApproval('allow_all_session')}>本会话完全允许</button>
            </div>
          </section>
        )}
        {diagnostic && <div className="agent-diagnostic">{diagnostic}</div>}
      </div>

      {activeSession?.direct_write && (
        <div className="agent-direct-write-banner">当前目录已授权，Agent 修改会直接写入，不经过隔离审阅。</div>
      )}

      {changes && changes.files.length > 0 && (
        <section className="agent-changes">
          <header><strong>待应用变更</strong><button onClick={() => void refreshChanges()}>刷新</button></header>
          <div className="agent-change-list">
            {changes.files.map((file) => (
              <label key={file.path}>
                <input
                  type="checkbox"
                  checked={selectedPaths.includes(file.path)}
                  onChange={(event) => setSelection({
                    key: changeKey,
                    excluded: event.target.checked
                      ? excludedPaths.filter((path) => path !== file.path)
                      : [...excludedPaths, file.path],
                  })}
                />
                <span className={`agent-change-status ${file.status}`}>{file.status}</span>
                <span>{file.path}</span>
                {!file.binary && <small>+{file.additions} −{file.deletions}</small>}
              </label>
            ))}
          </div>
          <footer>
            <button onClick={() => void discardSession()}>丢弃会话</button>
            <button className="primary" disabled={selectedPaths.length === 0} onClick={() => void applyChanges(selectedPaths)}>应用所选文件</button>
          </footer>
        </section>
      )}

      <div className="chatbot-input-area agent-composer">
        {editorContext && (
          <div className="agent-editor-reference" title={editorContext.path || editorContext.label}>
            <span aria-hidden="true">@</span>
            <strong>{editorContext.label}</strong>
            <small>{editorContext.selection ? '选区' : '文档'} · {editorContext.content.length.toLocaleString()} 字符</small>
            <button type="button" onClick={() => setEditorContext(null)} aria-label="移除编辑器引用">×</button>
          </div>
        )}
        {contextPaths.length > 0 && (
          <div className="agent-context-files">
            {contextPaths.map((path) => (
              <span key={path} title={path}>{fileName(path)}<button onClick={() => setContextPaths((items) => items.filter((item) => item !== path))} aria-label={`移除 ${fileName(path)}`}>×</button></span>
            ))}
          </div>
        )}
        <textarea
          className="chatbot-textarea agent-textarea"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
          }}
          placeholder={activeSessionId ? '提出后续变更要求' : '描述需要 Agent 完成的任务'}
          disabled={!workspaceRoot || !backendStatus?.compatible}
        />
        <div className="chatbot-input-toolbar agent-composer-toolbar">
          <button className="agent-icon-button" onClick={() => void chooseContextFiles()} disabled={!workspaceRoot || loading} title="添加当前目录中的文件" aria-label="添加文件">+</button>
          <button className="agent-reference-button" onClick={referenceEditor} disabled={!content || loading} title="引用当前选区或文档" aria-label="引用当前选区或文档">@ 引用</button>
          <ChatSelectMenu
            className={`agent-permission-menu ${effectiveApprovalMode === 'allow_all_session' ? 'unrestricted' : ''}`}
            value={effectiveApprovalMode}
            label={effectiveApprovalMode === 'allow_all_session' ? '完全访问' : '分级审批'}
            options={[
              { value: 'tiered', label: '分级审批', description: '敏感操作需要确认' },
              { value: 'allow_all_session', label: '完全访问', description: '仅当前会话，硬性边界仍生效', tone: 'warning' },
            ]}
            onChange={(value) => void changeApprovalMode(value as AgentApprovalMode)}
            disabled={loading}
            ariaLabel="审批模式"
            placement="top"
          />
          <label className="agent-read-only-toggle" title="禁止 Agent 写入、删除或移动文件">
            <input type="checkbox" checked={researchReadOnly} onChange={(event) => setResearchReadOnly(event.currentTarget.checked)} disabled={loading} />
            <span>研究只读</span>
          </label>
          <span className="agent-composer-spacer" />
          <ChatSelectMenu
            className="agent-model-menu"
            value={effectiveModel}
            label={modelLabel}
            options={modelOptions}
            onChange={setModel}
            disabled={loading || modelsLoading === backend || modelOptions.length === 0}
            ariaLabel="Agent 模型"
            placement="top"
            footer={modelCatalog?.diagnostic}
          />
          {backendStatus?.capabilities.reasoning_effort && (
            <ChatSelectMenu
              className="agent-effort-menu"
              value={reasoningEffort}
              label={EFFORT_LABELS[reasoningEffort] || reasoningEffort}
              options={effortOptions}
              onChange={setReasoningEffort}
              disabled={loading}
              ariaLabel="推理强度"
              placement="top"
            />
          )}
          <button
            className="agent-send-button"
            onClick={loading ? () => void cancelTurn() : () => void submit()}
            disabled={!loading && (!prompt.trim() || !workspaceRoot || !backendStatus?.compatible)}
            title={loading ? '停止任务' : '发送任务'}
            aria-label={loading ? '停止任务' : '发送任务'}
          >
            {loading ? '■' : '↑'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function RuntimeTabs({ active, onChange }: { active: 'api' | 'agent'; onChange: (runtime: 'api' | 'agent') => void }) {
  return (
    <div className="ai-runtime-tabs" role="tablist" aria-label="AI 运行模式">
      <button className={`ai-runtime-tab api ${active === 'api' ? 'active' : ''}`} onClick={() => onChange('api')} role="tab" aria-selected={active === 'api'}>
        <span className="ai-runtime-tab-icon" aria-hidden="true">
          <svg viewBox="0 0 16 16"><path d="M3 3.2h10v7.5H8l-3.2 2.4v-2.4H3z" /><path d="M5.4 6.9h5.2" /></svg>
        </span>
        <span className="ai-runtime-tab-label">AI 对话</span>
      </button>
      <button className={`ai-runtime-tab agent ${active === 'agent' ? 'active' : ''}`} onClick={() => onChange('agent')} role="tab" aria-selected={active === 'agent'}>
        <span className="ai-runtime-tab-icon" aria-hidden="true">
          <svg viewBox="0 0 16 16"><rect x="2.4" y="3" width="11.2" height="10" rx="1.5" /><path d="m4.7 6 2 1.6-2 1.6M8.5 9.4h2.8" /></svg>
        </span>
        <span className="ai-runtime-tab-label">Agent</span>
        <small>Beta</small>
      </button>
    </div>
  );
}

function eventLabel(kind: string) {
  if (kind === 'reasoning_delta') return '思考';
  if (kind === 'command_output') return '终端';
  if (kind === 'tool_started') return '工具';
  if (kind === 'tool_completed') return '工具完成';
  if (kind === 'status') return '状态';
  if (kind === 'error') return '错误';
  if (kind === 'done') return '完成';
  return 'Agent';
}

function toolLabel(tool: string) {
  const labels: Record<string, string> = {
    commandExecution: '终端',
    fileChange: '文件修改',
    webSearch: '网页搜索',
    mcpToolCall: 'MCP 工具',
  };
  return labels[tool] || tool;
}

function fileName(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

function AgentMarkdown({ content, compact = false }: { content: string; compact?: boolean }) {
  const html = useMemo(() => sanitizeRenderedHtml(agentMarkdown.render(content)), [content]);
  return <div className={`agent-message-content agent-markdown${compact ? ' compact' : ''}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

const ACTIVITY_KINDS = new Set(['reasoning_delta', 'status', 'tool_started', 'tool_completed', 'command_output', 'usage', 'file_changed']);

type TimelineBlock =
  | { type: 'message'; item: AgentTimelineItem }
  | { type: 'activity'; id: string; items: AgentTimelineItem[] };

function buildTimelineBlocks(items: AgentTimelineItem[]): TimelineBlock[] {
  const blocks: TimelineBlock[] = [];
  for (const item of items) {
    if (!ACTIVITY_KINDS.has(item.kind)) {
      if (item.kind !== 'done' || item.content) blocks.push({ type: 'message', item });
      continue;
    }
    const last = blocks[blocks.length - 1];
    if (last?.type === 'activity') {
      last.items.push(item);
    } else {
      blocks.push({ type: 'activity', id: `activity-${item.id}`, items: [item] });
    }
  }
  return blocks;
}

function AgentActivity({ items }: { items: AgentTimelineItem[] }) {
  const visibleItems = items.filter((item) => item.kind !== 'tool_completed' || item.content);
  const toolStarts = items.filter((item) => item.kind === 'tool_started');
  const commandCount = toolStarts.filter((item) => item.tool_name === 'commandExecution' || item.tool_name === 'command').length;
  const hasCommands = commandCount > 0 || items.some((item) => item.kind === 'command_output');
  const hasReasoning = items.some((item) => item.kind === 'reasoning_delta');
  const hasTools = toolStarts.length > 0;
  const statusOnly = items.every((item) => item.kind === 'status');

  if (statusOnly && items.length === 1) {
    return <div className="agent-activity-status"><span aria-hidden="true">·</span>{items[0].content}</div>;
  }

  let summary = '活动详情';
  if (hasCommands || hasTools) {
    const count = Math.max(toolStarts.length, commandCount, 1);
    summary = count > 1 ? `运行了 ${count} 个操作` : hasCommands ? '运行命令' : '使用工具';
  } else if (hasReasoning) {
    summary = '思考过程';
  }

  return (
    <details className="agent-activity">
      <summary><span className="agent-activity-icon" aria-hidden="true">›</span>{summary}</summary>
      <div className="agent-activity-content">
        {visibleItems.map((item) => (
          <section key={item.id} className={`agent-activity-${item.kind}`}>
            <header>{item.tool_name ? toolLabel(item.tool_name) : eventLabel(item.kind)}</header>
            {item.content && (item.kind === 'command_output'
              ? <pre>{item.content}</pre>
              : <AgentMarkdown content={item.content} compact />)}
          </section>
        ))}
      </div>
    </details>
  );
}
