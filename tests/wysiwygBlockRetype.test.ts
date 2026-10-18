import test from 'node:test';
import assert from 'node:assert/strict';
import { retypeBlock, type BlockRetypeTarget } from '../src/utils/wysiwyg/blockOps.ts';
import { splitMarkdownDocument } from '../src/utils/wysiwyg/blocks.ts';

test('all six heading levels retain the original text', () => {
  for (let level = 1; level <= 6; level++) {
    assert.equal(retypeBlock('正文', `heading${level}` as BlockRetypeTarget).source, `${'#'.repeat(level)} 正文`);
  }
});

test('task list conversions remove checkbox syntax instead of leaking it into text', () => {
  assert.equal(retypeBlock('- [x] 完成\n- [ ] 待办', 'paragraph').source, '完成\n待办');
  assert.equal(retypeBlock('完成\n待办', 'task').source, '- [ ] 完成\n- [ ] 待办');
  assert.equal(retypeBlock('- [x] 完成', 'task').source, '- [x] 完成');
});

test('code conversion uses a safe fence and preserves CRLF', () => {
  const result = retypeBlock('这里包含 ```\r\n下一行', 'code');
  assert.equal(result.source, '````\r\n这里包含 ```\r\n下一行\r\n````');
  assert.equal(splitMarkdownDocument(result.source).blocks.length, 1);
});
