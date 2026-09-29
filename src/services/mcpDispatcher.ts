/**
 * MCP 工具执行器（前端）：接收桥接转发的工具调用，在编辑器状态下执行并应答。
 *
 * 工具面参考 VMark MCP 文档的编辑器读写主轴：session / workspace /
 * document / selection。写操作默认经「AI 修改建议」内联审阅（用户接受 /
 * 拒绝），设置中开启「自动批准」后直接应用；revision 令牌提供乐观并发控制。
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useAppStore } from '../stores/appStore';
import { useAIStore } from '../stores/aiStore';
import { computeDocumentRevision, isPathWithinScope, mcpError } from '../utils/mcpTools';
import { readStoredStringArray } from '../utils/storage';

let initialized = false;
let statusSnapshot: Record<string, unknown> = {};

export function getMcpStatusSnapshot(): Record<string, unknown> {
  return statusSnapshot;
}

/** 允许的文件路径范围：工作区根目录 + 已打开文档所在目录。 */
function scopeRoots(): string[] {
  const state = useAppStore.getState();
  const roots = readStoredStringArray('zeditor.workspace-roots');
  const openDocumentDirs = state.tabs
    .map((tab) => tab.path)
    .filter((path): path is string => Boolean(path))
    .map((path) => path.replace(/[\\/][^\\/]+$/, ''));
  return [...roots, ...openDocumentDirs];
}

function requireActiveTab() {
  const app = useAppStore.getState();
  const tab = app.tabs.find((item) => item.id === app.activeTabId);
  if (!tab) throw mcpError('NO_TAB', '没有活动的标签页');
  return { app, tab };
}

async function executeMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  switch (method) {
    case 'session_get_state': {
      const app = useAppStore.getState();
      return {
        windows: [{
          label: 'main',
          focused: true,
          activeWorkspaceInstanceId: null,
          tabs: app.tabs.map((tab) => ({
            id: tab.id,
            filePath: tab.path || null,
            title: tab.title,
            dirty: Boolean(tab.modified),
            revision: tab.id === app.activeTabId ? computeDocumentRevision(app.content) : null,
            kind: 'markdown',
            active: tab.id === app.activeTabId,
            visible: true,
          })),
        }],
        capabilities: {
          version: String(statusSnapshot.version || ''),
          supportedKinds: ['markdown'],
          mcpProtocol: '2025-03-26',
        },
      };
    }
    case 'workspace_new': {
      useAppStore.getState().addTab();
      const state = useAppStore.getState();
      return { tabId: state.activeTabId };
    }
    case 'workspace_open': {
      const filePath = String(params.filePath || '');
      if (!isPathWithinScope(filePath, scopeRoots())) {
        throw mcpError('INVALID_PATH', '路径位于已打开的工作区 / 文档范围之外');
      }
      await useAppStore.getState().openFile(filePath);
      const state = useAppStore.getState();
      return { tabId: state.activeTabId, filePath };
    }
    case 'workspace_save': {
      const { app, tab } = requireActiveTab();
      if (!tab.path) throw mcpError('NO_PATH', '当前标签页尚未保存过，请使用 workspace_save_as');
      await app.saveTab(tab.id, tab.path);
      return { filePath: tab.path, revision: computeDocumentRevision(useAppStore.getState().content) };
    }
    case 'workspace_save_as': {
      const { app, tab } = requireActiveTab();
      const filePath = String(params.filePath || '');
      if (!isPathWithinScope(filePath, scopeRoots())) {
        throw mcpError('INVALID_PATH', '路径位于已打开的工作区 / 文档范围之外');
      }
      await app.saveTab(tab.id, filePath);
      return { revision: computeDocumentRevision(useAppStore.getState().content) };
    }
    case 'workspace_close': {
      const { app, tab } = requireActiveTab();
      if (tab.modified && !params.force) return { closed: false, reason: 'DIRTY' };
      app.closeTab(tab.id);
      return { closed: true };
    }
    case 'workspace_switch_tab': {
      const app = useAppStore.getState();
      const tabId = String(params.tabId || '');
      if (!app.tabs.some((tab) => tab.id === tabId)) {
        throw mcpError('INVALID_TAB', `标签页不存在：${tabId}`);
      }
      app.setActiveTab(tabId);
      return { activated: true, activeTabId: tabId };
    }
    case 'document_read': {
      const { app, tab } = requireActiveTab();
      return {
        content: app.content,
        revision: computeDocumentRevision(app.content),
        filePath: tab.path || null,
        kind: 'markdown',
        dirty: Boolean(tab.modified),
      };
    }
    case 'document_write': {
      const { app, tab } = requireActiveTab();
      const content = String(params.content ?? '');
      const current = app.content;
      const revision = computeDocumentRevision(current);
      const expected = params.expected_revision ? String(params.expected_revision) : null;
      if (expected && expected !== revision) {
        throw mcpError('STALE', 'Document has changed since the last read', { current_revision: revision });
      }
      if (app.settings.mcp.auto_approve) {
        app.updateTabContent(tab.id, content);
        return { revision: computeDocumentRevision(content), applied: 'applied' };
      }
      const ai = useAIStore.getState();
      if (ai.editMode === 'ask') throw mcpError('READ_ONLY', '当前为询问模式，不允许修改文档');
      ai.proposeEdit({
        kind: 'polish',
        reason: 'MCP document_write：AI 助手请求替换整篇内容，请审阅后接受或拒绝。',
        before: current,
        after: content,
        from: 0,
        to: current.length,
      });
      return { revision: computeDocumentRevision(content), applied: 'pending_review' };
    }
    case 'selection_get': {
      const { app, tab } = requireActiveTab();
      const view = app.editorView;
      if (!view) throw mcpError('NO_EDITOR', '编辑器未就绪');
      const selection = view.state.selection.main;
      return {
        text: selection.empty ? '' : view.state.sliceDoc(selection.from, selection.to),
        isEmpty: selection.empty,
        range: { from: selection.from, to: selection.to },
        mode: 'source',
        kind: 'markdown',
        tabId: tab.id,
        revision: computeDocumentRevision(app.content),
      };
    }
    case 'selection_set': {
      const { app } = requireActiveTab();
      const view = app.editorView;
      if (!view) throw mcpError('NO_EDITOR', '编辑器未就绪');
      const content = String(params.content ?? '');
      const revision = computeDocumentRevision(app.content);
      const expected = params.expected_revision ? String(params.expected_revision) : null;
      if (expected && expected !== revision) {
        throw mcpError('STALE', 'Document has changed since the last read', { current_revision: revision });
      }
      const selection = view.state.selection.main;
      view.replaceRange(selection.from, selection.to, content);
      return { revision: computeDocumentRevision(useAppStore.getState().content), replaced_chars: selection.to - selection.from };
    }
    default:
      throw mcpError('UNKNOWN_METHOD', `未知方法：${method}`);
  }
}

/** 初始化：监听桥接事件，把工具调用分发给执行器并回送结果。幂等。 */
export async function initMcpDispatcher(): Promise<void> {
  if (initialized || !('__TAURI_INTERNALS__' in window)) return;
  initialized = true;

  await listen<{ id: string; method: string; params: Record<string, unknown> }>(
    'mcp-call',
    async (event) => {
      const { id, method, params } = event.payload;
      let result: Record<string, unknown> | null = null;
      let errorPayload: Record<string, unknown> | null = null;
      try {
        result = await executeMethod(method, params || {});
      } catch (caught) {
        errorPayload = caught as Record<string, unknown>;
      }
      await invoke('mcp_bridge_respond', { id, result, error: errorPayload }).catch(() => undefined);
    },
  );

  await listen<{ event: string; data?: Record<string, unknown> }>('mcp-event', (event) => {
    if (event.payload?.data) statusSnapshot = event.payload.data;
    window.dispatchEvent(new CustomEvent('zeditor-mcp-status', { detail: event.payload }));
  });

  invoke<Record<string, unknown>>('mcp_bridge_status')
    .then((status) => {
      statusSnapshot = status;
      window.dispatchEvent(new CustomEvent('zeditor-mcp-status', { detail: { event: 'status', data: status } }));
    })
    .catch(() => undefined);
}
