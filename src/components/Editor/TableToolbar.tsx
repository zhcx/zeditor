import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ColumnAlignment, TableAction } from '../../utils/markdownTable';
import { AppIcon } from '../Icons/AppIcon';
import type { IconName } from '../Icons/iconGeometry';

const actionIcons: Record<TableAction, IconName> = {
  'row-above': 'arrowUp', 'row-below': 'arrowDown', 'row-delete': 'trash',
  'column-left': 'arrowLeft', 'column-right': 'arrowRight', 'column-delete': 'trash',
  'align-left': 'alignLeft', 'align-center': 'alignCenter', 'align-right': 'alignRight', 'align-none': 'table',
  format: 'sliders', 'table-delete': 'trash',
};

interface TableToolbarProps {
  /** 锚点：表格的视口矩形。工具栏贴在表格外侧，不覆盖表格本身。 */
  anchorLeft: number;
  anchorTop: number;
  anchorBottom: number;
  alignment: ColumnAlignment;
  columns: number;
  onAction: (action: TableAction) => void;
  onClose: () => void;
}

interface ToolbarPlacement { left: number; top: number; placement: 'above' | 'below' }

/**
 * 工具栏优先贴在表格上方，上方放不下就移到下方，两侧都紧张时退回空间更大的一侧并夹回视口。
 *
 * 尺寸必须用实测值：内容会随视口宽度换行成两行，按固定高度预留会把工具栏压到表格上
 * （正在编辑的表头行被盖住）。
 */
function placeToolbar(anchor: { left: number; top: number; bottom: number }, size: { width: number; height: number }): ToolbarPlacement {
  const gap = 12;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.min(size.width, viewportWidth - gap * 2);
  const above = anchor.top - size.height - gap;
  const below = anchor.bottom + gap;
  let placement: 'above' | 'below' = 'above';
  let top = above;
  if (above < gap) {
    placement = 'below';
    top = below;
  }
  if (top + size.height > viewportHeight - gap) {
    const preferAbove = above - gap >= viewportHeight - (anchor.bottom + size.height + gap);
    placement = preferAbove ? 'above' : 'below';
    top = Math.max(gap, Math.min(preferAbove ? above : below, viewportHeight - size.height - gap));
  }
  return { left: Math.max(gap, Math.min(anchor.left, viewportWidth - width - gap)), top, placement };
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
export function TableToolbar({ anchorLeft, anchorTop, anchorBottom, alignment, columns, onAction, onClose }: TableToolbarProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  // 首帧用估计尺寸定位，随后在绘制前按实测尺寸修正（内容换行会改变高度）。
  const [position, setPosition] = useState<ToolbarPlacement>(() => placeToolbar({ left: anchorLeft, top: anchorTop, bottom: anchorBottom }, { width: 620, height: 40 }));
  useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const reposition = () => {
      const rect = element.getBoundingClientRect();
      const next = placeToolbar({ left: anchorLeft, top: anchorTop, bottom: anchorBottom }, { width: rect.width, height: rect.height });
      setPosition(previous => (previous.left === next.left && previous.top === next.top && previous.placement === next.placement ? previous : next));
    };
    reposition();
    // 字体或内容让工具栏换行时尺寸会再变一次，跟随它重新贴边，避免贴出视口。
    const observer = new ResizeObserver(reposition);
    observer.observe(element);
    return () => observer.disconnect();
  }, [anchorLeft, anchorTop, anchorBottom]);

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
      <AppIcon name={actionIcons[entry.action]} size={16} />{entry.label.replace(/[↑↓←→]/g, '')}
    </button>
  );

  return (
    <div
      ref={rootRef}
      className="table-toolbar"
      role="toolbar"
      aria-label="表格操作"
      data-placement={position.placement}
      style={{ left: position.left, top: position.top }}
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
            <AppIcon name={actionIcons[entry.action]} size={16} />{entry.label}
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
          <AppIcon name="sliders" size={16} />整理
        </button>
        <button
          type="button"
          className="table-toolbar-button is-danger"
          title="删除整张表格"
          aria-label="删除整张表格"
          onClick={() => onAction('table-delete')}
        >
          <AppIcon name="trash" size={16} />删表
        </button>
      </div>
      <span className="table-toolbar-hint">Tab 切换单元格 · Enter 新增一行</span>
    </div>
  );
}
