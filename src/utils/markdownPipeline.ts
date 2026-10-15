/**
 * markdownPipeline — Markdown 源码的共享渲染管线。
 *
 * 预览与所见即所得编辑模式共用同一个 MarkdownIt 实例与同一组规则，确保两处排版完全一致。
 * 除 renderMarkdownToHtml 里的 DOMPurify 外，模块不依赖 DOM，因此 renderMarkdownSource
 * 可以直接在 node:test 中断言输出。
 */
import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import katex from 'katex';
// 相对导入带 .ts 扩展名：本模块会被 node:test 直接加载（仓库约定，见 tsconfig 的
// allowImportingTsExtensions 与 utils/markdownLint.ts），Node 的 ESM 解析要求显式扩展名。
import hljs from './highlight.ts';
import { parseImageAttributes } from './imageSyntax.ts';
import {
  findMediaEmbeds,
  isPlatformPageUrl,
  resolveRenderKind,
  videoPlatformEmbed,
  youtubeEmbedUrl,
  type MediaEmbedMatch,
} from './media.ts';
import { sanitizeRenderedHtml } from './safeHtml.ts';

export const markdownRenderer = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  breaks: true,
  highlight: (str, lang) => highlightFence(str, lang),
});
markdownRenderer.use(taskLists);

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
markdownRenderer.core.ruler.after('block', 'source_line_anchors', (state) => {
  state.tokens.forEach((token) => {
    if (token.map && !token.hidden && sourceAnchorTokenTypes.has(token.type)) {
      token.attrSet('data-source-line', String(token.map[0] + 1));
    }
  });
});
markdownRenderer.renderer.rules.heading_open = (tokens, index, options, _env, self) => {
  const token = tokens[index];
  if (token.map) token.attrSet('data-source-line', String(token.map[0] + 1));
  return self.renderToken(tokens, index, options);
};

/**
 * 图片尺寸语法：`![替代文本](路径){width=320 height=200}`。
 * 属性后缀在 Markdown 里只是紧跟图片的普通文本，这里截掉并挂到 img 上，
 * 让浏览器按指定像素渲染；解析失败时原样保留文本。
 */
markdownRenderer.core.ruler.after('inline', 'image_size_attributes', (state) => {
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

/** 代码围栏高亮；特殊围栏保留语言 class，交给预览的二次渲染接管。 */
function highlightFence(str: string, lang: string): string {
  const escape = markdownRenderer.utils.escapeHtml;
  if (lang === 'mermaid') {
    return `<pre class="hljs"><code class="language-mermaid">${escape(str)}</code></pre>`;
  }
  if (lang === 'markmap') {
    return `<pre class="hljs"><code class="language-markmap">${escape(str)}</code></pre>`;
  }
  if (lang === 'svg') {
    // SVG 图形围栏：保留源码交给二次渲染（校验 + 净化后内联显示）。
    return `<pre class="hljs"><code class="language-svg">${escape(str)}</code></pre>`;
  }
  if (lang && hljs.getLanguage(lang)) {
    try {
      return `<pre class="hljs"><code class="language-${escape(lang)}">${hljs.highlight(str, { language: lang, ignoreIllegals: true }).value}</code></pre>`;
    } catch {
      // ignore
    }
  }
  return `<pre class="hljs"><code>${escape(str)}</code></pre>`;
}

/**
 * 媒体语法先替换为占位元素：平台视频交回 safeHtml 重建 iframe，
 * 播放器（video / audio）在渲染完成后按需构建，避免跨进程解析阻塞 Markdown 渲染。
 */
function buildMediaPlaceholder(match: MediaEmbedMatch): string | null {
  // 占位元素随后还要经过公式渲染，属性里的 $ 必须换成实体，
  // 否则 `title="A$B$"` 会被当成行内公式渲染。
  const escape = (value: string) => markdownRenderer.utils.escapeHtml(value).replace(/\$/g, '&#36;');
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

export function renderMediaPlaceholders(source: string): string {
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

const escapeAttribute = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/"/g, '&quot;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

/**
 * 公式渲染。
 *
 * 输出上带 `data-tex`：所见即所得要在渲染结果上编辑，回写源码时必须能还原 TeX，
 * 而 KaTeX 的 DOM 结构无法反推。
 */
export const renderFormula = (tex: string, displayMode: boolean): string => {
  const source = tex.trim();
  const attribute = `data-tex="${escapeAttribute(source)}"`;
  try {
    return `<span class="zeditor-math" ${attribute}>${katex.renderToString(source, { displayMode, throwOnError: false, strict: 'warn', trust: false })}</span>`;
  } catch {
    return `<span class="zeditor-math" ${attribute}>${displayMode ? `$$${source}$$` : `$${source}$`}</span>`;
  }
};

// Keep code fences and inline code intact so their dollar signs are never
// interpreted as formulas.
export const renderMath = (source: string) => source
  .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g)
  .map((segment, index) => {
    if (index % 2 === 1) return segment;
    return segment.split(/(`[^`\n]*`)/g).map((part, partIndex) => {
      if (partIndex % 2 === 1) return part;
      return part
        .replace(/(^|\n)\$\$\s*([\s\S]*?)\s*\$\$(?=\n|$)/g, (_, prefix, tex) => `${prefix}<div class="katex-block" data-tex="${escapeAttribute(tex.trim())}" data-display="block">${renderFormula(tex, true)}</div>`)
        .replace(/(^|\n)\\\[\s*([\s\S]*?)\s*\\\](?=\n|$)/g, (_, prefix, tex) => `${prefix}<div class="katex-block" data-tex="${escapeAttribute(tex.trim())}" data-display="block">${renderFormula(tex, true)}</div>`)
        .replace(/\\\((.+?)\\\)/g, (_, tex) => renderFormula(tex, false))
        .replace(/(^|[^\\$])\$([^$\n]+?)\$(?!\$)/g, (_, prefix, tex) => `${prefix}${renderFormula(tex, false)}`);
    }).join('');
  }).join('');

/** 源码 → 未消毒 HTML：媒体占位 → 公式 → markdown-it 渲染。 */
export function renderMarkdownSource(source: string): string {
  return markdownRenderer.render(renderMath(renderMediaPlaceholders(source)));
}

/** 源码 → 可写入 DOM 的 HTML（调用方负责再跑增强管线）。 */
export function renderMarkdownToHtml(source: string): string {
  return sanitizeRenderedHtml(renderMarkdownSource(source));
}
