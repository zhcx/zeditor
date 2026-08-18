import assert from 'node:assert/strict';
import test from 'node:test';
import { groupSuperTagRecords } from '../src/utils/superTag.ts';

test('groups Markdown records by the Frontmatter class field', () => {
  const groups = groupSuperTagRecords([
    {
      path: 'movies/a.md',
      content: '---\ntitle: Movie A\nclass: movies\nyear: 2024\n---\n',
    },
    {
      path: 'movies/b.md',
      content: '---\ntitle: Movie B\nclass: movies\nyear: 2025\n---\n',
    },
    {
      path: 'notes/note.md',
      content: '---\ntitle: Plain note\n---\n',
    },
  ]);

  assert.deepEqual(groups.map((group) => group.className), ['movies']);
  assert.deepEqual(groups[0].records.map((record) => record.title), ['Movie A', 'Movie B']);
  assert.equal(groups[0].records[1].fields.year, 2025);
});

test('supports typed class fields and skips malformed or unclassified records', () => {
  const groups = groupSuperTagRecords([
    {
      path: 'books/a.md',
      content: '---\nclass:\n  type: text\n  value: books\ntitle: Typed book\n---\n',
    },
    { path: 'broken.md', content: '---\nclass: [broken\n---\n' },
    { path: 'plain.md', content: '# Plain' },
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].className, 'books');
  assert.equal(groups[0].records[0].title, 'Typed book');
});
