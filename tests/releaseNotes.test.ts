import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getReleaseNotes } from '../src/utils/releaseNotes.ts';

it('selects the installed version rather than an unreleased or newer section', () => {
  const log = '# 更新日志\n\n## 未发布\n\n新工作\n\n## v0.6.60（日期）\n\n新版\n\n## v0.6.6（日期）\n\n### 修复\n\n- 本版内容\n\n## v0.6.3（日期）\n\n旧内容';
  for (const eol of ['\n', '\r\n']) {
    assert.equal(getReleaseNotes(log.replace(/\n/g, eol), '0.6.6'), `### 修复${eol}${eol}- 本版内容`);
  }
  assert.equal(getReleaseNotes(log, '0.0.0'), null);
});

it('has release notes for the actual application version', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const log = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  const notes = getReleaseNotes(log, pkg.version);
  assert.ok(notes);
  assert.doesNotMatch(notes, /^## v/m);
});
