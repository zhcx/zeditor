import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface ToolbarMenuItem {
  label: string;
  action: () => void | Promise<void>;
  /** 显示在右侧的快捷键提示。 */
  shortcut?: string;
}

interface ToolbarMenuProps {
  label: string;
  title: string;
  items: ToolbarMenuItem[];
}

/**
 * 工具栏下拉菜单：把同类命令收进一个按钮。
 * 弹层挂在 body 上（工具栏本身会裁剪溢出内容），位置按触发按钮实时测量，
 * 越界时夹取到视口内，下方空间不足时翻到按钮上方。
 */
export function ToolbarMenu({ label, title, items }: ToolbarMenuProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number; placement: 'above' | 'below' } | null>(null);

  useLayoutEffect(() => {
    if (!open) return undefined;
    let frame = 0;
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      const menu = menuRef.current;
      if (!rect || !menu) return;
      const width = menu.offsetWidth || 220;
      const height = menu.offsetHeight || items.length * 30 + 12;
      const below = rect.bottom + 6;
      const flipsUp = below + height > window.innerHeight - 8 && rect.top >= height + 16;
      setPosition({
        top: flipsUp ? Math.max(8, rect.top - height - 6) : Math.max(8, below),
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        placement: flipsUp ? 'above' : 'below',
      });
    };

    updatePosition();
    // 浮动工具栏可能在同一帧里重新定位，下一帧再量一次避免弹层错位。
    frame = window.requestAnimationFrame(updatePosition);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, items.length]);

  const close = useCallback(() => {
    setOpen(false);
    setPosition(null);
    setActiveIndex(0);
  }, []);

  useEffect(() => {
    if (!open) return undefined;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close();
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        setActiveIndex((index) => (index + direction + items.length) % items.length);
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const item = items[activeIndex];
        close();
        if (item) void item.action();
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    // capture 阶段监听：即使焦点留在编辑器里也能响应方向键与 Enter。
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [open, items, activeIndex, close]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="toolbar-btn toolbar-menu-trigger"
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {label}
        <span className="toolbar-menu-caret" aria-hidden="true">▾</span>
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="toolbar-menu"
          role="menu"
          aria-label={title}
          data-placement={position?.placement ?? 'below'}
          style={{
            top: position?.top ?? 0,
            left: position?.left ?? 0,
            visibility: position ? 'visible' : 'hidden',
          }}
          onMouseDown={(event) => event.preventDefault()}
        >
          {items.map((item, index) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="toolbar-menu-item"
              data-active={index === activeIndex}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => {
                close();
                void item.action();
              }}
            >
              <span className="toolbar-menu-item-label">{item.label}</span>
              {item.shortcut && <kbd>{item.shortcut}</kbd>}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
