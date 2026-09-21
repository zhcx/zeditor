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
