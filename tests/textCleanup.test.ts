import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanText } from '../src/utils/textCleanup.ts';

test('trims line-end whitespace and collapses consecutive blank lines', () => {
  const result = cleanText('title  \n\t\n\nbody');

  assert.equal(result.content, 'title\n\nbody');
  assert.equal(result.changed, true);
});

test('preserves CRLF line endings while collapsing blank lines', () => {
  const result = cleanText('a\r\n\r\n\r\n b\r\n');

  assert.equal(result.content, 'a\r\n\r\n b\r\n');
});

test('trims Unicode whitespace at the end of each line', () => {
  const result = cleanText('a\u00a0\n\u2003\nb');

  assert.equal(result.content, 'a\n\nb');
});

test('reports clean text as unchanged', () => {
  const result = cleanText('already\n\nclean');

  assert.equal(result.content, 'already\n\nclean');
  assert.equal(result.changed, false);
});

test('maps the source offset of body to its cleaned offset', () => {
  const source = 'title  \n\t\n\nbody';
  const result = cleanText(source);

  assert.equal(result.mapOffset(source.indexOf('body')), result.content.indexOf('body'));
});

test('clamps mapped offsets to the source and cleaned bounds', () => {
  const result = cleanText('title  \n\nbody');

  assert.equal(result.mapOffset(-1), 0);
  assert.equal(result.mapOffset(Number.POSITIVE_INFINITY), result.content.length);
});
