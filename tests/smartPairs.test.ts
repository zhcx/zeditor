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
  assert.deepEqual(decide(escapedUrl, escapedUrl.length - 1, 'Tab'), { kind: 'default' });

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
  assert.deepEqual(decide('](x)', 3, 'Tab'), { kind: 'default' });
});

test('rejects invalid offsets and ignores unrelated keys', () => {
  for (const offset of [-1, 0.5, 2]) {
    assert.deepEqual(decide('x', offset, '('), { kind: 'default' });
  }
  assert.deepEqual(decide('```\n', 4, 'a'), { kind: 'default' });
});
