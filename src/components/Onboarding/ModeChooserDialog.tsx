import { AppIcon } from '../Icons/AppIcon';
import type { PersistentWorkspaceMode } from '../../stores/appStore';

interface ModeChooserDialogProps {
  onChoose: (mode: PersistentWorkspaceMode) => void;
  busy?: boolean;
}

/**
 * 首次启动的编辑方式选择：设置文件里没有 editor.mode 时出现一次，
 * 关闭（Esc）等同选择源码对照，避免每次启动都弹。
 */
export function ModeChooserDialog({ onChoose, busy = false }: ModeChooserDialogProps) {
  return (
    <div className="modal-overlay mode-chooser-overlay" role="dialog" aria-modal="true" aria-labelledby="mode-chooser-title">
      <div className="mode-chooser">
        <header className="mode-chooser-header">
          <h2 id="mode-chooser-title">选择你的编辑方式</h2>
          <p>之后可随时在状态栏、活动栏或菜单里切换。</p>
        </header>
        <div className="mode-chooser-cards">
          <button type="button" className="mode-chooser-card" disabled={busy} onClick={() => onChoose('wysiwyg')}>
            <span className="mode-chooser-card-icon" aria-hidden="true"><AppIcon name="penLine" size={20} /></span>
            <strong>所见即所得</strong>
            <span>像写文档一样直接编辑，不显示 Markdown 标记，适合不熟悉语法的用户</span>
          </button>
          <button type="button" className="mode-chooser-card" disabled={busy} onClick={() => onChoose('split')}>
            <span className="mode-chooser-card-icon" aria-hidden="true"><AppIcon name="format" size={20} /></span>
            <strong>源码对照</strong>
            <span>左侧编辑 Markdown 源码，右侧实时预览，适合熟悉语法的用户</span>
          </button>
        </div>
      </div>
    </div>
  );
}
