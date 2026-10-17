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
    const html = render(source);
    if (cache.size >= limit) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, html);
    return html;
  };
}
