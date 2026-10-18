import { it } from 'node:test';
import assert from 'node:assert/strict';
import {
  findFootnoteReferenceAt,
  matchFootnoteAt,
  parseFootnoteDefinitions,
} from '../src/utils/footnotes.ts';

it('parses single-line and indented multi-line definitions', () => {
  const definitions = parseFootnoteDefinitions('正文\n\n[^1]: 第一行\n    第二行\n\n    第三行\n\n[^2]: 另一条\n');
  assert.equal(definitions.get('1')?.content, '第一行\n第二行\n\n第三行');
  assert.equal(definitions.get('1')?.line, 3);
  assert.equal(definitions.get('2')?.content, '另一条');
});

it('ignores definitions inside fenced code and duplicate names', () => {
  const definitions = parseFootnoteDefinitions('```\n[^1]: 不是定义\n```\n\n[^1]: 真正的定义\n[^1]: 重复\n');
  assert.equal(definitions.get('1')?.content, '真正的定义');
  assert.equal(definitions.size, 1);
});

it('locates references but skips definition lines', () => {
  const text = '引用[^a]\n\n[^b]: 定义';
  assert.deepEqual(findFootnoteReferenceAt(text, 3), { name: 'a', from: 2, to: 6 });
  assert.equal(findFootnoteReferenceAt(text, text.indexOf('[^b]') + 1), null);
});

it('matches a reference just closed at the caret', () => {
  assert.deepEqual(matchFootnoteAt('正文[^注]', 6), { name: '注', from: 2, to: 6 });
  // 行首的 `[^注]:` 是定义，不转换。
  assert.equal(matchFootnoteAt('[^注]', 4), null);
  assert.equal(matchFootnoteAt('正文[^注', 5), null);
});

it('does not treat an info-bearing fence inside code as its closing fence', () => {
  const definitions = parseFootnoteDefinitions('````md\n```` not a closing fence\n[^fake]: 假定义\n````\n\n[^real]: 真定义');
  assert.equal(definitions.has('fake'), false);
  assert.equal(definitions.get('real')?.content, '真定义');
});
