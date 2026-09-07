import test from 'node:test';
import assert from 'node:assert/strict';
import * as workspaceTree from '../src/utils/workspaceTree.ts';
import {
  mergeLoadedChildren,
  replaceNodeChildren,
  replaceNodeChildrenMerged,
  type FileNode,
} from '../src/utils/workspaceTree.ts';

const dir = (name: string, path: string, children: FileNode[] = []): FileNode => ({ name, path, isDirectory: true, children });
const file = (name: string, path: string): FileNode => ({ name, path, isDirectory: false });

test('replaceNodeChildren swaps the children at the exact path', () => {
  const tree = [
    dir('a', '/a', [file('f1.md', '/a/f1.md'), dir('b', '/a/b', [file('f2.md', '/a/b/f2.md')])]),
  ];
  const next = replaceNodeChildren(tree, '/a/b', [file('f3.md', '/a/b/f3.md')]);
  assert.deepEqual(next[0].children?.[1].children, [file('f3.md', '/a/b/f3.md')]);
});

test('mergeLoadedChildren preserves already-loaded nested children across a shallow refresh', () => {
  // Old tree: the workspace root has a nested folder "b" whose children were
  // loaded lazily (it is expanded in the UI). read_folder returns a shallow
  // tree where every directory has empty children.
  const oldTree = [
    dir('a', '/a', [file('top.md', '/a/top.md'), dir('b', '/a/b', [file('nested.md', '/a/b/nested.md')])]),
  ];
  const shallowRefresh = [
    dir('a', '/a', [file('top.md', '/a/top.md'), dir('b', '/a/b', [])]),
  ];

  const merged = mergeLoadedChildren(oldTree, shallowRefresh);

  // The refreshed tree keeps the lazily-loaded children of "/a/b" even though
  // read_folder returned an empty children array for it.
  assert.deepEqual(merged[0].children?.[1].children, [file('nested.md', '/a/b/nested.md')]);
  // New files at the refreshed level are still picked up.
  assert.equal(merged[0].children?.[0].name, 'top.md');
});

test('mergeLoadedChildren adds newly created entries and drops deleted ones', () => {
  const oldTree = [
    dir('a', '/a', [file('old.md', '/a/old.md'), dir('b', '/a/b', [file('keep.md', '/a/b/keep.md')])]),
  ];
  const shallowRefresh = [
    dir('a', '/a', [file('new.md', '/a/new.md'), dir('b', '/a/b', [])]),
  ];

  const merged = mergeLoadedChildren(oldTree, shallowRefresh);
  const a = merged[0];
  assert.equal(a.children?.length, 2);
  assert.ok(a.children?.some(n => n.name === 'new.md'));
  assert.ok(!a.children?.some(n => n.name === 'old.md'));
  // The loaded nested children survive the refresh.
  assert.deepEqual(a.children?.find(n => n.name === 'b')?.children, [file('keep.md', '/a/b/keep.md')]);
});

test('mergeLoadedChildren does not fabricate children for never-loaded folders', () => {
  const oldTree = [dir('a', '/a', [dir('b', '/a/b', [])])];
  const shallowRefresh = [dir('a', '/a', [dir('b', '/a/b', [])])];
  const merged = mergeLoadedChildren(oldTree, shallowRefresh);
  assert.deepEqual(merged[0].children?.[0].children, []);
});

test('replaceNodeChildrenMerged refreshes a nested path while keeping its loaded children', () => {
  const oldTree = [
    dir('a', '/a', [dir('b', '/b', [dir('c', '/b/c', [file('deep.md', '/b/c/deep.md')])])]),
  ];
  // Refresh "/b": read_folder returns c with empty children.
  const next = replaceNodeChildrenMerged(oldTree, '/b', [dir('c', '/b/c', []), file('b-new.md', '/b/b-new.md')]);
  const b = next[0].children?.[0];
  assert.equal(b?.children?.length, 2);
  assert.deepEqual(b?.children?.find(n => n.path === '/b/c')?.children, [file('deep.md', '/b/c/deep.md')]);
  assert.ok(b?.children?.some(n => n.name === 'b-new.md'));
});

test('refreshing a workspace folder with no remaining files removes the deleted node', () => {
  const refreshWorkspaceFolderTree = (workspaceTree as typeof workspaceTree & {
    refreshWorkspaceFolderTree?: (
      folders: Array<{ path: string; tree: FileNode[] }>,
      folderPath: string,
      newChildren: FileNode[],
    ) => Array<{ path: string; tree: FileNode[] }>;
  }).refreshWorkspaceFolderTree;

  assert.equal(typeof refreshWorkspaceFolderTree, 'function', 'workspace refresh helper must be exported');
  const folders = [{ path: '/workspace', tree: [file('deleted.md', '/workspace/deleted.md')] }];
  const refreshed = refreshWorkspaceFolderTree!(folders, '/workspace', []);

  assert.deepEqual(refreshed[0].tree, []);
});
