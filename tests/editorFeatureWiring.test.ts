import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('smart pair setting is wired through editor settings and the settings panel', async () => {
  const storeSource = await readFile(new URL('../src/stores/appStore.ts', import.meta.url), 'utf8');
  const settingsSource = await readFile(new URL('../src/components/Settings/SettingsPanel.tsx', import.meta.url), 'utf8');

  assert.match(storeSource, /smart_pairs\?:\s*boolean/);
  assert.match(storeSource, /smart_pairs:\s*true/);
  assert.match(settingsSource, /smart_pairs/);
  assert.match(settingsSource, /启用自动配对与 Tab 跳出/);
  assert.match(settingsSource, /输入括号、引号和 Markdown 格式标记时自动补全；在代码区域中自动停用/);
});

test('desktop settings preserve smart pair choices and default old configs to enabled', async () => {
  const commandsSource = await readFile(new URL('../src-tauri/src/commands.rs', import.meta.url), 'utf8');

  assert.match(
    commandsSource,
    /#\[serde\(default\s*=\s*"default_smart_pairs"\)\]\s*pub smart_pairs:\s*bool/,
  );
  assert.match(commandsSource, /fn default_smart_pairs\(\)\s*->\s*bool\s*\{\s*true\s*\}/);
  assert.match(commandsSource, /editor:\s*EditorSettings\s*\{[\s\S]*?smart_pairs:\s*true,/);
});

test('editor routes supported empty-selection keys through smart pair decisions', async () => {
  const editorSource = await readFile(new URL('../src/components/Editor/Editor.tsx', import.meta.url), 'utf8');
  const smartPairsSource = await readFile(new URL('../src/utils/smartPairs.ts', import.meta.url), 'utf8');

  assert.match(editorSource, /import\s+\{\s*resolveSmartPair\s*\}\s+from\s+['"]\.\.\/\.\.\/utils\/smartPairs['"]/);
  assert.match(editorSource, /const\s+selection\s*=\s*controller\.getSelection\(\)/);
  assert.match(editorSource, /if\s*\(\s*!selection\.empty\s*\)\s*return/);
  assert.match(editorSource, /resolveSmartPair\(\s*\{[\s\S]*?value:\s*model\.getValue\(\)[\s\S]*?offset:\s*selection\.to[\s\S]*?key:\s*event\.browserEvent\.key[\s\S]*?enabled:\s*Boolean\(useAppStore\.getState\(\)\.settings\.editor\.smart_pairs\s*\?\?\s*true\)[\s\S]*?\}\s*\)/);
  assert.match(smartPairsSource, /SMART_KEYS\s*=\s*new Set\(\[\s*['"]Tab['"],\s*['"]Backspace['"]/);
  assert.match(editorSource, /if\s*\(\s*decision\.kind\s*===\s*['"]default['"]\s*\)\s*return/);
  assert.match(editorSource, /controller\.replaceRange\(decision\.from,\s*decision\.to,\s*decision\.text,\s*\{\s*from:\s*decision\.from\s*\+\s*decision\.cursor,\s*to:\s*decision\.from\s*\+\s*decision\.cursor,?\s*\}\s*\)/);
  assert.match(editorSource, /controller\.setSelection\(decision\.cursor\)/);
  assert.match(editorSource, /controller\.replaceRange\(decision\.from,\s*decision\.to,\s*['"]{2},\s*\{\s*from:\s*decision\.cursor,\s*to:\s*decision\.cursor,?\s*\}\s*\)/);
});
