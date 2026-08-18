import { useCallback, useDeferredValue, useEffect, useRef, useState } from 'react';
import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import hljs from 'highlight.js';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { useAppStore } from '../../stores/appStore';
import { sanitizeRenderedHtml } from '../../utils/safeHtml';
import { findActiveSourceElement } from '../../utils/activeSourceLine';
import { addHeadingAnchors, findLocalHeadingTarget } from '../../utils/headingAnchors';
import { prepareMarkdownSource } from '../../utils/markdownExtensions';
import { FrontmatterPanel } from '../Frontmatter/FrontmatterPanel';

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

function videoEmbedUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      const id = url.pathname.startsWith('/shorts/') ? url.pathname.split('/')[2] : url.searchParams.get('v');
      if (id && /^[\w-]{6,}$/.test(id)) return { src: `https://www.youtube-nocookie.com/embed/${id}`, title: 'YouTube 视频' };
    }
    if (host === 'youtu.be') {
      const id = url.pathname.slice(1).split('/')[0];
      if (id && /^[\w-]{6,}$/.test(id)) return { src: `https://www.youtube-nocookie.com/embed/${id}`, title: 'YouTube 视频' };
    }
    if (host === 'bilibili.com' || host === 'm.bilibili.com' || host === 'b23.tv') {
      const id = url.pathname.match(/\/(BV[\w]+|av\d+)/i)?.[1];
      if (id) {
        const key = id.toLowerCase().startsWith('av') ? `aid=${id.slice(2)}` : `bvid=${id}`;
        return { src: `https://player.bilibili.com/player.html?${key}&high_quality=1`, title: '哔哩哔哩视频' };
      }
    }
    if (host === 'vimeo.com' || host === 'player.vimeo.com') {
      const id = url.pathname.match(/(?:video\/)?(\d+)/)?.[1];
      if (id) return { src: `https://player.vimeo.com/video/${id}`, title: 'Vimeo 视频' };
    }
  } catch { /* Invalid URLs remain regular text. */ }
  return null;
}

function renderVideoExtensions(source: string) {
  let fence = '';
  return source.split('\n').map((line) => {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0];
      else if (fence === fenceMatch[1][0]) fence = '';
      return line;
    }
    if (fence) return line;
    const match = line.trim().match(/^@\[video\]\((https?:\/\/[^\s)]+)\)$/i);
    if (!match) return line;
    const embed = videoEmbedUrl(match[1]);
    if (!embed) return line;
    return `<figure class="video-embed" data-zeditor-video-src="${md.utils.escapeHtml(embed.src)}" data-zeditor-video-title="${embed.title}"><figcaption><a href="${md.utils.escapeHtml(match[1])}" target="_blank" rel="noreferrer">${embed.title}</a></figcaption></figure>`;
  }).join('\n');
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
  const { content, settings, setContent } = useAppStore();
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

    const rendered = sanitizeRenderedHtml(md.render(renderMath(renderVideoExtensions(prepareMarkdownSource(deferredContent)))));
    containerRef.current.innerHTML = rendered;
    addHeadingAnchors(containerRef.current);
    addListItemContentAnchors(containerRef.current);
    onContentRendered?.();

    // Mermaid is imported and rendered only when a diagram is close to the
    // visible preview. A long document can therefore contain many diagrams
    // without blocking initial render or editor input.
    const mermaidBlocks = containerRef.current.querySelectorAll('code.language-mermaid');
    const mermaidPromise = mermaidBlocks.length > 0
      ? import('mermaid').then(({ default: mermaid }) => {
        mermaid.initialize({
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
  }, [deferredContent, mermaidThemeVersion, onContentRendered]);

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

    const target = clickedElement
      ? clickedElement.closest<HTMLElement>('[data-source-line]')
      : null;
    const lineNumber = Number(target?.dataset.sourceLine);
    if (Number.isFinite(lineNumber) && lineNumber > 0) onSourceLineClick?.(lineNumber);
  }, [onSourceLineClick]);

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
        <FrontmatterPanel content={content} onContentChange={setContent} />
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
