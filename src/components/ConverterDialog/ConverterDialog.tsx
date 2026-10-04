import { AppIcon } from '../Icons/AppIcon';
import { useEffect, useRef, useCallback } from 'react';

export interface ConverterDialogAction {
  /** 弹窗类型：confirm（确认安装）、error（错误提示） */
  kind: 'confirm' | 'error';
  /** 弹窗标题 */
  title: string;
  /** 弹窗描述/详情 */
  description: string;
  /** 确认按钮文本 */
  confirmLabel?: string;
  /** 取消/关闭按钮文本 */
  cancelLabel?: string;
  /** 是否显示"不再提示"（仅 confirm 类型） */
  showSkip?: boolean;
  /** 确认回调 */
  onConfirm?: () => void;
  /** 取消/关闭回调 */
  onCancel?: () => void;
}

interface ConverterDialogProps {
  action: ConverterDialogAction | null;
  onClose: () => void;
}

export function ConverterDialog({ action, onClose }: ConverterDialogProps) {
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!action) return;
    confirmButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        action.onCancel?.();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [action, onClose]);

  const handleOverlayClick = useCallback((event: React.MouseEvent) => {
    if (event.target === event.currentTarget) {
      action?.onCancel?.();
      onClose();
    }
  }, [action, onClose]);

  if (!action) return null;

  const isConfirm = action.kind === 'confirm';
  const isError = action.kind === 'error';

  return (
    <div
      className="converter-dialog-overlay"
      role="presentation"
      onClick={handleOverlayClick}
    >
      <section
        className="converter-dialog"
        role={isError ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby="converter-dialog-title"
        aria-describedby="converter-dialog-desc"
      >
        <header className="converter-dialog-header">
          <div className="converter-dialog-heading">
            <span className="converter-dialog-icon" aria-hidden="true">
              {isError ? (
                /* 错误图标 */
                <AppIcon name="error" size={20}  />
              ) : (
                /* 转换/信息图标 */
                <AppIcon name="fileConvert" size={20}  />
              )}
            </span>
            <div>
              <h2 id="converter-dialog-title">{action.title}</h2>
              <p id="converter-dialog-desc">{action.description}</p>
            </div>
          </div>
          {isError && (
            <button
              className="converter-dialog-close"
              type="button"
              aria-label="关闭"
              title="关闭 (Esc)"
              onClick={() => { action.onCancel?.(); onClose(); }}
            >
              <span aria-hidden="true"><AppIcon name="close" size={16} /></span>
            </button>
          )}
        </header>

        {isError ? (
          <div className="converter-dialog-error-detail">
            <p>可通过以下方式解决：</p>
            <ul>
              <li>在<strong>设置 → 文档转换</strong>中安装或导入转换模块</li>
              <li>安装对应平台的 Zeditor AnyDoc 转换模块</li>
              <li>仅支持 Markdown 格式文件可直接打开</li>
            </ul>
          </div>
        ) : null}

        <footer className="converter-dialog-actions">
          {isConfirm && (
            <button
              className="converter-action-btn discard"
              type="button"
              onClick={() => { action.onCancel?.(); onClose(); }}
            >
              {action.cancelLabel || '稍后安装'}
            </button>
          )}
          <button
            ref={isConfirm ? confirmButtonRef : undefined}
            className={isConfirm ? 'converter-action-btn primary' : 'converter-action-btn'}
            type="button"
            onClick={() => { action.onConfirm?.(); onClose(); }}
          >
            {isError
              ? (action.confirmLabel || '知道了')
              : (action.confirmLabel || '立即安装')}
          </button>
        </footer>
      </section>
    </div>
  );
}
