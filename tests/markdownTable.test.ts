import test from 'node:test';
import assert from 'node:assert/strict';
import {
  alignmentAt,
  applyTableAction,
  cellPositionAt,
  deleteColumn,
  deleteRow,
  deleteTable,
  displayWidth,
  formatTableSource,
  insertColumn,
  insertRow,
  insertTable,
  isDelimiterRow,
  navigateTableCell,
  parseTableAt,
  setColumnAlignment,
  tableFromRows,
} from '../src/utils/markdownTable.ts';

const doc = [
  '# 标题',
  '',
  '| 名称 | 说明 | 状态 |',
  '| :--- | :---: | ---: |',
  '| A | 甲 | 完成 |',
  '| B | 乙 | 进行 |',
  '',
  '段落',
].join('\n');

const offsetOf = (needle: string, from = 0) => {
  const index = doc.indexOf(needle, from);
  assert.notEqual(index, -1, `fixture 缺少 ${needle}`);
  return index;
};

test('insertTable builds a padded table and selects the first header cell', () => {
  const insertion = insertTable(3, 3);
  const lines = insertion.text.split('\n');

  assert.equal(lines.length, 4);
  assert.equal(lines[0], '| 列 1 | 列 2 | 列 3 |');
  assert.match(lines[1], /^\|\s*---\s*\|\s*---\s*\|\s*---\s*\|$/);
  assert.equal(insertion.text.slice(insertion.cursor, insertion.cursorEnd), '列 1');
});

test('insertTable clamps the requested size', () => {
  // rows 含表头：rows = 2 时是一行表头 + 一行正文
  const minimal = insertTable(0, 0);
  assert.equal(minimal.text.split('\n').length, 3);
  assert.equal(parseTableAt(minimal.text, 0)?.columns, 1);

  const large = insertTable(999, 99);
  assert.equal(large.text.split('\n').length, 51);
  assert.equal(parseTableAt(large.text, 0)?.columns, 20);
});

test('parseTableAt finds the table around the cursor with alignments and offsets', () => {
  const table = parseTableAt(doc, offsetOf('B'));
  assert.ok(table);
  assert.equal(table.from, offsetOf('| 名称'));
  assert.equal(table.to, offsetOf('| B | 乙 | 进行 |') + '| B | 乙 | 进行 |'.length);
  assert.equal(table.columns, 3);
  assert.equal(table.rows.length, 4);
  assert.deepEqual(table.aligns, ['left', 'center', 'right']);

  assert.equal(parseTableAt(doc, offsetOf('# 标题')), null);
  assert.equal(parseTableAt(doc, offsetOf('段落')), null);
});

test('cellPositionAt maps cursors to cells, including the delimiter row', () => {
  const table = parseTableAt(doc, offsetOf('B'));
  assert.ok(table);
  assert.deepEqual(cellPositionAt(table, offsetOf('B')), { row: 3, column: 0 });
  assert.deepEqual(cellPositionAt(table, offsetOf('甲')), { row: 2, column: 1 });
  // 分隔行上的光标归到表头行的同一列，方便直接改对齐
  assert.deepEqual(cellPositionAt(table, offsetOf(':---:')), { row: 0, column: 1 });
  assert.equal(alignmentAt(doc, offsetOf('完成')), 'right');
});

test('escaped pipes and delimiter detection', () => {
  const escaped = '| a \\| b | c |';
  const table = parseTableAt(`${escaped}\n| --- | --- |\n| d | e |`, 0);
  assert.ok(table);
  assert.equal(table.rows[0].cells.length, 2);
  assert.equal(table.rows[0].cells[0].text, 'a \\| b');

  assert.equal(isDelimiterRow('| --- | :--: |'), true);
  assert.equal(isDelimiterRow('| 名称 | 说明 |'), false);
  assert.equal(isDelimiterRow('--- | ---'), true);
});

test('insertRow adds an empty row above or below the current row', () => {
  const offset = offsetOf('B');
  const below = insertRow(doc, offset, 'below');
  assert.ok(below);
  const belowTable = parseTableAt(below.text, 0);
  assert.ok(belowTable);
  assert.equal(belowTable.rows.length, 5);
  // 新增行为空单元格，光标落在第一个单元格内，不写入「内容」占位
  assert.deepEqual(belowTable.rows[4].cells.map((cell) => cell.text), ['', '', '']);
  assert.equal(below.text.slice(below.cursor - below.from, below.cursorEnd - below.from), '');
  assert.deepEqual(cellPositionAt(belowTable, below.cursor - below.from), { row: 4, column: 0 });

  const above = insertRow(doc, offset, 'above');
  assert.ok(above);
  const aboveTable = parseTableAt(above.text, 0);
  assert.ok(aboveTable);
  assert.deepEqual(aboveTable.rows[3].cells.map((cell) => cell.text), ['', '', '']);

  // 只有表格区间被替换，前后内容保持原样
  assert.equal(doc.slice(0, below.from), '# 标题\n\n');
  assert.equal(`${doc.slice(0, below.from)}${below.text}${doc.slice(below.to)}`.includes('# 标题'), true);
});

test('deleteRow removes the row and deletes the table when the last row goes away', () => {
  const removed = deleteRow(doc, offsetOf('B'));
  assert.ok(removed);
  const table = parseTableAt(removed.text, 0);
  assert.ok(table);
  assert.equal(table.rows.length, 3);
  assert.equal(removed.text.includes('| B |'), false);

  const single = '| h |\n| --- |\n| a |';
  const cleared = deleteRow(single, single.indexOf('| a'));
  assert.ok(cleared);
  assert.equal(cleared.text, '');
  assert.equal(cleared.from, 0);
  assert.equal(cleared.to, single.length);

  const headerRemoved = deleteRow(doc, offsetOf('名称'));
  assert.ok(headerRemoved);
  const promoted = parseTableAt(headerRemoved.text, 0);
  assert.ok(promoted);
  assert.equal(promoted.rows[0].cells[0].text, 'A');
});

test('insertColumn and deleteColumn keep rows and alignments in sync', () => {
  const inserted = insertColumn(doc, offsetOf('A'), 'right');
  assert.ok(inserted);
  const insertedTable = parseTableAt(inserted.text, 0);
  assert.ok(insertedTable);
  assert.equal(insertedTable.columns, 4);
  assert.equal(insertedTable.aligns.length, 4);
  assert.deepEqual(insertedTable.rows[0].cells.map((cell) => cell.text), ['名称', '', '说明', '状态']);
  assert.deepEqual(insertedTable.rows[2].cells.map((cell) => cell.text), ['A', '', '甲', '完成']);

  const removed = deleteColumn(doc, offsetOf('说明'));
  assert.ok(removed);
  const removedTable = parseTableAt(removed.text, 0);
  assert.ok(removedTable);
  assert.equal(removedTable.columns, 2);
  assert.deepEqual(removedTable.aligns, ['left', 'right']);

  const single = '| h |\n| --- |\n| a |';
  const cleared = deleteColumn(single, single.indexOf('h'));
  assert.ok(cleared);
  assert.equal(cleared.text, '');
});

test('setColumnAlignment rewrites only the delimiter row of the target column', () => {
  const centered = setColumnAlignment(doc, offsetOf('名称'), 'center');
  assert.ok(centered);
  const table = parseTableAt(centered.text, 0);
  assert.ok(table);
  assert.deepEqual(table.aligns, ['center', 'center', 'right']);
  assert.equal(alignmentAt(centered.text, centered.text.indexOf('名称')), 'center');
});

test('formatTableSource pads every column to a shared width and is idempotent', () => {
  const messy = '| a | 很长的列名 |\n| --- | --- |\n| bbb | c |';
  const formatted = formatTableSource(messy, messy.indexOf('bbb'));
  assert.ok(formatted);
  const widths = formatted.text.split('\n').map((line) => displayWidth(line));
  assert.equal(new Set(widths).size, 1);
  assert.equal(tableFromRows([['a', '很长的列名'], ['bbb', 'c']], ['none', 'none']), formatted.text);

  const again = formatTableSource(formatted.text, formatted.text.indexOf('bbb'));
  assert.ok(again);
  assert.equal(again.text, formatted.text);
});

test('deleteTable removes the table together with its trailing newline', () => {
  const removed = deleteTable(doc, offsetOf('A'));
  assert.ok(removed);
  assert.equal(removed.text, '');
  assert.equal(doc.slice(0, removed.from), '# 标题\n\n');
  assert.equal(doc.slice(removed.to), '\n段落');
});

test('navigateTableCell drives Tab, arrow and Enter navigation inside a table', () => {
  const tabForward = navigateTableCell(doc, offsetOf('| A'), 'Tab');
  assert.deepEqual(tabForward, { kind: 'move', cursor: offsetOf('甲'), cursorEnd: offsetOf('甲') + 1 });

  const tabBackward = navigateTableCell(doc, offsetOf('甲'), 'Shift+Tab');
  assert.deepEqual(tabBackward, { kind: 'move', cursor: offsetOf('| A') + 2, cursorEnd: offsetOf('A') + 1 });

  assert.deepEqual(navigateTableCell(doc, offsetOf('进行'), 'Tab'), { kind: 'insert-row' });
  assert.deepEqual(navigateTableCell(doc, offsetOf('完成'), 'Enter'), { kind: 'insert-row' });

  assert.deepEqual(navigateTableCell(doc, offsetOf('B'), 'ArrowUp'), {
    kind: 'move',
    cursor: offsetOf('A'),
    cursorEnd: offsetOf('A'),
  });
  assert.equal(navigateTableCell(doc, offsetOf('进行'), 'ArrowDown'), null);

  // 单元格内部的水平移动交回编辑器
  assert.equal(navigateTableCell(doc, offsetOf('完成') + 1, 'ArrowLeft'), null);
  assert.deepEqual(navigateTableCell(doc, offsetOf('完成'), 'ArrowLeft'), {
    kind: 'move',
    cursor: offsetOf('甲'),
    cursorEnd: offsetOf('甲'),
  });
  assert.deepEqual(navigateTableCell(doc, offsetOf('甲') + 1, 'ArrowRight'), {
    kind: 'move',
    cursor: offsetOf('完成'),
    cursorEnd: offsetOf('完成'),
  });

  assert.equal(navigateTableCell(doc, offsetOf('段落'), 'Tab'), null);
});

test('applyTableAction routes toolbar actions to table edits', () => {
  const offset = offsetOf('B');
  assert.deepEqual(applyTableAction(doc, offset, 'row-below'), insertRow(doc, offset, 'below'));
  assert.deepEqual(applyTableAction(doc, offset, 'column-left'), insertColumn(doc, offset, 'left'));
  assert.deepEqual(applyTableAction(doc, offset, 'table-delete'), deleteTable(doc, offset));
  const centered = applyTableAction(doc, offset, 'align-center');
  assert.ok(centered);
  assert.deepEqual(parseTableAt(centered.text, 0)?.aligns, ['center', 'center', 'right']);
});
