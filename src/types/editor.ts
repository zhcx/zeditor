export interface EditorSelectionRange {
  from: number;
  to: number;
  empty: boolean;
}

export interface EditorLine {
  from: number;
  to: number;
  number: number;
  text: string;
}

export interface EditorDispatchSelection {
  anchor?: number;
  head?: number;
  from?: number;
  to?: number;
  main?: EditorDispatchSelection;
}

export interface EditorDispatchSpec {
  changes?: { from: number; to?: number; insert?: string };
  selection?: EditorDispatchSelection;
  scrollIntoView?: boolean;
}

export interface EditorController {
  scrollDOM: HTMLElement;
  getScrollTop: () => number;
  getScrollHeight: () => number;
  getClientHeight: () => number;
  getTopForLineNumber: (lineNumber: number) => number;
  setScrollTop: (top: number) => void;
  onScroll: (listener: () => void) => () => void;
  /** CodeMirror-compatible facade kept for existing toolbar and AI integrations. */
  state: {
    selection: { main: EditorSelectionRange };
    sliceDoc: (from: number, to: number) => string;
    doc: {
      length: number;
      lines: number;
      lineAt: (offset: number) => EditorLine;
      line: (lineNumber: number) => EditorLine;
    };
    update: (spec: EditorDispatchSpec) => EditorDispatchSpec;
  };
  dispatch: (spec: EditorDispatchSpec) => void;
  getValue: () => string;
  /** 重新按文件编码读取时替换内容并清空撤销历史。 */
  resetValue?: (content: string) => void;
  getSelection: () => EditorSelectionRange;
  getText: (from: number, to: number) => string;
  replaceRange: (from: number, to: number, text: string, selection?: { from: number; to: number }) => void;
  setSelection: (from: number, to?: number) => void;
  lineAt: (offset: number) => EditorLine;
  line: (lineNumber: number) => EditorLine;
  coordsAtPos: (offset: number) => { left: number; bottom: number; x: number; y: number } | null;
  focus: () => void;
  undo: () => void;
  redo: () => void;
  revealOffset: (offset: number) => void;
}
