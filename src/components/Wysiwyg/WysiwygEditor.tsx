import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../stores/appStore';
import { renderMarkdownSource } from '../../utils/markdownPipeline';
import { sanitizeRenderedHtml } from '../../utils/safeHtml';
import { enhanceRenderedMarkdown } from '../../utils/markdownEnhancers';
import { splitMarkdownDocument, type WysiwygBlock, type WysiwygDocument } from '../../utils/wysiwyg/blocks';

/** 渲染结果按「块类型 + 块源码」缓存：只有被编辑的块需要重新渲染。 */
const blockHtmlCache = new Map<string, string>();
/** 缓存上界：长文档连续编辑会不断产生新键，超限直接整体丢弃，避免内存无界增长。 */
const BLOCK_HTML_CACHE_LIMIT = 600;

function renderBlockHtml(block: WysiwygBlock): string {
  const key = `${block.kind}\u0000${block.source}`;
  const cached = blockHtmlCache.get(key);
  if (cached !== undefined) return cached;
  if (blockHtmlCache.size >= BLOCK_HTML_CACHE_LIMIT) blockHtmlCache.clear();
  const html = sanitizeRenderedHtml(renderMarkdownSource(block.source));
  blockHtmlCache.set(key, html);
  return html;
}

interface WysiwygBlockViewProps {
  block: WysiwygBlock;
  documentPath: string | null;
  workflowViewerEnabled: boolean;
  scrollRoot: HTMLElement | null;
  theme: string;
  onContentRendered?: () => void;
}

const WysiwygBlockView = memo(function WysiwygBlockView({ block, documentPath, workflowViewerEnabled, scrollRoot, theme, onContentRendered }: WysiwygBlockViewProps) {
  const hostRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    host.innerHTML = renderBlockHtml(block);
    return enhanceRenderedMarkdown(host, {
      scrollRoot,
      source: block.source,
      documentPath,
      workflowViewerEnabled,
      theme,
      onContentRendered,
    });
  }, [block, documentPath, onContentRendered, scrollRoot, theme, workflowViewerEnabled]);

  return (
    <section
      ref={hostRef}
      className={`wysiwyg-block ${block.editable ? 'is-editable' : 'is-readonly'}`}
      data-block-kind={block.kind}
      data-source-line={block.startLine}
      contentEditable={false}
    />
  );
});

/** 同内容块共用一份 DOM 的代价是 key 冲突，这里按「类型 + 内容 + 出现序号」稳定编号。 */
function blockKeys(blocks: WysiwygBlock[]): string[] {
  const seen = new Map<string, number>();
  return blocks.map((block) => {
    const base = `${block.kind}:${block.source}`;
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return `${base}#${occurrence}`;
  });
}

export function WysiwygEditor() {
  const { content, currentFile, settings, markEditorBootReady } = useAppStore(useShallow(state => ({
    content: state.content,
    currentFile: state.currentFile,
    settings: state.settings,
    markEditorBootReady: state.markEditorBootReady,
  })));
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [scrollRoot, setScrollRoot] = useState<HTMLElement | null>(null);
  const blockDocument: WysiwygDocument = useMemo(() => splitMarkdownDocument(content), [content]);
  const keys = useMemo(() => blockKeys(blockDocument.blocks), [blockDocument]);
  const isEmpty = blockDocument.blocks.length === 0;
  const theme = document.documentElement.dataset.theme || 'vscode-dark';

  useEffect(() => { setScrollRoot(surfaceRef.current); }, []);
  // 启动页会等编辑区就绪：所见即所得下由这里宣告，避免每次启动白等 3 秒超时。
  useEffect(() => { markEditorBootReady(); }, [markEditorBootReady]);

  return (
    <div className="wysiwyg-surface" ref={surfaceRef} style={{ fontFamily: settings.appearance.font_family }}>
      <article className="wysiwyg-document preview-document markdown-body">
        {blockDocument.blocks.map((block, index) => (
          <WysiwygBlockView
            key={keys[index]}
            block={block}
            documentPath={currentFile}
            workflowViewerEnabled={settings.workflow?.render_in_preview !== false}
            scrollRoot={scrollRoot}
            theme={theme}
          />
        ))}
      </article>
      {isEmpty && (
        <div className="wysiwyg-empty-state">
          <strong>开始写作</strong>
          <span>输入内容即可看到排版结果，Markdown 标记会自动隐藏。</span>
        </div>
      )}
    </div>
  );
}
