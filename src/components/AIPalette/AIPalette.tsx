import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../../stores/appStore';
import { useAIStore, isAIConfigured } from '../../stores/aiStore';
import {
  BUILTIN_GENIES,
  extractGenieTarget,
  freeformGenie,
  templateToInstruction,
  type GenieDefinition,
  type GenieScope,
} from '../../utils/aiGenies';
import '../../styles/ai-palette.css';

const PROMPT_HISTORY_KEY = 'zeditor.ai-prompt-history';
const PROMPT_HISTORY_LIMIT = 20;

const SCOPE_ORDER: GenieScope[] = ['selection', 'block', 'document'];
const SCOPE_LABELS: Record<GenieScope, string> = {
  selection: '选区',
  block: '段落',
  document: '全文',
};

interface CustomGeniePayload {
  id: string;
  name: string;
  description: string;
  scope: string;
  category: string;
  action: string;
  model: string;
  prompt: string;
}

function loadPromptHistory(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PROMPT_HISTORY_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string').slice(0, PROMPT_HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

function customGenieToDefinition(payload: CustomGeniePayload): GenieDefinition {
  const scope = (['selection', 'block', 'document'] as const).includes(payload.scope as GenieScope)
    ? (payload.scope as GenieScope)
    : 'selection';
  return {
    id: `custom:${payload.id}`,
    name: payload.name,
    description: payload.description,
    category: payload.category || '自定义',
    scope,
    action: payload.action === 'insert' ? 'insert' : 'replace',
    icon: '🧩',
    backendAction: 'transform',
    instruction: templateToInstruction(payload.prompt),
    model: payload.model || undefined,
    kind: 'transform',
    custom: true,
  };
}

export function AIPalette({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const editorView = useAppStore(state => state.editorView);
  const { runGenie, status, statusMessage } = useAIStore();

  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<GenieScope>('selection');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [customGenies, setCustomGenies] = useState<GenieDefinition[]>([]);
  const [history, setHistory] = useState<string[]>(() => loadPromptHistory());
  const [confirmFreeform, setConfirmFreeform] = useState(false);
  const [notice, setNotice] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const historyBrowseIndex = useRef(-1);

  // 打开时：重置状态、自动探测初始范围（有选区 → selection，否则 block）。
  // 状态重置放入定时器回调：同步 setState 在 effect 体内会触发级联渲染。
  useEffect(() => {
    if (!visible) return;
    const timer = window.setTimeout(() => {
      setQuery('');
      setSelectedIndex(0);
      setConfirmFreeform(false);
      setNotice('');
      historyBrowseIndex.current = -1;
      const hasSelection = editorView ? !editorView.state.selection.main.empty : false;
      setScope(hasSelection ? 'selection' : 'block');
      inputRef.current?.focus();
    }, 30);
    return () => window.clearTimeout(timer);
  }, [visible, editorView]);

  // 关闭面板后把焦点还给编辑器：面板卸载后焦点会落到 body 上，
  // 之后在编辑框输入 '/' 等将无法触发斜杠命令与编辑器快捷键。
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (visible) {
      wasOpenRef.current = true;
      return;
    }
    if (wasOpenRef.current) {
      wasOpenRef.current = false;
      editorView?.focus();
    }
  }, [visible, editorView]);

  const loadCustomGenies = useCallback(async () => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    try {
      const payload = await invoke<CustomGeniePayload[]>('list_custom_genies');
      setCustomGenies(payload.map(customGenieToDefinition));
    } catch {
      // 自定义精灵加载失败不阻塞内置精灵。
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    const timer = window.setTimeout(() => void loadCustomGenies(), 0);
    return () => window.clearTimeout(timer);
  }, [visible, loadCustomGenies]);

  const allGenies = useMemo(() => [...BUILTIN_GENIES, ...customGenies], [customGenies]);

  const filteredGenies = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return allGenies;
    return allGenies.filter(genie =>
      genie.name.toLowerCase().includes(keyword)
      || genie.description.toLowerCase().includes(keyword)
      || genie.category.toLowerCase().includes(keyword),
    );
  }, [allGenies, query]);

  const isFreeform = query.trim().length > 0 && filteredGenies.length === 0;

  const grouped = useMemo(() => {
    const groups = new Map<string, GenieDefinition[]>();
    for (const genie of filteredGenies) {
      const list = groups.get(genie.category) || [];
      list.push(genie);
      groups.set(genie.category, list);
    }
    return [...groups.entries()];
  }, [filteredGenies]);

  const flatList = useMemo(() => grouped.flatMap(([, genies]) => genies), [grouped]);

  const saveHistory = useCallback((prompt: string) => {
    setHistory(previous => {
      const next = [prompt, ...previous.filter(item => item !== prompt)].slice(0, PROMPT_HISTORY_LIMIT);
      try {
        localStorage.setItem(PROMPT_HISTORY_KEY, JSON.stringify(next));
      } catch {
        // 存储配额异常时静默放弃持久化，不影响当次使用。
      }
      return next;
    });
  }, []);

  const executeGenie = useCallback((genie: GenieDefinition) => {
    if (!editorView) {
      setNotice('编辑器未就绪');
      return;
    }
    // 提前检查 AI 配置：未配置时保留面板并提示，而不是关闭后静默失败。
    if (!isAIConfigured(useAppStore.getState().settings.ai)) {
      setNotice('AI 未就绪：请先在「设置 → AI 助手」中启用并配置（Ollama 本地模型无需密钥）');
      return;
    }
    // 生效范围：精灵自身范围优先；选区精灵在无选区时回退到段落。
    const effectiveScope = genie.scope === 'selection' && editorView.state.selection.main.empty
      ? 'block'
      : genie.scope;
    const target = extractGenieTarget(editorView, effectiveScope);
    if (!target) {
      setNotice(`${SCOPE_LABELS[effectiveScope]}范围为空，请先选择或输入文本`);
      return;
    }
    onClose();
    void runGenie(genie, target);
  }, [editorView, onClose, runGenie]);

  const submitFreeform = useCallback((prompt: string) => {
    if (!editorView) {
      setNotice('编辑器未就绪');
      return;
    }
    if (!isAIConfigured(useAppStore.getState().settings.ai)) {
      setNotice('AI 未就绪：请先在「设置 → AI 助手」中启用并配置（Ollama 本地模型无需密钥）');
      return;
    }
    const target = extractGenieTarget(editorView, scope);
    if (!target) {
      setNotice(`${SCOPE_LABELS[scope]}范围为空，请先选择或输入文本`);
      return;
    }
    saveHistory(prompt.trim());
    setConfirmFreeform(false);
    onClose();
    void runGenie(freeformGenie(prompt, scope), target);
  }, [editorView, onClose, runGenie, saveHistory, scope]);

  // 键盘：Escape 关闭；Tab 循环范围；上下选择；Enter 执行/确认自由指令。
  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (confirmFreeform) {
        setConfirmFreeform(false);
        return;
      }
      onClose();
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      setScope(current => SCOPE_ORDER[(SCOPE_ORDER.indexOf(current) + 1) % SCOPE_ORDER.length]);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      // 自由格式模式：↑↓ 在历史指令间循环浏览（仅预填，不改动历史顺序）。
      if (isFreeform) {
        if (history.length === 0) return;
        const nextIndex = Math.min(historyBrowseIndex.current + 1, history.length - 1);
        historyBrowseIndex.current = nextIndex;
        setQuery(history[nextIndex]);
        return;
      }
      setSelectedIndex(current => Math.min(current + 1, Math.max(0, flatList.length - 1)));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (isFreeform) {
        if (history.length === 0) return;
        const nextIndex = Math.max(historyBrowseIndex.current - 1, 0);
        historyBrowseIndex.current = nextIndex;
        setQuery(history[nextIndex]);
        return;
      }
      setSelectedIndex(current => Math.max(0, current - 1));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (isFreeform) {
        // 两段式确认，防止把误输入直接发给模型（VMark 防误触设计）。
        if (!confirmFreeform) {
          setConfirmFreeform(true);
          return;
        }
        submitFreeform(query);
        return;
      }
      const genie = flatList[selectedIndex];
      if (genie) executeGenie(genie);
    }
  };

  // 高亮项变化时滚动到可见区域。
  useEffect(() => {
    const item = listRef.current?.querySelector(`[data-index="${selectedIndex}"]`);
    item?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (!visible) return null;

  const quickGenies = query.trim().length === 0
    ? BUILTIN_GENIES.filter(genie => ['polish', 'condense', 'proofread', 'rewrite'].includes(genie.id))
    : [];
  const running = status === 'loading' || status === 'proofreading' || status === 'companion';

  let flatIndex = -1;

  return (
    <div className="ai-palette-overlay" role="dialog" aria-modal="true" aria-label="AI 指令面板" onMouseDown={onClose}>
      <div className="ai-palette" onMouseDown={event => event.stopPropagation()}>
        <div className="ai-palette-header">
          <span className="ai-palette-title">AI 指令面板</span>
          <div className="ai-palette-scopes" role="tablist" aria-label="作用范围">
            {SCOPE_ORDER.map(item => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={scope === item}
                className={`ai-palette-scope${scope === item ? ' active' : ''}`}
                onClick={() => setScope(item)}
                title={item === 'selection' ? '作用于选中文本（无选区时自动降级为段落）' : item === 'block' ? '作用于光标所在段落' : '作用于整个文档'}
              >
                {SCOPE_LABELS[item]}
              </button>
            ))}
          </div>
        </div>

        <div className="ai-palette-input-row">
          <span className="ai-palette-search-icon" aria-hidden="true">⌕</span>
          <input
            ref={inputRef}
            className="ai-palette-input"
            value={query}
            onChange={event => {
              setQuery(event.target.value);
              setSelectedIndex(0);
              setConfirmFreeform(false);
              setNotice('');
              historyBrowseIndex.current = -1;
            }}
            onKeyDown={handleKeyDown}
            placeholder="搜索指令（润色、翻译、大纲…），或直接输入自定义要求"
            spellCheck={false}
          />
          {isFreeform && (
            <span className="ai-palette-freeform-tag">自由指令</span>
          )}
        </div>

        {isFreeform ? (
          <div className="ai-palette-freeform">
            <p className="ai-palette-freeform-hint">
              {confirmFreeform
                ? `再次按 Enter 将对「${SCOPE_LABELS[scope]}」执行该指令，Tab 可切换范围`
                : `将对「${SCOPE_LABELS[scope]}」执行该指令（Enter 确认，Tab 切换范围）`}
            </p>
            <blockquote className="ai-palette-freeform-quote">{query.trim()}</blockquote>
            {history.length > 0 && (
              <div className="ai-palette-history">
                <div className="ai-palette-history-title">最近指令</div>
                {history.slice(0, 5).map(item => (
                  <button key={item} type="button" className="ai-palette-history-item" onClick={() => submitFreeform(item)} title={item}>
                    {item}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="ai-palette-list" ref={listRef}>
            {quickGenies.length > 0 && (
              <div className="ai-palette-quick">
                {quickGenies.map(genie => (
                  <button key={`quick-${genie.id}`} type="button" onClick={() => executeGenie(genie)}>
                    {genie.icon} {genie.name}
                  </button>
                ))}
              </div>
            )}
            {grouped.map(([category, genies]) => (
              <div key={category} className="ai-palette-group">
                <div className="ai-palette-group-title">{category}</div>
                {genies.map(genie => {
                  flatIndex += 1;
                  const index = flatIndex;
                  return (
                    <button
                      key={genie.id}
                      type="button"
                      data-index={index}
                      className={`ai-palette-item${index === selectedIndex ? ' selected' : ''}`}
                      onMouseEnter={() => setSelectedIndex(index)}
                      onClick={() => executeGenie(genie)}
                    >
                      <span className="ai-palette-item-icon" aria-hidden="true">{genie.icon}</span>
                      <span className="ai-palette-item-body">
                        <span className="ai-palette-item-name">
                          {genie.name}
                          {genie.custom && <em className="ai-palette-item-badge">自定义</em>}
                        </span>
                        <span className="ai-palette-item-desc">{genie.description}</span>
                      </span>
                      <span className="ai-palette-item-meta">
                        <span className="ai-palette-item-scope">{SCOPE_LABELS[genie.scope]}</span>
                        {genie.action === 'insert' && <span className="ai-palette-item-action">插入</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
            {flatList.length === 0 && (
              <div className="ai-palette-empty">没有匹配的指令</div>
            )}
          </div>
        )}

        {notice && <div className="ai-palette-notice">{notice}</div>}

        <div className="ai-palette-footer">
          <div className="ai-palette-footer-hints">
            <span>↑↓ 选择</span>
            <span>Enter 执行</span>
            <span>Tab 切换范围</span>
            <span>Esc 关闭</span>
          </div>
          <div className="ai-palette-footer-actions">
            {('__TAURI_INTERNALS__' in window) && (
              <>
                <button
                  type="button"
                  title="在文件管理器中打开 genies 文件夹（Markdown 文件 = 自定义指令）"
                  onClick={() => { void invoke('open_genies_folder').then(() => loadCustomGenies()); }}
                >
                  自定义指令文件夹
                </button>
                <button type="button" title="重新加载自定义指令" onClick={() => void loadCustomGenies()}>
                  刷新
                </button>
              </>
            )}
          </div>
        </div>

        {running && (
          <div className="ai-palette-running" title={statusMessage}>
            <span className="ai-palette-running-dot" aria-hidden="true" />
            AI 正在处理上一条指令，结果将以内联建议呈现…
          </div>
        )}
      </div>
    </div>
  );
}
