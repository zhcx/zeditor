import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  WebDavDocumentSummary,
  WebDavDownloadedVersion,
  WebDavSettings,
  WebDavSyncEvent,
  WebDavSyncPhase,
  WebDavVersion,
} from '../types/webdav';
import {
  reduceWebDavStatus,
  type WebDavStatusState,
} from '../utils/webdavState';

const isTauriRuntime = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
let eventUnlisten: UnlistenFn | null = null;
let historyVersionsSequence = 0;

export interface WebDavStoreState {
  phase: WebDavSyncPhase;
  documentId: string;
  localPath: string;
  lastSuccessAt: string;
  error: string;
  versions: WebDavVersion[];
  versionsDocumentId: string;
  historyError: string;
  documents: WebDavDocumentSummary[];
  historyLoading: boolean;
  historyOpen: boolean;
  initialize: (settings: WebDavSettings) => Promise<void>;
  setCurrentDocument: (path: string | null) => void;
  retry: (settings: WebDavSettings) => Promise<void>;
  loadDocuments: (settings: WebDavSettings) => Promise<void>;
  loadVersions: (documentId: string, settings: WebDavSettings) => Promise<void>;
  downloadVersion: (
    documentId: string,
    versionId: string,
    settings: WebDavSettings,
  ) => Promise<WebDavDownloadedVersion>;
  setEnqueueError: (localPath: string, error: string) => void;
  setHistoryOpen: (open: boolean) => void;
}

const reduceEventIntoStore = (
  state: WebDavStoreState,
  event: WebDavSyncEvent,
): Partial<WebDavStoreState> => {
  const current: WebDavStatusState = {
    document_id: state.documentId,
    local_path: state.localPath,
    phase: state.phase,
    error: state.error,
    last_success_at: state.lastSuccessAt,
  };
  const next = reduceWebDavStatus(current, event);
  return {
    phase: next.phase,
    documentId: next.document_id,
    localPath: next.local_path,
    error: next.error,
    lastSuccessAt: next.last_success_at,
  };
};

export const useWebDavStore = create<WebDavStoreState>((set, get) => ({
  phase: 'idle',
  documentId: '',
  localPath: '',
  lastSuccessAt: '',
  error: '',
  versions: [],
  versionsDocumentId: '',
  historyError: '',
  documents: [],
  historyLoading: false,
  historyOpen: false,

  initialize: async (settings) => {
    if (!isTauriRuntime()) {
      set({ phase: settings.enabled ? 'idle' : 'disabled' });
      return;
    }
    if (!eventUnlisten) {
      eventUnlisten = await listen<WebDavSyncEvent>('webdav-sync-status', ({ payload }) => {
        // Both providers share the sync-status channel; keep only WebDAV events.
        if (payload.provider !== 'webdav') return;
        set((state) => reduceEventIntoStore(state, payload));
      });
    }
    set({ phase: settings.enabled ? 'idle' : 'disabled' });
    if (settings.enabled) {
      try {
        await invoke('webdav_retry_pending', { settings });
      } catch {
        // Startup retry failures surface through the status event stream.
      }
    }
  },

  setCurrentDocument: (path) => {
    const state = get();
    const tracking = state.documentId !== '';
    if (tracking && path !== null) return;
    set({ documentId: path ?? '', localPath: path ?? '', phase: path ? state.phase : 'idle' });
  },

  retry: async (settings) => {
    if (!isTauriRuntime()) return;
    try {
      await invoke('webdav_retry_pending', { settings });
    } catch (error) {
      set({ phase: 'error', error: String(error).slice(0, 240) });
    }
  },

  loadDocuments: async (settings) => {
    if (!isTauriRuntime()) return;
    set({ historyLoading: true });
    try {
      const documents = await invoke<WebDavDocumentSummary[]>('webdav_list_documents', {
        settings,
      });
      set({ documents, historyLoading: false });
    } catch (error) {
      set({ error: String(error).slice(0, 240), historyLoading: false });
    }
  },

  loadVersions: async (documentId, settings) => {
    if (!isTauriRuntime()) return;
    const request = ++historyVersionsSequence;
    set({ historyLoading: true, historyError: '', versions: [], versionsDocumentId: documentId });
    try {
      const versions = await invoke<WebDavVersion[]>('webdav_list_versions', {
        documentId,
        settings,
      });
      if (request !== historyVersionsSequence) return;
      set({ versions, versionsDocumentId: documentId, historyLoading: false });
    } catch (error) {
      if (request !== historyVersionsSequence) return;
      set({ historyError: String(error).slice(0, 240), historyLoading: false });
    }
  },

  downloadVersion: async (documentId, versionId, settings) => {
    const downloaded = await invoke<WebDavDownloadedVersion>('webdav_download_version', {
      documentId,
      versionId,
      settings,
    });
    return downloaded;
  },

  setEnqueueError: (localPath, error) => {
    set({ phase: 'error', localPath, error: String(error).slice(0, 240) });
  },

  setHistoryOpen: (open) => {
    set({ historyOpen: open });
  },
}));
