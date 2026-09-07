import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAutomaticEditorContext, formatAssistantInsertion } from '../src/utils/assistantEditor.ts';

test('builds automatic context for saved and unsaved documents', () => {
  const saved = buildAutomaticEditorContext({
    id: 'tab-saved',
    title: 'README.md',
    path: 'C:\\docs\\README.md',
    content: '# Notes',
  });
  const unsaved = buildAutomaticEditorContext({
    id: 'tab-unsaved',
    title: '未命名',
    path: null,
    content: 'draft',
  });

  assert.deepEqual(saved?.context, {
    label: 'README.md',
    path: 'C:\\docs\\README.md',
    content: '# Notes',
    selection: false,
  });
  assert.deepEqual(unsaved?.context, {
    label: '未命名',
    path: undefined,
    content: 'draft',
    selection: false,
  });
  assert.notEqual(saved?.key, unsaved?.key);
});

test('does not create context for an empty unnamed document', () => {
  assert.equal(buildAutomaticEditorContext({ id: 'empty', title: '未命名', path: null, content: '  ' }), null);
});

test('formats assistant insertion with a separator and avoids duplicate leading blank lines', () => {
  assert.equal(formatAssistantInsertion('Generated'), '---\n\nGenerated');
  assert.equal(formatAssistantInsertion('Generated', 'Original paragraph'), '\n\n---\n\nGenerated');
  assert.equal(formatAssistantInsertion('Generated', 'Original paragraph\n\n'), '---\n\nGenerated');
});
