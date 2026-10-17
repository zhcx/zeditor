import type { EditorController } from '../types/editor.ts';
import { lineAtOffset } from './wysiwyg/textLines.ts';

interface TextSelection { from: number; to: number }
interface HeadingEdit {
  from: number;
  to: number;
  text: string;
  selection: TextSelection;
}

/** Headings style existing lines; they never insert a separate blank block. */
export function createHeadingEdit(source: string, selection: TextSelection, level: number): HeadingEdit | null {
  if (!Number.isInteger(level) || level < 0 || level > 6) return null;
  const from = Math.max(0, Math.min(source.length, Math.min(selection.from, selection.to)));
  const to = Math.max(from, Math.min(source.length, Math.max(selection.from, selection.to)));
  const firstLine = lineAtOffset(source, from);
  // Selecting through a newline must not format the following unselected line.
  const lastLine = lineAtOffset(source, to > from ? to - 1 : to);
  const parts = source.slice(firstLine.from, lastLine.to).split(/(\r\n|\r|\n)/);
  const prefix = level > 0 ? `${'#'.repeat(level)} ` : '';
  const edits: Array<{ from: number; to: number; text: string }> = [];
  let offset = firstLine.from;
  const text = parts.map((part, index) => {
    const lineStart = offset;
    offset += part.length;
    if (index % 2 === 1 || (from !== to && !part.trim())) return part;
    const oldPrefix = part.match(/^ {0,3}#{1,6}(?:[\t ]+|$)/)?.[0] || '';
    if (oldPrefix === prefix) return part;
    edits.push({ from: lineStart, to: lineStart + oldPrefix.length, text: prefix });
    return prefix + part.slice(oldPrefix.length);
  }).join('');
  if (edits.length === 0) return null;

  const mapOffset = (position: number) => {
    let delta = 0;
    for (const edit of edits) {
      if (position < edit.from) break;
      if (position <= edit.to) return edit.from + delta + edit.text.length;
      delta += edit.text.length - (edit.to - edit.from);
    }
    return position + delta;
  };
  return {
    from: firstLine.from, to: lastLine.to, text,
    selection: { from: mapOffset(from), to: mapOffset(to) },
  };
}

/** One replacement gives every editor the same selection and undo semantics. */
export function applyHeadingLevel(editor: EditorController, level: number): void {
  const selection = editor.getSelection();
  const edit = createHeadingEdit(editor.getValue(), selection, level);
  if (edit) editor.replaceRange(edit.from, edit.to, edit.text, edit.selection);
  editor.focus();
}
