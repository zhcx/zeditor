import { useMemo, useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import { parseMarkdownHeadings } from '../../utils/markdownOutline';

interface ImmersiveOutlineProps {
  width?: number;
  mode: 'immersive' | 'zen';
  collapsed: boolean;
  previewScrollElement?: HTMLDivElement | null;
  onToggle: () => void;
}

export function ImmersiveOutline({
  width,
  mode,
  collapsed,
  previewScrollElement,
  onToggle,
}: ImmersiveOutlineProps) {
  const content = useAppStore((state) => state.content);
  const editorView = useAppStore((state) => state.editorView);
  const headings = useMemo(() => parseMarkdownHeadings(content), [content]);
  const [selectedLine, setSelectedLine] = useState<number | null>(null);

  const selectHeading = (line: number) => {
    setSelectedLine(line);

    if (mode === 'zen' && editorView) {
      const safeLine = Math.max(1, Math.min(line, editorView.state.doc.lines));
      const offset = editorView.state.doc.line(safeLine).from;
      editorView.dispatch({ selection: { anchor: offset }, scrollIntoView: true });
      editorView.revealOffset(offset);
      editorView.focus();
      return;
    }

    const target = previewScrollElement?.querySelector<HTMLElement>(`[data-source-line="${line}"]`);
    if (!previewScrollElement || !target) return;
    const containerRect = previewScrollElement.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const top = previewScrollElement.scrollTop + targetRect.top - containerRect.top - 18;
    previewScrollElement.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  };

  return (
    <aside
      className={`immersive-outline ${collapsed ? 'is-collapsed' : ''}`}
      style={collapsed ? undefined : { width }}
      aria-label="文档大纲"
    >
      {collapsed ? (
        <button
          className="immersive-outline-rail-button"
          type="button"
          onClick={onToggle}
          title="展开大纲"
          aria-label="展开大纲"
          aria-expanded="false"
        >
          <span aria-hidden="true">纲</span>
        </button>
      ) : (
        <>
          <header className="immersive-outline-header">
            <div>
              <strong>文档大纲</strong>
              <span>{headings.length > 0 ? `${headings.length} 个标题` : '快速定位章节'}</span>
            </div>
            <button
              className="immersive-control-button icon-only"
              type="button"
              onClick={onToggle}
              title="收起大纲"
              aria-label="收起大纲"
              aria-expanded="true"
            >
              ‹
            </button>
          </header>
          <div className="immersive-outline-content">
            {headings.length === 0 ? (
              <div className="immersive-outline-empty">
                <span aria-hidden="true">#</span>
                <p>添加 Markdown 标题后，大纲会自动显示在这里。</p>
              </div>
            ) : (
              <nav className="immersive-outline-list" aria-label="标题列表">
                {headings.map((heading, index) => (
                  <button
                    key={`${heading.line}-${index}`}
                    className={`immersive-outline-item ${selectedLine === heading.line ? 'is-active' : ''}`}
                    data-level={heading.level}
                    type="button"
                    onClick={() => selectHeading(heading.line)}
                    title={`${heading.text}（第 ${heading.line} 行）`}
                    style={{ paddingLeft: `${12 + (heading.level - 1) * 12}px` }}
                  >
                    <span className="immersive-outline-marker" aria-hidden="true" />
                    <span>{heading.text}</span>
                  </button>
                ))}
              </nav>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
