import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createWysiwygController } from '../src/components/Wysiwyg/WysiwygController.ts';
import { WysiwygSession } from '../src/components/Wysiwyg/wysiwygSession.ts';

it('scrolls to an outline selection only when requested', () => {
  const session = new WysiwygSession('# First\n\n# Second', { onSourceChange: () => undefined, insertClipboardImage: async () => false });
  const root = { scrollTop: 0, getBoundingClientRect: () => ({ top: 0, height: 200 }) } as HTMLElement;
  const target = { getBoundingClientRect: () => ({ top: 500, height: 20 }) } as HTMLElement;
  session.setAccessors({ getSurface: () => null, getBlockElement: index => index === 1 ? target : null });
  const controller = createWysiwygController({ session, getScrollDOM: () => root, getCaretRange: () => null, focus: () => undefined });
  const offset = controller.state.doc.line(3).from;

  controller.dispatch({ selection: { anchor: offset } });
  assert.equal(root.scrollTop, 0);
  controller.dispatch({ selection: { anchor: offset }, scrollIntoView: true });
  assert.equal(root.scrollTop, 410);
});

it('defers scrolling to a target that has not rendered', () => {
  const session = new WysiwygSession('# First\n\n# Second', { onSourceChange: () => undefined, insertClipboardImage: async () => false });
  let requested: number | null = null;
  const controller = createWysiwygController({
    session, getScrollDOM: () => null, getCaretRange: () => null, focus: () => undefined,
    deferReveal: offset => { requested = offset; },
  });
  const offset = controller.state.doc.line(3).from;
  controller.dispatch({ selection: { anchor: offset }, scrollIntoView: true });
  assert.equal(requested, offset);
});

it('keeps a selection pending while its block is not mounted', () => {
  const session = new WysiwygSession('# First\n\n# Second', { onSourceChange: () => undefined, insertClipboardImage: async () => false });
  const surface = { ownerDocument: { getSelection: () => null } } as unknown as HTMLElement;
  session.setAccessors({ getSurface: () => surface, getBlockElement: () => null });
  session.setSelectionOffsets(9);
  assert.deepEqual(session.getSelectionOffsets(), { from: 9, to: 9 });
  session.focus();
  assert.deepEqual(session.getSelectionOffsets(), { from: 9, to: 9 });
});
