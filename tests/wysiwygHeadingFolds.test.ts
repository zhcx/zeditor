import test from 'node:test';
import assert from 'node:assert/strict';
import { splitMarkdownDocument } from '../src/utils/wysiwyg/blocks.ts';
import { findHeadingFoldSections, foldedBlockIndexes } from '../src/utils/wysiwyg/headingFolds.ts';

test('heading sections cover every block until the next same-level heading', () => {
  const document = splitMarkdownDocument('# 一\n\n正文\n\n## 一之一\n\n细节\n\n# 二\n\n结尾');
  const sections = findHeadingFoldSections(document.blocks);

  assert.deepEqual(
    sections.map(({ level, title, index, lastIndex }) => ({ level, title, index, lastIndex })),
    [
      { level: 1, title: '一', index: 0, lastIndex: 3 },
      { level: 2, title: '一之一', index: 2, lastIndex: 3 },
      { level: 1, title: '二', index: 4, lastIndex: 5 },
    ],
  );
});

test('trailing blank paragraphs are not part of a folded section', () => {
  const document = splitMarkdownDocument('# 标题\n\n正文\n\n\n');
  const [section] = findHeadingFoldSections(document.blocks);
  assert.equal(section.index, 0);
  assert.equal(section.lastIndex, 1);
});

test('a heading without body has no fold section', () => {
  const document = splitMarkdownDocument('# 只有标题');
  assert.deepEqual(findHeadingFoldSections(document.blocks), []);
});

test('duplicate heading titles stay independent through their occurrence index', () => {
  const document = splitMarkdownDocument('## 小节\n\n一\n\n## 小节\n\n二');
  const sections = findHeadingFoldSections(document.blocks);
  assert.equal(sections.length, 2);
  assert.notEqual(sections[0].key, sections[1].key);
});

test('folded sections hide body blocks but keep the heading visible', () => {
  const document = splitMarkdownDocument('# 一\n\n正文\n\n# 二\n\n结尾');
  const sections = findHeadingFoldSections(document.blocks);
  const hidden = foldedBlockIndexes(sections, [sections[0].key]);
  assert.deepEqual([...hidden].sort((left, right) => left - right), [1]);
});
