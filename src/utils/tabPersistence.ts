import type { FileVersion } from './fileVersion.ts';

export interface PersistedTab {
  id: string;
  title: string;
  path: string | null;
  content: string;
  modified: boolean;
  encoding?: string;
  fileVersion?: FileVersion;
}

export function applySavedTab<T extends PersistedTab>(
  tabs: T[],
  tabId: string,
  path: string,
  savedContent: string,
  savedEncoding?: string,
  fileVersion?: FileVersion,
): T[] {
  return tabs.map(tab => tab.id === tabId
    ? {
        ...tab,
        path,
        title: path.split(/[\\/]/).pop() || path,
        modified: tab.content !== savedContent || (savedEncoding !== undefined && (tab.encoding || 'utf-8') !== savedEncoding),
        ...(fileVersion ? { fileVersion } : {}),
      }
    : tab);
}
