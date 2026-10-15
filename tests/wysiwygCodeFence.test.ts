import { it } from 'node:test';
import assert from 'node:assert/strict';
import { extractFenceCode, extractFenceLanguage, extractFenceMarker, formatFence } from '../src/utils/wysiwyg/codeFence.ts';

it('extracts code and language from a fenced block', () => {
  const source = '```ts\nconst a = 1;\nconst b = 2;\n```';
  assert.equal(extractFenceLanguage(source), 'ts');
  assert.equal(extractFenceCode(source), 'const a = 1;\nconst b = 2;');
  assert.equal(extractFenceMarker(source), '```');
});

it('supports tilde fences, longer fences and indentation', () => {
  const source = '  ~~~~javascript\n  const a = 1;\n  ~~~~';
  assert.equal(extractFenceMarker(source), '~~~~');
  assert.equal(extractFenceLanguage(source), 'javascript');
  assert.equal(extractFenceCode(source), 'const a = 1;');
});

it('treats a fence without a language as plain text', () => {
  const source = '```\nplain\n```';
  assert.equal(extractFenceLanguage(source), '');
  assert.equal(extractFenceCode(source), 'plain');
});

it('rebuilds a fence from code and language, preserving style', () => {
  assert.equal(formatFence('const a = 1;', 'ts'), '```ts\nconst a = 1;\n```');
  assert.equal(formatFence('plain', ''), '```\nplain\n```');
  assert.equal(formatFence('indented', 'ts', { marker: '~~~~', indent: '  ' }), '  ~~~~ts\n  indented\n  ~~~~');
  // 内容里出现更长的围栏时自动加长，避免提前闭合
  assert.equal(formatFence('```', 'ts'), '````ts\n```\n````');
});
