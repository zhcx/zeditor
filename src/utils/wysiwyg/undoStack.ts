/**
 * 所见即所得的撤销栈：内容级快照 + 光标偏移。
 *
 * 连续输入在 400 ms 窗口内合并为一条（保留窗口开始时的快照），
 * 结构操作使用 `coalesce: false` 形成明确的撤销边界。
 */
export interface UndoSnapshot {
  source: string;
  caret: number;
  timestamp: number;
}

export interface UndoStack {
  size(): number;
  push(snapshot: UndoSnapshot, options: { coalesce: boolean }): void;
  undo(current: UndoSnapshot): UndoSnapshot | null;
  redo(current: UndoSnapshot): UndoSnapshot | null;
  clear(): void;
}

const COALESCE_WINDOW_MS = 400;

export function createUndoStack(limit = 200): UndoStack {
  let past: UndoSnapshot[] = [];
  let future: UndoSnapshot[] = [];
  const trim = (stack: UndoSnapshot[]) => stack.length > limit ? stack.slice(stack.length - limit) : stack;

  return {
    size: () => past.length,
    push: (snapshot, options) => {
      future = [];
      const top = past[past.length - 1];
      if (options.coalesce && top && snapshot.timestamp - top.timestamp < COALESCE_WINDOW_MS) return;
      past = trim([...past, snapshot]);
    },
    undo: (current) => {
      const snapshot = past[past.length - 1];
      if (!snapshot) return null;
      past = past.slice(0, -1);
      future = [...future, current];
      return snapshot;
    },
    redo: (current) => {
      const snapshot = future[future.length - 1];
      if (!snapshot) return null;
      future = future.slice(0, -1);
      past = [...past, current];
      return snapshot;
    },
    clear: () => {
      past = [];
      future = [];
    },
  };
}
