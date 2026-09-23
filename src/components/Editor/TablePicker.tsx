import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface TablePickerProps {
  /** 触发按钮本身：位置与「点外部关闭」都以它为准。 */
  anchor: HTMLElement;
  onInsert: (rows: number, columns: number) => void;
  onClose: () => void;
  /** 默认尺寸快捷插入：与 Ctrl+Shift+T、功能菜单共用同一套模板。 */
  onInsertDefault: () => void;
  defaultSize?: { rows: number; columns: number };
}

export function TablePicker({
  anchor,
  onInsert,
  onClose,
  onInsertDefault,
  defaultSize = { rows: 3, columns: 3 },
}: TablePickerProps) {
  const [size, setSize] = useState({ rows: 0, columns: 0 });
  const [dragging, setDragging] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number; placement: 'above' | 'below' } | null>(null);
  const maxRows = 8;
  const maxColumns = 10;

  // 位置按锚点按钮实时测量：越界夹取到视口内，下方放不下时翻到按钮上方。
  useLayoutEffect(() => {
    let frame = 0;
    const updatePosition = () => {
      const rect = anchor.getBoundingClientRect();
      const picker = pickerRef.current;
      if (!picker) return;
      const width = picker.offsetWidth || 282;
      const height = picker.offsetHeight || 300;
      const below = rect.bottom + 6;
      const flipsUp = below + height > window.innerHeight - 8 && rect.top >= height + 16;
      setPosition({
        top: flipsUp ? Math.max(8, rect.top - height - 6) : Math.max(8, below),
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        placement: flipsUp ? 'above' : 'below',
      });
    };

    updatePosition();
    // 工具栏可能在同一帧里重新定位，下一帧再量一次可以避免弹层停留在旧位置。
    frame = window.requestAnimationFrame(updatePosition);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [anchor]);

  useEffect(() => {
    const stop = () => setDragging(false);
    document.addEventListener('mouseup', stop);
    return () => document.removeEventListener('mouseup', stop);
  }, []);

  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (pickerRef.current?.contains(target) || anchor.contains(target)) return;
      onClose();
    };

    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, [anchor, onClose]);

  // 单击与拖动都通过 mousedown / mouseenter 更新 size，这里统一按当前 size 插入。
  const handleInsert = () => {
    if (size.rows > 0 && size.columns > 0) onInsert(size.rows, size.columns);
  };

  // 必须挂到 body：浮动工具栏带 transform，会成为 fixed 定位的包含块，导致弹层偏移。
  return createPortal(
    <div
      ref={pickerRef}
      className="table-picker-popover"
      data-placement={position?.placement ?? 'below'}
      style={{
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        visibility: position ? 'visible' : 'hidden',
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="table-picker">
        <div className="table-picker-header"><strong>插入表格</strong><span>{size.rows} × {size.columns}</span></div>
        <div
          className="table-picker-grid"
          onClick={handleInsert}
          onMouseLeave={() => !dragging && setSize({ rows: 0, columns: 0 })}
        >
          {Array.from({ length: maxRows * maxColumns }, (_, index) => {
            const row = Math.floor(index / maxColumns) + 1;
            const column = (index % maxColumns) + 1;
            const active = row <= size.rows && column <= size.columns;
            return (
              <button
                key={index}
                aria-label={`${row}行${column}列`}
                className={active ? 'active' : ''}
                onMouseDown={(event) => {
                  event.preventDefault();
                  setDragging(true);
                  setSize({ rows: row, columns: column });
                }}
                onMouseEnter={() => setSize({ rows: row, columns: column })}
              />
            );
          })}
        </div>
        <div className="table-picker-hint">拖动选择表格大小，松开鼠标插入</div>
        <button type="button" className="table-picker-default" onClick={onInsertDefault}>
          <span>插入 {defaultSize.rows} × {defaultSize.columns} 表格</span>
          <span className="table-picker-shortcut">Ctrl+Shift+T</span>
        </button>
      </div>
    </div>,
    document.body,
  );
}
