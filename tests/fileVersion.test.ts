import assert from 'node:assert/strict';
import test from 'node:test';
import { fileVersionsMatch } from '../src/utils/fileVersion.ts';

test('file fingerprints match only when both byte length and digest are unchanged', () => {
  const original = { size: 18, sha256: 'abc123' };
  assert.equal(fileVersionsMatch(original, { size: 18, sha256: 'abc123' }), true);
  assert.equal(fileVersionsMatch(original, { size: 19, sha256: 'abc123' }), false);
  assert.equal(fileVersionsMatch(original, { size: 18, sha256: 'def456' }), false);
  assert.equal(fileVersionsMatch(original, null), false);
  assert.equal(fileVersionsMatch(null, null), true);
});
