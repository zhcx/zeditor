/**
 * 块源码的就地编辑器：占用块自身的位置，工具栏与文本框参与正常文档流。
 *
 * 之前的模态弹窗把编辑动作从文档里摘出去，长内容要在一个居中窗口里看，与
 * 「所见即所得」的上下文脱节。就地编辑保留前后文的滚动位置与排版，
 * 键盘交互与围栏代码块一致：Esc 取消、Ctrl+Enter 保存、Tab 缩进两个空格。
 */
import { useEffect, useRef, useState } from 'react';

export interface BlockSourceEditorProps {
  title: string;
  source: string;
  onApply: (source: string) => void;
  onClose: () => void;
}

export function BlockSourceEditor({ title, source, onApply, onClose }: BlockSourceEditorProps) {
  const [draft, setDraft] = useState(source);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
    textareaRef.current?.setSelectionRange(0, 0);
  }, []);

  return (
    <div className="wysiwyg-source-layer" contentEditable={false}>
      <div className="wysiwyg-source-toolbar">
        <strong>{title}</strong>
        <span>Ctrl+Enter 保存 · Esc 取消</span>
        <button type="button" onClick={onClose}>取消</button>
        <button type="button" className="is-primary" onClick={() => onApply(draft)}>保存</button>
      </div>
      <textarea
        ref={textareaRef}
        className="wysiwyg-source-editor"
        value={draft}
        rows={Math.max(6, draft.split('\n').length + 1)}
        spellCheck={false}
        aria-label={title}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          } else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            onApply(draft);
          } else if (event.key === 'Tab') {
            event.preventDefault();
            const { selectionStart, selectionEnd } = event.currentTarget;
            setDraft(draft.slice(0, selectionStart) + '  ' + draft.slice(selectionEnd));
            requestAnimationFrame(() => textareaRef.current?.setSelectionRange(selectionStart + 2, selectionStart + 2));
          }
        }}
      />
    </div>
  );
}
