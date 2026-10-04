import { AppIcon } from '../Icons/AppIcon';
import { useEffect, useRef } from 'react';
import type { CloseGuardTab, UnsavedChangesAction } from '../../utils/windowCloseGuard';

interface UnsavedChangesDialogProps {
  tabs: CloseGuardTab[];
  onAction: (action: UnsavedChangesAction) => void;
  scope?: 'application' | 'tab';
  busy?: boolean;
}

export function UnsavedChangesDialog({ tabs, onAction, scope = 'application', busy = false }: UnsavedChangesDialogProps) {
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const isApplicationClose = scope === 'application';

  useEffect(() => {
    saveButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onAction('cancel');
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onAction]);

  return (
    <div
      className="unsaved-dialog-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onAction('cancel');
      }}
    >
      <section
        className="unsaved-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="unsaved-dialog-title"
        aria-describedby="unsaved-dialog-description"
      >
        <header className="unsaved-dialog-header">
          <div className="unsaved-dialog-heading">
            <span className="unsaved-dialog-icon" aria-hidden="true">
              <AppIcon name="warning" size={20}  />
            </span>
            <div>
              <h2 id="unsaved-dialog-title">
                {isApplicationClose ? '退出前保存修改？' : '保存文件修改？'}
              </h2>
              <p id="unsaved-dialog-description">
                {isApplicationClose
                  ? `${tabs.length} 个文件包含尚未保存的内容`
                  : `“${tabs[0]?.title ?? '未命名'}”包含尚未保存的内容`}
              </p>
            </div>
          </div>
          <button
            className="unsaved-dialog-close"
            type="button"
            aria-label={isApplicationClose ? '取消退出' : '取消关闭标签页'}
            title={isApplicationClose ? '取消退出 (Esc)' : '取消关闭 (Esc)'}
            onClick={() => onAction('cancel')}
          >
            <span aria-hidden="true"><AppIcon name="close" size={16} /></span>
          </button>
        </header>

        <div className="unsaved-dialog-body">
          <div className="unsaved-file-list" aria-label="未保存的文件">
            {tabs.map((tab) => (
              <div className="unsaved-file-row" key={tab.id}>
                <span className="unsaved-file-mark" aria-hidden="true" />
                <span className="unsaved-file-name" title={tab.path ?? tab.title}>{tab.title}</span>
                <span className="unsaved-file-state">未保存</span>
              </div>
            ))}
          </div>
          <p className="unsaved-dialog-note">
            {isApplicationClose ? '保存后退出，或放弃这些修改。' : '保存后关闭标签页，或放弃本次修改。'}
            不保存的内容将无法恢复。
          </p>
        </div>

        <footer className="unsaved-dialog-actions">
          <button className="unsaved-action-button" type="button" onClick={() => onAction('cancel')}>
            取消
          </button>
          <button disabled={busy} className="unsaved-action-button discard" type="button" onClick={() => onAction('discard')}>
            不保存
          </button>
          <button
            ref={saveButtonRef}
            disabled={busy}
            className="unsaved-action-button primary"
            type="button"
            onClick={() => onAction('save')}
          >
            {isApplicationClose ? '全部保存' : '保存'}
          </button>
        </footer>
      </section>
    </div>
  );
}
