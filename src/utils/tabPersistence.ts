export interface PersistedTab {
  id: string;
  title: string;
  path: string | null;
  content: string;
  modified: boolean;
  encoding?: string;
}

export function applySavedTab<T extends PersistedTab>(
  tabs: T[],
  tabId: string,
  path: string,
  savedContent: string,
  savedEncoding?: string,
): T[] {
  return tabs.map(tab => tab.id === tabId
    ? {
        ...tab,
        path,
        title: path.split(/[\\/]/).pop() || path,
        modified: tab.content !== savedContent || (savedEncoding !== undefined && (tab.encoding || 'utf-8') !== savedEncoding),
      }
    : tab);
}
