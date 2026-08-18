import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildWorkspaceGraph,
  getBacklinks,
  getBrokenLinks,
  type WorkspaceGraphSnapshot,
} from '../src/utils/knowledgeGraph.ts';

test('builds directed graph edges from relative Markdown links', () => {
  const graph = buildWorkspaceGraph([
    { path: 'notes/a.md', content: '[B](b.md) and [B again](b.md)' },
    { path: 'notes/b.md', content: '[A](a.md)' },
    { path: 'assets/cover.png', content: '' },
  ], 123);

  assert.equal(graph.generatedAt, 123);
  assert.deepEqual(graph.nodes.map((node) => node.id), ['assets/cover.png', 'notes/a.md', 'notes/b.md']);
  assert.equal(graph.edges.length, 3);
  assert.equal(graph.edges[0].source, 'notes/a.md');
  assert.equal(graph.edges[0].target, 'notes/b.md');
  assert.equal(graph.edges[0].label, 'B');
  assert.equal(graph.edges[0].broken, false);
});

test('marks missing local targets and exposes reverse links', () => {
  const graph = buildWorkspaceGraph([
    { path: 'a.md', content: '[B](b.md) [Missing](missing.md)' },
    { path: 'b.md', content: '' },
  ]);

  const backlinks = getBacklinks(graph, 'b.md');
  const broken = getBrokenLinks(graph);

  assert.deepEqual(backlinks.map((edge) => edge.source), ['a.md']);
  assert.deepEqual(broken.map((edge) => edge.target), ['missing.md']);
});

test('keeps duplicate and bidirectional edges instead of collapsing relationships', () => {
  const graph: WorkspaceGraphSnapshot = buildWorkspaceGraph([
    { path: 'a.md', content: '[B one](b.md)\\n[B two](b.md)' },
    { path: 'b.md', content: '[A](a.md)' },
  ]);

  assert.equal(graph.edges.filter((edge) => edge.source === 'a.md').length, 2);
  assert.equal(graph.edges.filter((edge) => edge.source === 'b.md').length, 1);
});
