import { it } from 'node:test';
import assert from 'node:assert/strict';
import {
  contentStartOffset,
  mergeBlocks,
  setHeadingLevel,
  splitBlock,
  stripBlockPrefix,
  adjustListIndent,
} from '../src/utils/wysiwyg/blockOps.ts';

it('reports where the block content starts', () => {
  assert.equal(contentStartOffset('# 标题', 'heading'), 2);
  assert.equal(contentStartOffset('- [x] 任务', 'list'), 6);
  assert.equal(contentStartOffset('2. 第二项', 'list'), 3);
  assert.equal(contentStartOffset('> 引用文本', 'blockquote'), 2);
  assert.equal(contentStartOffset('普通段落', 'paragraph'), 0);
});

it('splits paragraphs, headings, quotes and list items on Enter', () => {
  assert.deepEqual(splitBlock({ source: '前半后半', kind: 'paragraph', caret: 2 }), {
    head: '前半',
    tail: '后半',
    separator: '\n\n',
  });
  assert.deepEqual(splitBlock({ source: '## 标题', kind: 'heading', caret: 7 }), {
    head: '## 标题',
    tail: '',
    separator: '\n\n',
  });
  assert.deepEqual(splitBlock({ source: '- 一项', kind: 'list', caret: 4 }), {
    head: '- 一项',
    tail: '- ',
    separator: '\n',
  });
  assert.deepEqual(splitBlock({ source: '3. 第三项', kind: 'list', caret: 6 }), {
    head: '3. 第三项',
    tail: '4. ',
    separator: '\n',
  });
  assert.deepEqual(splitBlock({ source: '> 引用', kind: 'blockquote', caret: 4 }), {
    head: '> 引用',
    tail: '> ',
    separator: '\n',
  });
});

it('strips the block prefix to fall back to a paragraph', () => {
  assert.deepEqual(stripBlockPrefix('## 标题', 'heading'), { source: '标题', caret: 0 });
  assert.deepEqual(stripBlockPrefix('- [ ] 任务', 'list'), { source: '任务', caret: 0 });
  assert.deepEqual(stripBlockPrefix('> 引用', 'blockquote'), { source: '引用', caret: 0 });
  assert.equal(stripBlockPrefix('普通段落', 'paragraph'), null);
});

it('merges two paragraphs at the junction', () => {
  assert.deepEqual(mergeBlocks('前一段', '后一段'), { source: '前一段后一段', caret: 3 });
  assert.equal(mergeBlocks('- 列表', '段落'), null);
});

it('changes heading level and clears it with level 0', () => {
  assert.deepEqual(setHeadingLevel('标题', 'paragraph', 3), { source: '### 标题', caret: 4 });
  assert.deepEqual(setHeadingLevel('### 标题', 'heading', 0), { source: '标题', caret: 0 });
  assert.deepEqual(setHeadingLevel('# 标题', 'heading', 2), { source: '## 标题', caret: 3 });
});

it('indents and outdents list items', () => {
  assert.deepEqual(adjustListIndent('- 一项', 'list', 'indent'), { source: '  - 一项', caret: 4 });
  assert.deepEqual(adjustListIndent('  - 一项', 'list', 'outdent'), { source: '- 一项', caret: 2 });
  assert.equal(adjustListIndent('- 一项', 'list', 'outdent'), null);
  assert.equal(adjustListIndent('段落', 'paragraph', 'indent'), null);
});
