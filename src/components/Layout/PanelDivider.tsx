import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { resizeFromPointer } from '../../utils/panelSizing';
import './panel-divider.css';

interface PanelDividerProps {
  className: string;
  label: string;
  side: 'before' | 'after' | 'split';
  onChange: (value: number) => void;
  onReset: () => void;
}

interface Drag {
  handle: HTMLDivElement;
  target: HTMLElement;
  other: HTMLElement | null;
  pointerId: number;
  startX: number;
  initial: number;
  total: number;
  min: number;
  max: number;
  clientX: number;
  frame: number;
  cursor: string;
  userSelect: string;
}

export function PanelDivider({ className, label, side, onChange, onReset }: PanelDividerProps) {
  const dragRef = useRef<Drag | null>(null);
  const commitRef = useRef(onChange);
  useEffect(() => { commitRef.current = onChange; }, [onChange]);

  const measure = (handle: HTMLDivElement, clientX: number, pointerId: number): Drag | null => {
    const before = handle.previousElementSibling as HTMLElement | null;
    const after = handle.nextElementSibling as HTMLElement | null;
    const target = side === 'after' ? after : before;
    if (!target) return null;
    const initial = target.getBoundingClientRect().width;
    const total = initial + (side === 'split' ? after?.getBoundingClientRect().width || 0 : 0);
    const documentWidth = Array.from(handle.parentElement?.querySelectorAll('.document-pane, .immersive-document-area') || [])
      .reduce((sum, node) => sum + node.getBoundingClientRect().width, 0);
    return {
      handle, target, other: side === 'split' ? after : null, pointerId,
      startX: clientX, initial, total, clientX, frame: 0,
      min: side === 'split' ? total * 0.1 : Math.min(150, initial * 0.5),
      max: side === 'split' ? total * 0.9 : Math.max(0, initial + documentWidth - 240),
      cursor: document.body.style.cursor, userSelect: document.body.style.userSelect,
    };
  };

  const apply = (drag: Drag): number => {
    const width = resizeFromPointer(drag.initial, drag.startX, drag.clientX, side === 'after' ? -1 : 1, drag.min, drag.max);
    if (side === 'split') {
      const ratio = width / Math.max(1, drag.total);
      drag.target.style.flex = `${ratio} 1 0px`;
      if (drag.other) drag.other.style.flex = `${1 - ratio} 1 0px`;
      return ratio;
    }
    drag.target.style.width = `${width}px`;
    return width;
  };

  const finish = (clientX?: number) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (clientX !== undefined) drag.clientX = clientX;
    cancelAnimationFrame(drag.frame);
    const value = apply(drag);
    dragRef.current = null;
    drag.handle.classList.remove('is-resizing');
    document.documentElement.classList.remove('panel-resizing');
    document.body.style.cursor = drag.cursor;
    document.body.style.userSelect = drag.userSelect;
    if (drag.handle.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
    commitRef.current(value);
  };

  useEffect(() => {
    const blur = () => finish();
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('blur', blur);
      const drag = dragRef.current;
      if (!drag) return;
      cancelAnimationFrame(drag.frame);
      document.documentElement.classList.remove('panel-resizing');
      document.body.style.cursor = drag.cursor;
      document.body.style.userSelect = drag.userSelect;
    };
    // A divider keeps the same side throughout its lifetime. The committed callback uses a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || dragRef.current) return;
    event.preventDefault();
    const drag = measure(event.currentTarget, event.clientX, event.pointerId);
    if (!drag) return;
    dragRef.current = drag;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.classList.add('is-resizing');
    document.documentElement.classList.add('panel-resizing');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  return <div className={`${className} panel-divider`} role="separator" aria-label={label}
    aria-orientation="vertical" tabIndex={0} title={`${label}（拖动调整，双击复位）`}
    onPointerDown={pointerDown}
    onPointerMove={event => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag.clientX = event.clientX;
      if (!drag.frame) drag.frame = requestAnimationFrame(() => { drag.frame = 0; apply(drag); });
    }}
    onPointerUp={event => { if (event.pointerId === dragRef.current?.pointerId) finish(event.clientX); }}
    onPointerCancel={() => finish()} onLostPointerCapture={() => finish()}
    onDoubleClick={onReset}
    onKeyDown={event => {
      if (event.key === 'Home' || event.key === 'Enter') { event.preventDefault(); onReset(); return; }
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const drag = measure(event.currentTarget, 0, -1);
      if (!drag) return;
      drag.clientX = (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 40 : 10);
      onChange(apply(drag));
    }} />;
}
