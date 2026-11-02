import test from 'node:test';
import assert from 'node:assert/strict';
import { assessLargeDocument, modeForDocument, LARGE_DOCUMENT_LIMITS } from '../src/utils/largeDocument.ts';

test('small ordinary documents retain the selected mode', () => {
  const result = assessLargeDocument('# 标题\n\n正文和 Python。\n');
  assert.equal(result.recommended, false);
  assert.equal(modeForDocument('wysiwyg', 'wysiwyg', false), 'wysiwyg');
});

test('original file bytes and UTF-8 fallback both trigger size assessment at the boundary', () => {
  assert.equal(assessLargeDocument('短文', LARGE_DOCUMENT_LIMITS.bytes - 1).recommended, false);
  assert.ok(assessLargeDocument('短文', LARGE_DOCUMENT_LIMITS.bytes).reasons.includes('size'));
  assert.ok(assessLargeDocument('中'.repeat(Math.ceil(LARGE_DOCUMENT_LIMITS.bytes / 3))).reasons.includes('size'));
});

test('many small blocks trigger even below the file-size limit', () => {
  const result = assessLargeDocument(Array.from({ length: LARGE_DOCUMENT_LIMITS.blocks }, (_, i) => `## 标题 ${i}\n\n正文\n`).join(''));
  assert.ok(result.reasons.includes('blocks'));
  assert.ok(result.bytes < LARGE_DOCUMENT_LIMITS.bytes);
});

test('large tables trigger complexity protection and fences do not count as tables', () => {
  const rows = Array.from({ length: 550 }, () => '| 甲 | 乙 | 丙 | 丁 |').join('\n');
  const table = `| 一 | 二 | 三 | 四 |\n| --- | --- | --- | --- |\n${rows}`;
  assert.ok(assessLargeDocument(table).reasons.includes('tables'));
  assert.equal(assessLargeDocument(`\`\`\`md\n${table}\n\`\`\``).recommended, false);
});

test('automatic light mode follows each tab and restores the saved preference without changing it', () => {
  assert.equal(modeForDocument('wysiwyg', 'wysiwyg', true), 'source');
  assert.equal(modeForDocument('source', 'wysiwyg', false), 'wysiwyg');
  assert.equal(modeForDocument('source', 'split', false), 'split');
  assert.equal(modeForDocument('zen', 'split', false), 'zen');
  assert.equal(modeForDocument('source', 'wysiwyg', true), 'source');
});

test('block estimates handle CR-only and CRLF line endings', () => {
  for (const eol of ['\r', '\r\n']) {
    const text = Array.from({ length: LARGE_DOCUMENT_LIMITS.blocks }, () => `# 标题${eol}${eol}`).join('');
    assert.ok(assessLargeDocument(text).reasons.includes('blocks'));
  }
});

test('recognizes tables nested in blockquotes while leaving fenced code alone', () => {
  const table = ['> | 一 | 二 | 三 | 四 |', '> | --- | --- | --- | --- |', ...Array.from({ length: 510 }, () => '> | 甲 | 乙 | 丙 | 丁 |')].join('\n');
  assert.ok(assessLargeDocument(table).reasons.includes('tables'));
});
