interface ExportSource {
  activeTabId: string | null;
  tabs: { id: string; title: string; path: string | null; content: string }[];
  content: string;
  editorView: { flushPendingEdits?: () => void } | null;
}

export interface ExportSnapshot { tabId: string | null; title: string; path: string | null; content: string }

/** Read again after flushing: the rendered component may still hold older React props. */
export function captureExportSnapshot(getState: () => ExportSource): ExportSnapshot {
  getState().editorView?.flushPendingEdits?.();
  const state = getState();
  const tab = state.tabs.find(item => item.id === state.activeTabId);
  return {
    tabId: tab?.id ?? null,
    title: tab?.title.replace(/\.md$/i, '') || 'document',
    path: tab?.path ?? null,
    content: tab?.content ?? state.content,
  };
}
