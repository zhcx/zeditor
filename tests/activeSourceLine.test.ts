import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findActiveSourceElement, resolveActiveSourceLine } from '../src/utils/activeSourceLine.ts';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('maps an editor line to the closest preview block that starts before it', () => {
  assert.equal(resolveActiveSourceLine([1, 4, 9, 14], 11), 9);
});

test('uses the first preview block when the cursor is before every source anchor', () => {
  assert.equal(resolveActiveSourceLine([4, 9], 1), 4);
});

test('handles duplicate, invalid and unsorted source anchors', () => {
  assert.equal(resolveActiveSourceLine([9, Number.NaN, 4, 9, 0], 9), 9);
});

test('returns null when the preview has no usable source anchors', () => {
  assert.equal(resolveActiveSourceLine([], 3), null);
});

function sourceElement(line: number, tagName: string, classes: string[] = []) {
  return {
    dataset: { sourceLine: String(line) },
    tagName,
    classList: { contains: (className: string) => classes.includes(className) },
  } as unknown as HTMLElement;
}

test('prefers the whole quote when nested anchors start on the same line', () => {
  const outer = sourceElement(7, 'BLOCKQUOTE');
  const inner = sourceElement(7, 'P');
  const root = {
    querySelectorAll: () => [outer, inner],
  } as unknown as ParentNode;

  assert.equal(findActiveSourceElement(root, 7), outer);
});

test('prefers the list item so the marker bar stays left of the bullet', () => {
  const item = sourceElement(7, 'LI');
  const content = sourceElement(7, 'SPAN', ['preview-list-item-content']);
  const childItem = sourceElement(8, 'LI');
  const root = {
    querySelectorAll: () => [item, content, childItem],
  } as unknown as ParentNode;

  // li 本体定位：竖条落在项目符号左侧，而不是紧贴文字
  assert.equal(findActiveSourceElement(root, 7), item);
});

test('preview tables only scroll when they overflow their column', () => {
  const styles = read('src/styles/main.css');

  assert.match(styles, /\.table-resize-wrap \{[\s\S]*?overflow: visible;/);
  assert.match(styles, /\.table-resize-wrap\.is-scrollable \{[\s\S]*?overflow-x: auto;/);
  assert.match(styles, /\.table-resize-wrap > table \{[\s\S]*?max-width: none;[\s\S]*?overflow: visible;/);
});

test('preview draws the list indicator left of the bullet', () => {
  const styles = read('src/styles/main.css');

  assert.match(styles, /\.preview-document li\.is-active-source-block::before \{\s*left: -1\.5em;/);
  // 列表容器缩进 1.6em，标记落在符号前的留白里
  assert.match(styles, /\.preview-document ul,\s*\.preview-document ol \{ padding-left: 1\.6em; \}/);
});

test('falls back to the content anchor when no list item carries the line', () => {
  const content = sourceElement(7, 'SPAN', ['preview-list-item-content']);
  const root = {
    querySelectorAll: () => [content],
  } as unknown as ParentNode;

  assert.equal(findActiveSourceElement(root, 7), content);
});
