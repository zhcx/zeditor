import { sameDocument, type DocumentSnapshot } from '../utils/documentSafety';
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useAppStore, type AIProviderId } from './appStore';
import { parseAIProviderProfiles } from '../utils/aiProviderProfiles';

export interface ProofreadResult {
  from: number;
  to: number;
  original: string;
  suggestion: string;
  type: 'spelling' | 'grammar' | 'punctuation' | 'style' | 'markdown' | 'layout';
  explanation: string;
}

function formatError(error: unknown): string {
  const errorMsg = String(error);
  if (errorMsg.includes('timeout') || errorMsg.includes('timed out')) {
    return '请求超时，请检查网络连接或稍后重试';
  }
  if (errorMsg.includes('connection') || errorMsg.includes('网络')) {
    return '网络连接失败，请检查网络设置';
  }
  if (errorMsg.includes('429') || errorMsg.includes('too many requests')) {
    return 'API请求过于频繁，请稍后重试';
  }
  if (errorMsg.includes('502') || errorMsg.includes('503') || errorMsg.includes('504')) {
    return 'AI服务暂时不可用，请稍后重试';
  }
  if (errorMsg.includes('401') || errorMsg.includes('unauthorized')) {
    return 'API密钥无效，请检查设置';
  }
  if (errorMsg.includes('解析校对结果失败') || errorMsg.includes('JSON')) {
    return 'AI返回格式异常，正在重试...';
  }
  // 截断过长的错误信息
  if (errorMsg.length > 200) {
    return errorMsg.substring(0, 200) + '...';
  }
  return errorMsg;
}

// Invoke wrapper with timeout so slow AI providers do not leave the UI hanging.
function invokeWithTimeout<T>(cmd: string, args: Record<string, unknown>, timeoutMs: number = 60000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error('请求超时，请检查网络连接或稍后重试'));
    }, timeoutMs);

    invoke<T>(cmd, args)
      .then((result) => {
        clearTimeout(timeoutId);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timeoutId);
        reject(error);
      });
  });
}

export interface CompanionSuggestion {
  text: string;
  style: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  attachments?: ChatMessageAttachment[];
  reasoning?: string;
  search?: ChatSearchContext;
}

export interface ChatConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

const CHAT_HISTORY_STORAGE_KEY = 'zeditor.ai-chat-history';
const CHAT_HISTORY_LIMIT = 30;

const createConversationId = () => `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const conversationTitle = (messages: ChatMessage[]) => {
  const firstQuestion = messages.find((message) => message.role === 'user')?.content || '新对话';
  const title = firstQuestion
    .replace(/!\[[^\]]*\]\(data:[^)]+\)/g, '[图片]')
    .replace(/\s+/g, ' ')
    .replace(/^#+\s*/, '')
    .trim();
  return title.slice(0, 32) || '新对话';
};

const upsertConversation = (conversations: ChatConversation[], id: string, messages: ChatMessage[]) => {
  const existing = conversations.find((conversation) => conversation.id === id);
  const now = Date.now();
  const next: ChatConversation = {
    id,
    title: conversationTitle(messages),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    messages,
  };
  return [next, ...conversations.filter((conversation) => conversation.id !== id)]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, CHAT_HISTORY_LIMIT);
};

const safePersistedMessages = (messages: ChatMessage[]) => messages.map((message) => ({
  ...message,
  content: message.content
    .replace(/data:image\/[^;\s]+;base64,[A-Za-z0-9+/=]+/g, '[图片数据已省略]')
    .slice(0, 100_000),
}));

const loadChatHistory = (): { conversations: ChatConversation[]; activeId: string | null } => {
  try {
    const saved = JSON.parse(localStorage.getItem(CHAT_HISTORY_STORAGE_KEY) || '{}') as {
      conversations?: ChatConversation[];
      activeId?: string | null;
    };
    const conversations = Array.isArray(saved.conversations)
      ? saved.conversations.filter((conversation) => conversation && typeof conversation.id === 'string' && Array.isArray(conversation.messages)).slice(0, CHAT_HISTORY_LIMIT)
      : [];
    const activeId = conversations.some((conversation) => conversation.id === saved.activeId) ? saved.activeId || null : null;
    return { conversations, activeId };
  } catch {
    return { conversations: [], activeId: null };
  }
};

const initialChatHistory = loadChatHistory();

export interface ChatSearchContext {
  provider: string;
  query: string;
  answer?: string;
  accessed_at: string;
  results: Array<{ title: string; url: string; content: string; published_at?: string }>;
}

let chatRequestSequence = 0;
let activeChatRequestId: string | null = null;

export interface ChatMessageAttachment {
  type: 'image' | 'text' | 'file';
  name: string;
  dataUrl?: string;
  content?: string;
}

export type ReasoningEffort = 'off' | 'fast' | 'balanced' | 'deep';

export type AIStatus = 'idle' | 'loading' | 'proofreading' | 'companion' | 'success' | 'error';
export type AIEditMode = 'ask' | 'suggest';
export type AIChangeKind = 'polish' | 'translation' | 'fact' | 'structure' | 'continuation' | 'proofread';

export interface AIEditProposal {
  source: DocumentSnapshot;
  id: string;
  kind: AIChangeKind;
  reason: string;
  before: string;
  after: string;
  from: number;
  to: number;
  createdAt: number;
}

export interface WorkspaceContextPayload {
  content: string;
  tokenEstimate: number;
  sourceNames: string[];
  retrievalOnly: boolean;
}

interface AIAppliedRound {
  tabId: string;
  content: string;
  proposal: AIEditProposal;
  appliedContent: string;
}

// 校对重试配置
const PROOFREAD_MAX_RETRIES = 2;
const PROOFREAD_RETRY_DELAY_MS = 1000;

let companionRequestSeq = 0;
const companionCache = new Map<string, string[]>();
const MAX_COMPANION_CACHE_SIZE = 20;

function normalizeCompanionSuggestions(input: unknown): string[] {
  const collectRawSuggestions = (value: unknown): string[] => {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(collectRawSuggestions);
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      return ['suggestions', 'data', 'items', 'results', 'text', 'content']
        .flatMap(key => collectRawSuggestions(record[key]));
    }
    return [];
  };

  const rawSuggestions = collectRawSuggestions(input);

  return rawSuggestions
    .flatMap((item) => {
      const trimmed = item.trim();
      if (!trimmed) return [];

      const lines = trimmed
        .split(/\r?\n+/)
        .map(line => line.replace(/^\s*(?:[-*]|\d+[.)]|[一二三四五六七八九十]+[、.])\s*/, '').trim())
        .filter(Boolean);

      return lines.length > 1 ? lines : [trimmed];
    })
    .filter((suggestion, index, suggestions) => suggestions.indexOf(suggestion) === index)
    .slice(0, 5);
}

function getCompanionCacheKey(content: string): string {
  const settings = useAppStore.getState().settings.ai;
  return [
    settings.provider,
    settings.api_endpoint,
    settings.model,
    settings.writing_style,
    settings.custom_style_prompt,
    content,
  ].join('\n---\n');
}

function cacheCompanionSuggestions(key: string, suggestions: string[]) {
  if (suggestions.length === 0) return;
  companionCache.delete(key);
  companionCache.set(key, suggestions);

  while (companionCache.size > MAX_COMPANION_CACHE_SIZE) {
    const oldestKey = companionCache.keys().next().value;
    if (!oldestKey) break;
    companionCache.delete(oldestKey);
  }
}

interface AIState {
  status: AIStatus;
  statusMessage: string;
  editMode: AIEditMode;
  pendingEdit: AIEditProposal | null;
  lastAppliedRound: AIAppliedRound | null;

  // 校对结果
  proofreadResults: ProofreadResult[];
  errorCount: number;
  proofreadPanelVisible: boolean;

  // 伴写
  companionVisible: boolean;
  companionPosition: { x: number; y: number } | null;
  companionSuggestions: string[];
  currentStyle: 'formal' | 'casual' | 'academic' | 'creative' | 'custom';

  // 翻译
  translationVisible: boolean;
  translationPosition: { x: number; y: number } | null;
  translationOriginal: string;
  translationResult: string;

  // 聊天
  chatbotVisible: boolean;
  chatbotMessages: ChatMessage[];
  chatbotConversations: ChatConversation[];
  activeChatConversationId: string | null;
  chatbotLoading: boolean;
  chatbotStreamingPhase: 'reasoning' | 'content' | null;
  reasoningEffort: ReasoningEffort;
  linkedDocument: { title: string; path?: string; content: string } | null;

  // 操作
  setStatus: (status: AIStatus, message?: string) => void;
  setEditMode: (mode: AIEditMode) => void;
  proposeEdit: (proposal: Omit<AIEditProposal, 'id' | 'createdAt' | 'source'>) => void;
  acceptPendingEdit: () => void;
  rejectPendingEdit: () => void;
  undoLastAiRound: () => void;
  checkProofread: (content: string, baseOffset?: number) => Promise<void>;
  getCompanionSuggestion: (content: string, context?: string) => Promise<void>;
  rewriteSelection: (text: string) => Promise<string>;
  translateText: (text: string, targetLang?: string) => Promise<string>;
  summarizeText: (content: string) => Promise<string>;
  generateOutline: (content: string) => Promise<string>;
  continueWriting: (beforeText: string) => Promise<string>;
  chatForEditor: (userMessage: string, source?: string) => Promise<string>;
  suggestFilename: (content: string) => Promise<string | null>;

  // UI控制
  setProofreadPanelVisible: (visible: boolean) => void;
  setChatbotVisible: (visible: boolean) => void;
  toggleChatbot: () => void;
  sendChatMessage: (content: string, attachments?: ChatMessageAttachment[], selection?: { provider: AIProviderId; model: string; searchContext?: string; searchPreview?: ChatSearchContext; workspaceContext?: WorkspaceContextPayload | null }) => Promise<void>;
  stopChatMessage: () => void;
  clearChatHistory: () => void;
  newChatConversation: () => void;
  selectChatConversation: (conversationId: string) => void;
  setReasoningEffort: (effort: ReasoningEffort) => void;
  toggleLinkDocument: () => void;
  setLinkedDocument: (doc: { title: string; path?: string; content: string } | null) => void;
  setCompanionVisible: (visible: boolean, position?: { x: number; y: number }) => void;
  setCurrentStyle: (style: 'formal' | 'casual' | 'academic' | 'creative' | 'custom') => void;
  setTranslationVisible: (visible: boolean, position?: { x: number; y: number }, original?: string, result?: string) => void;
  applySuggestion: (suggestion: string) => void;
  applyProofreadFix: (result: ProofreadResult) => void;
  ignoreProofreadResult: (result: ProofreadResult) => void;
  clearResults: () => void;
}

export const useAIStore = create<AIState>((set, get) => ({
  status: 'idle',
  statusMessage: '',
  editMode: 'suggest',
  pendingEdit: null,
  lastAppliedRound: null,
  proofreadResults: [],
  errorCount: 0,
  proofreadPanelVisible: false,
  companionVisible: false,
  companionPosition: null,
  companionSuggestions: [],
  currentStyle: 'formal',
  translationVisible: false,
  translationPosition: null,
  translationOriginal: '',
  translationResult: '',
  chatbotVisible: false,
  chatbotMessages: initialChatHistory.conversations.find((conversation) => conversation.id === initialChatHistory.activeId)?.messages || [],
  chatbotConversations: initialChatHistory.conversations,
  activeChatConversationId: initialChatHistory.activeId,
  chatbotLoading: false,
  chatbotStreamingPhase: null,
  reasoningEffort: 'balanced',
  linkedDocument: null,

  setStatus: (status, message = '') => {
    set({ status, statusMessage: message });
  },

  setEditMode: (mode) => set({ editMode: mode }),

  proposeEdit: (proposal) => {
    if (get().editMode === 'ask') {
      set({ status: 'success', statusMessage: '询问模式不会修改文档；已保留 AI 回复供你参考。' });
      return;
    }

    set({
      pendingEdit: { ...proposal, source: {activeTabId:useAppStore.getState().activeTabId,content:useAppStore.getState().content}, id: `ai-edit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, createdAt: Date.now() },
      status: 'success',
      statusMessage: 'AI 修改建议等待确认。',
    });
  },

  acceptPendingEdit: () => {
    const proposal = get().pendingEdit;
    if (!proposal) return;
    const { editorView, content, activeTabId, setContent } = useAppStore.getState();
    if (!activeTabId || !sameDocument(proposal.source, {activeTabId,content}) || proposal.from < 0 || proposal.to < proposal.from || proposal.to > content.length || content.slice(proposal.from, proposal.to) !== proposal.before) {
      set({ pendingEdit: null, status: 'error', statusMessage: '文档已发生变化，无法安全应用此建议。请重新生成。' });
      return;
    }

    set({ lastAppliedRound: { tabId: activeTabId, content, proposal, appliedContent: content.slice(0,proposal.from)+proposal.after+content.slice(proposal.to) }, pendingEdit: null });
    if (editorView) {
      editorView.dispatch(editorView.state.update({
        changes: { from: proposal.from, to: proposal.to, insert: proposal.after },
        selection: { anchor: proposal.from, head: proposal.from + proposal.after.length },
      }));
      editorView.focus();
    } else {
      setContent(content.slice(0, proposal.from) + proposal.after + content.slice(proposal.to));
    }
    set({ status: 'success', statusMessage: '已应用此处 AI 修改；可一键撤销本轮。' });
  },

  rejectPendingEdit: () => set({ pendingEdit: null, status: 'idle', statusMessage: '已拒绝 AI 修改建议。' }),

  undoLastAiRound: () => {
    const round = get().lastAppliedRound;
    const { activeTabId, setContent } = useAppStore.getState();
    if (!round || round.tabId !== activeTabId) {
      set({ status: 'error', statusMessage: '当前文档没有可撤销的 AI 修改。' });
      return;
    }
    if (useAppStore.getState().content !== round.appliedContent) {
      set({ status: 'error', statusMessage: 'AI 修改后文档又有编辑，无法安全还原整篇快照。请使用编辑器撤销。' });
      return;
    }
    setContent(round.content);
    set({ lastAppliedRound: null, status: 'success', statusMessage: '已还原本轮 AI 修改前版本。' });
  },

  checkProofread: async (content, baseOffset = 0) => {
    // 防止并发校对：如果正在校对中，忽略新的请求
    if (get().status === 'proofreading') {
      console.warn('[proofread] 校对进行中，忽略重复请求');
      return;
    }

    const settings = useAppStore.getState().settings;

    if (!settings.ai.enabled) {
      set({ status: 'error', statusMessage: 'AI功能未启用' });
      return;
    }

    if (!settings.ai.api_key) {
      set({ status: 'error', statusMessage: '请先配置API密钥' });
      return;
    }

    const trimmedContent = content.trim();
    if (!trimmedContent) {
      set({ status: 'idle', statusMessage: '' });
      return;
    }

    const trimStartOffset = content.indexOf(trimmedContent);
    const resultOffset = baseOffset + Math.max(0, trimStartOffset);

    set({
      status: 'proofreading',
      statusMessage: baseOffset > 0 ? '正在校对选中文本...' : '正在校对全文...',
    });

    // 带重试的校对请求
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= PROOFREAD_MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          set({ statusMessage: `校对重试中 (${attempt}/${PROOFREAD_MAX_RETRIES})...` });
          await new Promise(resolve => setTimeout(resolve, PROOFREAD_RETRY_DELAY_MS));
        }

        const requestData = {
          action: 'proofread',
          content: trimmedContent,
          settings: settings.ai,
        };

        const response = await invokeWithTimeout<{
          success: boolean;
          data: ProofreadResult[];
          message?: string;
        }>('ai_request', requestData, 300000);

        if (response.success) {
          const raw = Array.isArray(response.data) ? response.data : [];
          // 严格过滤：from/to 必须为数字，from < to，非 NaN
          const results: ProofreadResult[] = raw
            .filter(r =>
              typeof r.from === 'number' && typeof r.to === 'number' &&
              !isNaN(r.from) && !isNaN(r.to) &&
              r.from >= 0 && r.to > r.from &&
              typeof r.suggestion === 'string' && r.suggestion.length > 0
            )
            .map(r => ({
              ...r,
              from: r.from + resultOffset,
              to: r.to + resultOffset,
            }));
          set({
            status: 'success',
            statusMessage: results.length > 0 ? `发现 ${results.length} 处问题` : '校对完成，未发现问题',
            proofreadResults: results,
            errorCount: results.length,
            proofreadPanelVisible: results.length > 0,
          });
          return; // 成功，退出重试循环
        } else {
          // API返回失败（非网络错误），不再重试
          set({ status: 'error', statusMessage: response.message || '校对失败' });
          return;
        }
      } catch (error) {
        lastError = error;
        console.error(`AI proofreading failed (attempt ${attempt + 1}):`, error);

        // 判断是否为可重试的错误（网络/超时相关）
        const errorMsg = String(error).toLowerCase();
        const isRetryable = ['timeout', 'timed out', 'connection', 'network', 'reset', 'closed', '429', '502', '503', '504'].some(
          pattern => errorMsg.includes(pattern)
        );

        if (isRetryable && attempt < PROOFREAD_MAX_RETRIES) {
          continue; // 继续重试
        }

        // 不可重试或已达最大重试次数
        set({ status: 'error', statusMessage: formatError(error) });
        return;
      }
    }

    // 所有重试都失败
    if (lastError) {
      set({ status: 'error', statusMessage: `校对失败（已重试${PROOFREAD_MAX_RETRIES}次）: ${formatError(lastError)}` });
    }
  },

  getCompanionSuggestion: async (content, context) => {
    const requestSeq = ++companionRequestSeq;
    const settings = useAppStore.getState().settings;

    if (!settings.ai.enabled) {
      set({ status: 'error', statusMessage: 'AI功能未启用', companionSuggestions: [] });
      return;
    }

    if (!settings.ai.api_key) {
      set({ status: 'error', statusMessage: '请先配置API密钥', companionSuggestions: [] });
      return;
    }

    const trimmedContent = content.trim();
    if (!trimmedContent) {
      set({ status: 'idle', statusMessage: '', companionSuggestions: [] });
      return;
    }

    const cacheKey = getCompanionCacheKey(trimmedContent);
    const cachedSuggestions = companionCache.get(cacheKey);
    if (cachedSuggestions) {
      set({
        status: 'success',
        statusMessage: '',
        companionSuggestions: cachedSuggestions,
        companionVisible: true,
      });
      return;
    }

    set({
      status: 'companion',
      statusMessage: '正在生成伴写建议...',
      companionSuggestions: [],
    });

    try {
      const requestData = {
        action: 'companion',
        content: trimmedContent,
        context: context || undefined,
        settings: settings.ai,
      };
      const response = await invokeWithTimeout<{
        success: boolean;
        data: { suggestions: string[] };
        message?: string;
      }>('ai_request', requestData, 60000);
      if (requestSeq !== companionRequestSeq) return;

      if (response.success && response.data?.suggestions) {
        const suggestions = normalizeCompanionSuggestions(response.data.suggestions);
        cacheCompanionSuggestions(cacheKey, suggestions);

        set({
          status: suggestions.length > 0 ? 'success' : 'error',
          statusMessage: suggestions.length > 0 ? '' : 'AI未返回可用续写，请刷新重试',
          companionSuggestions: suggestions,
          companionVisible: true,
        });
      } else {
        set({ status: 'error', statusMessage: response.message || '生成建议失败' });
      }
    } catch (error) {
      console.error('伴写错误:', error);
      if (requestSeq !== companionRequestSeq) return;
      set({ status: 'error', statusMessage: formatError(error) });
    }
  },

  rewriteSelection: async (text) => {
    const snapshot = {activeTabId:useAppStore.getState().activeTabId,content:useAppStore.getState().content};
    const settings = useAppStore.getState().settings;

    if (!settings.ai.enabled) {
      return text;
    }

    if (!settings.ai.api_key) {
      set({ status: 'error', statusMessage: '请先配置API密钥' });
      return text;
    }

    set({ status: 'loading', statusMessage: '正在重写...' });

    try {
      const requestData = {
        action: 'rewrite',
        content: text,
        settings: settings.ai,
      };
      const response = await invokeWithTimeout<{
        success: boolean;
        data: { rewritten: string };
        message?: string;
      }>('ai_request', requestData, 60000);

      if (!sameDocument(snapshot, useAppStore.getState())) {
        set({status:'error',statusMessage:'文档已变化，请重新生成 AI 结果'});
        return '';
      }
      set({ status: 'idle', statusMessage: '' });

      if (response.success && response.data?.rewritten) {
        return response.data.rewritten;
      }
      return text;
    } catch (error) {
      console.error('重写错误:', error);
      set({ status: 'error', statusMessage: formatError(error) });
      return text;
    }
  },

  translateText: async (text, targetLang = '英文') => {
    const snapshot = {activeTabId:useAppStore.getState().activeTabId,content:useAppStore.getState().content};
    const settings = useAppStore.getState().settings;

    if (!settings.ai.enabled) {
      return text;
    }

    if (!settings.ai.api_key) {
      set({ status: 'error', statusMessage: '请先配置API密钥' });
      return text;
    }

    set({ status: 'loading', statusMessage: '正在翻译...' });

    try {
      const requestData = {
        action: 'translate',
        content: text,
        context: targetLang,
        settings: settings.ai,
      };
      const response = await invokeWithTimeout<{
        success: boolean;
        data: { translated: string };
        message?: string;
      }>('ai_request', requestData, 60000);

      if (!sameDocument(snapshot, useAppStore.getState())) {
        set({status:'error',statusMessage:'文档已变化，请重新生成 AI 结果'});
        return '';
      }
      set({ status: 'idle', statusMessage: '' });

      if (response.success && response.data?.translated) {
        // 返回原文和译文，用特殊分隔符
        return `${text}|||${response.data.translated}`;
      }
      return text;
    } catch (error) {
      console.error('翻译错误:', error);
      set({ status: 'error', statusMessage: formatError(error) });
      return text;
    }
  },

  summarizeText: async (content) => {
    const snapshot = {activeTabId:useAppStore.getState().activeTabId,content:useAppStore.getState().content};
    const settings = useAppStore.getState().settings;

    if (!settings.ai.enabled) {
      return '';
    }

    if (!settings.ai.api_key) {
      set({ status: 'error', statusMessage: '请先配置API密钥' });
      return '';
    }

    set({ status: 'loading', statusMessage: '正在生成摘要...' });

    try {
      const requestData = {
        action: 'summarize',
        content,
        settings: settings.ai,
      };
      const response = await invokeWithTimeout<{
        success: boolean;
        data: { summary: string };
        message?: string;
      }>('ai_request', requestData, 60000);

      if (!sameDocument(snapshot, useAppStore.getState())) {
        set({status:'error',statusMessage:'文档已变化，请重新生成 AI 结果'});
        return '';
      }
      set({ status: 'idle', statusMessage: '' });

      if (response.success && response.data?.summary) {
        return response.data.summary;
      }
      return '';
    } catch (error) {
      console.error('摘要错误:', error);
      set({ status: 'error', statusMessage: formatError(error) });
      return '';
    }
  },

  generateOutline: async (content) => {
    const snapshot = {activeTabId:useAppStore.getState().activeTabId,content:useAppStore.getState().content};
    const settings = useAppStore.getState().settings;

    if (!settings.ai.enabled) {
      return '';
    }

    if (!settings.ai.api_key) {
      set({ status: 'error', statusMessage: '请先配置API密钥' });
      return '';
    }

    set({ status: 'loading', statusMessage: '正在生成大纲...' });

    try {
      const requestData = {
        action: 'outline',
        content,
        settings: settings.ai,
      };
      const response = await invokeWithTimeout<{
        success: boolean;
        data: { outline: string };
        message?: string;
      }>('ai_request', requestData, 60000);

      if (!sameDocument(snapshot, useAppStore.getState())) {
        set({status:'error',statusMessage:'文档已变化，请重新生成 AI 结果'});
        return '';
      }
      set({ status: 'idle', statusMessage: '' });

      if (response.success && response.data?.outline) {
        return response.data.outline;
      }
      return '';
    } catch (error) {
      console.error('大纲错误:', error);
      set({ status: 'error', statusMessage: formatError(error) });
      return '';
    }
  },

  // 根据光标前文续写正文。返回空字符串表示未生成（未启用 AI、
  // 缺少密钥或请求失败——失败状态已写入 statusMessage）。
  continueWriting: async (beforeText) => {
    const settings = useAppStore.getState().settings;

    if (!settings.ai.enabled || !settings.ai.api_key) {
      return '';
    }

    set({ status: 'loading', statusMessage: '正在续写...' });

    try {
      const requestData = {
        action: 'chat',
        content: `请根据下面的 Markdown 内容自然地继续写作。

要求：
1. 直接输出续写的正文，不要重复已有内容，不要解释，不要任何前言后语。
2. 延续原文的语气、人称与 Markdown 格式习惯。
3. 输出 100 字左右即可停下。

已有内容（结尾处为最新）：
${beforeText.slice(-2000)}`,
        settings: settings.ai,
      };
      const response = await invokeWithTimeout<{
        success: boolean;
        data: { response?: string };
        message?: string;
      }>('ai_request', requestData, 60000);

      set({ status: 'idle', statusMessage: '' });

      const text = response.success ? response.data?.response?.trim() : '';
      return text || '';
    } catch (error) {
      console.error('续写错误:', error);
      set({ status: 'error', statusMessage: formatError(error) });
      return '';
    }
  },

  // 编辑器内的通用单轮问答/写作：返回模型正文，失败或未启用时返回空串。
  chatForEditor: async (userMessage, source) => {
    const settings = useAppStore.getState().settings;

    if (!settings.ai.enabled || !settings.ai.api_key) {
      return '';
    }

    set({ status: 'loading', statusMessage: 'AI 正在生成...' });

    try {
      const contextBlock = source?.trim()
        ? `\n\n<当前文档相关内容>\n${source.trim().slice(-2000)}\n</当前文档相关内容>`
        : '';
      const response = await invokeWithTimeout<{
        success: boolean;
        data: { response?: string };
        message?: string;
      }>('ai_request', {
        action: 'chat',
        content: `${userMessage}${contextBlock}`,
        settings: settings.ai,
      }, 60000);

      set({ status: 'idle', statusMessage: '' });
      return response.success ? response.data?.response?.trim() || '' : '';
    } catch (error) {
      console.error('编辑器 AI 调用错误:', error);
      set({ status: 'error', statusMessage: formatError(error) });
      return '';
    }
  },

  // 为「保存/另存为」对话框建议文件名。未启用 AI 或请求失败时返回 null，
  // 调用方据此回退到默认文件名；短超时避免拖慢保存对话框的弹出。
  suggestFilename: async (content) => {
    const settings = useAppStore.getState().settings;

    if (!settings.ai.enabled || !settings.ai.api_key || !content.trim()) {
      return null;
    }

    try {
      const response = await invokeWithTimeout<{
        success: boolean;
        data: { filename?: string };
        message?: string;
      }>('ai_request', {
        action: 'filename',
        content,
        settings: settings.ai,
      }, 8000);

      if (!response.success) return null;
      const cleaned = (response.data?.filename || '')
        .replace(/[\\/:*?"<>|.]/g, '')
        .replace(/[\s`'"“”‘’、，。！？：；（）[\]{}#*_~>-]/g, '')
        .replace(/^(未命名|Untitled)$/i, '')
        .trim()
        .slice(0, 40);
      return cleaned || null;
    } catch {
      // 文件名建议是锦上添花的功能，任何失败都静默回退。
      return null;
    }
  },

  setChatbotVisible: (visible) => {
    set({ chatbotVisible: visible });
  },

  toggleChatbot: () => {
    set((state) => ({ chatbotVisible: !state.chatbotVisible }));
  },

  sendChatMessage: async (content, attachments, selection) => {
    const ensureActiveConversation = () => {
      const state = get();
      if (state.activeChatConversationId) return state.activeChatConversationId;
      const id = createConversationId();
      set({
        activeChatConversationId: id,
        chatbotConversations: upsertConversation(state.chatbotConversations, id, state.chatbotMessages),
      });
      return id;
    };

    // Browser preview uses the Vite local proxy. Desktop keeps its native
    // streaming path below, while browser testing receives a full reply.
    if (!('__TAURI_INTERNALS__' in window)) {
      const appSettings = useAppStore.getState().settings;
      let browserSettings = appSettings.ai;
      if (selection) {
        const profiles = parseAIProviderProfiles(appSettings.ai.provider_profiles);
        const profile = profiles[selection.provider] || (selection.provider === appSettings.ai.provider
          ? { api_key: appSettings.ai.api_key, api_endpoint: appSettings.ai.api_endpoint, model: appSettings.ai.model }
          : undefined);
        if (profile) {
          browserSettings = {
            ...appSettings.ai,
            provider: selection.provider,
            api_key: profile.api_key,
            api_endpoint: profile.api_endpoint,
            model: selection.model || profile.model,
          };
        }
      }
      const attachmentContent = attachments?.map((attachment) => {
        if (attachment.type === 'image' && attachment.dataUrl) return `![${attachment.name}](${attachment.dataUrl})`;
        if (attachment.type === 'text' && attachment.content) return `> **附件: ${attachment.name}**\n> \`\`\`\n${attachment.content}\n> \`\`\``;
        return `> 附件: ${attachment.name}`;
      }).join('\n') || '';
      const messageContent = [attachmentContent, content].filter(Boolean).join('\n');
      const timestamp = Date.now();
      const assistantId = `${timestamp.toString(36)}-browser`;
      const previousMessages = get().chatbotMessages;
      ensureActiveConversation();
      set({
        chatbotMessages: [
          ...previousMessages,
          {
            id: `${timestamp.toString(36)}-user`,
            role: 'user',
            content: messageContent,
            timestamp,
            attachments: attachments?.map((attachment) => ({ type: attachment.type, name: attachment.name })),
            search: selection?.searchPreview,
          },
          {
            id: assistantId,
            role: 'assistant',
            content: '',
            timestamp,
            search: selection?.searchPreview,
          },
        ],
        chatbotLoading: true,
        chatbotStreamingPhase: 'content',
      });

      try {
        if (!browserSettings.enabled) throw new Error('请先在设置中启用 AI 助手');
        if (!browserSettings.api_key.trim()) throw new Error('请先配置 API 密钥');
        const requestContent = [messageContent, selection?.workspaceContext?.content ? `[本地工作区上下文：${selection.workspaceContext.retrievalOnly ? '仅检索片段' : '所选内容'}]\n${selection.workspaceContext.content}` : '', selection?.searchContext ? `[网络搜索上下文]\n${selection.searchContext}` : ''].filter(Boolean).join('\n\n---\n\n');
        const response = await fetch('/api/ai-chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: requestContent,
            context: previousMessages.map((message) => ({ role: message.role, content: message.content })),
            settings: browserSettings,
            temperature: get().reasoningEffort === 'deep' ? 0.3 : get().reasoningEffort === 'fast' ? 0.9 : 0.7,
            maxTokens: get().reasoningEffort === 'deep' ? 4000 : get().reasoningEffort === 'fast' ? 800 : 2000,
          }),
        });
        const payload = await response.json().catch(() => ({})) as { content?: string; reasoning?: string; error?: string };
        if (!response.ok) throw new Error(payload.error || `AI 服务请求失败 (${response.status})`);
        set((state) => ({
          chatbotMessages: state.chatbotMessages.map((message) => message.id === assistantId
            ? { ...message, content: payload.content || 'AI 服务未返回内容', reasoning: payload.reasoning || undefined }
            : message),
          chatbotLoading: false,
          chatbotStreamingPhase: null,
        }));
      } catch (error) {
        set((state) => ({
          chatbotMessages: state.chatbotMessages.map((message) => message.id === assistantId
            ? { ...message, content: `**错误:** ${String(error)}` }
            : message),
          chatbotLoading: false,
          chatbotStreamingPhase: null,
        }));
      }
      return;
    }

    const appSettings = useAppStore.getState().settings;
    let settings = appSettings;
    if (selection) {
      const profiles = parseAIProviderProfiles(appSettings.ai.provider_profiles);
      const profile = profiles[selection.provider] || (selection.provider === appSettings.ai.provider
        ? {
            api_key: appSettings.ai.api_key,
            api_endpoint: appSettings.ai.api_endpoint,
            model: appSettings.ai.model,
          }
        : undefined);
      if (!profile) {
        set({ status: 'error', statusMessage: '请先在设置中配置该 AI 服务商' });
        return;
      }
      settings = {
        ...appSettings,
        ai: {
          ...appSettings.ai,
          provider: selection.provider,
          api_key: profile.api_key,
          api_endpoint: profile.api_endpoint,
          model: selection.model || profile.model,
        },
      };
    }

    if (!settings.ai.enabled) {
      set({ status: 'error', statusMessage: 'AI功能未启用' });
      return;
    }

    if (!settings.ai.api_key) {
      set({ status: 'error', statusMessage: '请先配置API密钥' });
      return;
    }

    // Build message content with attachments embedded
    let messageContent = content;
    if (attachments && attachments.length > 0) {
      const attachmentTexts = attachments.map((att) => {
        if (att.type === 'image' && att.dataUrl) {
          return `![${att.name}](${att.dataUrl})`;
        }
        if (att.type === 'text' && att.content) {
          return `> **附件: ${att.name}**\n> \`\`\`\n${att.content}\n> \`\`\`\n`;
        }
        return `> 附件: ${att.name}\n`;
      });
      messageContent = attachmentTexts.join('\n') + (content ? '\n' + content : '');
    }

    const userMessage: ChatMessage = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      role: 'user',
      content: messageContent,
      timestamp: Date.now(),
      attachments: attachments ? attachments.map((a) => ({ type: a.type, name: a.name })) : undefined,
      search: selection?.searchPreview,
    };

    const requestContent = [messageContent, selection?.workspaceContext?.content ? `[本地工作区上下文：${selection.workspaceContext.retrievalOnly ? '仅检索片段' : '所选内容'}]\n${selection.workspaceContext.content}` : '', selection?.searchContext ? `[网络搜索上下文]\n${selection.searchContext}` : ''].filter(Boolean).join('\n\n---\n\n');
    const prevMessages = get().chatbotMessages;
    const assistantId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const requestId = `${assistantId}-${++chatRequestSequence}`;
    activeChatRequestId = requestId;
    const assistantPlaceholder: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      search: selection?.searchPreview,
    };
    ensureActiveConversation();
    set({
      chatbotMessages: [...prevMessages, userMessage, assistantPlaceholder],
      chatbotLoading: true,
      chatbotStreamingPhase: 'reasoning',
    });

    const effort = get().reasoningEffort;
    const effortConfig: Record<string, { temperature: number; max_tokens: number }> = {
      fast: { temperature: 0.9, max_tokens: 800 },
      balanced: { temperature: 0.7, max_tokens: 2000 },
      deep: { temperature: 0.3, max_tokens: 4000 },
    };

    // Only enable thinking for providers that support it (DeepSeek, SiliconFlow)
    const provider = settings.ai.provider;
    const supportsThinking = provider === 'deepseek' || provider === 'siliconflow';

    // Set up event listeners before invoking the streaming command
    const unlisteners: (() => void)[] = [];

    try {
      const history = prevMessages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const requestArgs: Record<string, unknown> = {
        content: requestContent,
        context: JSON.stringify(history),
        settings: settings.ai,
        enableThinking: supportsThinking && effort !== 'off',
        requestId,
      };


      if (effort !== 'off') {
        const config = effortConfig[effort];
        requestArgs.temperature = config.temperature;
        requestArgs.max_tokens = config.max_tokens;
      }

      // Listen for reasoning chunks
      const unlistenReasoning = await listen<{ content: string; requestId?: string }>('ai-chat-reasoning-chunk', (event) => {
        if (activeChatRequestId !== requestId) return;
        if (event.payload.requestId && event.payload.requestId !== requestId) return;
        set((state) => ({
          chatbotMessages: state.chatbotMessages.map((m) =>
            m.id === assistantId
              ? { ...m, reasoning: (m.reasoning || '') + event.payload.content }
              : m,
          ),
        }));
      });
      unlisteners.push(unlistenReasoning);

      // Listen for reasoning done
      const unlistenReasoningDone = await listen<{ requestId?: string }>('ai-chat-reasoning-done', (event) => {
        if (activeChatRequestId !== requestId) return;
        if (event.payload.requestId && event.payload.requestId !== requestId) return;
        set({ chatbotStreamingPhase: 'content' });
      });
      unlisteners.push(unlistenReasoningDone);

      // Listen for content chunks
      const unlistenContent = await listen<{ content: string; requestId?: string }>('ai-chat-content-chunk', (event) => {
        if (activeChatRequestId !== requestId) return;
        if (event.payload.requestId && event.payload.requestId !== requestId) return;
        set((state) => ({
          chatbotMessages: state.chatbotMessages.map((m) =>
            m.id === assistantId
              ? { ...m, content: m.content + event.payload.content }
              : m,
          ),
        }));
      });
      unlisteners.push(unlistenContent);

      // Listen for stream error
      const unlistenError = await listen<{ message: string; requestId?: string }>('ai-chat-error', (event) => {
        if (activeChatRequestId !== requestId) return;
        if (event.payload.requestId && event.payload.requestId !== requestId) return;
        set((state) => ({
          chatbotMessages: state.chatbotMessages.map((m) =>
            m.id === assistantId
              ? { ...m, content: m.content || `**错误:** ${event.payload.message}` }
              : m,
          ),
          chatbotLoading: false,
          chatbotStreamingPhase: null,
        }));
      });
      unlisteners.push(unlistenError);

      // Listen for stream done
      const unlistenDone = await listen<{ requestId?: string }>('ai-chat-done', (event) => {
        if (activeChatRequestId !== requestId) return;
        if (event.payload.requestId && event.payload.requestId !== requestId) return;
        activeChatRequestId = null;
        set({ chatbotLoading: false, chatbotStreamingPhase: null });
      });
      unlisteners.push(unlistenDone);

      // Start streaming
      await invoke('ai_chat_streaming', requestArgs);
    } catch (error) {
      console.error('Chat streaming error:', error);
      set((state) => ({
        chatbotMessages: state.chatbotMessages.map((m) =>
          m.id === assistantId
            ? { ...m, content: m.content || `**错误:** ${String(error)}` }
            : m,
        ),
        chatbotLoading: false,
        chatbotStreamingPhase: null,
      }));
    } finally {
      // Clean up all listeners
      for (const unlisten of unlisteners) {
        unlisten();
      }
    }
  },

  stopChatMessage: () => {
    // The native stream finishes in the background, but its listeners are removed
    // immediately by the request lifecycle. This releases the composer for the next turn.
    activeChatRequestId = null;
    set({ chatbotLoading: false, chatbotStreamingPhase: null });
  },

  clearChatHistory: () => {
    const activeId = get().activeChatConversationId;
    set((state) => ({
      chatbotMessages: [],
      activeChatConversationId: null,
      chatbotConversations: activeId
        ? state.chatbotConversations.filter((conversation) => conversation.id !== activeId)
        : state.chatbotConversations,
    }));
  },

  newChatConversation: () => {
    activeChatRequestId = null;
    set({
      chatbotMessages: [],
      activeChatConversationId: null,
      chatbotLoading: false,
      chatbotStreamingPhase: null,
      linkedDocument: null,
    });
  },

  selectChatConversation: (conversationId) => {
    const conversation = get().chatbotConversations.find((item) => item.id === conversationId);
    if (!conversation) return;
    activeChatRequestId = null;
    set({
      activeChatConversationId: conversation.id,
      chatbotMessages: conversation.messages,
      chatbotLoading: false,
      chatbotStreamingPhase: null,
    });
  },

  setReasoningEffort: (effort) => {
    set({ reasoningEffort: effort });
  },

  toggleLinkDocument: () => {
    const current = get().linkedDocument;
    if (current) {
      set({ linkedDocument: null });
    } else {
      const appState = useAppStore.getState();
      const activeTab = appState.getActiveTab();
      if (activeTab && activeTab.content.trim()) {
        set({
          linkedDocument: {
            title: activeTab.title,
            path: activeTab.path || undefined,
            content: activeTab.content,
          },
        });
      }
    }
  },

  setLinkedDocument: (doc) => {
    set({ linkedDocument: doc });
  },

  setProofreadPanelVisible: (visible) => {
    set({ proofreadPanelVisible: visible });
  },

  setCompanionVisible: (visible, position) => {
    set({
      companionVisible: visible,
      companionPosition: position || null,
    });
  },

  setCurrentStyle: (style) => {
    set({ currentStyle: style });
  },

  setTranslationVisible: (visible, position?, original?, result?) => {
    set({
      translationVisible: visible,
      translationPosition: position || null,
      translationOriginal: original || '',
      translationResult: result || '',
    });
  },

  applySuggestion: (suggestion) => {
    const { editorView, content } = useAppStore.getState();
    const position = editorView?.state.selection.main.to ?? content.length;
    get().proposeEdit({
      kind: 'continuation',
      reason: 'AI 伴写：基于当前光标前的上下文续写，不包含事实核验。',
      before: '',
      after: suggestion,
      from: position,
      to: position,
    });
    set({ companionVisible: false, companionSuggestions: [] });
  },

  applyProofreadFix: (result) => {
    get().proposeEdit({
      kind: 'proofread',
      reason: `AI 校对依据：${result.explanation}`,
      before: result.original,
      after: result.suggestion,
      from: result.from,
      to: result.to,
    });

    const newResults = get().proofreadResults.filter(r => r !== result);
    set({
      proofreadResults: newResults,
      errorCount: newResults.length,
      proofreadPanelVisible: newResults.length > 0,
    });
  },

  ignoreProofreadResult: (result) => {
    // Just remove this result from the list without applying the fix
    const newResults = get().proofreadResults.filter(r => r !== result);
    set({
      proofreadResults: newResults,
      errorCount: newResults.length,
      proofreadPanelVisible: newResults.length > 0,
      status: newResults.length > 0 ? 'success' : 'idle',
      statusMessage: newResults.length > 0 ? `剩余 ${newResults.length} 处问题` : '校对完成',
    });
  },

  clearResults: () => {
    set({
      status: 'idle',
      statusMessage: '',
      proofreadResults: [],
      errorCount: 0,
      companionSuggestions: [],
      proofreadPanelVisible: false,
    });
  },
}));

let chatHistoryPersistTimer: number | null = null;

useAIStore.subscribe((state, previous) => {
  if (
    state.chatbotMessages !== previous.chatbotMessages
    && state.activeChatConversationId
  ) {
    useAIStore.setState({
      chatbotConversations: upsertConversation(
        state.chatbotConversations,
        state.activeChatConversationId,
        state.chatbotMessages,
      ),
    });
    return;
  }

  if (
    state.chatbotConversations === previous.chatbotConversations
    && state.activeChatConversationId === previous.activeChatConversationId
  ) return;

  if (chatHistoryPersistTimer !== null) window.clearTimeout(chatHistoryPersistTimer);
  chatHistoryPersistTimer = window.setTimeout(() => {
    chatHistoryPersistTimer = null;
    try {
      localStorage.setItem(CHAT_HISTORY_STORAGE_KEY, JSON.stringify({
        activeId: useAIStore.getState().activeChatConversationId,
        conversations: useAIStore.getState().chatbotConversations.map((conversation) => ({
          ...conversation,
          messages: safePersistedMessages(conversation.messages),
        })),
      }));
    } catch {
      // A full storage quota must not interrupt the active conversation.
    }
  }, 160);
});
