import { useEffect, useState } from 'react';
import { AppIcon } from '../Icons/AppIcon';
import type { RecoverySnapshot } from '../../utils/recovery';
import './recovery.css';

interface RecoveryDialogProps {
  snapshots: RecoverySnapshot[];
  onRestore: (id: string) => void;
  onSaveCopy: (id: string) => void;
  onDiscard: (id: string) => void;
}

const formatUpdatedAt = (timestamp: number) => {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : '时间未知';
};

export function RecoveryDialog({ snapshots, onRestore, onSaveCopy, onDiscard }: RecoveryDialogProps) {
  const [selectedId, setSelectedId] = useState(snapshots[0]?.id ?? '');
  const selected = snapshots.find(snapshot => snapshot.id === selectedId) ?? snapshots[0];

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  if (!selected) return null;

  return (
    <div className="recovery-overlay">
      <section className="recovery-dialog" role="dialog" aria-modal="true" aria-labelledby="recovery-title">
        <header className="recovery-header">
          <span className="recovery-icon" aria-hidden="true"><AppIcon name="history" size={20} /></span>
          <div>
            <h2 id="recovery-title">恢复未保存内容</h2>
            <p>这些草稿来自上次会话。恢复后会作为未保存文档打开，不会覆盖磁盘文件。</p>
          </div>
        </header>

        <div className="recovery-body">
          <nav className="recovery-list" aria-label="可恢复文档">
            {snapshots.map(snapshot => (
              <button
                className={`recovery-item ${snapshot.id === selected.id ? 'active' : ''}`}
                key={snapshot.id}
                type="button"
                onClick={() => setSelectedId(snapshot.id)}
              >
                <strong>{snapshot.title || '未命名'}</strong>
                <span>{snapshot.path || '未保存到文件'}</span>
                <small>{formatUpdatedAt(snapshot.updatedAt)}</small>
              </button>
            ))}
          </nav>

          <section className="recovery-preview" aria-label="恢复内容预览">
            <div className="recovery-preview-heading">
              <strong>{selected.title || '未命名'}</strong>
              <span>{selected.content.length.toLocaleString()} 个字符</span>
            </div>
            <pre>{selected.content}</pre>
          </section>
        </div>

        <footer className="recovery-actions">
          <button className="recovery-discard" type="button" onClick={() => onDiscard(selected.id)}>丢弃此快照</button>
          <span className="recovery-action-spacer" />
          <button type="button" onClick={() => onSaveCopy(selected.id)}>另存为文件…</button>
          <button className="primary" type="button" onClick={() => onRestore(selected.id)}>恢复到新标签页</button>
        </footer>
      </section>
    </div>
  );
}
