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
}

/** Confirm a destructive delete, then close affected editor tabs only after the delete succeeds. */
export async function deleteDocument(
  path: string,
  name: string,
  tabs: DeletableDocumentTab[],
  options: DocumentDeletionOptions,
): Promise<boolean> {
  const openTabs = tabs.filter(tab => tab.path === path);
  const hasUnsavedChanges = openTabs.some(tab => tab.modified);
  const message = openTabs.length > 0
    ? hasUnsavedChanges
      ? `文档「${name}」正在编辑，且包含未保存修改。确认删除后将关闭编辑器并永久删除该文档，是否继续？`
      : `文档「${name}」当前已打开。确认删除后将关闭编辑器并永久删除该文档，是否继续？`
    : `确定要删除「${name}」吗？此操作不可撤销。`;

  if (!(await options.confirm(message))) return false;
  await options.deleteItem();
  openTabs.forEach(tab => options.closeTab(tab.id));
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
