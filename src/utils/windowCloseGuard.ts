export interface CloseGuardTab {
  id: string;
  title: string;
  path: string | null;
  modified: boolean;
}

export type UnsavedChangesAction = 'save' | 'discard' | 'cancel';

interface WindowCloseDependencies {
  promptAction: (tabs: CloseGuardTab[]) => Promise<UnsavedChangesAction>;
  chooseSavePath: (tab: CloseGuardTab) => Promise<string | null>;
  saveTab: (tabId: string, path: string) => Promise<void>;
  discardTabs?: (tabIds: string[]) => Promise<void>;
  getTabs?: () => CloseGuardTab[];
  isCancelled?: () => boolean;
}

export type WindowCloseResult = 'close' | 'stay';

export async function guardWindowClose(
  tabs: CloseGuardTab[],
  dependencies: WindowCloseDependencies,
): Promise<WindowCloseResult> {
  const modifiedTabs = tabs.filter(tab => tab.modified);
  if (modifiedTabs.length === 0) return 'close';

  const action = await dependencies.promptAction(modifiedTabs);
  if (dependencies.isCancelled?.()) return 'stay';
  if (action === 'cancel') return 'stay';
  if (action === 'discard') {
    try {
      await dependencies.discardTabs?.(modifiedTabs.map(tab => tab.id));
      return 'close';
    } catch {
      return 'stay';
    }
  }

  try {
    for (const tab of modifiedTabs) {
      if (dependencies.isCancelled?.()) return 'stay';
      const path = tab.path ?? await dependencies.chooseSavePath(tab);
      if (!path || dependencies.isCancelled?.()) return 'stay';
      await dependencies.saveTab(tab.id, path);
    }
  } catch {
    return 'stay';
  }

  if (dependencies.isCancelled?.() || dependencies.getTabs?.().some(tab => tab.modified)) return 'stay';
  return 'close';
}
