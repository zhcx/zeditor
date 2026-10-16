/**
 * 块悬停操作条：只读块的主要入口（编辑源码），以及所有块的删除与「在下方插入段落」。
 * 它是块元素的兄弟节点且 contentEditable=false，不进入「DOM → 源码」的序列化范围。
 */
import { AppIcon } from '../Icons/AppIcon';
import { useEffect, useRef, useState } from 'react';

export interface BlockActionsProps {
  index: number;
  kind: string;
  editable: boolean;
  onEditSource: (index: number) => void;
  onDelete: (index: number) => void;
  onInsertAfter: (index: number) => void;
  onMove: (from: number, to: number) => void;
  onDuplicate: (index: number) => void;
  count: number;
}

export function BlockActions({ index, onEditSource, onDelete, onInsertAfter, onMove, onDuplicate, count }: BlockActionsProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', escape); };
  }, [open]);
  const run = (action: () => void) => { setOpen(false); action(); };
  return (
    <div ref={rootRef} className={`wysiwyg-block-actions${open ? ' is-open' : ''}`} contentEditable={false} onMouseDown={event => event.preventDefault()}>
      <button className="wysiwyg-block-handle" type="button" aria-label={`第 ${index + 1} 块操作`} aria-expanded={open} title="块操作：移动、复制、插入和删除" onClick={() => setOpen(value => !value)}><AppIcon name="grip" size={17} /></button>
      {open && <div className="wysiwyg-block-menu" role="menu" aria-label="块操作">
        <button type="button" role="menuitem" onClick={() => run(() => onInsertAfter(index))}><AppIcon name="plus" size={14} />在下方插入段落</button>
        <button type="button" role="menuitem" disabled={index === 0} onClick={() => run(() => onMove(index, index - 1))}><AppIcon name="arrowUp" size={14} />上移</button>
        <button type="button" role="menuitem" disabled={index === count - 1} onClick={() => run(() => onMove(index, index + 1))}><AppIcon name="arrowDown" size={14} />下移</button>
        <button type="button" role="menuitem" onClick={() => run(() => onDuplicate(index))}><AppIcon name="copy" size={14} />复制块</button>
        <button type="button" role="menuitem" onClick={() => run(() => onEditSource(index))}><AppIcon name="format" size={14} />编辑块源码</button>
        <button type="button" role="menuitem" className="is-danger" onClick={() => run(() => onDelete(index))}><AppIcon name="trash" size={14} />删除块</button>
      </div>}
    </div>
  );
}
