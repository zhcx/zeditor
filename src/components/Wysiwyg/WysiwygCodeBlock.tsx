/**
 * 围栏代码块的编辑层。
 *
 * 它是块外壳里的一个覆盖层（不进入块元素的 DOM）：平时只显示语言选择，点击「编辑代码」后
 * 浮在高亮内容之上提供纯文本编辑；失焦即写回并恢复高亮。
 */
import { useEffect, useRef, useState } from 'react';
import { HIGHLIGHT_LANGUAGE_NAMES } from '../../utils/highlight';

export interface WysiwygCodeBlockProps {
  index: number;
  /** 代码内容（由外层从块源码解析得到）。 */
  code: string;
  /** 当前语言（围栏信息串）。 */
  language: string;
  onCommit: (index: number, code: string, language?: string) => void;
}

export function WysiwygCodeBlock({ index, code, language, onCommit }: WysiwygCodeBlockProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const editing = draft !== null;

  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    if (draft !== code) onCommit(index, draft);
  };

  return (
    <div className={`wysiwyg-code-layer ${editing ? 'is-editing' : ''}`} contentEditable={false}>
      {editing ? (
        <textarea
          ref={textareaRef}
          className="wysiwyg-code-editor"
          value={draft}
          spellCheck={false}
          aria-label="编辑代码"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              commit();
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="wysiwyg-code-entry"
          onClick={() => setDraft(code)}
          title="点击编辑代码"
        >
          编辑代码
        </button>
      )}
      <label className="wysiwyg-code-language">
        <select
          value={language}
          aria-label="代码语言"
          onChange={(event) => onCommit(index, draft ?? code, event.target.value)}
        >
          <option value="">纯文本</option>
          {HIGHLIGHT_LANGUAGE_NAMES.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      </label>
    </div>
  );
}
