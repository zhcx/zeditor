/**
 * Markdown 表格解析与编辑工具。
 *
 * 所有函数都是纯函数：输入文档文本与光标偏移，返回需要替换的区间、
 * 新文本与编辑后的光标位置，由调用方（编辑器控制器）写回编辑器。
 * 支持对齐分隔行 `:---` / `:---:` / `---:`，以及省略首尾竖线的写法。
 */

export type ColumnAlignment = 'left' | 'center' | 'right' | 'none';

export interface TableCell {
  /** 单元格文本（已去掉首尾空白） */
  text: string;
  /** 单元格文本在文档中的起始偏移 */
  from: number;
  /** 单元格文本在文档中的结束偏移 */
  to: number;
}

export interface TableRow {
  /** 行首偏移 */
  from: number;
  /** 行尾偏移（不含换行符） */
  to: number;
  cells: TableCell[];
}

export interface MarkdownTable {
  /** 表格第一行的行首偏移 */
  from: number;
  /** 表格最后一行的行尾偏移 */
  to: number;
  /** 全部行，rows[1] 是对齐分隔行 */
  rows: TableRow[];
  /** 每一列的对齐方式 */
  aligns: ColumnAlignment[];
  columns: number;
}

export interface CellPosition {
  /** table.rows 中的行下标（1 为分隔行） */
  row: number;
  column: number;
}

export interface TableEdit {
  /** 需要替换的区间 */
  from: number;
  to: number;
  /** 替换后的文本 */
  text: string;
  /** 编辑后的光标起点（文档绝对偏移） */
  cursor: number;
  /** 编辑后的选区终点 */
  cursorEnd: number;
}

export interface TableInsertion {
  text: string;
  cursor: number;
  cursorEnd: number;
}

export type TableNavigationKey = 'Tab' | 'Shift+Tab' | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Enter';

export type TableNavigation =
  | { kind: 'move'; cursor: number; cursorEnd: number }
  /** 光标位于表格末行，需追加一行后把光标移入新行第一个单元格 */
  | { kind: 'insert-row' };

export type TableAction =
  | 'row-above'
  | 'row-below'
  | 'row-delete'
  | 'column-left'
  | 'column-right'
  | 'column-delete'
  | 'align-left'
  | 'align-center'
  | 'align-right'
  | 'align-none'
  | 'format'
  | 'table-delete';

/** 新增行、新增列与插入表格时填入的占位文本。 */
export const TABLE_BODY_PLACEHOLDER = '内容';

const MIN_COLUMN_WIDTH = 3;
const DELIMITER_PATTERN = /^:?-+:?$/;

function lineStartOffsets(content: string): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const line of content.split('\n')) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  return offsets;
}

function lineIndexAt(offsets: number[], offset: number): number {
  let index = 0;
  for (let cursor = 0; cursor < offsets.length; cursor += 1) {
    if (offsets[cursor] <= offset) index = cursor;
    else break;
  }
  return index;
}

interface CellSegment {
  text: string;
  start: number;
  end: number;
}

/** 按未被转义的 `|` 切分一行，并丢弃首尾管道造成的空片段。 */
function cellSegments(line: string): CellSegment[] {
  const segments: CellSegment[] = [];
  let start = 0;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '\\') {
      index += 1;
      continue;
    }
    if (line[index] === '|') {
      segments.push({ text: line.slice(start, index), start, end: index });
      start = index + 1;
    }
  }
  segments.push({ text: line.slice(start), start, end: line.length });
  if (segments.length > 1 && segments[0].text.trim() === '') segments.shift();
  if (segments.length > 1 && segments[segments.length - 1].text.trim() === '') segments.pop();
  return segments;
}

function cellsOf(line: string, lineStart: number): TableCell[] {
  return cellSegments(line).map((segment) => {
    const trimmedStart = segment.text.length - segment.text.trimStart().length;
    const trimmedEnd = segment.text.length - segment.text.trimEnd().length;
    const from = lineStart + segment.start + trimmedStart;
    const to = Math.max(from, lineStart + segment.end - trimmedEnd);
    return { text: segment.text.trim(), from, to };
  });
}

/** 行内是否出现未转义的竖线（Markdown 表格的必要条件）。 */
export function isTableRow(line: string): boolean {
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '\\') {
      index += 1;
      continue;
    }
    if (line[index] === '|') return true;
  }
  return false;
}

/** 是否为对齐分隔行，例如 `| --- | :--: | ---: |`。 */
export function isDelimiterRow(line: string): boolean {
  if (!isTableRow(line)) return false;
  const cells = cellSegments(line).map((segment) => segment.text.trim());
  return cells.length > 0 && cells.every((cell) => DELIMITER_PATTERN.test(cell));
}

export function alignmentFromDelimiter(cell: string): ColumnAlignment {
  const value = cell.trim();
  const left = value.startsWith(':');
  const right = value.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return 'none';
}

export function delimiterForAlignment(alignment: ColumnAlignment): string {
  if (alignment === 'center') return ':---:';
  if (alignment === 'right') return '---:';
  if (alignment === 'left') return ':---';
  return '---';
}

/**
 * 定位包含指定偏移的表格；光标不在表格内时返回 null。
 * 表格由连续的“含竖线行”组成，第二行必须是对齐分隔行。
 */
export function parseTableAt(content: string, offset: number): MarkdownTable | null {
  const lines = content.split('\n');
  const offsets = lineStartOffsets(content);
  const cursorLine = lineIndexAt(offsets, offset);
  if (!isTableRow(lines[cursorLine])) return null;

  let start = cursorLine;
  while (start > 0 && isTableRow(lines[start - 1])) start -= 1;
  let end = cursorLine;
  while (end + 1 < lines.length && isTableRow(lines[end + 1])) end += 1;

  let headerIndex = -1;
  for (let index = start; index < end; index += 1) {
    if (isDelimiterRow(lines[index + 1])) {
      headerIndex = index;
      break;
    }
  }
  if (headerIndex < 0 || headerIndex > cursorLine) return null;

  const rows: TableRow[] = [];
  for (let index = headerIndex; index <= end; index += 1) {
    const line = lines[index];
    const lineStart = offsets[index];
    rows.push({ from: lineStart, to: lineStart + line.length, cells: cellsOf(line, lineStart) });
  }
  if (rows.length < 2) return null;

  const aligns = rows[1].cells.map((cell) => alignmentFromDelimiter(cell.text));
  const columns = Math.max(
    rows.length > 0 ? Math.max(...rows.map((row) => row.cells.length)) : 0,
    aligns.length,
  );
  if (columns === 0) return null;

  return { from: offsets[headerIndex], to: rows[rows.length - 1].to, rows, aligns, columns };
}

/** 光标所在的单元格位置；落在分隔行或表格外时返回 null。 */
export function cellPositionAt(table: MarkdownTable, offset: number): CellPosition | null {
  // 光标停在对齐分隔行时归到表头行的同一列，工具栏与对齐动作依然可用。
  const delimiter = table.rows[1];
  if (delimiter && offset >= delimiter.from && offset <= delimiter.to) {
    const column = delimiter.cells.findIndex((cell) => offset >= cell.from && offset <= cell.to);
    return { row: 0, column: column < 0 ? 0 : column };
  }

  for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex += 1) {
    if (rowIndex === 1) continue;
    const row = table.rows[rowIndex];
    if (offset < row.from || offset > row.to) continue;
    const cells = row.cells;
    if (cells.length === 0) return { row: rowIndex, column: 0 };
    let column = cells.findIndex((cell) => offset >= cell.from && offset <= cell.to);
    if (column < 0) {
      // 光标落在管道符或单元格前导空白上时，归属右边最近的单元格。
      const next = cells.findIndex((cell) => cell.from >= offset);
      column = next < 0 ? cells.length - 1 : next;
    }
    return { row: rowIndex, column };
  }
  return null;
}

/** 表格内的可编辑行（跳过对齐分隔行），返回 table.rows 下标与行本身。 */
function editableRows(table: MarkdownTable): { index: number; row: TableRow }[] {
  return table.rows
    .map((row, index) => ({ index, row }))
    .filter((entry) => entry.index !== 1);
}

/** 表格的正文行文本（不含对齐分隔行）。 */
function dataRowsOf(table: MarkdownTable): string[][] {
  return table.rows
    .filter((_row, index) => index !== 1)
    .map((row) => row.cells.map((cell) => cell.text));
}

function charWidth(codePoint: number): number {
  const wide = (codePoint >= 0x1100 && codePoint <= 0x115f)
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1f9ff);
  return wide ? 2 : 1;
}

/** 终端/等宽字体下的显示宽度：中日韩字符与常见表情按 2 列计算。 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) width += charWidth(character.codePointAt(0) ?? 0);
  return width;
}

function padCell(text: string, width: number): string {
  if (!text) return '';
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/** 由正文行与对齐方式生成规范表格源码（列宽按显示宽度补齐）。 */
export function tableFromRows(rows: string[][], aligns: ColumnAlignment[]): string {
  const columns = Math.max(1, aligns.length, ...rows.map((row) => row.length));
  const normalized = rows.map((row) => Array.from({ length: columns }, (_value, index) => (row[index] ?? '').trim()));
  const delimiters = Array.from({ length: columns }, (_value, index) => delimiterForAlignment(aligns[index] ?? 'none'));
  const widths = Array.from({ length: columns }, (_value, index) => Math.max(
    MIN_COLUMN_WIDTH,
    displayWidth(delimiters[index]),
    ...normalized.map((row) => displayWidth(row[index])),
  ));

  const renderRow = (cells: string[], padding: string[]) => `| ${cells
    .map((cell, index) => padCell(cell, widths[index]) || padding[index])
    .join(' | ')} |`;

  const emptyPadding = Array.from({ length: columns }, () => '');
  const lines = [
    renderRow(normalized[0] ?? Array.from({ length: columns }, () => ''), emptyPadding),
    renderRow(delimiters, delimiters),
    ...normalized.slice(1).map((row) => renderRow(row, emptyPadding)),
  ];
  return lines.join('\n');
}

function cellOffsetsInText(text: string, rowIndex: number, column: number): { from: number; to: number } {
  const parsed = parseTableAt(text, 0);
  const row = parsed?.rows[rowIndex];
  const cell = row?.cells[Math.min(column, Math.max(0, (row?.cells.length ?? 1) - 1))];
  if (!cell) return { from: 0, to: 0 };
  return { from: cell.from, to: cell.to };
}

/**
 * 用新的正文行与对齐方式重建表格，并把光标放到指定单元格（正文行下标）。
 */
function rebuild(
  table: MarkdownTable,
  rows: string[][],
  aligns: ColumnAlignment[],
  focus: { row: number; column: number },
): TableEdit {
  const text = tableFromRows(rows, aligns);
  const delimiterRow = focus.row === 0 ? 0 : focus.row + 1;
  const offsets = cellOffsetsInText(text, delimiterRow, focus.column);
  return {
    from: table.from,
    to: table.to,
    text,
    cursor: table.from + offsets.from,
    cursorEnd: table.from + offsets.to,
  };
}

/** 生成可插入文档的表格源码，光标落在表头第一个单元格。 */
export function insertTable(rows: number, columns: number): TableInsertion {
  const safeRows = Math.max(2, Math.min(50, Math.floor(rows) || 2));
  const safeColumns = Math.max(1, Math.min(20, Math.floor(columns) || 1));
  const header = Array.from({ length: safeColumns }, (_value, index) => `列 ${index + 1}`);
  const body = Array.from({ length: safeRows - 1 }, () => Array.from({ length: safeColumns }, () => ''));
  const aligns = Array.from({ length: safeColumns }, () => 'none' as ColumnAlignment);
  const text = tableFromRows([header, ...body], aligns);
  const offsets = cellOffsetsInText(text, 0, 0);
  return { text, cursor: offsets.from, cursorEnd: offsets.to };
}

function dataRowIndexAt(table: MarkdownTable, position: CellPosition): number {
  return editableRows(table).findIndex((entry) => entry.index === position.row);
}

/** 在当前行上方或下方插入一行，光标落在新行的同列单元格。 */
export function insertRow(content: string, offset: number, where: 'above' | 'below'): TableEdit | null {
  const table = parseTableAt(content, offset);
  if (!table) return null;
  const position = cellPositionAt(table, offset);
  if (!position) return null;

  const rows = dataRowsOf(table);
  const target = Math.max(0, Math.min(dataRowIndexAt(table, position) + (where === 'below' ? 1 : 0), rows.length));
  rows.splice(target, 0, Array.from({ length: table.columns }, () => TABLE_BODY_PLACEHOLDER));
  return rebuild(table, rows, table.aligns, { row: target, column: Math.min(position.column, table.columns - 1) });
}

/** 删除当前行；只剩表头时连同表格一起删除，删到表头时把首行正文提升为表头。 */
export function deleteRow(content: string, offset: number): TableEdit | null {
  const table = parseTableAt(content, offset);
  if (!table) return null;
  const position = cellPositionAt(table, offset);
  if (!position) return null;

  const rows = dataRowsOf(table);
  const target = dataRowIndexAt(table, position);
  if (target < 0) return null;
  if (rows.length <= 1) return deleteTable(content, offset);

  rows.splice(target, 1);
  // 删掉最后一条正文行后只剩表头，整张表格一起删除，避免留下空壳。
  if (rows.length <= 1) return deleteTable(content, offset);
  return rebuild(table, rows, table.aligns, {
    row: Math.max(0, Math.min(target, rows.length - 1)),
    column: Math.min(position.column, table.columns - 1),
  });
}

/** 在当前列左右插入一列，光标落在被选中列的单元格。 */
export function insertColumn(content: string, offset: number, where: 'left' | 'right'): TableEdit | null {
  const table = parseTableAt(content, offset);
  if (!table) return null;
  const position = cellPositionAt(table, offset);
  if (!position) return null;

  const rows = dataRowsOf(table);
  const target = Math.max(0, Math.min(position.column + (where === 'right' ? 1 : 0), table.columns));
  rows.forEach((row, index) => {
    row.splice(target, 0, index === 0 ? `列 ${table.columns + 1}` : '');
  });
  const aligns = [...table.aligns];
  aligns.splice(target, 0, 'none');
  return rebuild(table, rows, aligns, { row: dataRowIndexAt(table, position), column: target });
}

/** 删除当前列；只剩一列时删除整张表格。 */
export function deleteColumn(content: string, offset: number): TableEdit | null {
  const table = parseTableAt(content, offset);
  if (!table) return null;
  const position = cellPositionAt(table, offset);
  if (!position) return null;
  if (table.columns <= 1) return deleteTable(content, offset);

  const rows = dataRowsOf(table);
  const target = Math.min(position.column, table.columns - 1);
  rows.forEach((row) => row.splice(target, 1));
  const aligns = table.aligns.filter((_value, index) => index !== target);
  return rebuild(table, rows, aligns, {
    row: dataRowIndexAt(table, position),
    column: Math.min(target, table.columns - 2),
  });
}

/** 设置当前列的对齐方式，同时按新宽度重新排版整张表格。 */
export function setColumnAlignment(content: string, offset: number, alignment: ColumnAlignment): TableEdit | null {
  const table = parseTableAt(content, offset);
  if (!table) return null;
  const position = cellPositionAt(table, offset);
  if (!position) return null;

  const aligns = [...table.aligns];
  for (let index = 0; index < table.columns; index += 1) {
    if (index === position.column) aligns[index] = alignment;
    else if (!aligns[index]) aligns[index] = 'none';
  }
  return rebuild(table, dataRowsOf(table), aligns, {
    row: dataRowIndexAt(table, position),
    column: position.column,
  });
}

/** 按列宽补齐空格，把源码整理成等宽对齐的表格。 */
export function formatTableSource(content: string, offset: number): TableEdit | null {
  const table = parseTableAt(content, offset);
  if (!table) return null;
  const position = cellPositionAt(table, offset);
  return rebuild(table, dataRowsOf(table), table.aligns, {
    row: position ? dataRowIndexAt(table, position) : 0,
    column: position?.column ?? 0,
  });
}

/** 删除整张表格（连同换行）。 */
export function deleteTable(content: string, offset: number): TableEdit | null {
  const table = parseTableAt(content, offset);
  if (!table) return null;
  const to = content[table.to] === '\n' ? table.to + 1 : table.to;
  return { from: table.from, to, text: '', cursor: table.from, cursorEnd: table.from };
}

/** 当前列的既有对齐方式，供工具栏高亮。 */
export function alignmentAt(content: string, offset: number): ColumnAlignment | null {
  const table = parseTableAt(content, offset);
  if (!table) return null;
  const position = cellPositionAt(table, offset);
  if (!position) return null;
  return table.aligns[position.column] ?? 'none';
}

function focusCell(cell: TableCell, select: boolean): TableNavigation {
  return { kind: 'move', cursor: cell.from, cursorEnd: select ? cell.to : cell.from };
}

function cellAt(row: TableRow, column: number): TableCell | null {
  if (row.cells.length === 0) return null;
  return row.cells[Math.min(column, row.cells.length - 1)];
}

/**
 * 表格内的键盘导航：Tab 跳到下一个单元格（末行时追加一行），
 * 方向键在单元格之间移动，Enter 在当前行下方新增一行。
 * 光标不在表格内或按键应交回编辑器处理时返回 null。
 */
export function navigateTableCell(content: string, offset: number, key: TableNavigationKey): TableNavigation | null {
  const table = parseTableAt(content, offset);
  if (!table) return null;
  const position = cellPositionAt(table, offset);
  if (!position) return null;

  const rows = editableRows(table);
  const rowIndex = rows.findIndex((entry) => entry.index === position.row);
  if (rowIndex < 0) return null;
  const currentCell = cellAt(table.rows[position.row], position.column);
  if (!currentCell) return null;

  if (key === 'Enter') return { kind: 'insert-row' };

  if (key === 'Tab' || key === 'Shift+Tab') {
    const forward = key === 'Tab';
    const nextColumn = position.column + (forward ? 1 : -1);
    if (nextColumn >= 0 && nextColumn < table.columns) {
      const cell = cellAt(table.rows[position.row], nextColumn);
      return cell ? focusCell(cell, true) : null;
    }
    if (forward) {
      if (rowIndex < rows.length - 1) {
        const cell = cellAt(rows[rowIndex + 1].row, 0);
        return cell ? focusCell(cell, true) : null;
      }
      return { kind: 'insert-row' };
    }
    const cell = cellAt(table.rows[rows[0].index], 0);
    return cell ? focusCell(cell, true) : null;
  }

  if (key === 'ArrowUp' || key === 'ArrowDown') {
    const targetIndex = rowIndex + (key === 'ArrowDown' ? 1 : -1);
    if (targetIndex < 0 || targetIndex > rows.length - 1) return null;
    const cell = cellAt(rows[targetIndex].row, position.column);
    return cell ? focusCell(cell, false) : null;
  }

  if (key === 'ArrowLeft') {
    if (offset > currentCell.from) return null;
    const previous = position.column > 0
      ? cellAt(table.rows[position.row], position.column - 1)
      : rowIndex > 0 ? cellAt(rows[rowIndex - 1].row, table.columns - 1) : null;
    return previous ? focusCell(previous, false) : null;
  }

  if (offset < currentCell.to) return null;
  const next = position.column < table.columns - 1
    ? cellAt(table.rows[position.row], position.column + 1)
    : rowIndex < rows.length - 1 ? cellAt(rows[rowIndex + 1].row, 0) : null;
  return next ? focusCell(next, false) : null;
}

/** 把工具栏动作映射为表格编辑，供编辑器与菜单共用。 */
export function applyTableAction(content: string, offset: number, action: TableAction): TableEdit | null {
  switch (action) {
    case 'row-above': return insertRow(content, offset, 'above');
    case 'row-below': return insertRow(content, offset, 'below');
    case 'row-delete': return deleteRow(content, offset);
    case 'column-left': return insertColumn(content, offset, 'left');
    case 'column-right': return insertColumn(content, offset, 'right');
    case 'column-delete': return deleteColumn(content, offset);
    case 'align-left': return setColumnAlignment(content, offset, 'left');
    case 'align-center': return setColumnAlignment(content, offset, 'center');
    case 'align-right': return setColumnAlignment(content, offset, 'right');
    case 'align-none': return setColumnAlignment(content, offset, 'none');
    case 'format': return formatTableSource(content, offset);
    case 'table-delete': return deleteTable(content, offset);
    default: return null;
  }
}
