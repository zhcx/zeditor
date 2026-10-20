export interface DocumentSnapshot { activeTabId: string | null; content: string }

export interface DeletableDocumentTab {
  id: string;
  path: string | null;
  modified: boolean;
}

export interface DocumentDeletionOptions {
  confirm: (message: string) => boolean | Promise<boolean>;
  deleteItem: () => Promise<void>;
  closeTab: (id: string) => void;
  preserveTab?: (id: string) => void;
  getTabs?: () => DeletableDocumentTab[];
  flushEdits?: () => void;
}

/** Match whole path segments; Windows paths are case insensitive. */
export function isPathWithin(path: string, root: string): boolean {
  const normalize = (value: string) => {
    const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
    return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized;
  };
  const target = normalize(path);
  const parent = normalize(root);
  return target === parent || target.startsWith(`${parent}/`);
}

/** Recycle first; only then detach dirty buffers and close clean descendants. */
export async function deleteDocument(
  path: string,
  name: string,
  tabs: DeletableDocumentTab[],
  options: DocumentDeletionOptions,
): Promise<boolean> {
  const openTabs = tabs.filter(tab => tab.path !== null && isPathWithin(tab.path, path));
  const hasUnsavedChanges = openTabs.some(tab => tab.modified);
  const message = openTabs.length > 0
    ? hasUnsavedChanges
      ? `「${name}」包含正在编辑且尚未保存的文档。移入回收站后，未保存修改将保留为草稿，是否继续？`
      : `「${name}」包含已打开的文档。移入回收站后将关闭这些标签，是否继续？`
    : `确定将「${name}」移入回收站吗？可在“回收站与恢复”中找回。`;

  if (!(await options.confirm(message))) return false;
  await options.deleteItem();
  options.flushEdits?.();
  (options.getTabs?.() || tabs).filter(tab => tab.path !== null && isPathWithin(tab.path, path)).forEach(tab => {
    if (tab.modified && options.preserveTab) options.preserveTab(tab.id);
    else options.closeTab(tab.id);
  });
  return true;
}

/** 保存顺序与请求顺序一致，失败不阻塞后续保存。 */
export function createSaveQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return function enqueue<T>(write: () => Promise<T>): Promise<T> {
    const result = tail.then(write);
    tail = result.catch(() => undefined);
    return result;
  };
}

/** Serialize editor saves and recycling so a queued save cannot recreate a deleted file. */
export const enqueueDocumentWrite = createSaveQueue();

export function sameDocument(a: DocumentSnapshot, b: DocumentSnapshot): boolean {
  return a.activeTabId !== null && a.activeTabId === b.activeTabId && a.content === b.content;
}

/** 每个标签拥有自己的模型和撤销栈，切换显示模式时也可复用。 */
export class DocumentSessions<T extends { dispose(): void }> {
  private sessions = new Map<string, T>();
  get(id: string, create: () => T): T {
    let session = this.sessions.get(id);
    if (!session) { session = create(); this.sessions.set(id, session); }
    return session;
  }
  retain(ids: string[]) {
    for (const [id, session] of this.sessions) {
      if (!ids.includes(id)) { session.dispose(); this.sessions.delete(id); }
    }
  }
}
