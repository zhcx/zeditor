import { createUndoStack, type UndoStack } from './wysiwyg/undoStack.ts';

// Each tab owns one bounded history shared by its editing surfaces.
const histories = new Map<string, UndoStack>();
export const documentHistory = {
  get(id: string): UndoStack {
    let history = histories.get(id);
    if (!history) {
      history = createUndoStack(200, 8 * 1024 * 1024);
      histories.set(id, history);
    }
    return history;
  },
  delete(id: string): void { histories.delete(id); },
};
