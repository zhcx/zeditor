import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { autoCompleteOptions } from '../src/utils/editorSuggestions.ts';

test('自动补全开启时同时启用快速建议、触发字符与当前文档单词', () => {
  assert.deepEqual(autoCompleteOptions(true), {
    quickSuggestions: true,
    suggestOnTriggerCharacters: true,
    wordBasedSuggestions: 'currentDocument',
    suggest: { showWords: true },
  });
});

test('自动补全关闭时连单词建议一起关闭，避免关闭后仍弹补全', () => {
  assert.deepEqual(autoCompleteOptions(false), {
    quickSuggestions: false,
    suggestOnTriggerCharacters: false,
    wordBasedSuggestions: 'off',
    suggest: { showWords: false },
  });
});

test('源码编辑器读取自动补全设置，并在设置变化后即时同步', async () => {
  const editor = await readFile(new URL('../src/components/Editor/Editor.tsx', import.meta.url), 'utf8');

  assert.match(editor, /import \{ autoCompleteOptions \} from '\.\.\/\.\.\/utils\/editorSuggestions'/);
  assert.match(editor, /\.\.\.autoCompleteOptions\(useAppStore\.getState\(\)\.settings\.editor\.auto_complete !== false\)/);
  assert.match(editor, /monacoRef\.current\?\.updateOptions\(autoCompleteOptions\(settings\.editor\.auto_complete !== false\)\)/);
  assert.doesNotMatch(editor, /quickSuggestions: false/);
  assert.doesNotMatch(editor, /suggestOnTriggerCharacters: false/);
});
