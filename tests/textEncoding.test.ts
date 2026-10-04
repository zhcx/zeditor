import test from 'node:test';
import assert from 'node:assert/strict';
import { TEXT_ENCODINGS, isTextEncoding, encodingLabel } from '../src/utils/textEncoding.ts';
import { applySavedTab } from '../src/utils/tabPersistence.ts';

test('编码列表涵盖 Unicode、中文和常用旧编码，名称唯一', () => {
  assert.equal(new Set(TEXT_ENCODINGS.map(item => item.value)).size, TEXT_ENCODINGS.length);
  for (const name of ['utf-8', 'utf-8-bom', 'utf-16le', 'utf-16be', 'gbk', 'gb18030', 'big5', 'shift-jis', 'windows-1252']) assert.equal(isTextEncoding(name), true);
  assert.equal(isTextEncoding('unknown'), false);
  assert.equal(encodingLabel(), 'UTF-8');
});

test('保存期间切换编码时，文档仍保持未保存状态', () => {
  const tabs = [{ id: 'a', title: 'a.md', path: 'a.md', content: '中文', modified: true, encoding: 'gbk' }];
  assert.equal(applySavedTab(tabs, 'a', 'a.md', '中文', 'utf-8')[0].modified, true);
  assert.equal(applySavedTab(tabs, 'a', 'a.md', '中文', 'gbk')[0].modified, false);
});
