import { it } from 'node:test';
import assert from 'node:assert/strict';
import {
  findBlockReferenceLine,
  findHeadingForWikiAnchor,
  formatWikiLink,
  matchWikiLinkAt,
  parseWikiLink,
  wikiLinkDisplayText,
} from '../src/utils/wikiLinks.ts';

it('parses Obsidian wiki link forms', () => {
  assert.deepEqual(parseWikiLink('[[笔记]]'), { target: '笔记', anchor: null, label: null });
  assert.deepEqual(parseWikiLink('[[notes/卡片|卡片笔记]]'), { target: 'notes/卡片', anchor: null, label: '卡片笔记' });
  assert.deepEqual(parseWikiLink('[[笔记#标题]]'), { target: '笔记', anchor: '标题', label: null });
  assert.deepEqual(parseWikiLink('[[笔记#标题|别名]]'), { target: '笔记', anchor: '标题', label: '别名' });
  // 省略笔记名表示当前文档内的锚点。
  assert.deepEqual(parseWikiLink('[[#本文标题]]'), { target: '', anchor: '本文标题', label: null });
  assert.equal(parseWikiLink('[[]]'), null);
  assert.equal(parseWikiLink('[[|别名]]'), null);
  assert.equal(parseWikiLink('[[a[b]]'), null);
});

it('uses aliases and anchor text for display', () => {
  assert.equal(wikiLinkDisplayText(parseWikiLink('[[笔记|别名]]')!), '别名');
  assert.equal(wikiLinkDisplayText(parseWikiLink('[[笔记#标题]]')!), '笔记 > 标题');
  assert.equal(wikiLinkDisplayText(parseWikiLink('[[#本文标题]]')!), '本文标题');
});

it('rebuilds wiki source without losing aliases', () => {
  assert.equal(formatWikiLink({ target: '笔记', anchor: null, label: null }), '[[笔记]]');
  assert.equal(formatWikiLink({ target: '笔记', anchor: '标题', label: null }), '[[笔记#标题]]');
  assert.equal(formatWikiLink({ target: '笔记', anchor: null, label: null }, '别称'), '[[笔记|别称]]');
  // 与原显示相同就不写别名；含语法字符的文字退回默认显示。
  assert.equal(formatWikiLink({ target: '笔记', anchor: null, label: null }, '笔记'), '[[笔记]]');
  assert.equal(formatWikiLink({ target: '笔记', anchor: null, label: null }, 'a|b'), '[[笔记]]');
});

it('finds headings and block references for anchors', () => {
  const content = '# 第一章\n\n正文\n\n## 1. 小节\n\n- 项 ^abc123\n';
  assert.equal(findHeadingForWikiAnchor(content, '1. 小节')?.line, 5);
  // 标题锚点归一化后与章节号一致；同名时取文档中第一个。
  assert.equal(findHeadingForWikiAnchor(content, '1')?.line, 1);
  assert.equal(findHeadingForWikiAnchor(content, '不存在的标题'), null);
  assert.equal(findBlockReferenceLine(content, '^abc123'), 7);
  assert.equal(findBlockReferenceLine(content, '^missing'), null);
});

it('matches a wiki link just closed before the caret', () => {
  const text = '前缀[[笔记#标题|别名]]';
  const match = matchWikiLinkAt(text, text.length);
  assert.equal(match?.parts.target, '笔记');
  assert.equal(match?.parts.anchor, '标题');
  assert.equal(match?.parts.label, '别名');
  assert.equal(match?.from, 2);
  // 还没补上第二个 `]` 时不转换。
  assert.equal(matchWikiLinkAt(text, text.length - 1), null);
  // 内容里出现方括号不是合法链接。
  assert.equal(matchWikiLinkAt('[[a]b]]', 7), null);
});
