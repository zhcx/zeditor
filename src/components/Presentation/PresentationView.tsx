import { useEffect, useRef, useCallback } from 'react';
import Reveal, { type RevealApi } from 'reveal.js';
import 'reveal.js/reveal.css';
import 'reveal.js/theme/white.css';
import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import hljs from '../../utils/highlight';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { useAppStore } from '../../stores/appStore';
import { sanitizeRenderedHtml } from '../../utils/safeHtml';
import { splitMarkdownToSlides } from '../../utils/markdownToSlides';
import '../../styles/presentation.css';
import { open } from '@tauri-apps/plugin-shell';

interface PresentationViewProps {
  onExit: () => void;
}

// 独立的 markdown-it 实例，与 Preview.tsx 保持相同配置
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

// KaTeX 公式渲染，与 Preview.tsx 保持一致
const renderFormula = (tex: string, displayMode: boolean) => {
  try {
    return katex.renderToString(tex.trim(), { displayMode, throwOnError: false, strict: 'warn', trust: false });
  } catch {
    return displayMode ? `$$${tex}$$` : `$${tex}$`;
  }
};

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

export function PresentationView({ onExit }: PresentationViewProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const deckRef = useRef<HTMLDivElement>(null);
  const revealRef = useRef<RevealApi | null>(null);
  const mermaidSequenceRef = useRef(0);
  const onExitRef = useRef(onExit);
  const { content } = useAppStore();

  // 保持最新的退出回调，避免父组件重渲染时演示 deck 被反复重建
  useEffect(() => {
    onExitRef.current = onExit;
  }, [onExit]);

  // Escape 退出演示模式
  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onExitRef.current();
    }
  }, []);

  useEffect(() => {
    const previousFocus = document.activeElement;
    overlayRef.current?.focus();
    // 使用 capture 阶段，确保在 Reveal.js 之前处理 Escape
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [handleKeyDown]);

  useEffect(() => {
    const deckElement = deckRef.current;
    if (!deckElement) return;

    let cancelled = false;

    // 判断暗色主题
    const theme = document.documentElement.dataset.theme || '';
    const isDark = theme.endsWith('-dark');

    // 拆分并渲染幻灯片（跳过空片段，例如连续或结尾的 `---`）
    const slides = splitMarkdownToSlides(content).filter((slide) => slide.trim());
    const slidesContainer = deckElement.querySelector('.slides');
    if (!slidesContainer) return;

    slidesContainer.innerHTML = slides.length > 0
      ? slides
        .map((slideMarkdown) => `<section>${sanitizeRenderedHtml(md.render(renderMath(slideMarkdown)))}</section>`)
        .join('')
      : '<section><p>当前文档没有可演示的内容，使用 --- 分隔幻灯片后再试。</p></section>';

    // 初始化 Reveal.js：Esc 由外层 capture 监听统一处理
    const deck = new Reveal(deckElement, {
      embedded: false,
      hash: false,
      history: false,
      controls: true,
      progress: true,
      center: true,
      transition: 'slide',
      width: 1280,
      height: 720,
      margin: 0.04,
    });

    revealRef.current = deck;

    deck.initialize().then(() => {
      if (cancelled) return;

      // Mermaid 图表延迟渲染
      const mermaidBlocks = deckElement.querySelectorAll('code.language-mermaid');
      if (mermaidBlocks.length === 0) return;

      return import('mermaid').then(async ({ default: mermaid }) => {
        if (cancelled) return;

        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          // 安全清洗会移除 foreignObject，使用 SVG 文字保留节点标签。
          htmlLabels: false,
          theme: isDark ? 'dark' : 'neutral',
        });

        for (const block of mermaidBlocks) {
          if (cancelled) return;
          const code = block.textContent || '';
          const pre = block.parentElement;
          try {
            const { svg } = await mermaid.render(
              `pres-mermaid-${Date.now()}-${mermaidSequenceRef.current++}`,
              code,
            );
            if (cancelled) return;
            if (pre) {
              const wrapper = document.createElement('div');
              wrapper.innerHTML = sanitizeRenderedHtml(
                `<figure class="mermaid-container"><figcaption>Mermaid 图表</figcaption>${svg}</figure>`,
              );
              if (wrapper.firstElementChild) pre.replaceWith(wrapper.firstElementChild);
            }
          } catch (e) {
            console.error('Mermaid render error in presentation:', e);
            if (cancelled) return;
            if (pre) {
              const errorBlock = document.createElement('div');
              errorBlock.className = 'mermaid-error';
              errorBlock.innerHTML = `<strong>图表语法错误</strong><pre>${md.utils.escapeHtml(code)}</pre>`;
              pre.replaceWith(errorBlock);
            }
          }
          // 图表替换会改变幻灯片内容尺寸，需要让 Reveal.js 重新排版
          if (!cancelled) deck.layout();
        }
      });
    }).catch((error: unknown) => {
      if (!cancelled) console.error('演示模式初始化失败:', error);
    });

    return () => {
      cancelled = true;
      try {
        deck.destroy();
      } catch {
        // Reveal.js destroy can throw if not fully initialized
      }
      revealRef.current = null;
    };
  }, [content]);

  return (
    <div className="presentation-overlay" ref={overlayRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="演示模式"
      onClick={(event) => {
        const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
        const href = link?.getAttribute('href');
        if (!href || href.startsWith('#')) return;
        // 外链不能导航当前 WebView，否则会丢失整个编辑器会话。
        event.preventDefault();
        let url: URL;
        try { url = new URL(href, window.location.href); } catch { return; }
        if (!['https:', 'http:', 'mailto:'].includes(url.protocol)) return;
        if ('__TAURI_INTERNALS__' in window) void open(url.href).catch(console.error);
        else window.open(url.href, '_blank', 'noopener,noreferrer');
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const controls = Array.from(overlayRef.current?.querySelectorAll<HTMLElement>('button, a[href], [tabindex="0"]') ?? [])
          .filter((element) => !element.closest('[inert]') && element.getClientRects().length > 0 && !element.matches(':disabled'));
        if (!controls.length) { event.preventDefault(); return; }
        const index = controls.indexOf(document.activeElement as HTMLElement);
        if (index < 0 || (event.shiftKey ? index === 0 : index === controls.length - 1)) {
          event.preventDefault();
          controls[event.shiftKey ? controls.length - 1 : 0].focus();
        }
      }}>
      <button
        className="presentation-exit-btn"
        onClick={onExit}
        title="退出演示模式 (Esc)"
        aria-label="退出演示模式"
      >
        ✕ 退出
      </button>
      <div className="reveal" ref={deckRef}>
        <div className="slides" />
      </div>
    </div>
  );
}
