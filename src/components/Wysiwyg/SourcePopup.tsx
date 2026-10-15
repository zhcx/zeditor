/**
 * 非文本块的源码编辑弹窗：表格、Mermaid、Mapmap、SVG、工作流、媒体、块级公式、HTML 块。
 * 用纯文本域而不是 Monaco：这些块的源码通常只有几十行，弹窗不需要完整编辑器能力。
 */
import { useEffect, useRef, useState } from 'react';

export interface SourcePopupProps {
  title: string;
  source: string;
  onApply: (source: string) => void;
  onClose: () => void;
}

export function SourcePopup({ title, source, onApply, onClose }: SourcePopupProps) {
  const [draft, setDraft] = useState(source);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
    textareaRef.current?.setSelectionRange(0, 0);
  }, []);

  return (
    <div className="modal-overlay wysiwyg-source-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="wysiwyg-source-popup" onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}>
        <header>
          <strong>{title}</strong>
          <button type="button" onClick={onClose} aria-label="关闭">✕</button>
        </header>
        <textarea
          ref={textareaRef}
          value={draft}
          spellCheck={false}
          aria-label={title}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
              event.preventDefault();
              onApply(draft);
            }
          }}
        />
        <footer>
          <span>Esc 关闭 · Ctrl+Enter 保存</span>
          <div>
            <button type="button" onClick={onClose}>取消</button>
            <button type="button" className="is-primary" onClick={() => onApply(draft)}>保存</button>
          </div>
        </footer>
      </div>
    </div>
  );
}
