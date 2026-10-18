/**
 * EditorController 适配器：把编辑会话包装成既有接口（markdown 偏移坐标系）。
 *
 * 工具栏、AI 校对与改写、翻译插入、状态栏行列与字数、大纲跳转都只依赖这个接口，
 * 因此它们在所见即所得模式下无需改动即可继续工作。
 *
 * 偏移一致性约定：`getSelection()` 会先 flush 挂起的输入再读取，因此「读选区 → 用这对
 * 偏移做替换」的既有调用方（工具栏、AI）始终拿到最新偏移；`replaceRange` 只做 flush，
 * 不再重算调用方给的偏移。
 */
import { countLines, lineAtOffset, offsetOfLine } from '../../utils/wysiwyg/textLines.ts';
import { rectOfRange, revealElement } from './domCaret.ts';
import type { WysiwygSession } from './wysiwygSession';
import type { EditorController, EditorDispatchSpec, EditorLine } from '../../types/editor';

export interface WysiwygControllerDeps {
  session: WysiwygSession;
  /** 编辑表面的滚动容器。 */
  getScrollDOM: () => HTMLElement | null;
  /** 当前选区（弹窗定位用）。 */
  getCaretRange: () => Range | null;
  focus: () => void;
}

export function createWysiwygController(deps: WysiwygControllerDeps): EditorController {
  const { session } = deps;
  let fallbackScroll: HTMLElement | null = null;

  const scrollHost = (): HTMLElement => {
    const element = deps.getScrollDOM();
    if (element) return element;
    if (!fallbackScroll) fallbackScroll = document.createElement('div');
    return fallbackScroll;
  };

  const selectionRange = () => session.getSelectionOffsets();

  const controller: EditorController = {
    get scrollDOM() { return scrollHost(); },
    getScrollTop: () => deps.getScrollDOM()?.scrollTop ?? 0,
    getScrollHeight: () => deps.getScrollDOM()?.scrollHeight ?? 0,
    getClientHeight: () => deps.getScrollDOM()?.clientHeight ?? 0,
    getTopForLineNumber: (lineNumber) => {
      const element = session.locateElementOfOffset(offsetOfLine(session.getSource(), lineNumber));
      return element?.offsetTop ?? 0;
    },
    setScrollTop: (top) => {
      const element = deps.getScrollDOM();
      if (element) element.scrollTop = top;
    },
    onScroll: (listener) => {
      const element = deps.getScrollDOM();
      if (!element) return () => undefined;
      element.addEventListener('scroll', listener, { passive: true });
      return () => element.removeEventListener('scroll', listener);
    },
    state: {
      get selection() {
        const { from, to } = selectionRange();
        return { main: { from, to, empty: from === to } };
      },
      sliceDoc: (from, to) => { session.flushWriteBack(); return session.getSource().slice(from, to); },
      doc: {
        get length() { return session.getSource().length; },
        get lines() { return countLines(session.getSource()); },
        lineAt: (offset: number) => lineAtOffset(session.getSource(), offset) as EditorLine,
        line: (lineNumber: number) => lineAtOffset(session.getSource(), offsetOfLine(session.getSource(), lineNumber)) as EditorLine,
      },
      update: (spec) => spec,
    },
    dispatch: (spec: EditorDispatchSpec) => {
      const selection = spec.selection?.main ?? spec.selection;
      const changes = spec.changes;
      if (changes) {
        const from = changes.from;
        const to = changes.to ?? from;
        const caret = selection?.from ?? selection?.anchor ?? from + (changes.insert?.length ?? 0);
        session.replaceRange(from, to, changes.insert ?? '', caret);
        if (selection) session.setSelectionOffsets(caret, selection.to ?? selection.head ?? caret);
        return;
      }
      if (selection) {
        const from = selection.from ?? selection.anchor ?? 0;
        const to = selection.to ?? selection.head ?? from;
        session.setSelectionOffsets(from, to);
      }
    },
    getValue: () => {
      session.flushWriteBack();
      return session.getSource();
    },
    flushPendingEdits: () => session.flushWriteBack(),
    resetValue: (content) => { session.applySource(content, 0); },
    getSelection: () => {
      // 先落盘再读：否则调用方拿到的偏移会落后于用户刚敲的内容。
      session.prepareExternalEdit();
      const { from, to } = selectionRange();
      return { from, to, empty: from === to };
    },
    getText: (from, to) => { session.flushWriteBack(); return session.getSource().slice(from, to); },
    replaceRange: (from, to, text, selection) => {
      session.replaceRange(from, to, text, selection?.from);
      if (selection) session.setSelectionOffsets(selection.from, selection.to);
    },
    setSelection: (from, to) => { session.setSelectionOffsets(from, to); },
    lineAt: (offset) => lineAtOffset(session.getSource(), offset) as EditorLine,
    line: (lineNumber) => lineAtOffset(session.getSource(), offsetOfLine(session.getSource(), lineNumber)) as EditorLine,
    coordsAtPos: (offset) => {
      const range = session.rangeOfOffset(offset) ?? deps.getCaretRange();
      const rect = range ? rectOfRange(range) : null;
      if (!rect) return null;
      return { left: rect.left, bottom: rect.bottom, x: rect.left, y: rect.top };
    },
    focus: () => deps.focus(),
    undo: () => { session.handleUndo(); },
    redo: () => { session.handleRedo(); },
    revealOffset: (offset) => {
      const element = session.locateElementOfOffset(offset);
      if (element) revealElement(element, deps.getScrollDOM());
      else if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => {
        const revealed = session.locateElementOfOffset(offset);
        if (revealed) revealElement(revealed, deps.getScrollDOM());
      });
    },
  };

  return controller;
}
