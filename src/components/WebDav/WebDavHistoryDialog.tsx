import { AppIcon } from '../Icons/AppIcon';
import { openBase64Document } from '../../services/textDocuments';
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import type {
  S3Settings,
  WebDavDocumentSummary,
  WebDavDownloadedVersion,
  WebDavSettings,
  WebDavVersion,
} from '../../types/webdav';
import { useWebDavStore } from '../../stores/webdavStore';
import { useS3Store } from '../../stores/s3Store';
import { useAppStore } from '../../stores/appStore';

interface WebDavHistoryDialogProps {
  open: boolean;
  mode: 'current' | 'global';
  /** WebDAV or S3 settings; the dialog routes to the matching store. */
  settings: WebDavSettings | S3Settings;
  /** Backend provider for this dialog instance. */
  provider?: 'webdav' | 's3';
  currentDocumentId?: string;
  onClose: () => void;
}

const isTauriRuntime = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export function WebDavHistoryDialog({
  open,
  mode,
  settings,
  provider = 'webdav',
  currentDocumentId,
  onClose,
}: WebDavHistoryDialogProps) {
  // Both stores expose the same action shapes; pick by provider so the right
  // command names (webdav_* / s3_*) are invoked. Both hooks run unconditionally.
  const webdavState = useWebDavStore();
  const s3State = useS3Store();
  const store = provider === 's3' ? s3State : webdavState;
  const versions = store.versions;
  const documents = store.documents;
  const historyLoading = store.historyLoading;
  const loadDocuments = store.loadDocuments as (settings: WebDavSettings | S3Settings) => Promise<void>;
  const loadVersions = store.loadVersions as (documentId: string, settings: WebDavSettings | S3Settings) => Promise<void>;
  const downloadVersion = store.downloadVersion as (
    documentId: string,
    versionId: string,
    settings: WebDavSettings | S3Settings,
  ) => Promise<WebDavDownloadedVersion>;
  const setHistoryOpen = store.setHistoryOpen;
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || !settings.enabled) return;
    if (mode === 'global') {
      void loadDocuments(settings);
    } else if (currentDocumentId) {
      void loadVersions(currentDocumentId, settings);
    }
  }, [open, mode, settings, currentDocumentId, loadDocuments, loadVersions]);

  if (!open) return null;

  const activeDocumentId =
    mode === 'global'
      ? selectedDocumentId ?? documents[0]?.document_id ?? ''
      : currentDocumentId ?? '';
  const activeVersions =
    activeDocumentId !== '' && versions.length > 0 && selectedDocumentId === activeDocumentId
      ? versions
      : mode === 'global'
        ? []
        : versions;

  const pickDocument = (documentId: string) => {
    setSelectedDocumentId(documentId);
    void loadVersions(documentId, settings);
  };

  const download = async (documentId: string, version: WebDavVersion) => {
    setDownloadingId(version.id);
    setError('');
    try {
      const downloaded = await downloadVersion(documentId, version.id, settings);
      const path = await save({
        defaultPath: downloaded.filename,
        filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
      });
      if (typeof path !== 'string') return;
      // 备份保存的是原始字节，恢复时不能将 GBK/UTF-16 强制写成 UTF-8。
      if (downloaded.data_base64 !== undefined) await invoke('save_file_bytes', { path, dataBase64: downloaded.data_base64 });
      else await invoke('save_file_content', { path, content: downloaded.content });
    } catch (downloadError) {
      setError(String(downloadError).slice(0, 240));
    } finally {
      setDownloadingId(null);
    }
  };

  /** 打开远端版本：内容载入编辑器新标签页（不覆盖当前正在编辑的内容）。 */
  const openVersion = async (documentId: string, version: WebDavVersion) => {
    setDownloadingId(version.id);
    setError('');
    try {
      const downloaded = await downloadVersion(documentId, version.id, settings);
      if (downloaded.data_base64 !== undefined) {
        await openBase64Document(downloaded.filename, downloaded.data_base64);
      } else {
        useAppStore.getState().addTab({ title: downloaded.filename, content: downloaded.content, modified: true });
      }
      onClose();
    } catch (openError) {
      setError(String(openError).slice(0, 240));
    } finally {
      setDownloadingId(null);
    }
  };

  /** 双击文档行：加载该文档版本列表并直接打开最新版本。 */
  const openLatestVersion = async (document: WebDavDocumentSummary) => {
    setError('');
    try {
      await loadVersions(document.document_id, settings);
      const latestStore = provider === 's3' ? useS3Store.getState() : useWebDavStore.getState();
      const latest = latestStore.versions[0];
      if (!latest) {
        setError('该文档暂无可打开的备份版本');
        return;
      }
      await openVersion(document.document_id, latest);
    } catch (openError) {
      setError(String(openError).slice(0, 240));
    }
  };

  const close = () => {
    setHistoryOpen(false);
    onClose();
  };

  return (
    <div className="webdav-history-dialog">
      <div className="webdav-history-dialog-header">
        <h3>{mode === 'global' ? '全部备份' : '当前文档历史'}</h3>
        <button type="button" className="webdav-dialog-close" onClick={close} aria-label="关闭">
          <AppIcon name="close" size={20}  />
        </button>
      </div>

      <div className="webdav-history-dialog-body">
        {mode === 'global' && (
          <div className="webdav-document-list">
            <h4>文档</h4>
            {historyLoading && documents.length === 0 ? (
              <p className="webdav-history-empty">加载中…</p>
            ) : documents.length === 0 ? (
              <p className="webdav-history-empty">暂无备份文档</p>
            ) : (
              documents.map(document => (
                <button
                  key={document.document_id}
                  type="button"
                  title="单击查看版本，双击打开最新备份"
                  className={`webdav-document-row ${
                    selectedDocumentId === document.document_id ? 'selected' : ''
                  }`}
                  onClick={() => pickDocument(document.document_id)}
                  onDoubleClick={() => void openLatestVersion(document)}
                >
                  <span className="webdav-document-name">{document.display_name}</span>
                  <span className="webdav-document-time">
                    {new Date(document.latest_at).toLocaleString()}
                  </span>
                </button>
              ))
            )}
          </div>
        )}

        <div className="webdav-version-list">
          <h4>版本</h4>
          {historyLoading && activeVersions.length === 0 ? (
            <p className="webdav-history-empty">加载中…</p>
          ) : activeVersions.length === 0 ? (
            <p className="webdav-history-empty">暂无历史版本</p>
          ) : (
            activeVersions.map(version => (
              <div
                key={version.id}
                className="webdav-version-row"
                title="双击打开此版本"
                onDoubleClick={() => void openVersion(activeDocumentId, version)}
              >
                <div className="webdav-version-meta">
                  <span className="webdav-version-time">
                    {new Date(version.created_at).toLocaleString()}
                  </span>
                  <span className="webdav-version-size">
                    {(version.size / 1024).toFixed(1)} KB
                  </span>
                  <span className="webdav-version-hash">{version.sha256.slice(0, 12)}</span>
                </div>
                <div className="webdav-version-actions">
                  <button
                    type="button"
                    className="button webdav-version-open"
                    disabled={downloadingId === version.id || !isTauriRuntime() || activeDocumentId === ''}
                    onClick={() => void openVersion(activeDocumentId, version)}
                  >
                    {downloadingId === version.id ? '打开中…' : '打开'}
                  </button>
                  <button
                    type="button"
                    className="button webdav-version-download"
                    disabled={downloadingId === version.id || !isTauriRuntime() || activeDocumentId === ''}
                    onClick={() => void download(activeDocumentId, version)}
                  >
                    另存为
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {error && <p className="webdav-connection-result error">{error}</p>}
    </div>
  );
}
