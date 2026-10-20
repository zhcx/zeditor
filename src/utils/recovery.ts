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

/** Ignore state-only tab updates; only changed recovery data needs another durable write. */
export function changedRecoveryTabs(tabs: RecoverySourceTab[], previous: RecoverySourceTab[]): RecoverySourceTab[] {
  const byId = new Map(previous.map(tab => [tab.id, tab]));
  return tabs.filter(tab => {
    const before = byId.get(tab.id);
    return !before || before.content !== tab.content || before.path !== tab.path
      || before.title !== tab.title || before.encoding !== tab.encoding || before.modified !== tab.modified
      || before.recoveryId !== tab.recoveryId || before.externalChangePending !== tab.externalChangePending
      || before.fileVersion?.size !== tab.fileVersion?.size || before.fileVersion?.sha256 !== tab.fileVersion?.sha256;
  });
}

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
    // Historical snapshots have no trustworthy save baseline. Detach them so
    // the first save uses an explicit new-file choice rather than overwriting.
    path: snapshot.fileVersion ? snapshot.path : null,
    content: snapshot.content,
    encoding: snapshot.encoding,
    modified: true,
    ...(snapshot.fileVersion ? { fileVersion: snapshot.fileVersion } : {}),
    ...(snapshot.externalChangePending ? { externalChangePending: true } : {}),
  };
}
