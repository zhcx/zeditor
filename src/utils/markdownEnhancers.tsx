/**
 * markdownEnhancers — 渲染后 HTML 的共享增强管线。
 *
 * 预览与所见即所得模式共用：Mermaid、Markmap、SVG 图形、GitHub 工作流、媒体播放器、
 * 图片资源解析、表格列宽与标题锚点都在这里完成。函数返回清理函数，调用方在重新渲染前
 * 必须调用它（断开观察者、卸载挂在被替换 DOM 上的 React 根）。
 *
 * 扩展名是 .tsx：工作流图与思维导图需要挂载 React 根。
 *
 * eslint-disable-next-line 说明：本模块是 DOM 工具（不导出组件），react-refresh 规则
 * 把文件顶部的 lazy 常量当作组件定义而报错；这些内嵌视图不是 HMR 边界，抑制是安全的。
 */
/* eslint-disable react-refresh/only-export-components */
import { Suspense, lazy } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { markdownRenderer, renderMarkdownToHtml } from './markdownPipeline.ts';
import { sanitizeRenderedHtml } from './safeHtml.ts';
import { addHeadingAnchors } from './headingAnchors.ts';
import { hasWorkflowShape } from './workflowShape.ts';
import { MARKMAP_FENCE_SELECTOR } from './markmapSource.ts';
import { isRemoteMediaSource } from './media.ts';
import { findImages } from './imageSyntax.ts';
import { resolveMediaSources } from '../services/mediaAssets';
import { resolveWikiLinkTargets } from '../services/wikiLinks';

// 工作流查看器（含 YAML 解析器）与思维导图只在真的遇到时加载。
const WorkflowViewer = lazy(() => import('../components/WorkflowViewer/WorkflowViewer').then(m => ({ default: m.WorkflowViewer })));
const MarkmapViewer = lazy(() => import('../components/MarkmapViewer/MarkmapViewer').then(m => ({ default: m.MarkmapViewer })));

/** Markdown 代码围栏里可被识别为工作流的语言标记。 */
const WORKFLOW_FENCE_SELECTOR = 'code.language-yaml, code.language-yml, code.language-github-actions-workflow';

const isDesktopRuntime = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** 预览表格的列宽只作用于视图：Markdown 没有列宽语义，不写回文档。 */
const tableColumnWidths = new Map<string, number[]>();

function tableLayoutKey(documentPath: string | null, table: HTMLTableElement, index: number): string {
  const header = (table.querySelector('tr')?.textContent || '').trim().slice(0, 120);
  return `${documentPath ?? ''}|${index}|${header}`;
}

function tableColumnCount(table: HTMLTableElement): number {
  // 必须取 rows[0] 而不是 `tr:first-child`：thead 和 tbody 的首行都满足
  // :first-child，选择器会数出两倍列，colgroup 里多出的 col 会让浏览器
  // 把表格撑满容器并按比例压缩列宽，拖动也就改不到真正的列。
  return table.rows[0]?.cells.length ?? 0;
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
  return Array.from(table.rows[0]?.cells ?? [])
    .map((cell) => Math.round(cell.getBoundingClientRect().width));
}

/** 给表格加列宽拖动把手：拖动改列宽，双击把手恢复该列的自动宽度。 */
function enhanceTables(container: HTMLElement, documentPath: string | null): () => void {
  const tables = Array.from(container.querySelectorAll<HTMLTableElement>('table'));
  if (tables.length === 0) return () => {};
  const cleanups: Array<() => void> = [];
  // Measure visible tables together, then write handle positions together. Reading
  // after each table's writes forces the entire document to lay out repeatedly.
  const pending = new Map<HTMLElement, () => () => void>();
  const measures = new Map<HTMLElement, () => () => void>();
  const visible = new Set<HTMLElement>();
  let frame = 0;
  const schedule = (wrap: HTMLElement) => {
    const measure = measures.get(wrap);
    if (!measure || !visible.has(wrap)) return;
    pending.set(wrap, measure);
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const writes = [...pending.values()].map(read => read());
      pending.clear();
      writes.forEach(write => write());
    });
  };
  const visibility = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
    for (const entry of entries) {
      const wrap = entry.target as HTMLElement;
      if (entry.isIntersecting) { visible.add(wrap); schedule(wrap); }
      else { visible.delete(wrap); pending.delete(wrap); }
    }
  }, { rootMargin: '500px' });
  tables.forEach((table, tableIndex) => {
    if (tableColumnCount(table) < 2) return;
    const key = tableLayoutKey(documentPath, table, tableIndex);
    const wrap = document.createElement('div');
    wrap.className = 'table-resize-wrap';
    table.parentElement?.insertBefore(wrap, table);
    wrap.appendChild(table);

    let widths = (tableColumnWidths.get(key) ?? []).slice(0, tableColumnCount(table));
    applyColumnWidths(table, widths);

    const handles: HTMLDivElement[] = [];
    // 拖动起点永远取当前渲染宽度：手柄按渲染位置摆放，若沿用上次写入的
    // 设置值，起点会和手柄所在的实际边界脱节，越拖偏差越大。
    const currentWidths = () => measureColumnWidths(table);
    const measurePosition = () => {
      const wrapRect = wrap.getBoundingClientRect();
      const cells = Array.from(table.rows[0]?.cells ?? []);
      const tableRect = table.getBoundingClientRect();
      const overflow = tableRect.width > wrap.clientWidth + 1;
      const positions = cells.map(cell => cell.getBoundingClientRect().right - wrapRect.left + wrap.scrollLeft);
      return () => {
        wrap.classList.toggle('is-scrollable', overflow);
        handles.forEach((handle, index) => {
          handle.style.display = index < positions.length ? 'block' : 'none';
          handle.style.left = `${positions[index] || 0}px`;
          handle.style.height = `${Math.max(24, tableRect.height)}px`;
        });
      };
    };
    const reposition = () => measurePosition()();
    measures.set(wrap, measurePosition);

    // 每列一个右边界手柄：列与列之间 + 最右列的右边缘都能拖动调宽。
    for (let index = 0; index < tableColumnCount(table); index += 1) {
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
        schedule(wrap);
      });
    }

    // 首次定位之外，字体加载、分栏拖宽、窗口缩放等后续布局变化都会改变
    // 列边界，手柄必须跟着重摆，否则会停在过期位置上。
    let repositionObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      repositionObserver = new ResizeObserver(() => {
        if (!wrap.isConnected) {
          repositionObserver?.disconnect();
          return;
        }
        schedule(wrap);
      });
      repositionObserver.observe(wrap);
    }
    if (visibility) visibility.observe(wrap);
    else { visible.add(wrap); schedule(wrap); }
    cleanups.push(() => {
      repositionObserver?.disconnect();
      visibility?.unobserve(wrap);
      if (wrap.parentNode) { wrap.parentNode.insertBefore(table, wrap); wrap.remove(); }
    });
  });
  return () => {
    cancelAnimationFrame(frame);
    visibility?.disconnect();
    pending.clear();
    measures.clear();
    cleanups.forEach(cleanup => cleanup());
  };
}

function addListItemContentAnchors(container: HTMLElement) {
  // 插件的 enabled 选项是模块级状态，不能影响演示模式的只读任务列表。
  container.querySelectorAll<HTMLInputElement>('li.task-list-item input.task-list-item-checkbox')
    .forEach((checkbox) => { checkbox.disabled = false; });
  container.querySelectorAll<HTMLLIElement>('li[data-source-line]').forEach((item) => {
    // Loose lists already have a paragraph anchor that excludes nested lists.
    if (item.querySelector(':scope > p[data-source-line], :scope > .preview-list-item-content')) return;

    const sourceLine = item.dataset.sourceLine;
    const directNodes = Array.from(item.childNodes);
    const nestedListIndex = directNodes.findIndex(
      (node) => node instanceof HTMLElement && ['UL', 'OL', 'BLOCKQUOTE', 'PRE', 'TABLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(node.tagName),
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

export interface EnhanceRenderedMarkdownOptions {
  /** 内容所在的可滚动容器（IntersectionObserver 的 root）；为空时用视口。 */
  scrollRoot: HTMLElement | null;
  /** 本次渲染所用的 Markdown 源码：图片语法定位与工作流行号换算都基于它。 */
  source: string;
  /** 当前文档路径：图片/媒体资源解析与表格列宽记忆的键。 */
  documentPath: string | null;
  /** `settings.workflow.render_in_preview`：关闭后 yaml 围栏保持代码块。 */
  workflowViewerEnabled: boolean;
  /** 当前解析后的主题 id，用于 Mermaid 主题选择。 */
  theme: string;
  /** 渲染或布局变化后通知调用方（滚动同步、内容高度测量）。 */
  onContentRendered?: () => void;
  /** 工作流图内「跳转」回调，参数为 1 起的源码行号（相对传入的 source）。 */
  onJumpToLine?: (lineNumber: number) => void;
  /** 提供后，图片双击打开属性编辑。 */
  onOpenImageEditor?: (index: number) => void;
  /** 提供后，图片右键打开尺寸菜单。 */
  onOpenImageMenu?: (event: MouseEvent, index: number) => void;
  /**
   * 解析失败的图片保持 `<img>` 原样（加 `is-unresolved` 类与标题），不替换成提示文本。
   * 所见即所得表面必须开启：替换成文本后「DOM → 源码」回写会丢掉图片。
   */
  keepUnresolvedImages?: boolean;
}

/**
 * 脚注悬停预览：引用旁弹出定义内容，不需要跳到文末。
 *
 * 浮层挂在 body 上，既不会被 contenteditable 回写，也不会被预览容器的
 * overflow 裁剪；鼠标移入浮层时暂停隐藏，滚动或缩放时立即收起。
 */
function enhanceFootnotes(root: HTMLElement): () => void {
  const references = Array.from(root.querySelectorAll<HTMLElement>('.footnote-ref[data-footnote-name]'));
  if (references.length === 0) return () => undefined;

  let popover: HTMLElement | null = null;
  let hideTimer = 0;
  const removePopover = () => {
    if (!popover) return;
    popover.remove();
    popover = null;
  };
  const hide = () => {
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(removePopover, 120);
  };
  const cancelHide = () => window.clearTimeout(hideTimer);

  const position = (reference: HTMLElement) => {
    if (!popover) return;
    const rect = reference.getBoundingClientRect();
    const width = Math.min(380, window.innerWidth - 16);
    popover.style.width = `${width}px`;
    popover.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    // 先按下方定位并测量真实高度，放不下再翻到上方。
    popover.style.top = `${rect.bottom + 8}px`;
    const height = popover.offsetHeight;
    const staysBelow = rect.bottom + height + 16 <= window.innerHeight || rect.top < height + 16;
    const top = staysBelow
      ? Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - height - 8))
      : rect.top - height - 8;
    popover.style.top = `${Math.max(8, top)}px`;
  };

  const show = (reference: HTMLElement) => {
    cancelHide();
    removePopover();
    const name = reference.dataset.footnoteName ?? '';
    const content = reference.dataset.footnoteContent;
    const title = `<div class="footnote-popover-title">脚注 ${markdownRenderer.utils.escapeHtml(name)}</div>`;
    const body = content === undefined
      ? '<div class="footnote-popover-empty">未找到脚注定义</div>'
      : `<div class="footnote-popover-body markdown-body">${renderMarkdownToHtml(content)}</div>`;
    popover = document.createElement('div');
    popover.className = 'footnote-popover';
    popover.setAttribute('role', 'tooltip');
    popover.innerHTML = title + body;
    popover.addEventListener('pointerenter', cancelHide);
    popover.addEventListener('pointerleave', hide);
    document.body.append(popover);
    position(reference);
  };

  const cleanups: Array<() => void> = [];
  for (const reference of references) {
    const enter = () => show(reference);
    const leave = () => hide();
    reference.addEventListener('pointerenter', enter);
    reference.addEventListener('pointerleave', leave);
    reference.addEventListener('focus', enter);
    reference.addEventListener('blur', leave);
    cleanups.push(() => {
      reference.removeEventListener('pointerenter', enter);
      reference.removeEventListener('pointerleave', leave);
      reference.removeEventListener('focus', enter);
      reference.removeEventListener('blur', leave);
    });
  }

  const closeOnViewportChange = () => {
    cancelHide();
    removePopover();
  };
  window.addEventListener('scroll', closeOnViewportChange, true);
  window.addEventListener('resize', closeOnViewportChange);

  return () => {
    window.clearTimeout(hideTimer);
    removePopover();
    cleanups.forEach(cleanup => cleanup());
    window.removeEventListener('scroll', closeOnViewportChange, true);
    window.removeEventListener('resize', closeOnViewportChange);
  };
}

let mermaidSequence = 0;

/** 对已写入 root 的渲染结果做增强，返回清理函数（断开观察者、卸载 React 根）。 */
export function enhanceRenderedMarkdown(root: HTMLElement, options: EnhanceRenderedMarkdownOptions): () => void {
  let disposed = false;
  const notify = () => options.onContentRendered?.();
  const workflowRoots: Root[] = [];
  const markmapRoots: Root[] = [];
  let mermaidObserver: IntersectionObserver | null = null;
  let workflowObserver: IntersectionObserver | null = null;
  let markmapObserver: IntersectionObserver | null = null;

  addHeadingAnchors(root);
  addListItemContentAnchors(root);

  // Wiki 链接存在性：解析失败的链接画成虚线，点击时再给出提示。
  // 结果有 30 秒缓存，输入期间同一批目标不会反复扫盘。
  const wikiLinks = Array.from(root.querySelectorAll<HTMLElement>('.wiki-link[data-wiki-target]'));
  if (wikiLinks.length > 0) {
    void resolveWikiLinkTargets(options.documentPath, wikiLinks.map(link => link.dataset.wikiTarget ?? ''))
      .then((resolved) => {
        if (disposed) return;
        wikiLinks.forEach((link) => {
          const path = resolved.get(link.dataset.wikiTarget ?? '');
          // 非 Tauri 环境返回空表：不做判断，避免把全部链接误标为未解析。
          if (path === undefined) return;
          link.classList.toggle('is-unresolved', path === null);
          if (path) link.dataset.wikiPath = path;
        });
      });
  }

  // 本地媒体需要先解析成 asset 地址才能播放，解析完成后再替换占位元素。
  const placeholders = Array.from(root.querySelectorAll<HTMLElement>('[data-zeditor-media-key]'));
  if (placeholders.length > 0) {
    const items = placeholders.map(readMediaPlaceholder);
    const localSources = [
      ...items.filter((item) => !isRemoteMediaSource(item.src)).map((item) => item.src),
      ...items.filter((item) => item.poster && !isRemoteMediaSource(item.poster)).map((item) => item.poster),
    ];
    void resolveMediaSources(options.documentPath, localSources).then((resolved) => {
      if (disposed) return;
      items.forEach((item) => {
        const url = isRemoteMediaSource(item.src) ? item.src : resolved.get(item.src) || null;
        const poster = item.poster
          ? (isRemoteMediaSource(item.poster) ? item.poster : resolved.get(item.poster))
          : undefined;
        const figure = createMediaFigure(item, url, poster, notify);
        const parent = item.node.parentElement;
        // 整行只有一条媒体语法时，占位元素所在段落一起替换，避免播放器被段落包裹。
        if (parent && parent.tagName === 'P' && parent.childElementCount === 1 && !(parent.textContent || '').trim()) {
          parent.replaceWith(figure);
        } else {
          item.node.replaceWith(figure);
        }
      });
      notify();
    });
  }

  // Mermaid is imported and rendered only when a diagram is close to the
  // visible preview. A long document can therefore contain many diagrams
  // without blocking initial render or editor input.
  const mermaidBlocks = root.querySelectorAll('code.language-mermaid');
  const mermaidPromise = mermaidBlocks.length > 0
    ? import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({
        // 安全清洗会移除 foreignObject，使用 SVG 文字保留节点标签。
        htmlLabels: false,
        startOnLoad: false,
        securityLevel: 'strict',
        theme: options.theme.endsWith('-dark') ? 'dark' : 'neutral',
      });
      return mermaid;
    })
    : null;
  const renderMermaid = async (block: Element) => {
    const code = block.textContent || '';
    try {
      const mermaid = await mermaidPromise!;
      const { svg } = await mermaid.render(`mermaid-${Date.now()}-${mermaidSequence++}`, code);
      const pre = block.parentElement;
      if (!disposed && pre) {
        // Mermaid 输出同样要过一遍净化：它会把节点标签渲染进 SVG。
        const wrapper = document.createElement('div');
        wrapper.innerHTML = sanitizeRenderedHtml(`<figure class="mermaid-container"><figcaption>Mermaid 图表</figcaption>${svg}</figure>`);
        if (wrapper.firstElementChild) pre.replaceWith(wrapper.firstElementChild);
        notify();
      }
    } catch (error) {
      console.error('Mermaid render error:', error);
      const pre = block.parentElement;
      if (!disposed && pre) {
        const errorBlock = document.createElement('div');
        errorBlock.className = 'mermaid-error';
        errorBlock.innerHTML = `<strong>图表语法错误</strong><pre>${markdownRenderer.utils.escapeHtml(code)}</pre>`;
        pre.replaceWith(errorBlock);
        notify();
      }
    }
  };

  if (typeof IntersectionObserver === 'undefined') {
    mermaidBlocks.forEach((block) => void renderMermaid(block));
  } else {
    mermaidObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        mermaidObserver?.unobserve(entry.target);
        void renderMermaid(entry.target);
      });
    }, { root: options.scrollRoot, rootMargin: '480px 0px' });
    mermaidBlocks.forEach((block) => mermaidObserver?.observe(block));
  }

  // SVG 图形：` ```svg ` 围栏像 Mermaid 一样二次渲染，但渲染是同步的，
  // 无需懒加载与防抖。校验失败显示「无效 SVG」错误块（参考 VMark 设计）。
  const svgBlocks = root.querySelectorAll('code.language-svg');
  if (svgBlocks.length > 0) {
    void import('./svgFigure.ts').then(({ buildSvgFigureHtml, attachSvgFigureInteractions, createDomSvgParser }) => {
      if (disposed) return;
      const parse = createDomSvgParser();
      svgBlocks.forEach((block) => {
        const pre = block.parentElement;
        if (!pre) return;
        void buildSvgFigureHtml(block.textContent || '', parse).then((result) => {
          if (disposed) return;
          const wrapper = document.createElement('div');
          wrapper.innerHTML = result.html;
          const figure = wrapper.firstElementChild;
          if (figure instanceof HTMLElement) {
            pre.replaceWith(figure);
            if (result.ok) attachSvgFigureInteractions(figure);
            notify();
          }
        });
      });
    });
  }

  // GitHub Actions 工作流：`yaml` 围栏里若是可识别的工作流，就替换为只读
  // 依赖图（与 Mermaid 一样只读、可折叠）。识别需要 YAML 解析器，因此先做
  // 正则预判，命中后再动态导入；非工作流的 YAML 代码块保持原样。
  const renderWorkflowBlock = async (block: HTMLElement) => {
    const source = block.textContent || '';
    const { looksLikeWorkflowYaml } = await import('./githubWorkflow.ts');
    if (disposed) return;
    if (!looksLikeWorkflowYaml(source)) return;
    const pre = block.parentElement;
    if (!pre) return;

    // 代码块输出没有 data-source-line（highlight 返回 pre 时属性会丢失），
    // 这里按块内文本在文档中的偏移换算行号，供诊断跳转使用。
    const offsetInDocument = options.source.indexOf(source);
    const lineOffset = offsetInDocument < 0
      ? 0
      : options.source.slice(0, offsetInDocument).split('\n').length - 1;

    const mount = document.createElement('div');
    mount.className = 'workflow-embed-mount';
    const mountRoot = createRoot(mount);
    mountRoot.render(
      <Suspense fallback={null}>
        <WorkflowViewer
          source={source}
          embedded
          lineOffset={lineOffset}
          onJumpToLine={(line) => options.onJumpToLine?.(line)}
        />
      </Suspense>,
    );
    pre.replaceWith(mount);
    workflowRoots.push(mountRoot);
    notify();
  };

  const workflowBlocks = options.workflowViewerEnabled
    ? Array.from(root.querySelectorAll<HTMLElement>(WORKFLOW_FENCE_SELECTOR))
      .filter(block => hasWorkflowShape(block.textContent || ''))
    : [];
  if (workflowBlocks.length > 0) {
    if (typeof IntersectionObserver === 'undefined') {
      workflowBlocks.forEach((block) => void renderWorkflowBlock(block));
    } else {
      workflowObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          workflowObserver?.unobserve(entry.target);
          void renderWorkflowBlock(entry.target as HTMLElement);
        });
      }, { root: options.scrollRoot, rootMargin: '480px 0px' });
      workflowBlocks.forEach((block) => workflowObserver?.observe(block));
    }
  }

  // Markmap 思维导图：```markmap 围栏里的 Markdown 标题层级渲染成可交互 SVG 树
  // （拖动平移、Ctrl + 滚轮缩放、点击圆圈折叠）。与内联工作流图一样先靠近视口
  // 才挂载 React 根，重渲染前必须卸载，否则会随输入不断累积实例。
  const renderMarkmapBlock = (block: HTMLElement) => {
    const source = block.textContent || '';
    if (!source.trim()) return;
    const pre = block.parentElement;
    if (!pre) return;

    const mount = document.createElement('div');
    mount.className = 'markmap-embed-mount';
    const mountRoot = createRoot(mount);
    mountRoot.render(
      <Suspense fallback={null}>
        <MarkmapViewer source={source} embedded title={options.documentPath ?? undefined} />
      </Suspense>,
    );
    pre.replaceWith(mount);
    markmapRoots.push(mountRoot);
    notify();
  };

  const markmapBlocks = Array.from(root.querySelectorAll<HTMLElement>(MARKMAP_FENCE_SELECTOR));
  if (markmapBlocks.length > 0) {
    if (typeof IntersectionObserver === 'undefined') {
      markmapBlocks.forEach((block) => renderMarkmapBlock(block));
    } else {
      markmapObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          markmapObserver?.unobserve(entry.target);
          renderMarkmapBlock(entry.target as HTMLElement);
        });
      }, { root: options.scrollRoot, rootMargin: '480px 0px' });
      markmapBlocks.forEach((block) => markmapObserver?.observe(block));
    }
  }

  // 图片：本地相对路径先解析成 asset 协议地址，缺失时给出可读提示，
  // 并挂上双击编辑属性与右键尺寸菜单。
  const imageSpecs = findImages(options.source);
  const images = Array.from(root.querySelectorAll<HTMLImageElement>('img'));
  const localImageSources = [...new Set(images
    .map((img) => img.getAttribute('src') || '')
    .filter((source) => source && !isRemoteMediaSource(source)))];
  // 浏览器预览模式没有 asset 协议，相对路径只能保持原样，只有桌面端才解析与提示缺失。
  if (isDesktopRuntime && localImageSources.length > 0) {
    void resolveMediaSources(options.documentPath, localImageSources).then((resolved) => {
      if (disposed) return;
      images.forEach((img) => {
        const source = img.getAttribute('src') || '';
        if (!source || isRemoteMediaSource(source)) return;
        // 记住原始路径：src 会被改写成 asset 地址，但回写源码要用原始路径。
        img.dataset.mdSrc = source;
        const url = resolved.get(source);
        if (url) {
          img.src = url;
          if (options.onContentRendered) img.addEventListener('load', notify);
          return;
        }
        if (options.keepUnresolvedImages) {
          img.classList.add('is-unresolved');
          img.title = `无法读取图片：${source}`;
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
      notify();
    });
  }

  if (options.onOpenImageEditor || options.onOpenImageMenu) {
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
        options.onOpenImageEditor?.(index);
      });
      img.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        options.onOpenImageMenu?.(event, index);
      });
    });
  }

  const cleanupTables = enhanceTables(root, options.documentPath);
  const cleanupFootnotes = enhanceFootnotes(root);

  return () => {
    disposed = true;
    cleanupTables();
    cleanupFootnotes();
    mermaidObserver?.disconnect();
    workflowObserver?.disconnect();
    markmapObserver?.disconnect();
    // 内联工作流图与思维导图挂在被替换的 DOM 上，清理时必须同时卸载 React 根。
    workflowRoots.forEach((workflowRoot) => workflowRoot.unmount());
    markmapRoots.forEach((markmapRoot) => markmapRoot.unmount());
  };
}
