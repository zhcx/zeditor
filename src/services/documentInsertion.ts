import { useAppStore } from '../stores/appStore';

export interface ImportTarget {
  tabId: string | null;
  path: string | null;
}

export function captureImportTarget(): ImportTarget {
  const { activeTabId, currentFile } = useAppStore.getState();
  return { tabId: activeTabId, path: currentFile };
}

/** 异步导入始终写回发起操作的文档，避免切换标签后污染另一篇文章。 */
export function insertImportedText(target: ImportTarget, text: string): void {
  const store = useAppStore.getState();
  const tab = store.tabs.find(item => item.id === target.tabId);
  if (!tab || tab.path !== target.path) {
    throw new Error('原文档已关闭或保存位置已改变，文件已导入，但未插入引用');
  }
  const editor = store.activeTabId === tab.id ? store.editorView : null;
  if (editor && editor.getValue() === tab.content) {
    const selection = editor.getSelection();
    const cursor = selection.from + text.length;
    editor.replaceRange(selection.from, selection.to, text, { from: cursor, to: cursor });
    editor.focus();
  } else {
    store.updateTabContent(tab.id, `${tab.content}${text}`);
  }
}
