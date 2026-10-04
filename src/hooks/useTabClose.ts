import { useEffect, useRef, useState } from 'react';
import { message, save } from '@tauri-apps/plugin-dialog';
import { useAppStore } from '../stores/appStore';
import { resolveSaveBaseName } from '../utils/saveName';
import type { UnsavedChangesAction } from '../utils/windowCloseGuard';

/** 标签栏和资源管理器共用关闭保护，保存过程中取消或继续编辑都不会丢失内容。 */
export function useTabClose() {
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(null);
  const pendingCloseTab = useAppStore(state => state.tabs.find(tab => tab.id === pendingCloseTabId) ?? null);
  const closeEpoch = useRef(0);
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => () => { closeEpoch.current += 1; }, []);

  const requestTabClose = (id: string) => {
    const tab = useAppStore.getState().tabs.find(item => item.id === id);
    if (!tab) return;
    closeEpoch.current += 1;
    if (tab.modified) setPendingCloseTabId(id);
    else useAppStore.getState().closeTab(id);
  };

  const resolveTabClose = async (action: UnsavedChangesAction) => {
    if (action === 'cancel') closeEpoch.current += 1;
    if (savingRef.current && action !== 'cancel') return;
    const epoch = closeEpoch.current;
    const tab = useAppStore.getState().tabs.find(item => item.id === pendingCloseTabId);
    if (!tab || action === 'cancel') {
      setPendingCloseTabId(null);
      return;
    }
    try {
      if (action === 'save') {
        savingRef.current = true;
        setSaving(true);
        const baseName = tab.path ? '' : await resolveSaveBaseName(tab.title, tab.content);
        if (epoch !== closeEpoch.current) return;
        const path = tab.path ?? await save({
          title: `保存“${tab.title}”`,
          filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
          defaultPath: `${baseName || tab.title.replace(/\.md$/i, '')}.md`,
        });
        if (typeof path !== 'string') {
          setPendingCloseTabId(null);
          return;
        }
        if (epoch !== closeEpoch.current) return;
        await useAppStore.getState().saveTab(tab.id, path);
        if (epoch !== closeEpoch.current || useAppStore.getState().tabs.find(item => item.id === tab.id)?.modified) return;
      }
      setPendingCloseTabId(null);
      if (epoch === closeEpoch.current) useAppStore.getState().closeTab(tab.id);
    } catch (error) {
      useAppStore.getState().setUploadStatus('error', 0, `保存失败：${String(error)}`);
      if ('__TAURI_INTERNALS__' in window) {
        await message(`保存失败：${String(error)}`, { title: '无法保存文件', kind: 'error' });
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  return { requestTabClose, pendingCloseTab, saving, resolveTabClose };
}
