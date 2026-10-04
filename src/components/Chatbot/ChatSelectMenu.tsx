import { AppIcon } from '../Icons/AppIcon';
import { useEffect, useRef, useState } from 'react';

export interface ChatSelectOption {
  value: string;
  label: string;
  description?: string;
  tone?: 'warning';
}

interface ChatSelectMenuProps {
  value: string;
  label: string;
  options: ChatSelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
  placement?: 'top' | 'bottom';
  footer?: string;
}

export function ChatSelectMenu({
  value,
  label,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  className = '',
  placement = 'bottom',
  footer,
}: ChatSelectMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={`chat-select-menu ${className}`}>
      <button
        type="button"
        className="chat-select-trigger"
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={label}
      >
        <span>{label}</span>
        <AppIcon name="chevronDown" size={20}  />
      </button>
      {open && (
        <div className={`chat-select-popover placement-${placement}`} role="listbox" aria-label={ariaLabel}>
          <div className="chat-select-options">
            {options.map((option) => (
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                className={`${option.value === value ? 'selected' : ''} ${option.tone || ''}`}
                key={option.value}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                <span className="chat-select-option-copy">
                  <strong>{option.label}</strong>
                  {option.description && <small>{option.description}</small>}
                </span>
                <span className="chat-select-check" aria-hidden="true">{option.value === value ? <AppIcon name="check" size={14} /> : ''}</span>
              </button>
            ))}
          </div>
          {footer && <div className="chat-select-footer">{footer}</div>}
        </div>
      )}
    </div>
  );
}
