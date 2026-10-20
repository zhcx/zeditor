import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AppIcon } from '../Icons/AppIcon';
import './recycle.css';

export interface RecycleEntry {
  id: string;
  name: string;
  originalPath: string;
  deletedAt: number;
  isDirectory: boolean;
  location: 'system' | 'app';
  canRestore: boolean;
  available: boolean;
  note: string;
}

interface RecycleDialogProps {
  onClose: () => void;
  onRestored: (path: string) => void;
}

/** Shows Zeditor's own deletion records, never unrelated system trash contents. */
export function RecycleDialog({ onClose, onRestored }: RecycleDialogProps) {
  const [entries, setEntries] = useState<RecycleEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(true);

  const reload = useCallback(async () => {
    try {
      const items = await invoke<RecycleEntry[]>('list_recycled_items');
      if (mountedRef.current) { setEntries(items); setError(''); }
    } catch (failure) {
      if (mountedRef.current) setError(`无法读取回收记录：${String(failure)}`);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const previous = document.activeElement;
    closeRef.current?.focus();
    // Loading state is already true on mount; synchronize it only when the
    // external request settles, including React StrictMode's second setup.
    let active = true;
    void invoke<RecycleEntry[]>('list_recycled_items').then(items => {
      if (active) { setEntries(items); setError(''); }
    }).catch(failure => {
      if (active) setError(`无法读取回收记录：${String(failure)}`);
    }).finally(() => { if (active) setLoading(false); });
    return () => {
      active = false;
      mountedRef.current = false;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (!busyId) onClose();
      }
      if (event.key === 'Tab') {
        const controls = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]');
        if (!controls?.length) return;
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [busyId, onClose]);

  const restore = async (entry: RecycleEntry) => {
    setBusyId(entry.id);
    setError('');
    setMessage('');
    try {
      const path = await invoke<string>('restore_recycled_item', { id: entry.id });
      if (!mountedRef.current) return;
      setMessage(`已恢复：${path}`);
      onRestored(path);
      await reload();
    } catch (failure) {
      if (mountedRef.current) setError(`恢复失败：${String(failure)}`);
    } finally {
      if (mountedRef.current) setBusyId(null);
    }
  };

  return (
    <div className="recycle-overlay">
      <section className="recycle-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="recycle-title" aria-describedby="recycle-description">
        <header className="recycle-header">
          <div>
            <h2 id="recycle-title">回收站与文件恢复</h2>
            <p id="recycle-description">此处列出通过 Zeditor 删除的项目。恢复到原位置时会保留已有的同名内容。</p>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} disabled={!!busyId} aria-label="关闭回收站" title="关闭"><AppIcon name="close" size={18} /></button>
        </header>
        <div className="recycle-notice">优先使用系统回收站；不可用时存入 Zeditor 恢复区。系统回收站被清空后，其中的项目将无法恢复。恢复前，请在资源管理器中重新打开原位置的父文件夹。</div>
        <div className="recycle-messages" aria-live="polite">
          {error && <p className="recycle-error" role="alert">{error}</p>}
          {message && <p className="recycle-success">{message}</p>}
        </div>
        <div className="recycle-list" aria-busy={loading}>
          {loading ? <p className="recycle-empty">正在读取回收记录…</p> : entries.length === 0 ? <p className="recycle-empty">暂无通过 Zeditor 删除的项目。</p> : entries.map(entry => (
            <article className="recycle-item" key={entry.id}>
              <div className="recycle-item-body">
                <strong>{entry.name}<span className="recycle-badge">{entry.location === 'app' ? 'Zeditor 恢复区' : '系统回收站'}</span></strong>
                <span className="recycle-path" title={entry.originalPath}>{entry.originalPath}</span>
                <small>{new Date(entry.deletedAt).toLocaleString()} · {entry.isDirectory ? '文件夹' : '文件'}</small>
                {entry.note && <p>{entry.note}</p>}
                {entry.available && !entry.canRestore && !entry.note && <p>请打开系统回收站或废纸篓，按名称与原路径查找后恢复。</p>}
              </div>
              <button type="button" onClick={() => void restore(entry)} disabled={!entry.canRestore || !entry.available || !!busyId}>
                {busyId === entry.id ? '正在恢复…' : entry.available ? '恢复到原位置' : '已不可恢复'}
              </button>
            </article>
          ))}
        </div>
        <footer className="recycle-footer">
          <span>macOS 的系统废纸篓项目请在访达中恢复。</span>
          <button type="button" onClick={() => { setLoading(true); setError(''); void reload(); }} disabled={loading || !!busyId}>刷新记录</button>
        </footer>
      </section>
    </div>
  );
}
