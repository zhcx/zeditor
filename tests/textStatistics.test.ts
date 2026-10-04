import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateTextStatistics, formatTextStatistics } from '../src/utils/textStatistics.ts';

test('merges Chinese characters and English words into one word count', () => {
  const statistics = calculateTextStatistics('你好 MarkItDown editor');

  assert.deepEqual(statistics, {
    wordCount: 4,
    totalCharacters: 20,
  });
});

test('treats an uninterrupted English sequence as one word', () => {
  assert.deepEqual(calculateTextStatistics('d'.repeat(244)), {
    wordCount: 1,
    totalCharacters: 244,
  });
});

test('counts apostrophes and hyphens inside English words without splitting them', () => {
  assert.equal(calculateTextStatistics("Markdown's user-friendly").wordCount, 2);
});

test('counts a Unicode emoji as one total character', () => {
  assert.equal(calculateTextStatistics('中👍A').totalCharacters, 3);
});

test('counts supplementary Han characters and unpaired surrogates consistently', () => {
  assert.deepEqual(calculateTextStatistics('𠮷😀\uD800A\uDC00'), { wordCount: 2, totalCharacters: 5 });
});

test('formats the merged word count and total character count only', () => {
  assert.equal(formatTextStatistics(''), '0 字, 0 字符');
  assert.equal(formatTextStatistics('中文 hello'), '3 字, 8 字符');
});
