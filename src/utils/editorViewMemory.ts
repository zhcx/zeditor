import type { WorkspaceMode } from './workspaceMode.ts';

export type EditorSurface = 'source' | 'wysiwyg';
export interface EditorViewSnapshot { from: number; to: number; scrollTop: number }
export interface EditorViewRestore extends EditorViewSnapshot { followCaret: boolean }
interface Entry {
  source?: EditorViewSnapshot;
  wysiwyg?: EditorViewSnapshot;
  last?: EditorViewSnapshot;
  pending?: Partial<Record<EditorSurface, EditorViewSnapshot>>;
}

export function editorSurface(mode: WorkspaceMode): EditorSurface | null {
  if (mode === 'wysiwyg') return 'wysiwyg';
  if (mode === 'split' || mode === 'source' || mode === 'zen') return 'source';
  return null;
}

export function createEditorViewMemory() {
  const entries = new Map<string, Entry>();
  return {
    capture(id: string, surface: EditorSurface, snapshot: EditorViewSnapshot) {
      const entry = entries.get(id) ?? {};
      entry[surface] = snapshot;
      entry.last = snapshot;
      entries.set(id, entry);
    },
    follow(id: string, from: EditorSurface, to: EditorSurface) {
      if (from === to) return;
      const entry = entries.get(id);
      const snapshot = entry?.[from];
      if (entry && snapshot) entry.pending = { ...entry.pending, [to]: snapshot };
    },
    peek(id: string, surface: EditorSurface): EditorViewRestore | undefined {
      const entry = entries.get(id);
      const pending = entry?.pending?.[surface];
      if (pending) return { ...pending, followCaret: true };
      const own = entry?.[surface];
      if (own) return { ...own, followCaret: false };
      return entry?.last ? { ...entry.last, followCaret: true } : undefined;
    },
    consume(id: string, surface: EditorSurface) {
      const pending = entries.get(id)?.pending;
      if (pending) delete pending[surface];
    },
    delete(id: string) { entries.delete(id); },
  };
}

export const editorViewMemory = createEditorViewMemory();
