import type { Tab } from '../stores/appStore.ts';
import type { TextEncoding } from './textEncoding.ts';
import type { FileVersion } from './fileVersion.ts';

export interface RecoverySnapshot {
  id: string;
  title: string;
  path: string | null;
  content: string;
  encoding: TextEncoding;
  updatedAt: number;
  fileVersion?: FileVersion;
  externalChangePending?: boolean;
}

export type RecoverySourceTab = Pick<Tab, 'id' | 'title' | 'path' | 'content' | 'modified' | 'encoding' | 'fileVersion' | 'externalChangePending'> & {
  recoveryId?: string;
};

export function createRecoverySnapshot(tab: RecoverySourceTab, updatedAt = Date.now()): RecoverySnapshot | null {
  if (tab.path !== null ? !tab.modified : !tab.content) return null;
  return {
    id: tab.recoveryId || tab.id,
    title: tab.title,
    path: tab.path,
    content: tab.content,
    encoding: tab.encoding || 'utf-8',
    updatedAt,
    ...(tab.fileVersion ? { fileVersion: tab.fileVersion } : {}),
    ...(tab.externalChangePending ? { externalChangePending: true } : {}),
  };
}

export function restoreRecoverySnapshot(snapshot: RecoverySnapshot, newTabId: string): Tab & { recoveryId: string } {
  return {
    id: newTabId,
    recoveryId: snapshot.id,
    title: snapshot.title,
    path: snapshot.path,
    content: snapshot.content,
    encoding: snapshot.encoding,
    modified: true,
    ...(snapshot.fileVersion ? { fileVersion: snapshot.fileVersion } : {}),
    ...(snapshot.externalChangePending ? { externalChangePending: true } : {}),
  };
}
