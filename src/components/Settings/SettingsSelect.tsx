import { createPortal } from 'react-dom';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import '../../styles/settings-select.css';

export interface SettingsSelectOption {
  value: string;
  label: string;
  description?: string;
  /** 左侧彩色徽标文本（不传则不显示徽标）。 */
  badge?: string;
  /** 徽标背景色。 */
  color?: string;
}

interface SettingsSelectProps {
  value: string;
  options: SettingsSelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
  disabled?: boolean;
  searchPlaceholder?: string;
  /** 追加到根元素的类名，便于外部控制宽度 / 布局。 */
  className?: string;
}

/**
 * 设置面板专用的自定义下拉。
 * 原生 <select> 的展开列表在 WebView 中无法跟随主题，这里改为 portal 渲染的浮层，
 * 支持搜索、键盘导航与选中高亮，风格与设置项输入框保持一致。
 */
export function SettingsSelect({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder = '请选择',
  disabled = false,
  searchPlaceholder = '搜索…',
  className = '',
}: SettingsSelectProps) {
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const [dropStyle, setDropStyle] = useState<CSSProperties>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // 选项较多时才展示搜索框，避免简单下拉显得冗余。
  const showSearch = options.length > 8;
  const selected = options.find((option) => option.value === value);

  const filteredOptions = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    if (!keyword) return options;
    return options.filter((option) =>
      option.label.toLocaleLowerCase().includes(keyword)
      || option.value.toLocaleLowerCase().includes(keyword)
      || (option.description?.toLocaleLowerCase().includes(keyword) ?? false),
    );
  }, [options, query]);

  const selectedIndex = filteredOptions.findIndex((option) => option.value === value);
  const effectiveActiveIndex = activeIndex >= 0 && activeIndex < filteredOptions.length ? activeIndex : selectedIndex;

  const positionDropdown = useCallback(() => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const spaceBelow = window.innerHeight - rect.bottom - 12;
    const spaceAbove = rect.top - 12;
    const openAbove = spaceBelow < 320 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(180, Math.min(400, openAbove ? spaceAbove : spaceBelow));
    setDropStyle({
      position: 'fixed',
      left: rect.left,
      width: rect.width,
      maxHeight,
      ...(openAbove ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
      zIndex: 100200,
    });
  }, []);

  const openDropdown = useCallback(() => {
    setQuery('');
    setActiveIndex(-1);
    positionDropdown();
    setOpen(true);
  }, [positionDropdown]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const reposition = () => positionDropdown();
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, positionDropdown]);

  // 展开时把焦点交给搜索框，方便直接输入过滤。
  useEffect(() => {
    if (open && showSearch) searchRef.current?.focus();
  }, [open, showSearch]);

  // 键盘高亮项滚动到可视区域。
  useEffect(() => {
    if (!open || effectiveActiveIndex < 0) return;
    panelRef.current
      ?.querySelector<HTMLElement>(`[data-option-index="${effectiveActiveIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [open, effectiveActiveIndex]);

  const commit = (nextValue: string) => {
    onChange(nextValue);
    setOpen(false);
  };

  const handleListKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => (filteredOptions.length === 0 ? -1 : index < filteredOptions.length - 1 ? index + 1 : 0));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => (filteredOptions.length === 0 ? -1 : index > 0 ? index - 1 : filteredOptions.length - 1));
    } else if (event.key === 'Enter') {
      if (effectiveActiveIndex >= 0 && filteredOptions[effectiveActiveIndex]) {
        event.preventDefault();
        commit(filteredOptions[effectiveActiveIndex].value);
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    }
  };

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openDropdown();
      }
      return;
    }
    handleListKeyDown(event);
  };

  const renderBadge = (option: SettingsSelectOption) => (
    option.badge
      ? <span className="settings-select-badge" style={option.color ? { background: option.color } : undefined}>{option.badge}</span>
      : null
  );

  const panel = open ? createPortal(
    <div
      ref={panelRef}
      id={listboxId}
      className="settings-select-panel"
      style={dropStyle}
      role="listbox"
      aria-label={ariaLabel}
      onKeyDown={handleListKeyDown}
    >
      {showSearch && (
        <div className="settings-select-search">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="m10.4 10.4 3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input
            ref={searchRef}
            type="text"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(-1);
            }}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      )}
      <div className="settings-select-list">
        {filteredOptions.length === 0 ? (
          <div className="settings-select-empty">未找到匹配项</div>
        ) : filteredOptions.map((option, index) => {
          const isSelected = option.value === value;
          const isActive = index === effectiveActiveIndex;
          return (
            <button
              type="button"
              key={option.value}
              role="option"
              aria-selected={isSelected}
              data-option-index={index}
              className={`settings-select-option${isSelected ? ' is-selected' : ''}${isActive ? ' is-active' : ''}`}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => commit(option.value)}
            >
              {renderBadge(option)}
              <span className="settings-select-option-copy">
                <span className="settings-select-option-label">{option.label}</span>
                {option.description && <small>{option.description}</small>}
              </span>
              <span className="settings-select-check" aria-hidden="true">{isSelected ? '✓' : ''}</span>
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <div ref={rootRef} className={`settings-select${open ? ' is-open' : ''}${disabled ? ' is-disabled' : ''}${className ? ` ${className}` : ''}`}>
      <button
        type="button"
        className="settings-select-trigger"
        onClick={() => (open ? setOpen(false) : openDropdown())}
        onKeyDown={handleTriggerKeyDown}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={ariaLabel}
      >
        {selected ? renderBadge(selected) : null}
        <span className="settings-select-value">{selected ? selected.label : placeholder}</span>
        <svg className="settings-select-caret" viewBox="0 0 16 16" aria-hidden="true">
          <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {panel}
    </div>
  );
}
