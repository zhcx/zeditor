import assert from 'node:assert/strict';
import test from 'node:test';

type HeadingEdit = { from: number; to: number; text: string; selection: { from: number; to: number } };
const formatting = await import('../src/utils/headingFormatting.ts').catch(() => ({})) as {
  createHeadingEdit?: (source: string, selection: { from: number; to: number }, level: number) => HeadingEdit | null;
};

const convert = (source: string, from: number, to: number, level: number) => {
  const edit = formatting.createHeadingEdit?.(source, { from, to }, level);
  assert.ok(edit, 'heading conversion must produce a replacement');
  return { source: source.slice(0, edit.from) + edit.text + source.slice(edit.to), selection: edit.selection };
};

test('converts selected text in its existing line without inserting an empty heading', () => {
  assert.deepEqual(convert('前文\n\n标题文字\n\n后文', 4, 8, 2), {
    source: '前文\n\n## 标题文字\n\n后文', selection: { from: 7, to: 11 },
  });
});

test('partial selection formats the whole line and retains selection on the same text', () => {
  assert.deepEqual(convert('句首标题文字句尾', 2, 6, 3), {
    source: '### 句首标题文字句尾', selection: { from: 6, to: 10 },
  });
});

test('formats all selected nonempty lines and excludes an endpoint at the next line start', () => {
  assert.equal(convert('第一段\n\n第二段\n\n第三段', 0, 10, 2).source, '## 第一段\n\n## 第二段\n\n第三段');
});

test('replaces an existing heading marker and preserves CRLF', () => {
  assert.deepEqual(convert('# 标题\r\n\r\n正文', 2, 4, 4), {
    source: '#### 标题\r\n\r\n正文', selection: { from: 5, to: 7 },
  });
});

test('collapsed caret converts the current line without losing its position', () => {
  assert.deepEqual(convert('普通文字', 2, 2, 1), { source: '# 普通文字', selection: { from: 4, to: 4 } });
  assert.deepEqual(convert('', 0, 0, 2), { source: '## ', selection: { from: 3, to: 3 } });
});

test('supports all six levels, removing headings and avoiding no-op edits', () => {
  for (let level = 1; level <= 6; level++) assert.equal(convert('标题', 0, 2, level).source, `${'#'.repeat(level)} 标题`);
  assert.equal(convert('### 标题', 4, 6, 0).source, '标题');
  assert.equal(formatting.createHeadingEdit?.('## 标题', { from: 3, to: 5 }, 2), null);
  assert.equal(formatting.createHeadingEdit?.('标题', { from: 0, to: 2 }, 7), null);
});
