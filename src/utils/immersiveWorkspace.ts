import type { WorkspaceMode } from './workspaceMode.ts';

export type { WorkspaceMode };

export interface ImmersiveWorkspacePolicy {
  active: boolean;
  kind: 'reading' | 'writing' | null;
  showEditorToolbar: boolean;
  showOutline: boolean;
  showChatbox: boolean;
  hideWorkbenchChrome: boolean;
}

export function getImmersiveWorkspacePolicy(
  mode: WorkspaceMode,
  chatbotVisible: boolean,
): ImmersiveWorkspacePolicy {
  // 只有沉浸写作 / 沉浸阅读是沉浸态：源码对照与所见即所得都是常规工作区。
  const active = mode === 'immersive' || mode === 'zen';

  return {
    active,
    kind: mode === 'zen' ? 'writing' : mode === 'immersive' ? 'reading' : null,
    showEditorToolbar: mode === 'zen',
    showOutline: active,
    showChatbox: active && chatbotVisible,
    hideWorkbenchChrome: active,
  };
}
