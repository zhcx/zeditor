/**
 * 工作区模式的规范类型。
 *
 * 放在 utils 里是为了让 `immersiveWorkspace` 与 `appStore` 共用同一份定义（store 本来就依赖
 * utils）。`split` 与 `wysiwyg` 是持久模式（写进设置），`immersive` 与 `zen` 是临时模式。
 */
export type WorkspaceMode = 'split' | 'wysiwyg' | 'immersive' | 'zen';
export type PersistentWorkspaceMode = 'split' | 'wysiwyg';

export function isPersistentWorkspaceMode(mode: WorkspaceMode): mode is PersistentWorkspaceMode {
  return mode === 'split' || mode === 'wysiwyg';
}
