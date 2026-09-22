import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
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
import {
  findImages,
  formatImageMarkdown,
  parseImageAttributes,
  withImageSize,
  type ImageSpec,
} from '../../utils/imageSyntax';
import { ImagePropertiesModal } from '../Editor/ImagePropertiesModal';
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

/**
 * 图片尺寸语法：`![替代文本](路径){width=320 height=200}`。
 * 属性后缀在 Markdown 里只是紧跟图片的普通文本，这里截掉并挂到 img 上，
 * 让浏览器按指定像素渲染；解析失败时原样保留文本。
 */
md.core.ruler.after('inline', 'image_size_attributes', (state) => {
  state.tokens.forEach((token) => {
    if (token.type !== 'inline' || !token.children) return;
    const children = token.children;
    for (let index = children.length - 2; index >= 0; index -= 1) {
      const child = children[index];
      const next = children[index + 1];
      if (child.type !== 'image' || !next || next.type !== 'text') continue;
      const match = next.content.match(/^\s*\{([^}]*)\}/);
      if (!match) continue;
      const { width, height } = parseImageAttributes(match[1]);
      if (!width && !height) continue;
      if (width) child.attrSet('width', String(width));
      if (height) child.attrSet('height', String(height));
      next.content = next.content.slice(match[0].length);
      if (!next.content) children.splice(index + 1, 1);
    }
  });
});

const isDesktopRuntime = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** 预览表格的列宽只作用于视图：Markdown 没有列宽语义，不写回文档。 */
const tableColumnWidths = new Map<string, number[]>();

function tableLayoutKey(documentPath: string | null, table: HTMLTableElement, index: number): string {
  const header = (table.querySelector('tr')?.textContent || '').trim().slice(0, 120);
  return `${documentPath ?? ''}|${index}|${header}`;
}

function tableColumnCount(table: HTMLTableElement): number {
  return table.querySelectorAll('tr:first-child > *').length;
}

function applyColumnWidths(table: HTMLTableElement, widths: number[]): void {
  const columns = tableColumnCount(table);
  const existing = table.querySelector('colgroup');
  if (!widths.slice(0, columns).some((width) => width > 0)) {
    existing?.remove();
    table.style.removeProperty('table-layout');
    return;
  }

  const colgroup = existing ?? document.createElement('colgroup');
  if (!existing) table.insertBefore(colgroup, table.firstChild);
  while (colgroup.children.length < columns) colgroup.appendChild(document.createElement('col'));
  while (colgroup.children.length > columns) colgroup.lastElementChild?.remove();
  for (let index = 0; index < columns; index += 1) {
    const column = colgroup.children[index];
    if (column instanceof HTMLElement) {
      column.style.width = widths[index] > 0 ? `${Math.round(widths[index])}px` : '';
    }
  }
  table.style.tableLayout = 'fixed';
}

function measureColumnWidths(table: HTMLTableElement): number[] {
  return Array.from(table.querySelectorAll<HTMLTableCellElement>('tr:first-child > *'))
    .map((cell) => Math.round(cell.getBoundingClientRect().width));
}

/** 给表格加列宽拖动把手：拖动改列宽，双击把手恢复该列的自动宽度。 */
function enhanceTables(container: HTMLElement, documentPath: string | null): void {
  Array.from(container.querySelectorAll<HTMLTableElement>('table')).forEach((table, tableIndex) => {
    if (tableColumnCount(table) < 2) return;
    const key = tableLayoutKey(documentPath, table, tableIndex);
    const wrap = document.createElement('div');
    wrap.className = 'table-resize-wrap';
    table.parentElement?.insertBefore(wrap, table);
    wrap.appendChild(table);

    let widths = tableColumnWidths.get(key) ?? [];
    applyColumnWidths(table, widths);

    const handles: HTMLDivElement[] = [];
    const currentWidths = () => (widths.some((width) => width > 0) ? widths.slice() : measureColumnWidths(table));
    const reposition = () => {
      const wrapRect = wrap.getBoundingClientRect();
      const cells = Array.from(table.querySelectorAll<HTMLTableCellElement>('tr:first-child > *'));
      const height = table.getBoundingClientRect().height;
      handles.forEach((handle, index) => {
        const cell = cells[index];
        if (!cell || index === cells.length - 1) {
          handle.style.display = 'none';
          return;
        }
        handle.style.display = 'block';
        handle.style.left = `${cell.getBoundingClientRect().right - wrapRect.left + wrap.scrollLeft}px`;
        handle.style.height = `${Math.max(24, height)}px`;
      });
    };

    for (let index = 0; index < tableColumnCount(table) - 1; index += 1) {
      const handle = document.createElement('div');
      handle.className = 'table-column-handle';
      handle.setAttribute('role', 'separator');
      handle.setAttribute('aria-label', `调整第 ${index + 1} 列宽度`);
      wrap.appendChild(handle);
      handles.push(handle);

      handle.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const startX = event.clientX;
        const startWidths = currentWidths();
        handle.setPointerCapture(event.pointerId);

        const move = (moveEvent: PointerEvent) => {
          const next = startWidths.slice();
          next[index] = Math.max(60, Math.round((startWidths[index] ?? 0) + (moveEvent.clientX - startX)));
          widths = next;
          applyColumnWidths(table, widths);
          reposition();
        };
        const finish = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', finish);
          tableColumnWidths.set(key, widths);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', finish);
      });

      handle.addEventListener('dblclick', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const next = currentWidths();
        next[index] = 0;
        widths = next;
        tableColumnWidths.set(key, next);
        applyColumnWidths(table, next);
        reposition();
      });
    }

    window.requestAnimationFrame(reposition);
  });
}

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
  const [imageEditorIndex, setImageEditorIndex] = useState<number | null>(null);
  const [imageMenu, setImageMenu] = useState<{ x: number; y: number; index: number } | null>(null);
  // DOM 事件监听里需要 React 回调，用 ref 取最新实现，避免重建整个预览。
  const imageInteractionRef = useRef<{
    openEditor: (index: number) => void;
    openMenu: (event: MouseEvent, index: number) => void;
  }>({ openEditor: () => {}, openMenu: () => {} });
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
    imageInteractionRef.current = {
      openEditor: (index) => setImageEditorIndex(index),
      openMenu: (event, index) => setImageMenu({ x: event.clientX, y: event.clientY, index }),
    };
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

    // 图片：本地相对路径先解析成 asset 协议地址，缺失时给出可读提示，
    // 并挂上双击编辑属性与右键尺寸菜单。
    const imageSpecs = findImages(deferredContent);
    const images = Array.from(container.querySelectorAll<HTMLImageElement>('img'));
    const localImageSources = [...new Set(images
      .map((img) => img.getAttribute('src') || '')
      .filter((source) => source && !isRemoteMediaSource(source)))];
    // 浏览器预览模式没有 asset 协议，相对路径只能保持原样，只有桌面端才解析与提示缺失。
    if (isDesktopRuntime && localImageSources.length > 0) {
      void resolveMediaSources(currentFile, localImageSources).then((resolved) => {
        if (disposed) return;
        images.forEach((img) => {
          const source = img.getAttribute('src') || '';
          if (!source || isRemoteMediaSource(source)) return;
          const url = resolved.get(source);
          if (url) {
            img.src = url;
            if (onContentRendered) img.addEventListener('load', onContentRendered);
            return;
          }
          const missing = document.createElement('span');
          missing.className = 'image-embed-missing';
          missing.textContent = `无法读取图片：${source}`;
          const parent = img.parentElement;
          if (parent && parent.tagName === 'P' && parent.childElementCount === 1 && !(parent.textContent || '').trim()) {
            parent.replaceWith(missing);
          } else {
            img.replaceWith(missing);
          }
        });
        onContentRendered?.();
      });
    }

    images.forEach((img) => {
      const source = img.getAttribute('src') || '';
      const alt = img.getAttribute('alt') || '';
      const match = imageSpecs.find((candidate) => candidate.src === source && candidate.alt === alt)
        ?? imageSpecs.find((candidate) => candidate.src === source)
        ?? null;
      if (!match) return;
      const index = imageSpecs.indexOf(match);
      img.dataset.zeditorImageIndex = String(index);
      img.addEventListener('dblclick', (event) => {
        event.preventDefault();
        imageInteractionRef.current.openEditor(index);
      });
      img.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        imageInteractionRef.current.openMenu(event, index);
      });
    });

    enhanceTables(container, currentFile);

    return () => {
      disposed = true;
      observer?.disconnect();
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

  const documentImages = useMemo(() => findImages(content), [content]);
  const editingImage = imageEditorIndex !== null ? documentImages[imageEditorIndex] ?? null : null;
  const menuImage = imageMenu ? documentImages[imageMenu.index] ?? null : null;

  // 图片编辑始终基于最新源码：DOM 事件里的下标只在本次渲染内有效。
  const applyImageSpec = useCallback((index: number, spec: ImageSpec) => {
    const store = useAppStore.getState();
    const editor = store.editorView;
    const match = findImages(store.content)[index];
    if (!editor || !match) return;
    editor.replaceRange(match.from, match.to, formatImageMarkdown(spec));
    editor.focus();
  }, []);

  const resizeImage = useCallback((index: number, width?: number) => {
    const match = findImages(useAppStore.getState().content)[index];
    if (!match) return;
    applyImageSpec(index, withImageSize({
      alt: match.alt,
      src: match.src,
      ...(match.title ? { title: match.title } : {}),
    }, width));
  }, [applyImageSpec]);

  const deleteImage = useCallback((index: number) => {
    const store = useAppStore.getState();
    const editor = store.editorView;
    const match = findImages(store.content)[index];
    if (!editor || !match) return;
    // 图片独占一行时连行一起删除，避免留下一行空白。
    const line = editor.lineAt(match.from);
    const aloneOnLine = line.text.trim() === match.raw.trim();
    editor.replaceRange(
      aloneOnLine ? line.from : match.from,
      aloneOnLine ? Math.min(line.to + 1, editor.getValue().length) : match.to,
      '',
    );
    editor.focus();
  }, []);

  useEffect(() => {
    if (!imageMenu) return undefined;
    const close = () => setImageMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [imageMenu]);

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
      {imageMenu && menuImage && (
        <div
          className="preview-image-menu"
          role="menu"
          aria-label="图片操作"
          style={{
            left: Math.max(8, Math.min(imageMenu.x, window.innerWidth - 180)),
            top: Math.max(8, Math.min(imageMenu.y, window.innerHeight - 230)),
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button type="button" role="menuitem" onClick={() => { resizeImage(imageMenu.index, 240); setImageMenu(null); }}>小 (240px)</button>
          <button type="button" role="menuitem" onClick={() => { resizeImage(imageMenu.index, 420); setImageMenu(null); }}>中 (420px)</button>
          <button type="button" role="menuitem" onClick={() => { resizeImage(imageMenu.index, 640); setImageMenu(null); }}>大 (640px)</button>
          <button type="button" role="menuitem" onClick={() => { resizeImage(imageMenu.index, undefined); setImageMenu(null); }}>原始尺寸</button>
          <div className="preview-image-menu-divider" role="separator" />
          <button type="button" role="menuitem" onClick={() => { setImageEditorIndex(imageMenu.index); setImageMenu(null); }}>编辑属性…</button>
          <button type="button" role="menuitem" onClick={() => { void navigator.clipboard.writeText(menuImage.src); setImageMenu(null); }}>复制路径</button>
          <button type="button" role="menuitem" className="is-danger" onClick={() => { deleteImage(imageMenu.index); setImageMenu(null); }}>删除图片</button>
        </div>
      )}
      {editingImage && (
        <ImagePropertiesModal
          spec={editingImage}
          onApply={(spec) => {
            if (imageEditorIndex !== null) applyImageSpec(imageEditorIndex, spec);
            setImageEditorIndex(null);
          }}
          onClose={() => setImageEditorIndex(null)}
        />
      )}
    </div>
  );
}
