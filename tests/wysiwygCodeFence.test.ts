import { it } from 'node:test';
import assert from 'node:assert/strict';
import { extractFenceCode, extractFenceInfo, extractFenceLanguage, extractFenceMarker, formatFence, withFenceLanguage } from '../src/utils/wysiwyg/codeFence.ts';

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

it('reads CRLF fences without exposing the closing marker as code', () => {
  const source = '```ts\r\nconst a = 1;\r\n```';
  assert.equal(extractFenceCode(source), 'const a = 1;');
  assert.equal(extractFenceLanguage(source), 'ts');
});

it('keeps blank lines at the end of code while editing', () => {
  const code = 'const a = 1;\n\n';
  assert.equal(formatFence(code, 'ts'), '```ts\nconst a = 1;\n\n\n```');
  assert.equal(extractFenceCode(formatFence(code, 'ts')), code);
});

it('does not treat a shorter or different closing marker as the fence end', () => {
  for (const source of ['~~~~\ncode\n~~~', '```\ncode\n~~~']) {
    assert.equal(extractFenceCode(source), 'code\n~~~');
  }
});

it('rebuilds a fence from code and language, preserving style', () => {
  assert.equal(formatFence('const a = 1;', 'ts'), '```ts\nconst a = 1;\n```');
  assert.equal(formatFence('plain', ''), '```\nplain\n```');
  assert.equal(formatFence('indented', 'ts', { marker: '~~~~', indent: '  ' }), '  ~~~~ts\n  indented\n  ~~~~');
  // 内容里出现更长的围栏时自动加长，避免提前闭合
  assert.equal(formatFence('```', 'ts'), '````ts\n```\n````');
});

it('keeps the rest of the fence info string when writing back', () => {
  // 回归：编辑代码块时 `title=` / 行高亮等属性曾被丢掉。
  const withTitle = '```js title="示例"\nconst a = 1;\n```';
  assert.equal(extractFenceInfo(withTitle), 'js title="示例"');
  assert.equal(extractFenceLanguage(withTitle), 'js');
  assert.equal(
    formatFence(extractFenceCode(withTitle), 'js', {
      info: extractFenceInfo(withTitle),
      marker: extractFenceMarker(withTitle),
    }),
    withTitle,
  );

  const withHighlight = '```ts {1,3}\nconst b = 2;\n```';
  assert.equal(extractFenceInfo(withHighlight), 'ts {1,3}');
  assert.equal(
    formatFence('const b = 3;', 'ts', { info: extractFenceInfo(withHighlight) }),
    '```ts {1,3}\nconst b = 3;\n```',
  );

  // 切换语言只替换第一个词，其余属性保留
  assert.equal(withFenceLanguage('js title="示例"', 'ts'), 'ts title="示例"');
  assert.equal(withFenceLanguage('js {1,3}', 'python'), 'python {1,3}');
  assert.equal(withFenceLanguage('js', ''), '');
  assert.equal(withFenceLanguage('', 'ts'), 'ts');
});
