import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSmartPair,
  type SmartPairDecision,
  type SmartPairInput,
} from '../src/utils/smartPairs.ts';

const decide = (value: string, offset: number, key: string, enabled = true): SmartPairDecision => {
  const input: SmartPairInput = { value, offset, key, enabled };
  return resolveSmartPair(input);
};

test('inserts ordinary, CJK, curly quote and backtick pairs', () => {
  for (const [key, text] of [
    ['(', '()'], ['[', '[]()'], ['{', '{}'], ['"', '""'], ["'", "''"], ['`', '``'],
    ['「', '「」'], ['『', '『』'], ['（', '（）'], ['【', '【】'], ['《', '《》'], ['〈', '〈〉'],
    ['“', '“”'], ['‘', '‘’'],
  ] as const) {
    const action = decide('', 0, key);
    assert.deepEqual(action, { kind: 'insert', from: 0, to: 0, text, cursor: 1 });
  }
});

test('returns an absolute cursor when inserting after existing text', () => {
  assert.deepEqual(decide('abc', 3, '('), {
    kind: 'insert', from: 3, to: 3, text: '()', cursor: 4,
  });
});

test('creates Markdown emphasis pairs and upgrades them to double markers', () => {
  assert.deepEqual(decide('', 0, '*'), { kind: 'insert', from: 0, to: 0, text: '**', cursor: 1 });
  assert.deepEqual(decide('**', 1, '*'), { kind: 'replace', from: 0, to: 2, text: '****', cursor: 2 });
  assert.deepEqual(decide('', 0, '_'), { kind: 'insert', from: 0, to: 0, text: '__', cursor: 1 });
  assert.deepEqual(decide('__', 1, '_'), { kind: 'replace', from: 0, to: 2, text: '____', cursor: 2 });
  assert.deepEqual(decide('', 0, '~'), { kind: 'insert', from: 0, to: 0, text: '~~', cursor: 1 });
  assert.deepEqual(decide('~~', 1, '~'), { kind: 'replace', from: 0, to: 2, text: '~~~~', cursor: 2 });
});

test('inserts a link template and tabs through its two destinations', () => {
  assert.deepEqual(decide('', 0, '['), { kind: 'insert', from: 0, to: 0, text: '[]()', cursor: 1 });
  assert.deepEqual(decide('[text]()', 5, 'Tab'), { kind: 'move', cursor: 7 });
  assert.deepEqual(decide('[text](url)', 10, 'Tab'), { kind: 'move', cursor: 11 });
});

test('does not tab through links whose opening bracket is escaped', () => {
  const escapedEmpty = '\\[text]()';
  const escapedUrl = '\\[text](url)';
  assert.deepEqual(decide(escapedEmpty, escapedEmpty.indexOf(']'), 'Tab'), { kind: 'default' });
  // 转义方括号使链接失效，圆括号退化为普通括号：光标在闭合括号前仍按
  // 括号跳出前移一位，但不做链接字段导航。
  assert.deepEqual(decide(escapedUrl, escapedUrl.length - 1, 'Tab'), {
    kind: 'move', cursor: escapedUrl.length,
  });

  const evenEscapes = '\\\\[text]()';
  const labelEnd = evenEscapes.indexOf(']');
  assert.deepEqual(decide(evenEscapes, labelEnd, 'Tab'), { kind: 'move', cursor: labelEnd + 2 });
});

test('deletes empty pairs with Backspace', () => {
  assert.deepEqual(decide('()', 1, 'Backspace'), { kind: 'delete', from: 0, to: 2, cursor: 0 });
  assert.deepEqual(decide('[]()', 1, 'Backspace'), { kind: 'delete', from: 0, to: 4, cursor: 0 });
  assert.deepEqual(decide('**', 1, 'Backspace'), { kind: 'delete', from: 0, to: 2, cursor: 0 });
});

test('does not intercept code blocks, non-empty inline code or disabled settings', () => {
  assert.deepEqual(decide('```\n(', 5, '('), { kind: 'default' });
  assert.deepEqual(decide('`code`', 5, '('), { kind: 'default' });
  assert.deepEqual(decide('', 0, '(', false), { kind: 'default' });
  assert.deepEqual(decide('(', 1, 'Tab', false), { kind: 'default' });
});

test('allows Tab and Backspace to finish an empty auto-created backtick pair', () => {
  assert.deepEqual(decide('``', 1, 'Tab'), { kind: 'move', cursor: 2 });
  assert.deepEqual(decide('``', 1, 'Backspace'), { kind: 'delete', from: 0, to: 2, cursor: 0 });
  assert.deepEqual(decide('```', 1, 'Tab'), { kind: 'default' });
  assert.deepEqual(decide('```', 1, 'Backspace'), { kind: 'default' });
});

test('closes fenced code only with the same marker and sufficient run length', () => {
  for (const value of ['````\n```\n', '```\n~~~\n']) {
    assert.deepEqual(decide(value, value.length, '('), { kind: 'default' });
  }

  const trailingText = '```\n``` trailing\n';
  assert.deepEqual(decide(trailingText, trailingText.length, '('), { kind: 'default' });

  const indentedCode = '    ```\n';
  assert.deepEqual(decide(indentedCode, indentedCode.length, '('), {
    kind: 'insert', from: indentedCode.length, to: indentedCode.length,
    text: '()', cursor: indentedCode.length + 1,
  });

  const closed = ' ```lang\n  `````   \n';
  assert.deepEqual(decide(closed, closed.length, '('), {
    kind: 'insert', from: closed.length, to: closed.length, text: '()', cursor: closed.length + 1,
  });
});

test('does not intercept Tab or Backspace in fenced and non-empty inline code', () => {
  assert.deepEqual(decide('```\n[]()', 5, 'Tab'), { kind: 'default' });
  assert.deepEqual(decide('```\n()', 5, 'Backspace'), { kind: 'default' });
  assert.deepEqual(decide('`()`', 2, 'Backspace'), { kind: 'default' });
});

test('does not treat two backticks inside code as an empty auto-created pair', () => {
  for (const key of ['Tab', 'Backspace']) {
    assert.deepEqual(decide('```\n``\n```', 5, key), { kind: 'default' });
    assert.deepEqual(decide('`a``b`', 3, key), { kind: 'default' });
  }
});

test('matches inline code delimiters by backtick run length', () => {
  assert.deepEqual(decide('`code`', 1, '('), { kind: 'default' });
  assert.deepEqual(decide('``code``', 2, '('), { kind: 'default' });
  assert.deepEqual(decide('``code``', 6, '('), { kind: 'default' });
  assert.deepEqual(decide('``()``', 3, 'Backspace'), { kind: 'default' });

  const unmatched = '``code`';
  assert.deepEqual(decide(unmatched, unmatched.length, '('), { kind: 'default' });
});

test('ignores Tab near incomplete link-like text', () => {
  assert.deepEqual(decide(']()', 0, 'Tab'), { kind: 'default' });
  // 不是完整链接，但光标紧邻 `(` 的闭合括号之前，按括号跳出前移一位。
  assert.deepEqual(decide('](x)', 3, 'Tab'), { kind: 'move', cursor: 4 });
});

test('tabs out of brackets and quotes at the closing character', () => {
  assert.deepEqual(decide('()', 1, 'Tab'), { kind: 'move', cursor: 2 });
  assert.deepEqual(decide('(abc)', 4, 'Tab'), { kind: 'move', cursor: 5 });
  assert.deepEqual(decide('[item]', 5, 'Tab'), { kind: 'move', cursor: 6 });
  assert.deepEqual(decide('{key}', 4, 'Tab'), { kind: 'move', cursor: 5 });
  // 开闭同形的引号
  assert.deepEqual(decide('"quoted"', 7, 'Tab'), { kind: 'move', cursor: 8 });
  assert.deepEqual(decide("'quoted'", 7, 'Tab'), { kind: 'move', cursor: 8 });
  // 中日韩括号与弯引号
  assert.deepEqual(decide('「字」', 2, 'Tab'), { kind: 'move', cursor: 3 });
  assert.deepEqual(decide('『字』', 2, 'Tab'), { kind: 'move', cursor: 3 });
  assert.deepEqual(decide('（文）', 2, 'Tab'), { kind: 'move', cursor: 3 });
  assert.deepEqual(decide('【项】', 2, 'Tab'), { kind: 'move', cursor: 3 });
  assert.deepEqual(decide('《书》', 2, 'Tab'), { kind: 'move', cursor: 3 });
  assert.deepEqual(decide('“引”', 2, 'Tab'), { kind: 'move', cursor: 3 });
  assert.deepEqual(decide('‘引’', 2, 'Tab'), { kind: 'move', cursor: 3 });
});

test('tabs out of only the innermost nested bracket', () => {
  assert.deepEqual(decide('((n))', 3, 'Tab'), { kind: 'move', cursor: 4 });
  assert.deepEqual(decide('(a(b))', 4, 'Tab'), { kind: 'move', cursor: 5 });
  // 内层的方括号不干扰外层圆括号的跳出
  assert.deepEqual(decide('(a[b]c)', 6, 'Tab'), { kind: 'move', cursor: 7 });
});

test('leaves the cursor untouched when no bracket precedes it', () => {
  assert.deepEqual(decide('(abc)', 2, 'Tab'), { kind: 'default' });
  assert.deepEqual(decide('abc', 3, 'Tab'), { kind: 'default' });
  assert.deepEqual(decide('a)bc', 1, 'Tab'), { kind: 'default' });
  assert.deepEqual(decide('(a"b', 3, 'Tab'), { kind: 'default' });
});

test('does not tab out of escaped brackets or quotes', () => {
  // 开符被转义：不构成可配对的括号
  assert.deepEqual(decide('\\(a\\)', 4, 'Tab'), { kind: 'default' });
  // 闭合符被转义：是字面量，不跳出
  assert.deepEqual(decide('「a\\」', 3, 'Tab'), { kind: 'default' });
  // 引号同样按转义处理
  assert.deepEqual(decide('\\"a\\"', 4, 'Tab'), { kind: 'default' });
});

test('does not tab out across line boundaries', () => {
  const multiline = '(abc\ndef)';
  assert.deepEqual(decide(multiline, multiline.indexOf(')'), 'Tab'), { kind: 'default' });
});

test('tabs out of Markdown inline formatting ranges', () => {
  assert.deepEqual(decide('**bold**', 6, 'Tab'), { kind: 'move', cursor: 8 });
  assert.deepEqual(decide('**bold text**', 6, 'Tab'), { kind: 'move', cursor: 13 });
  assert.deepEqual(decide('*italic*', 7, 'Tab'), { kind: 'move', cursor: 8 });
  assert.deepEqual(decide('_em_', 3, 'Tab'), { kind: 'move', cursor: 4 });
  assert.deepEqual(decide('~~gone~~', 6, 'Tab'), { kind: 'move', cursor: 8 });
  assert.deepEqual(decide('==mark==', 6, 'Tab'), { kind: 'move', cursor: 8 });
  assert.deepEqual(decide('x^2^', 3, 'Tab'), { kind: 'move', cursor: 4 });
  // 光标在格式区间内的任意位置都会跳出到闭合标记之后
  assert.deepEqual(decide('**bold**', 4, 'Tab'), { kind: 'move', cursor: 8 });
});

test('keeps plain text with spaced markers untouched', () => {
  // 开标记之后或闭标记之前是空白，不符合 CommonMark 分隔符规则，不视为区间。
  assert.deepEqual(decide('2 * 3 * 4', 6, 'Tab'), { kind: 'default' });
  assert.deepEqual(decide('a * b * c', 6, 'Tab'), { kind: 'default' });
  assert.deepEqual(decide('a ~~ b ~~ c', 8, 'Tab'), { kind: 'default' });
});

test('prefers bracket escape over formatting escape', () => {
  // 由内而外：先跳过最内层的括号，再退出加粗标记。
  const boldBracket = '**bold (text)**';
  assert.deepEqual(decide(boldBracket, boldBracket.indexOf(')'), 'Tab'), {
    kind: 'move', cursor: boldBracket.indexOf(')') + 1,
  });
});

test('tabs through link fields in source mode', () => {
  const link = '[text](url)';
  const labelEnd = link.indexOf(']');
  const urlStart = link.indexOf('(') + 1;
  const urlEnd = link.lastIndexOf(')');
  assert.deepEqual(decide(link, labelEnd, 'Tab'), { kind: 'move', cursor: urlStart });
  assert.deepEqual(decide(link, urlStart + 1, 'Tab'), { kind: 'move', cursor: urlEnd + 1 });
  assert.deepEqual(decide(link, urlEnd, 'Tab'), { kind: 'move', cursor: urlEnd + 1 });
});

test('disables Tab escape inside fenced and inline code', () => {
  assert.deepEqual(decide('```\n(a)\n```', 6, 'Tab'), { kind: 'default' });
  assert.deepEqual(decide('`(a)`', 3, 'Tab'), { kind: 'default' });
  assert.deepEqual(decide('**(`x`)**', 4, 'Tab'), { kind: 'default' });
});

test('rejects invalid offsets and ignores unrelated keys', () => {
  for (const offset of [-1, 0.5, 2]) {
    assert.deepEqual(decide('x', offset, '('), { kind: 'default' });
  }
  assert.deepEqual(decide('```\n', 4, 'a'), { kind: 'default' });
});
