/**
 * 围栏代码块的编辑层。
 *
 * 工具栏和文本框参与正常文档布局，代码每次输入立即写回；完成编辑后恢复高亮。
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
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  selection?: { from: number; to: number; preserveFocus?: boolean } | null;
}

export function WysiwygCodeBlock({ index, code, language, onCommit, editing, onEditingChange, selection }: WysiwygCodeBlockProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState(false);
  const [languagesReady, setLanguagesReady] = useState(false);

  useEffect(() => {
    if (editing && !selection?.preserveFocus) textareaRef.current?.focus();
  }, [editing, selection?.preserveFocus]);
  useEffect(() => {
    if (!editing || !selection) return;
    if (!selection.preserveFocus) textareaRef.current?.focus();
    textareaRef.current?.setSelectionRange(selection.from, selection.to);
  }, [editing, selection]);

  return (
    <div className={`wysiwyg-code-layer ${editing ? 'is-editing' : ''}`} contentEditable={false}>
      <div className="wysiwyg-code-toolbar">
        <select value={language} aria-label="代码语言" onFocus={() => setLanguagesReady(true)} onPointerDown={() => setLanguagesReady(true)} onChange={event => onCommit(index, code, event.target.value)}>
          <option value="">纯文本</option>
          {language && (!languagesReady || !HIGHLIGHT_LANGUAGE_NAMES.includes(language)) && <option value={language}>{language}</option>}
          {languagesReady && HIGHLIGHT_LANGUAGE_NAMES.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
        <span />
        <button type="button" onClick={() => { void navigator.clipboard.writeText(code).then(() => setCopied(true)); }}>{copied ? '已复制' : '复制代码'}</button>
        <button type="button" onClick={() => onEditingChange(!editing)}>{editing ? '完成编辑' : '编辑代码'}</button>
      </div>
      {editing ? (
        <textarea
          ref={textareaRef}
          className="wysiwyg-code-editor"
          value={code}
          rows={Math.max(5, code.split('\n').length + 1)}
          spellCheck={false}
          aria-label="编辑代码"
          onChange={(event) => onCommit(index, event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' || ((event.ctrlKey || event.metaKey) && event.key === 'Enter')) {
              event.preventDefault();
              onEditingChange(false);
            } else if (event.key === 'Tab') {
              event.preventDefault();
              const { selectionStart, selectionEnd } = event.currentTarget;
              onCommit(index, code.slice(0, selectionStart) + '  ' + code.slice(selectionEnd));
              requestAnimationFrame(() => textareaRef.current?.setSelectionRange(selectionStart + 2, selectionStart + 2));
            }
          }}
        />
      ) : null}
    </div>
  );
}
