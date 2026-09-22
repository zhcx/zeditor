import { useEffect } from 'react';
import type { ColumnAlignment, TableAction } from '../../utils/markdownTable';

interface TableToolbarProps {
  /** 相对视口的定位（fixed） */
  left: number;
  top: number;
  placement: 'above' | 'below';
  alignment: ColumnAlignment;
  columns: number;
  onAction: (action: TableAction) => void;
  onClose: () => void;
}

interface ToolbarEntry {
  action: TableAction;
  label: string;
  title: string;
}

const ROW_ACTIONS: ToolbarEntry[] = [
  { action: 'row-above', label: '↑行', title: '在上方插入一行' },
  { action: 'row-below', label: '↓行', title: '在下方插入一行' },
  { action: 'row-delete', label: '删行', title: '删除当前行' },
];

const COLUMN_ACTIONS: ToolbarEntry[] = [
  { action: 'column-left', label: '←列', title: '在左侧插入一列' },
  { action: 'column-right', label: '→列', title: '在右侧插入一列' },
  { action: 'column-delete', label: '删列', title: '删除当前列' },
];

const ALIGN_ACTIONS: { action: TableAction; label: string; title: string; alignment: ColumnAlignment }[] = [
  { action: 'align-left', label: '左', title: '当前列左对齐', alignment: 'left' },
  { action: 'align-center', label: '中', title: '当前列居中', alignment: 'center' },
  { action: 'align-right', label: '右', title: '当前列右对齐', alignment: 'right' },
];

/**
 * 光标进入表格后出现的浮动工具栏：增删行列、切换对齐、整理格式。
 * 使用 onMouseDown 阻止默认行为，避免点击按钮时编辑器丢失焦点。
 */
export function TableToolbar({ left, top, placement, alignment, columns, onAction, onClose }: TableToolbarProps) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const renderEntry = (entry: ToolbarEntry) => (
    <button
      key={entry.action}
      type="button"
      className="table-toolbar-button"
      title={entry.title}
      aria-label={entry.title}
      onClick={() => onAction(entry.action)}
    >
      {entry.label}
    </button>
  );

  return (
    <div
      className="table-toolbar"
      role="toolbar"
      aria-label="表格操作"
      data-placement={placement}
      style={{ left, top }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <span className="table-toolbar-size">{columns} 列</span>
      <div className="table-toolbar-group">{ROW_ACTIONS.map(renderEntry)}</div>
      <div className="table-toolbar-group">{COLUMN_ACTIONS.map(renderEntry)}</div>
      <div className="table-toolbar-group">
        {ALIGN_ACTIONS.map((entry) => (
          <button
            key={entry.action}
            type="button"
            className={`table-toolbar-button align-${entry.alignment}`}
            data-active={alignment === entry.alignment}
            title={entry.title}
            aria-label={entry.title}
            onClick={() => onAction(entry.action)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <div className="table-toolbar-group">
        <button
          type="button"
          className="table-toolbar-button"
          title="整理表格格式：按列宽补齐空格"
          aria-label="整理表格格式"
          onClick={() => onAction('format')}
        >
          整理
        </button>
        <button
          type="button"
          className="table-toolbar-button is-danger"
          title="删除整张表格"
          aria-label="删除整张表格"
          onClick={() => onAction('table-delete')}
        >
          删表
        </button>
      </div>
      <span className="table-toolbar-hint">Tab 切换单元格 · Enter 新增一行</span>
    </div>
  );
}
