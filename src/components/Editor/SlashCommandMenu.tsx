import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SlashCommand } from '../../utils/slashCommands';
import { AppIcon } from '../Icons/AppIcon';
import { getCommandIcon } from '../Icons/iconGeometry';

export interface SlashMenuAnchor {
  left: number;
  top: number;
  bottom: number;
}

interface SlashCommandMenuProps {
  anchor: SlashMenuAnchor;
  commands: SlashCommand[];
  selectedIndex: number;
  query: string;
  onSelect: (command: SlashCommand) => void;
  onSelectedIndexChange: (index: number) => void;
  onClose: () => void;
}

const VIEWPORT_GAP = 12;
const CURSOR_GAP = 8;

export function SlashCommandMenu({
  anchor,
  commands,
  selectedIndex,
  query,
  onSelect,
  onSelectedIndexChange,
  onClose,
}: SlashCommandMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({
    left: anchor.left,
    top: anchor.bottom + CURSOR_GAP,
    maxHeight: 420,
  });

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const left = Math.max(VIEWPORT_GAP, Math.min(anchor.left, window.innerWidth - rect.width - VIEWPORT_GAP));
    const roomBelow = Math.max(0, window.innerHeight - anchor.bottom - CURSOR_GAP - VIEWPORT_GAP);
    const roomAbove = Math.max(0, anchor.top - CURSOR_GAP - VIEWPORT_GAP);
    const placeBelow = roomBelow >= Math.min(rect.height, 220) || roomBelow >= roomAbove;
    const maxHeight = Math.max(120, Math.min(420, placeBelow ? roomBelow : roomAbove));
    const top = placeBelow
      ? anchor.bottom + CURSOR_GAP
      : Math.max(VIEWPORT_GAP, anchor.top - Math.min(rect.height, maxHeight) - CURSOR_GAP);
    setPosition({ left, top, maxHeight });
  }, [anchor, commands.length]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener('pointerdown', handlePointerDown, true);
    return () => window.removeEventListener('pointerdown', handlePointerDown, true);
  }, [onClose]);

  useEffect(() => {
    menuRef.current
      ?.querySelector<HTMLElement>(`[data-command-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  return (
    <div
      ref={menuRef}
      className="slash-command-menu"
      style={position}
      role="listbox"
      aria-label="Markdown 快捷命令"
    >
      <div className="slash-command-header">
        <span>{query ? `搜索“${query}”` : '基础块'}</span>
        <span className="slash-command-key-hint">↑↓ 选择 · Enter 插入</span>
      </div>
      <div className="slash-command-list">
        {commands.length > 0 ? commands.map((command, index) => (
          <Fragment key={command.id}>
            {command.dividerBefore && index > 0 && (
              <div className="slash-command-divider" role="separator" />
            )}
            <button
              type="button"
              id={`slash-command-${command.id}`}
              role="option"
              aria-selected={index === selectedIndex}
              data-command-index={index}
              className={`slash-command-item${index === selectedIndex ? ' selected' : ''}`}
              onMouseMove={() => onSelectedIndexChange(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                onSelect(command);
              }}
            >
            <span className="slash-command-icon" aria-hidden="true"><AppIcon name={getCommandIcon(command.id)} /></span>
            <span className="slash-command-copy">
              <strong>{command.title}</strong>
              <small>{command.description}</small>
            </span>
            <span className="slash-command-shortcut">{command.shortcut}</span>
            </button>
          </Fragment>
        )) : (
          <div className="slash-command-empty">没有匹配的命令</div>
        )}
      </div>
      <div className="slash-command-footer"><kbd>Esc</kbd> 关闭 <span>输入文字可筛选</span></div>
    </div>
  );
}
