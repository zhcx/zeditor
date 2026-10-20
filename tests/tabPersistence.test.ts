import test from 'node:test';
import assert from 'node:assert/strict';
import { applySavedTab, type PersistedTab } from '../src/utils/tabPersistence.ts';

const tabs: PersistedTab[] = [
  { id: 'first', title: 'first.md', path: 'C:\\docs\\first.md', content: 'first', modified: true },
  { id: 'second', title: '未命名', path: null, content: 'second', modified: true },
];

test('marks only the saved tab clean and applies its save path', () => {
  const result = applySavedTab(tabs, 'second', 'C:\\docs\\second.md', 'second');

  assert.deepEqual(result, [
    tabs[0],
    { ...tabs[1], title: 'second.md', path: 'C:\\docs\\second.md', modified: false },
  ]);
});

test('keeps a tab dirty when its content changes while saving', () => {
  const changedTabs = tabs.map(tab => tab.id === 'second' ? { ...tab, content: 'newer content' } : tab);
  const result = applySavedTab(changedTabs, 'second', 'C:\\docs\\second.md', 'second');

  assert.equal(result[1].modified, true);
  assert.equal(result[1].path, 'C:\\docs\\second.md');
});

test('refreshes the file fingerprint after a successful save without clearing newer edits', () => {
  const baseline = { size: 6, sha256: 'baseline' };
  const saved = { size: 6, sha256: 'saved' };
  const source = tabs.map(tab => tab.id === 'second' ? { ...tab, fileVersion: baseline } : tab);
  const result = applySavedTab(source, 'second', 'C:\\docs\\second.md', 'second', 'utf-8', saved);

  assert.equal(result[1].fileVersion, saved);
  assert.equal(result[1].modified, false);

  const editedWhileSaving = source.map(tab => tab.id === 'second' ? { ...tab, content: 'newer' } : tab);
  const newer = applySavedTab(editedWhileSaving, 'second', 'C:\\docs\\second.md', 'second', 'utf-8', saved);
  assert.equal(newer[1].fileVersion, saved);
  assert.equal(newer[1].modified, true);
});
