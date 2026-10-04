import { AppIcon } from '../Icons/AppIcon';
import { useShallow } from 'zustand/react/shallow';
import { useMemo } from 'react';
import { useAppStore } from '../../stores/appStore';
import { parseMarkdownHeadings } from '../../utils/markdownOutline';

interface OutlinePanelProps {
  style?: React.CSSProperties;
}

export function OutlinePanel({ style }: OutlinePanelProps) {
  const { content, outlineVisible, setOutlineVisible } = useAppStore(useShallow(state => ({ content: state.content, outlineVisible: state.outlineVisible, setOutlineVisible: state.setOutlineVisible })));

  const headings = useMemo(() => parseMarkdownHeadings(content), [content]);

  if (!outlineVisible) return null;

  const scrollToLine = (line: number) => {
    const { editorView } = useAppStore.getState();
    if (editorView) {
      const pos = editorView.state.doc.line(line).from;
      editorView.dispatch({
        selection: { anchor: pos },
        scrollIntoView: true,
      });
      editorView.focus();
    }
  };

  return (
    <div className="outline-panel" style={style}>
      <div className="outline-panel-header">
        <h3>大纲</h3>
        <button className="outline-close-btn" onClick={() => setOutlineVisible(false)} title="关闭大纲">
          <AppIcon name="close" size={16} /></button>
      </div>
      <div className="outline-panel-content">
        {headings.length === 0 ? (
          <div className="outline-empty">
            <span>文档中未检测到标题</span>
          </div>
        ) : (
          <nav className="outline-list">
            {headings.map((h, i) => (
              <button
                key={i}
                className="outline-item"
                data-level={h.level}
                style={{ paddingLeft: `${12 + (h.level - 1) * 16}px` }}
                onClick={() => scrollToLine(h.line)}
                title={h.text}
              >
                <span className="outline-item-text">{h.text}</span>
              </button>
            ))}
          </nav>
        )}
      </div>
    </div>
  );
}
