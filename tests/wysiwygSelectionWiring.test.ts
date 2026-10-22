import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('WYSIWYG text blocks share one editing host so selection can cross blocks', async () => {
  const editor = await readFile(new URL('../src/components/Wysiwyg/WysiwygEditor.tsx', import.meta.url), 'utf8');

  assert.match(editor, /<article\s+className="wysiwyg-document preview-document markdown-body"\s+contentEditable=\{true\}\s+suppressContentEditableWarning/);
  assert.match(editor, /onInput=\{handleSurfaceInput\}/);
  assert.match(editor, /onKeyDown=\{handleSurfaceKeyDown\}/);
  assert.match(editor, /onCut=\{handleSurfaceCut\}/);
  assert.match(editor, /contentEditable=\{editable\}/);
});
