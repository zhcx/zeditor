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
import { parseWikiLink, WIKI_LINK_PATTERN, wikiLinkDisplayText, type WikiLinkParts } from './wikiLinks.ts';
import { parseFootnoteDefinitions, type FootnoteDefinition } from './footnotes.ts';
import { BoundedCache } from './boundedCache.ts';

export const markdownRenderer = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  breaks: true,
  highlight: (str, lang) => highlightFence(str, lang),
});
markdownRenderer.use(taskLists);

// MarkdownIt 的普通引用定义会吞掉 `[^n]: 单词` 并将 [^n] 当成 URL 链接。
// 保留脚注定义为可编辑段落；普通 [label]: URL 仍交给原有规则。
markdownRenderer.block.ruler.before('reference', 'footnote_definition', (state, startLine, endLine, silent) => {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const first = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine]);
  if (!/^\[\^([^\]\r\n]+)\]:/.test(first)) return false;
  if (silent) return true;
  let next = startLine + 1;
  while (next < endLine) {
    if (state.sCount[next] - state.blkIndent >= 4 && !state.isEmpty(next)) { next += 1; continue; }
    if (state.isEmpty(next)) {
      let following = next + 1;
      while (following < endLine && state.isEmpty(following)) following += 1;
      if (following < endLine && state.sCount[following] - state.blkIndent >= 4) { next = following; continue; }
    }
    break;
  }
  const opening = state.push('paragraph_open', 'p', 1);
  opening.map = [startLine, next];
  const content = state.getLines(startLine, next, state.blkIndent, false).trimEnd();
  const prefix = /^ {0,3}\[\^[^\]\r\n]+\]:[ \t]*/.exec(content)![0];
  const marker = state.push('inline', '', 0);
  marker.content = prefix;
  marker.children = [];
  marker.meta = { footnoteDefinitionPrefix: true };
  const inline = state.push('inline', '', 0);
  inline.content = content.slice(prefix.length);
  inline.map = [startLine, next];
  inline.children = [];
  state.push('paragraph_close', 'p', -1);
  state.line = next;
  return true;
}, { alt: ['paragraph'] });
markdownRenderer.core.ruler.after('inline', 'footnote_definition_prefix', state => {
  for (const token of state.tokens) {
    if (!token.meta?.footnoteDefinitionPrefix) continue;
    const literal = new state.Token('html_inline', '', 0);
    literal.content = markdownRenderer.utils.escapeHtml(token.content);
    token.children = [literal];
  }
});

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

/**
 * Obsidian Wiki 链接：`[[笔记]]` / `[[笔记#标题|别名]]`。
 *
 * 解析在 text token 内完成，因此代码块与行内代码天然不受影响；
 * 输出用无 `href` 的 span（而不是 a），避免被当作外链或本地锚点处理，
 * 点击行为由预览 / 所见即所得自己的事件处理接管。
 */
function wikiLinkHtml(parts: WikiLinkParts): string {
  const escape = markdownRenderer.utils.escapeHtml;
  const attributes = [
    'class="wiki-link"',
    'role="link"',
    'tabindex="0"',
    `data-wiki-target="${escape(parts.target)}"`,
    parts.anchor ? `data-wiki-anchor="${escape(parts.anchor)}"` : '',
  ].filter(Boolean).join(' ');
  return `<span ${attributes}>${escape(wikiLinkDisplayText(parts))}</span>`;
}

markdownRenderer.core.ruler.after('inline', 'wiki_link_rendering', (state) => {
  for (const token of state.tokens) {
    if (token.type !== 'inline' || !token.children) continue;
    const next: typeof token.children = [];
    for (const child of token.children) {
      if (child.type !== 'text' || !child.content.includes('[[')) {
        next.push(child);
        continue;
      }
      const content = child.content;
      let cursor = 0;
      let matched = false;
      WIKI_LINK_PATTERN.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = WIKI_LINK_PATTERN.exec(content)) !== null) {
        const parts = parseWikiLink(match[0]);
        if (!parts) continue;
        matched = true;
        if (match.index > cursor) {
          const text = new state.Token('text', '', 0);
          text.content = content.slice(cursor, match.index);
          next.push(text);
        }
        const link = new state.Token('html_inline', '', 0);
        link.content = wikiLinkHtml(parts);
        next.push(link);
        cursor = match.index + match[0].length;
      }
      if (!matched) {
        next.push(child);
        continue;
      }
      if (cursor < content.length) {
        const text = new state.Token('text', '', 0);
        text.content = content.slice(cursor);
        next.push(text);
      }
    }
    token.children = next;
  }
});

/**
 * 脚注引用：`[^1]` 渲染成上标，定义内容放进 data 属性供悬停浮层读取。
 *
 * 定义行自己（行首 `[^name]:`）保持原文，避免把定义也变成引用。
 * 没有定义的引用仍然渲染，标上 `is-unresolved` 让样式弱化。
 */
function footnoteReferenceHtml(name: string, definition?: FootnoteDefinition): string {
  const escape = markdownRenderer.utils.escapeHtml;
  const attributes = [
    `class="footnote-ref${definition ? '' : ' is-unresolved'}"`,
    'role="doc-noteref"',
    'tabindex="0"',
    `data-footnote-name="${escape(name)}"`,
    definition ? `data-footnote-content="${escape(definition.content)}"` : '',
  ].filter(Boolean).join(' ');
  return `<sup ${attributes}>[${escape(name)}]</sup>`;
}

markdownRenderer.core.ruler.after('inline', 'footnote_references', (state) => {
  if (!state.src.includes('[^')) return;
  const definitions: ReadonlyMap<string, FootnoteDefinition> = state.env.zeditorFootnotes ?? parseFootnoteDefinitions(state.src);

  for (const token of state.tokens) {
    if (token.type !== 'inline' || !token.children) continue;
    const next: typeof token.children = [];
    for (const child of token.children) {
      if (child.type !== 'text' || !child.content.includes('[^')) {
        next.push(child);
        continue;
      }
      const content = child.content;
      const pattern = /\[\^([^\]\r\n]+)\]/g;
      let cursor = 0;
      let matched = false;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        const prefix = content.slice(0, match.index);
        const atLineStart = prefix.length === 0 || /(?:^|\n)[ \t]*$/.test(prefix);
        // 行首且紧跟冒号：这是脚注定义，保持原文。
        if (atLineStart && content.charAt(match.index + match[0].length) === ':') continue;
        matched = true;
        if (match.index > cursor) {
          const text = new state.Token('text', '', 0);
          text.content = content.slice(cursor, match.index);
          next.push(text);
        }
        const reference = new state.Token('html_inline', '', 0);
        const name = match[1].trim();
        reference.content = footnoteReferenceHtml(name, definitions.get(name));
        next.push(reference);
        cursor = match.index + match[0].length;
      }
      if (!matched) {
        next.push(child);
        continue;
      }
      if (cursor < content.length) {
        const text = new state.Token('text', '', 0);
        text.content = content.slice(cursor);
        next.push(text);
      }
    }
    token.children = next;
  }
});

/**
 * Highlight and math results depend only on the source string and language.
 * Long documents re-render on every keystroke, so caching unchanged fences
 * avoids re-running the lexer (and KaTeX) for the overwhelming majority of the
 * document. The byte budget keeps pathological files bounded.
 */
const RENDER_CACHE_ENTRIES = 500;
const RENDER_CACHE_BYTES = 8 * 1024 * 1024;
const highlightCache = new BoundedCache<string, string>(
  RENDER_CACHE_ENTRIES,
  RENDER_CACHE_BYTES,
  value => value.length,
);
const katexCache = new BoundedCache<string, string>(
  RENDER_CACHE_ENTRIES,
  RENDER_CACHE_BYTES,
  value => value.length,
);

/** 代码围栏高亮；特殊围栏保留语言 class，交给预览的二次渲染接管。 */
function highlightFence(str: string, lang: string): string {
  // Length-prefix the language so no (lang, source) pair can collide with
  // another fence whose language/source boundary falls elsewhere.
  const cacheKey = `${lang.length}:${lang}:${str}`;
  const cached = highlightCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const rendered = renderHighlightFence(str, lang);
  highlightCache.set(cacheKey, rendered);
  return rendered;
}

function renderHighlightFence(str: string, lang: string): string {
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
  const languageClass = lang ? ` class="language-${escape(lang)}"` : '';
  return `<pre class="hljs"><code${languageClass}>${escape(str)}</code></pre>`;
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
  const cacheKey = `${displayMode ? 'B' : 'I'}\u0000${source}`;
  const cached = katexCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const attribute = `data-tex="${escapeAttribute(source)}"`;
  let rendered: string;
  try {
    rendered = `<span class="zeditor-math" ${attribute}>${katex.renderToString(source, { displayMode, throwOnError: false, strict: 'warn', trust: false })}</span>`;
  } catch {
    rendered = `<span class="zeditor-math" ${attribute}>${displayMode ? `$$${source}$$` : `$${source}$`}</span>`;
  }
  katexCache.set(cacheKey, rendered);
  return rendered;
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

export interface MarkdownRenderOptions {
  /** 只读预览的段内行定位；编辑 DOM 和导出沿用原有块结构。 */
  sourceLineAnchors?: boolean;
}

markdownRenderer.core.ruler.push('preview_source_lines', state => {
  if (!state.env.sourceLineAnchors) return;
  state.tokens.forEach((token, index) => {
    const paragraph = state.tokens[index - 1];
    if (token.type !== 'inline' || !token.map || !token.children
      || paragraph?.type !== 'paragraph_open' || paragraph.level !== 0) return;
    const children = token.children;
    const breaks = children.filter(child => child.type === 'softbreak' || child.type === 'hardbreak').length;
    // 原始 HTML 可跨行开闭标签；多行行内代码会折叠换行。无法逐行映射时保持块定位。
    if (!breaks || breaks !== (token.content.match(/\n/g) ?? []).length
      || children.some(child => child.type === 'html_inline')) return;
    let line = token.map[0] + 1;
    const html = (content: string) => {
      const marker = new state.Token('html_inline', '', 0);
      marker.content = content;
      return marker;
    };
    const startLine = () => html(`<span class="preview-source-line" data-source-line="${line}">`);
    const anchored = [startLine()];
    const open: typeof children = [];
    for (const child of children) {
      if (child.type === 'softbreak' || child.type === 'hardbreak') {
        // 格式可跨源码行：每行内闭合再重开，避免生成交叉嵌套的 HTML。
        for (const opening of [...open].reverse()) anchored.push(html(`</${opening.tag}>`));
        anchored.push(html('</span>'), child);
        line += 1;
        anchored.push(startLine(), ...open);
      } else {
        anchored.push(child);
        if (child.nesting === 1) open.push(child);
        else if (child.nesting === -1) open.pop();
      }
    }
    anchored.push(html('</span>'));
    token.children = anchored;
  });
});

/** 源码 → 未消毒 HTML：媒体占位 → 公式 → markdown-it 渲染。 */
export function renderMarkdownSource(source: string, options: MarkdownRenderOptions = {}): string {
  const zeditorFootnotes = source.includes('[^') ? parseFootnoteDefinitions(source) : new Map<string, FootnoteDefinition>();
  let protectedSource = source;
  const prefixes: string[] = [];
  let marker = '\u0000zeditor_footnote_prefix\u0000';
  if (zeditorFootnotes.size) {
    while (source.includes(marker)) marker += '_';
    protectedSource = source.replace(/^ {0,3}\[\^[^\]\r\n]+\]:/gm, prefix => {
      prefixes.push(prefix);
      return `${marker}${prefixes.length - 1}${marker}`;
    });
  }
  let prepared = renderMath(renderMediaPlaceholders(protectedSource));
  if (prefixes.length) prepared = prepared.replace(new RegExp(`${marker}(\\d+)${marker}`, 'g'), (_, index) => prefixes[Number(index)]);
  return markdownRenderer.render(prepared, { zeditorFootnotes, sourceLineAnchors: options.sourceLineAnchors });
}

/** 源码 → 可写入 DOM 的 HTML（调用方负责再跑增强管线）。 */
export function renderMarkdownToHtml(source: string, options: MarkdownRenderOptions = {}): string {
  return sanitizeRenderedHtml(renderMarkdownSource(source, options));
}
