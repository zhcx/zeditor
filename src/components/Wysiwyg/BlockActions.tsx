/**
 * 块悬停操作条：块的主要入口——插入、转换、移动、复制、源码编辑与删除。
 * 它是块元素的兄弟节点且 contentEditable=false，不进入「DOM → 源码」的序列化范围。
 * 「在下方插入」「转换为」用与右键菜单同一套子菜单组件，交互与样式保持一致。
 */
import { AppIcon } from '../Icons/AppIcon';
import { ContextSubmenu } from '../Editor/EditorContextMenu';
import { useEffect, useRef, useState } from 'react';
import { BLOCK_INSERT_ITEMS, BLOCK_RETYPE_ITEMS, type BlockInsertKind } from '../../utils/wysiwyg/blockMenu';
import type { BlockRetypeTarget } from '../../utils/wysiwyg/blockOps';
export type { BlockInsertKind } from '../../utils/wysiwyg/blockMenu';
export type { BlockRetypeTarget } from '../../utils/wysiwyg/blockOps';

export interface BlockActionsProps {
  index: number;
  kind: string;
  editable: boolean;
  onEditSource: (index: number) => void;
  onDelete: (index: number) => void;
  onInsertAfter: (index: number, kind: BlockInsertKind) => void;
  onMove: (from: number, to: number) => void;
  onDuplicate: (index: number) => void;
  onRetype: (index: number, target: BlockRetypeTarget) => void;
  count: number;
}

export function BlockActions({ index, kind, editable, onEditSource, onDelete, onInsertAfter, onMove, onDuplicate, onRetype, count }: BlockActionsProps) {
  // 只有承载文本、可以安全改写行首前缀的块才能转换（表格 / 代码块 / HTML 等自带结构）。
  const canRetype = editable && kind !== 'table' && kind !== 'fence' && kind !== 'html' && kind !== 'other';
  const [open, setOpen] = useState(false);
  const [submenu, setSubmenu] = useState<'insert' | 'retype' | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
      setSubmenu(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        setSubmenu(null);
      }
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', escape); };
  }, [open]);
  const run = (action: () => void) => { setOpen(false); setSubmenu(null); action(); };
  // 子菜单靠 hover 展开：点击只负责打开，不做 toggle——否则悬停已经展开时
  // 点一下会立刻收起（toggle 会把 hover 的结果翻回去）。
  const submenuHandlers = (id: 'insert' | 'retype') => ({
    open: submenu === id,
    onToggle: () => setSubmenu(id),
    onHover: (next: boolean) => setSubmenu(current => (next ? id : current === id ? null : current)),
  });
  return (
    <div ref={rootRef} className={`wysiwyg-block-actions${open ? ' is-open' : ''}`} contentEditable={false} onMouseDown={event => event.preventDefault()}>
      <button className="wysiwyg-block-handle" type="button" aria-label={`第 ${index + 1} 块操作`} aria-expanded={open} title="块操作：插入、转换、移动、复制和删除" onClick={() => setOpen(value => !value)}><AppIcon name="grip" size={18} /></button>
      {open && <div className="wysiwyg-block-menu" role="menu" aria-label="块操作">
        <ContextSubmenu label="转换为" icon="heading" direction="right" disabled={!canRetype} {...submenuHandlers('retype')}>
          {BLOCK_RETYPE_ITEMS.map(item => (
            <button key={item.target} type="button" role="menuitem" onClick={() => run(() => onRetype(index, item.target))}>
              <span>{item.label}</span>
            </button>
          ))}
        </ContextSubmenu>
        <ContextSubmenu label="在下方插入" icon="insert" direction="right" {...submenuHandlers('insert')}>
          {BLOCK_INSERT_ITEMS.map(item => (
            <button key={item.kind} type="button" role="menuitem" onClick={() => run(() => onInsertAfter(index, item.kind))}>
              <span>{item.label}</span>
            </button>
          ))}
        </ContextSubmenu>
        <div className="wysiwyg-block-menu-divider" role="separator" />
        <button type="button" role="menuitem" disabled={index === 0} onClick={() => run(() => onMove(index, index - 1))}><AppIcon name="arrowUp" size={14} />上移</button>
        <button type="button" role="menuitem" disabled={index === count - 1} onClick={() => run(() => onMove(index, index + 1))}><AppIcon name="arrowDown" size={14} />下移</button>
        <button type="button" role="menuitem" onClick={() => run(() => onDuplicate(index))}><AppIcon name="copy" size={14} />复制块</button>
        <button type="button" role="menuitem" onClick={() => run(() => onEditSource(index))}><AppIcon name="format" size={14} />编辑块源码</button>
        <div className="wysiwyg-block-menu-divider" role="separator" />
        <button type="button" role="menuitem" className="is-danger" onClick={() => run(() => onDelete(index))}><AppIcon name="trash" size={14} />删除块</button>
      </div>}
    </div>
  );
}
