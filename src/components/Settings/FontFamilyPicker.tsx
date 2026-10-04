import { AppIcon } from '../Icons/AppIcon';
import { createPortal } from 'react-dom';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

interface FontFamilyPickerProps {
  value: string;
  fontFamilies: string[];
  onChange: (value: string) => void;
  placeholder?: string;
}

export function FontFamilyPicker({ value, fontFamilies, onChange, placeholder }: FontFamilyPickerProps) {
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const [dropStyle, setDropStyle] = useState<React.CSSProperties>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filteredFonts = useMemo(() => {
    const normalized = filterText.trim().toLocaleLowerCase();
    if (!normalized) return fontFamilies;
    return fontFamilies.filter((font) => font.toLocaleLowerCase().includes(normalized));
  }, [filterText, fontFamilies]);
  const effectiveActiveIndex = activeIndex >= 0 && activeIndex < filteredFonts.length ? activeIndex : -1;

  const positionDropdown = useCallback(() => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const spaceBelow = window.innerHeight - rect.bottom - 12;
    const spaceAbove = rect.top - 12;
    const openAbove = spaceBelow < 220 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(160, Math.min(360, openAbove ? spaceAbove : spaceBelow));

    setDropStyle({
      position: 'fixed',
      left: rect.left,
      width: rect.width,
      maxHeight,
      ...(openAbove
        ? { bottom: window.innerHeight - rect.top + 4 }
        : { top: rect.bottom + 4 }),
      zIndex: 100100,
    });
  }, []);

  const openDropdown = useCallback(() => {
    setFilterText('');
    setActiveIndex(-1);
    positionDropdown();
    setOpen(true);
  }, [positionDropdown]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || listRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleMove = () => positionDropdown();
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('scroll', handleMove, true);
    window.addEventListener('resize', handleMove);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('scroll', handleMove, true);
      window.removeEventListener('resize', handleMove);
    };
  }, [open, positionDropdown]);

  useEffect(() => {
    if (effectiveActiveIndex < 0) return;
    listRef.current?.querySelector<HTMLElement>(`[data-font-index="${effectiveActiveIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [effectiveActiveIndex]);

  const selectFont = (font: string) => {
    setFilterText('');
    setActiveIndex(-1);
    onChange(font);
    setOpen(false);
    inputRef.current?.focus();
  };

  const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const nextValue = event.target.value;
    setFilterText(nextValue);
    setActiveIndex(-1);
    onChange(nextValue);
    if (!open) setOpen(true);
    positionDropdown();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open && (event.key === 'ArrowDown' || event.key === 'Enter')) {
      event.preventDefault();
      openDropdown();
      return;
    }

    if (!open) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => index < filteredFonts.length - 1 ? index + 1 : 0);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => index > 0 ? index - 1 : filteredFonts.length - 1);
    } else if (event.key === 'Enter' && effectiveActiveIndex >= 0) {
      event.preventDefault();
      selectFont(filteredFonts[effectiveActiveIndex]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  };

  const dropdown = open ? createPortal(
    <div
      ref={listRef}
      id={listboxId}
      className="font-picker-dropdown"
      style={dropStyle}
      role="listbox"
      aria-label={`本机字体，共 ${filteredFonts.length} 项`}
    >
      <div className="font-picker-summary">
        {filterText ? `找到 ${filteredFonts.length} 个字体` : `全部字体 · ${filteredFonts.length} 个`}
      </div>
      {filteredFonts.length === 0 ? (
        <div className="font-picker-empty">没有匹配的字体</div>
      ) : filteredFonts.map((font, index) => (
        <button
          type="button"
          key={font}
          id={`font-option-${index}`}
          data-font-index={index}
          className={`font-picker-item ${index === effectiveActiveIndex ? 'active' : ''} ${font === value ? 'selected' : ''}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => selectFont(font)}
          onMouseEnter={() => setActiveIndex(index)}
          role="option"
          aria-selected={font === value}
        >
          <span className="font-picker-preview" style={{ fontFamily: font }}>Aa 字</span>
          <span className="font-picker-name">{font}</span>
          {font === value && <span className="font-picker-check" aria-hidden="true"><AppIcon name="check" size={14} /></span>}
        </button>
      ))}
    </div>,
    document.body,
  ) : null;

  return (
    <div className="font-picker" ref={rootRef}>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={handleInputChange}
        onFocus={openDropdown}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={effectiveActiveIndex >= 0 ? `font-option-${effectiveActiveIndex}` : undefined}
        autoComplete="off"
        spellCheck={false}
      />
      <button
        type="button"
        className="font-picker-toggle"
        aria-label={open ? '收起字体列表' : '展开字体列表'}
        aria-expanded={open}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (open) setOpen(false);
          else {
            inputRef.current?.focus();
            openDropdown();
          }
        }}
      >
        <AppIcon name="chevronDown" size={20}  />
      </button>
      {dropdown}
    </div>
  );
}
