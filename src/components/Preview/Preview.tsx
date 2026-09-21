import { useCallback, useDeferredValue, useEffect, useRef, useState } from 'react';
import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import hljs from '../../utils/highlight';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { useAppStore } from '../../stores/appStore';
import { sanitizeRenderedHtml } from '../../utils/safeHtml';
import { findActiveSourceElement } from '../../utils/activeSourceLine';
import { addHeadingAnchors, findLocalHeadingTarget } from '../../utils/headingAnchors';
import {
  findMediaEmbeds,
  isPlatformPageUrl,
  isRemoteMediaSource,
  resolveRenderKind,
  videoPlatformEmbed,
  youtubeEmbedUrl,
  type MediaEmbedMatch,
} from '../../utils/media';
import { resolveMediaSources } from '../../services/mediaAssets';
import { open } from '@tauri-apps/plugin-shell';
import { toggleTaskLine } from '../../utils/taskList';

interface PreviewProps {
  className?: string;
  style?: React.CSSProperties;
  onScrollContainerReady?: (element: HTMLDivElement | null) => void;
  onContentRendered?: () => void;
  activeEditorLine?: number;
  onSourceLineClick?: (lineNumber: number) => void;
}

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  breaks: true,
  highlight: (str, lang) => {
    if (lang === 'mermaid') {
      return `<pre class="hljs"><code class="language-mermaid">${md.utils.escapeHtml(str)}</code></pre>`;
    }
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code class="language-${md.utils.escapeHtml(lang)}">${hljs.highlight(str, { language: lang, ignoreIllegals: true }).value}</code></pre>`;
      } catch {
        // ignore
      }
    }
    return `<pre class="hljs"><code>${md.utils.escapeHtml(str)}</code></pre>`;
  },
});
md.use(taskLists);
const sourceAnchorTokenTypes = new Set([
  'heading_open',
  'paragraph_open',
  'list_item_open',
  'blockquote_open',
  'fence',
  'code_block',
  'table_open',
  'hr',
]);
md.core.ruler.after('block', 'source_line_anchors', (state) => {
  state.tokens.forEach((token) => {
    if (token.map && !token.hidden && sourceAnchorTokenTypes.has(token.type)) {
      token.attrSet('data-source-line', String(token.map[0] + 1));
    }
  });
});
md.renderer.rules.heading_open = (tokens, index, options, _env, self) => {
  const token = tokens[index];
  if (token.map) token.attrSet('data-source-line', String(token.map[0] + 1));
  return self.renderToken(tokens, index, options);
};

function addListItemContentAnchors(container: HTMLElement) {
  // 插件的 enabled 选项是模块级状态，不能影响演示模式的只读任务列表。
  container.querySelectorAll<HTMLInputElement>('li.task-list-item input.task-list-item-checkbox')
    .forEach((checkbox) => { checkbox.disabled = false; });
  container.querySelectorAll<HTMLLIElement>('li[data-source-line]').forEach((item) => {
    // Loose lists already have a paragraph anchor that excludes nested lists.
    if (item.querySelector(':scope > p[data-source-line]')) return;

    const sourceLine = item.dataset.sourceLine;
    const directNodes = Array.from(item.childNodes);
    const nestedListIndex = directNodes.findIndex(
      (node) => node instanceof HTMLElement && (node.tagName === 'UL' || node.tagName === 'OL'),
    );
    const contentNodes = nestedListIndex >= 0 ? directNodes.slice(0, nestedListIndex) : directNodes;
    if (!sourceLine || contentNodes.length === 0) return;

    const anchor = document.createElement('span');
    anchor.className = 'preview-list-item-content';
    anchor.dataset.sourceLine = sourceLine;
    item.insertBefore(anchor, contentNodes[0]);
    contentNodes.forEach((node) => anchor.appendChild(node));
  });
}

/**
 * 媒体语法先替换为占位元素：平台视频交回 safeHtml 重建 iframe，
 * 播放器（video / audio）在渲染完成后按需构建，避免跨进程解析阻塞 Markdown 渲染。
 */
function buildMediaPlaceholder(match: MediaEmbedMatch): string | null {
  // 占位元素随后还要经过公式渲染，属性里的 $ 必须换成实体，
  // 否则 `title="A$B$"` 会被当成行内公式渲染。
  const escape = (value: string) => md.utils.escapeHtml(value).replace(/\$/g, '&#36;');
  const renderKind = resolveRenderKind(match);

  if (renderKind === 'youtube' || renderKind === 'embed') {
    const youtube = youtubeEmbedUrl(match.src);
    const platform = videoPlatformEmbed(match.src)
      ?? (youtube ? { src: youtube, title: 'YouTube 视频' } : null);
    if (platform) {
      return `<figure class="video-embed" data-zeditor-video-src="${escape(platform.src)}" data-zeditor-video-title="${escape(platform.title)}"><figcaption><a href="${escape(match.src)}" target="_blank" rel="noreferrer">${escape(platform.title)}</a></figcaption></figure>`;
    }
  }

  // 平台页面链接拿不到可嵌入的视频 id（例如 b23.tv 短链）时保留原文，
  // 让作者能直接看到并修正语法，而不是显示一个空播放器。
  if (isPlatformPageUrl(match.src)) return null;

  return `<span class="media-embed" data-zeditor-media-key="${match.index}" data-zeditor-media-kind="${renderKind === 'audio' ? 'audio' : 'video'}" data-zeditor-media-src="${escape(match.src)}" data-zeditor-media-title="${escape(match.title ?? '')}" data-zeditor-media-poster="${escape(match.poster ?? '')}" data-source-line="${match.line}"></span>`;
}

function renderMediaPlaceholders(source: string): string {
  const matches = findMediaEmbeds(source);
  if (matches.length === 0) return source;

  let output = source;
  // 从后往前替换，前面的偏移量才不会被前面的替换破坏。
  for (const match of [...matches].reverse()) {
    const placeholder = buildMediaPlaceholder(match);
    if (!placeholder) continue;
    output = output.slice(0, match.from) + placeholder + output.slice(match.to);
  }
  return output;
}

interface MediaPlaceholder {
  node: HTMLElement;
  kind: 'video' | 'audio';
  src: string;
  title: string;
  poster: string;
  line: string;
}

function readMediaPlaceholder(node: HTMLElement): MediaPlaceholder {
  return {
    node,
    kind: node.dataset.zeditorMediaKind === 'audio' ? 'audio' : 'video',
    src: node.dataset.zeditorMediaSrc || '',
    title: node.dataset.zeditorMediaTitle || '',
    poster: node.dataset.zeditorMediaPoster || '',
    line: node.dataset.sourceLine || '',
  };
}

/** 相对路径在示例里可能被编码，标题显示时还原成文件名。 */
function mediaFileName(source: string): string {
  const name = source.split('#')[0].split('?')[0].split(/[\\/]/).pop() || source;
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

function createMediaFigure(
  placeholder: MediaPlaceholder,
  url: string | null,
  posterUrl: string | undefined,
  onReady: () => void,
): HTMLElement {
  const figure = document.createElement('figure');
  figure.className = `media-embed media-embed-${placeholder.kind}`;
  if (placeholder.line) figure.dataset.sourceLine = placeholder.line;

  if (!url) {
    figure.classList.add('is-missing');
    const missing = document.createElement('span');
    missing.className = 'media-embed-missing';
    missing.textContent = `无法读取媒体文件：${placeholder.src}`;
    figure.appendChild(missing);
  } else {
    const player = document.createElement(placeholder.kind === 'audio' ? 'audio' : 'video');
    player.controls = true;
    player.preload = 'metadata';
    player.src = url;
    if (posterUrl && player instanceof HTMLVideoElement) {
      player.poster = posterUrl;
      player.setAttribute('playsinline', '');
    }
    player.addEventListener('loadedmetadata', onReady);
    figure.appendChild(player);
  }

  const caption = document.createElement('figcaption');
  caption.textContent = placeholder.title || mediaFileName(placeholder.src);
  figure.appendChild(caption);
  return figure;
}

const renderFormula = (tex: string, displayMode: boolean) => {
  try {
    return katex.renderToString(tex.trim(), { displayMode, throwOnError: false, strict: 'warn', trust: false });
  } catch {
    return displayMode ? `$$${tex}$$` : `$${tex}$`;
  }
};

// Keep code fences and inline code intact so their dollar signs are never
// interpreted as formulas.
const renderMath = (source: string) => source
  .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g)
  .map((segment, index) => {
    if (index % 2 === 1) return segment;
    return segment.split(/(`[^`\n]*`)/g).map((part, partIndex) => {
      if (partIndex % 2 === 1) return part;
      return part
        .replace(/(^|\n)\$\$\s*([\s\S]*?)\s*\$\$(?=\n|$)/g, (_, prefix, tex) => `${prefix}<div class="katex-block">${renderFormula(tex, true)}</div>`)
        .replace(/(^|\n)\\\[\s*([\s\S]*?)\s*\\\](?=\n|$)/g, (_, prefix, tex) => `${prefix}<div class="katex-block">${renderFormula(tex, true)}</div>`)
        .replace(/\\\((.+?)\\\)/g, (_, tex) => renderFormula(tex, false))
        .replace(/(^|[^\\$])\$([^$\n]+?)\$(?!\$)/g, (_, prefix, tex) => `${prefix}${renderFormula(tex, false)}`);
    }).join('');
  }).join('');

export function Preview({ className, style, onScrollContainerReady, onContentRendered, activeEditorLine = 1, onSourceLineClick }: PreviewProps) {
  const containerRef = useRef<HTMLElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  // CSS variables handle normal Markdown theme changes without touching the
  // document tree. Mermaid SVGs bake their own colors, so only those need a
  // refresh when the theme changes.
  const resolvedThemeRef = useRef(document.documentElement.dataset.theme || 'vscode-dark');
  const contentRef = useRef('');
  const mermaidSequenceRef = useRef(0);
  const [mermaidThemeVersion, setMermaidThemeVersion] = useState(0);
  const { content, settings, currentFile } = useAppStore();
  // Markdown parsing, sanitization and DOM replacement are comparatively
  // expensive. Deferring them keeps Monaco's keystroke updates responsive.
  const deferredContent = useDeferredValue(content);
  const isEmpty = content.trim().length === 0;

  useEffect(() => {
    onScrollContainerReady?.(cardRef.current);
    return () => onScrollContainerReady?.(null);
  }, [onScrollContainerReady]);

  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  useEffect(() => {
    const handleThemeChange = (event: Event) => {
      resolvedThemeRef.current = (event as CustomEvent<string>).detail;

      // Avoid reparsing the entire preview on every theme switch. A full
      // render remains necessary only when rendered Mermaid SVG needs new
      // theme colors.
      if (/```mermaid(?:\s|$)/i.test(contentRef.current)) {
        setMermaidThemeVersion((version) => version + 1);
      }
    };

    window.addEventListener('zeditor-theme-change', handleThemeChange);
    return () => window.removeEventListener('zeditor-theme-change', handleThemeChange);
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;

    const container = containerRef.current;
    const rendered = sanitizeRenderedHtml(md.render(renderMath(renderMediaPlaceholders(deferredContent))));
    container.innerHTML = rendered;
    addHeadingAnchors(container);
    addListItemContentAnchors(container);
    onContentRendered?.();

    // 本地媒体需要先解析成 asset 地址才能播放，解析完成后再替换占位元素。
    const placeholders = Array.from(container.querySelectorAll<HTMLElement>('[data-zeditor-media-key]'));
    if (placeholders.length > 0) {
      const items = placeholders.map(readMediaPlaceholder);
      const localSources = [
        ...items.filter((item) => !isRemoteMediaSource(item.src)).map((item) => item.src),
        ...items.filter((item) => item.poster && !isRemoteMediaSource(item.poster)).map((item) => item.poster),
      ];
      void resolveMediaSources(currentFile, localSources).then((resolved) => {
        if (disposed) return;
        items.forEach((item) => {
          const url = isRemoteMediaSource(item.src) ? item.src : resolved.get(item.src) || null;
          const poster = item.poster
            ? (isRemoteMediaSource(item.poster) ? item.poster : resolved.get(item.poster))
            : undefined;
          const figure = createMediaFigure(item, url, poster, () => onContentRendered?.());
          const parent = item.node.parentElement;
          // 整行只有一条媒体语法时，占位元素所在段落一起替换，避免播放器被段落包裹。
          if (parent && parent.tagName === 'P' && parent.childElementCount === 1 && !(parent.textContent || '').trim()) {
            parent.replaceWith(figure);
          } else {
            item.node.replaceWith(figure);
          }
        });
        onContentRendered?.();
      });
    }

    // Mermaid is imported and rendered only when a diagram is close to the
    // visible preview. A long document can therefore contain many diagrams
    // without blocking initial render or editor input.
    const mermaidBlocks = containerRef.current.querySelectorAll('code.language-mermaid');
    const mermaidPromise = mermaidBlocks.length > 0
      ? import('mermaid').then(({ default: mermaid }) => {
        mermaid.initialize({
          // 安全清洗会移除 foreignObject，使用 SVG 文字保留节点标签。
          htmlLabels: false,
          startOnLoad: false,
          securityLevel: 'strict',
          theme: resolvedThemeRef.current.endsWith('-dark') ? 'dark' : 'neutral',
        });
        return mermaid;
      })
      : null;
    const renderMermaid = async (block: Element) => {
      const code = block.textContent || '';
      try {
        const mermaid = await mermaidPromise!;
        const { svg } = await mermaid.render(`mermaid-${Date.now()}-${mermaidSequenceRef.current++}`, code);
        const pre = block.parentElement;
        if (!disposed && pre) {
          const wrapper = document.createElement('div');
          wrapper.innerHTML = sanitizeRenderedHtml(`<figure class="mermaid-container"><figcaption>Mermaid 图表</figcaption>${svg}</figure>`);
          if (wrapper.firstElementChild) pre.replaceWith(wrapper.firstElementChild);
          onContentRendered?.();
        }
      } catch (e) {
        console.error('Mermaid render error:', e);
        const pre = block.parentElement;
        if (!disposed && pre) {
          const errorBlock = document.createElement('div');
          errorBlock.className = 'mermaid-error';
          errorBlock.innerHTML = `<strong>图表语法错误</strong><pre>${md.utils.escapeHtml(code)}</pre>`;
          pre.replaceWith(errorBlock);
          onContentRendered?.();
        }
      }
    };

    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        observer?.unobserve(entry.target);
        void renderMermaid(entry.target);
      });
    }, { root: cardRef.current, rootMargin: '480px 0px' });

    mermaidBlocks.forEach((block) => {
      if (observer) observer.observe(block);
      else void renderMermaid(block);
    });

    // Handle image clicks for upload
    const images = containerRef.current.querySelectorAll('img');
    images.forEach((img) => {
      if (onContentRendered) img.addEventListener('load', onContentRendered);
      img.addEventListener('click', () => {
        img.setAttribute('data-src', img.src);
      });
    });

    return () => {
      disposed = true;
      observer?.disconnect();
      images.forEach((img) => {
        if (onContentRendered) img.removeEventListener('load', onContentRendered);
      });
    };
  }, [deferredContent, mermaidThemeVersion, onContentRendered, currentFile]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const activeElement = findActiveSourceElement(container, activeEditorLine);
    activeElement?.classList.add('is-active-source-block');

    return () => activeElement?.classList.remove('is-active-source-block');
  }, [activeEditorLine, deferredContent, mermaidThemeVersion]);

  const handleSourceClick = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const clickedElement = event.target instanceof Element ? event.target : null;

    // 播放器自己处理播放、进度与音量点击，预览不再抢走这些操作。
    if (clickedElement?.closest('video, audio')) return;

    // 任务列表交互：点击预览区 checkbox 直接切换编辑器源码中的 [ ] ↔ [x]
    if (clickedElement instanceof HTMLInputElement && clickedElement.matches('input.task-list-item-checkbox')) {
      event.preventDefault();
      const listItem = clickedElement.closest<HTMLElement>('li.task-list-item[data-source-line]');
      const lineNumber = Number(listItem?.dataset.sourceLine);
      const editor = useAppStore.getState().editorView;
      if (Number.isInteger(lineNumber) && lineNumber > 0 && editor
        && editor.getValue() === deferredContent && lineNumber <= editor.state.doc.lines) {
        const line = editor.line(lineNumber);
        // click 发生时浏览器已经切换 checked，源码才是可靠的当前状态。
        const toggled = toggleTaskLine(line.text);
        if (toggled !== line.text) {
          editor.replaceRange(line.from, line.to, toggled);
        }
        return;
      }
      return;
    }

    const localLink = clickedElement?.closest<HTMLAnchorElement>('a[href^="#"]');
    const container = containerRef.current;
    if (localLink && container) {
      const destination = findLocalHeadingTarget(container, localLink.getAttribute('href') || '');
      if (destination) {
        event.preventDefault();
        destination.scrollIntoView({ block: 'start' });
        const destinationLine = Number(destination.dataset.sourceLine);
        if (Number.isFinite(destinationLine) && destinationLine > 0) onSourceLineClick?.(destinationLine);
        return;
      }
    }

    // External links must open in the system browser. Letting the webview
    // follow them would navigate the whole application away from the document.
    const externalLink = clickedElement?.closest<HTMLAnchorElement>('a[href]');
    if (externalLink) {
      const rawHref = externalLink.getAttribute('href') || '';
      if (rawHref && !rawHref.startsWith('#')) {
        event.preventDefault();
        let url: string;
        try {
          url = new URL(rawHref, window.location.href).href;
        } catch {
          url = rawHref;
        }
        if ('__TAURI_INTERNALS__' in window) {
          void open(url).catch(() => window.open(url, '_blank', 'noopener,noreferrer'));
        } else {
          window.open(url, '_blank', 'noopener,noreferrer');
        }
        return;
      }
    }

    const target = clickedElement
      ? clickedElement.closest<HTMLElement>('[data-source-line]')
      : null;
    const lineNumber = Number(target?.dataset.sourceLine);
    if (Number.isFinite(lineNumber) && lineNumber > 0) onSourceLineClick?.(lineNumber);
  }, [onSourceLineClick, deferredContent]);

  const containerStyle: React.CSSProperties = {
    fontFamily: settings.appearance.font_family,
    fontSize: 'var(--font-content-size)',
    lineHeight: settings.appearance.line_height,
  };

  return (
    <div
      className={`preview-container ${className || ''}`}
      style={{ ...containerStyle, ...style }}
    >
      <div ref={cardRef} className={`preview-card ${isEmpty ? 'is-empty' : ''}`}>
        <article ref={containerRef} className="preview-document markdown-body" onClick={handleSourceClick} />
        {isEmpty && (
          <div className="preview-empty-state">
            <span className="preview-empty-mark" aria-hidden="true">↗</span>
            <strong>预览将在这里显示</strong>
            <span>开始写作后，这里会呈现舒适的阅读排版。</span>
          </div>
        )}
      </div>
    </div>
  );
}
