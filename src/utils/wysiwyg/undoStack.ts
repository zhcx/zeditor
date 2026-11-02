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
  canUndo(): boolean;
  canRedo(): boolean;
  push(snapshot: UndoSnapshot, options: { coalesce: boolean }): void;
  undo(current: UndoSnapshot): UndoSnapshot | null;
  redo(current: UndoSnapshot): UndoSnapshot | null;
  /** End a typing group without clearing redo when switching surfaces. */
  boundary(): void;
  clear(): void;
}

const COALESCE_WINDOW_MS = 400;

export function createUndoStack(limit = 200, maxCharacters = Infinity): UndoStack {
  let past: UndoSnapshot[] = [];
  let future: UndoSnapshot[] = [];
  let lastPushCoalescible = false;
  const trim = (stack: UndoSnapshot[]) => {
    let remaining = 0;
    let first = stack.length;
    while (first > 0 && stack.length - first < limit) {
      const next = stack[first - 1].source.length;
      if (first < stack.length && remaining + next > maxCharacters) break;
      remaining += next;
      first--;
    }
    return first === 0 ? stack : stack.slice(first);
  };

  return {
    size: () => past.length,
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    push: (snapshot, options) => {
      future = [];
      const top = past[past.length - 1];
      if (options.coalesce && lastPushCoalescible && top && snapshot.timestamp - top.timestamp < COALESCE_WINDOW_MS) return;
      past = trim([...past, snapshot]);
      lastPushCoalescible = options.coalesce;
    },
    undo: (current) => {
      lastPushCoalescible = false;
      const snapshot = past[past.length - 1];
      if (!snapshot) return null;
      past = past.slice(0, -1);
      future = trim([...future, current]);
      return snapshot;
    },
    redo: (current) => {
      lastPushCoalescible = false;
      const snapshot = future[future.length - 1];
      if (!snapshot) return null;
      future = future.slice(0, -1);
      past = trim([...past, current]);
      return snapshot;
    },
    boundary: () => { lastPushCoalescible = false; },
    clear: () => {
      past = [];
      future = [];
      lastPushCoalescible = false;
    },
  };
}
