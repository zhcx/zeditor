import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSmartPair, type SmartPairDecision } from '../src/utils/smartPairs.ts';

const decide = (value: string, offset: number, key: string, enabled = true): SmartPairDecision =>
  resolveSmartPair({ value, offset, key, enabled });

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
});
