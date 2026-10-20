import { useState } from 'react';
import type { FileConflict } from '../../stores/appStore';
import './file-conflict.css';

interface FileConflictDialogProps {
  conflict: FileConflict;
  onReload: () => void;
  onOpenDiskCopy: () => void;
  onSaveCopy: () => void;
  onOverwrite: () => Promise<void>;
  onClose: () => void;
}

export function FileConflictDialog({ conflict, onReload, onOpenDiskCopy, onSaveCopy, onOverwrite, onClose }: FileConflictDialogProps) {
  const [confirmedConflict, setConfirmedConflict] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const diskExists = conflict.diskExists;
  const conflictKey = `${conflict.tabId}:${conflict.diskFileVersion?.sha256 || 'missing'}:${conflict.localContent}`;
  const confirmOverwrite = confirmedConflict === conflictKey;

  const confirmAndOverwrite = async () => {
    if (!confirmOverwrite) {
      setConfirmedConflict(conflictKey);
      return;
    }
    setBusy(true);
    try {
      await onOverwrite();
    } catch (caught) {
      setError({ key: conflictKey, message: String(caught) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="file-conflict-overlay">
      <section className="file-conflict-dialog" role="alertdialog" aria-modal="true" aria-labelledby="file-conflict-title">
        <header className="file-conflict-header">
          <div>
            <h2 id="file-conflict-title">文件在其他位置已更改</h2>
            <p title={conflict.path}>{conflict.path} · 自动保存已暂停</p>
          </div>
          <button type="button" onClick={onClose} aria-label="返回编辑">返回编辑</button>
        </header>

        <div className="file-conflict-columns">
          <section>
            <h3>当前编辑内容</h3>
            <pre>{conflict.localContent}</pre>
          </section>
          <section>
            <h3>磁盘上的内容</h3>
            {conflict.diskContent !== null
              ? <pre>{conflict.diskContent}</pre>
              : <p className="file-conflict-deleted">{diskExists
                ? '磁盘文件存在，但当前编码无法预览。请另存你的版本，避免覆盖未检查的内容。'
                : '此文件已在外部删除。你的编辑内容仍保留在当前标签页。'}</p>}
          </section>
        </div>
        {error?.key === conflictKey && <p className="file-conflict-error" role="alert">保存失败：{error.message}</p>}

        <footer className="file-conflict-actions">
          <button type="button" onClick={onClose}>返回编辑并手动合并</button>
          <span className="file-conflict-spacer" />
          <button type="button" onClick={onSaveCopy}>另存我的版本…</button>
          {conflict.diskContent !== null && <button type="button" onClick={onOpenDiskCopy}>在新标签页打开磁盘版本</button>}
          {conflict.diskContent !== null
            ? <button type="button" onClick={onReload}>重新载入磁盘版本</button>
            : !diskExists && <button type="button" onClick={onReload}>保留本地版本并另存</button>}
          {conflict.diskContent !== null && (
            <button className="file-conflict-overwrite" type="button" disabled={busy} onClick={() => { void confirmAndOverwrite(); }}>
              {busy ? '正在保存…' : confirmOverwrite ? '再次确认：覆盖磁盘文件' : '审阅后覆盖磁盘文件'}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
