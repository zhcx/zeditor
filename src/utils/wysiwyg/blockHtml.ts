import type { WysiwygBlockKind } from './blocks.ts';

/** 按块缓存 HTML；渲染器由宿主注入，纯逻辑可独立验证。 */
export function createBlockHtmlRenderer(render: (source: string) => string, limit = 600) {
  const cache = new Map<string, string>();
  return (kind: WysiwygBlockKind, source: string): string => {
    const key = `${kind}\u0000${source}`;
    const cached = cache.get(key);
    if (cached !== undefined) {
      cache.delete(key);
      cache.set(key, cached);
      return cached;
    }
    // Markdown 的 softbreak HTML 是 <br> 后再跟一个排版换行；可编辑 DOM
    // 只保留 <br>，否则下一次输入会把它们回写成两个源码换行。
    const editable = ['paragraph', 'heading', 'list', 'blockquote', 'table'].includes(kind);
    const normalized = source.replace(/\r\n|\r/g, '\n');
    const trailing = kind === 'paragraph' ? normalized.match(/\n+$/)?.[0].length ?? 0 : 0;
    const body = trailing ? normalized.slice(0, -trailing) : source;
    let html = render(body);
    if (editable) html = html.replace(/(<br\s*\/?>)\r?\n/g, '$1');
    if (kind === 'paragraph') {
      const placeholder = '<br data-wysiwyg-placeholder="true">';
      if (!html.trim()) {
        const text = body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
        html = `<p>${text}${'<br>'.repeat(trailing)}${placeholder}</p>`;
      } else if (trailing) {
        // 最后一个 BR 只是 Chromium 空行的光标落点，不写进 Markdown。
        html = html.replace(/<\/p>\s*$/, `${'<br>'.repeat(trailing)}${placeholder}</p>`);
      }
    }
    if (cache.size >= limit) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, html);
    return html;
  };
}
