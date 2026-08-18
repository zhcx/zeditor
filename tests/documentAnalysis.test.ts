import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseDocumentAnalysis,
  parseFrontmatter,
  parseDocumentReferences,
  updateFrontmatterField,
  type DocumentReference,
} from '../src/utils/documentAnalysis.ts';

test('parses shorthand and typed frontmatter without consuming the markdown body', () => {
  const source = `---
title: Research note
year: 2024
tags: [paper, ai]
done: false
status:
  type: select
  label: Status
  value: Reading
  options: [Todo, Reading, Done]
---

# Findings`;

  const result = parseFrontmatter(source);

  assert.equal(result.present, true);
  assert.equal(result.bodyStart, source.indexOf('# Findings'));
  assert.equal(result.values.title, 'Research note');
  assert.equal(result.values.year, 2024);
  assert.deepEqual(result.values.tags, ['paper', 'ai']);
  assert.equal(result.fields.find((field) => field.key === 'year')?.type, 'number');
  assert.equal(result.fields.find((field) => field.key === 'done')?.type, 'checkbox');
  assert.equal(result.fields.find((field) => field.key === 'status')?.type, 'select');
  assert.deepEqual(result.fields.find((field) => field.key === 'status')?.options, ['Todo', 'Reading', 'Done']);
  assert.equal(result.diagnostics.length, 0);
});

test('keeps malformed frontmatter diagnosable instead of treating it as document content', () => {
  const result = parseFrontmatter('---\ntitle: [broken\n---\n# Body');

  assert.equal(result.present, true);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.severity === 'error'));
  assert.equal(result.bodyStart, 23);
});

test('extracts standard links and encoded extended references with metadata', () => {
  const source = [
    '[ordinary](other.md)',
    '[term](explain%20this|mode=tip|style=teal)',
    '[old wording](fix%20this|mode=revision|advice=new%20wording)',
    '[record](records/movie.md|mode=supertag)',
    '[highlight](papers/paper.pdf|mode=pdf-card|annotation=abc-123)',
    '![image](assets/cover.png)',
  ].join('\n');

  const references = parseDocumentReferences(source, 'notes/current.md');

  assert.deepEqual(references.map((reference) => reference.mode), [
    'link',
    'tip',
    'revision',
    'supertag',
    'pdf-card',
  ]);
  assert.equal(references[0].targetPath, 'notes/other.md');
  assert.equal(references[1].metadata?.style, 'teal');
  assert.equal(references[2].metadata?.advice, 'new wording');
  assert.equal(references[4].metadata?.annotation, 'abc-123');
  assert.equal(references.some((reference) => reference.targetPath.endsWith('cover.png')), false);
});

test('extracts numeric footnotes and synchronizes repeated labels', () => {
  const source = [
    'A claim[^1] and a second claim[^2].',
    '',
    '[^1]: First source',
    '[^2]: Second source',
    '[^1]: Repeated source should be diagnosed',
  ].join('\n');

  const analysis = parseDocumentAnalysis(source, 'notes/current.md');

  assert.deepEqual(analysis.footnotes.map((footnote) => footnote.label), ['1', '2']);
  assert.equal(analysis.footnotes[0].content, 'First source');
  assert.equal(analysis.footnotes[0].referenceCount, 1);
  assert.ok(analysis.diagnostics.some((diagnostic) => diagnostic.message.includes('duplicate footnote')));
});

test('returns stable document metadata and normalized reference paths', () => {
  const analysis = parseDocumentAnalysis('[next](../other.md)', 'notes/current.md');
  const reference: DocumentReference = analysis.references[0];

  assert.equal(reference.sourcePath, 'notes/current.md');
  assert.equal(reference.targetPath, 'other.md');
  assert.match(analysis.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(analysis.headings.length, 0);
});

test('updates shorthand and typed frontmatter values without changing the body', () => {
  const source = [
    '---',
    'title: Old title',
    'status:',
    '  type: select',
    '  value: Reading',
    '---',
    '',
    '# Body',
  ].join('\n');

  const updatedTitle = updateFrontmatterField(source, 'title', 'New title');
  const updatedStatus = updateFrontmatterField(updatedTitle, 'status', 'Done');

  assert.match(updatedStatus, /title: "New title"/);
  assert.match(updatedStatus, / {2}value: "Done"/);
  assert.match(updatedStatus, /# Body$/);
});

test('creates a frontmatter block when editing metadata on a plain markdown document', () => {
  const updated = updateFrontmatterField('# Body', 'favorite', true);

  assert.match(updated, /^---\nfavorite: true\n---\n# Body$/);
});
