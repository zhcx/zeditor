/**
 * HTML5 媒体嵌入语法工具。
 *
 * 支持的源码写法：
 * - `@[video](demo.mp4)`              本地 / 远程视频，渲染为 `<video>`
 * - `@[audio](demo.mp3)`              本地 / 远程音频，渲染为 `<audio>`
 * - `@[youtube](https://...)`         YouTube，渲染为隐私增强型 iframe
 * - `@[video](https://b23.tv/...)`    B站 / Vimeo 在线视频，渲染为平台 iframe
 * - `@[video](demo.mp4){title="演示" poster="cover.jpg"}`  标题与封面
 * - `![](demo.mp4)`                   图片语法中的媒体文件自动提升为播放器
 */

export type MediaKind = 'video' | 'audio' | 'youtube' | 'embed';

export interface MediaEmbedSpec {
  kind: MediaKind;
  src: string;
  title?: string;
  poster?: string;
}

export interface MediaEmbedMatch extends MediaEmbedSpec {
  /** 文档中出现的顺序，从 0 开始 */
  index: number;
  /** 源码起始偏移 */
  from: number;
  /** 源码结束偏移 */
  to: number;
  /** 1 起的行号 */
  line: number;
  /** 原始源码文本 */
  raw: string;
  /** directive 为 @[xxx]()，image 为 ![]() 自动提升 */
  syntax: 'directive' | 'image';
}

const VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv', 'avi', 'wmv', 'flv']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'aac', 'wav', 'oga', 'ogg', 'opus', 'flac', 'weba']);

/** 文件选择器与拖放识别时使用的媒体扩展名（不含点号）。 */
export const MEDIA_FILE_EXTENSIONS = [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS];

const DIRECTIVE_PATTERN = /^@\[(video|audio|youtube|embed)\]\(([^\s)]+)\)(?:\s*\{([^}]*)\})?$/;
const IMAGE_PATTERN = /!\[([^\]]*)\]\(([^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'))?\)/g;
// 属性值允许包含转义引号，才能原样往返 formatMediaEmbed 写出的 `title="他说\"你好\""`。
const ATTRIBUTE_PATTERN = /(\w+)\s*=\s*("((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s}]+))/g;

function stripUrlSuffix(source: string): string {
  const withoutHash = source.split('#')[0];
  return withoutHash.split('?')[0];
}

export function extensionOfSource(source: string): string {
  const match = stripUrlSuffix(source.trim()).match(/\.([a-z0-9]+)$/i);
  return match ? match[1].toLowerCase() : '';
}

export function isRemoteMediaSource(source: string): boolean {
  const value = source.trim();
  return /^(?:https?:|data:|blob:|asset:)/i.test(value) || value.startsWith('//');
}

/** 依据扩展名判断媒体类型，无法判断时返回 null。 */
export function mediaKindOfSource(source: string): 'video' | 'audio' | null {
  const extension = extensionOfSource(source);
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  return null;
}

export function isMediaFilePath(path: string): boolean {
  return mediaKindOfSource(path) !== null;
}

export function youtubeVideoId(rawUrl: string): string | null {
  const isValidId = (value: string) => (/^[\w-]{6,}$/.test(value) ? value : null);
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase().replace(/^(?:www|m)\./, '');
    if (host === 'youtu.be') return isValidId(url.pathname.slice(1).split('/')[0] || '');
    if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return null;
    const segments = url.pathname.split('/').filter(Boolean);
    if (['shorts', 'embed', 'live', 'v'].includes(segments[0] || '')) return isValidId(segments[1] || '');
    return isValidId(url.searchParams.get('v') || '');
  } catch {
    return null;
  }
}

/** YouTube 隐私增强型嵌入地址：不写入 www.youtube.com 的 Cookie。 */
export function youtubeEmbedUrl(rawUrl: string): string | null {
  const id = youtubeVideoId(rawUrl);
  return id ? `https://www.youtube-nocookie.com/embed/${id}` : null;
}

export interface PlatformEmbed {
  src: string;
  title: string;
  platform: 'youtube' | 'bilibili' | 'vimeo';
}

const PLATFORM_HOSTS = new Set([
  'youtube.com',
  'm.youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'bilibili.com',
  'm.bilibili.com',
  'b23.tv',
  'vimeo.com',
  'player.vimeo.com',
]);

/** 在线视频平台的页面链接（区别于可直接播放的媒体文件直链）。 */
export function isPlatformPageUrl(source: string): boolean {
  try {
    const host = new URL(source).hostname.toLowerCase().replace(/^www\./, '');
    return PLATFORM_HOSTS.has(host);
  } catch {
    return false;
  }
}

export function videoPlatformEmbed(rawUrl: string): PlatformEmbed | null {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (!PLATFORM_HOSTS.has(host)) return null;
    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be' || host === 'youtube-nocookie.com') {
      const id = youtubeVideoId(rawUrl);
      if (id) return { src: `https://www.youtube-nocookie.com/embed/${id}`, title: 'YouTube 视频', platform: 'youtube' };
    }
    if (host === 'bilibili.com' || host === 'm.bilibili.com' || host === 'b23.tv') {
      // b23.tv 短链需要联网跳转才能拿到 BV 号，这里只处理完整链接。
      const id = url.pathname.match(/\/(BV[\w]+|av\d+)/i)?.[1];
      if (id) {
        const key = id.toLowerCase().startsWith('av') ? `aid=${id.slice(2)}` : `bvid=${id}`;
        return { src: `https://player.bilibili.com/player.html?${key}&high_quality=1`, title: '哔哩哔哩视频', platform: 'bilibili' };
      }
    }
    if (host === 'vimeo.com' || host === 'player.vimeo.com') {
      const id = url.pathname.match(/(?:video\/)?(\d+)/)?.[1];
      if (id) return { src: `https://player.vimeo.com/video/${id}`, title: 'Vimeo 视频', platform: 'vimeo' };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * 渲染时使用的类型：远程链接按平台降级为 iframe，本地文件按扩展名决定
 * `<video>` / `<audio>`，未知扩展名按视频处理。
 */
export function resolveRenderKind(spec: MediaEmbedSpec): MediaKind {
  if (spec.kind === 'audio' && !isRemoteMediaSource(spec.src)) return 'audio';
  if (isRemoteMediaSource(spec.src)) {
    if (youtubeEmbedUrl(spec.src)) return 'youtube';
    if (videoPlatformEmbed(spec.src)) return 'embed';
    return spec.kind === 'audio' ? 'audio' : 'video';
  }
  return mediaKindOfSource(spec.src) ?? (spec.kind === 'audio' ? 'audio' : 'video');
}

function escapeAttributeValue(value: string): string {
  return value.replace(/["\\]/g, (character) => `\\${character}`);
}

function unescapeAttributeValue(value: string): string {
  return value.replace(/\\(["\\])/g, '$1');
}

/** 解析 `{key="value"}` 形式的属性集合，供媒体指令与图片尺寸复用。 */
export function parseAttributePairs(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const result: Record<string, string> = {};
  for (const match of raw.matchAll(ATTRIBUTE_PATTERN)) {
    const key = match[1].toLowerCase();
    const value = unescapeAttributeValue(match[3] ?? match[4] ?? match[5] ?? '');
    if (!value) continue;
    result[key] = value;
  }
  return result;
}

export function parseMediaAttributes(raw: string | undefined): { title?: string; poster?: string } {
  const pairs = parseAttributePairs(raw);
  return {
    ...(pairs.title ? { title: pairs.title } : {}),
    ...(pairs.poster ? { poster: pairs.poster } : {}),
  };
}

export function formatMediaEmbed(spec: MediaEmbedSpec): string {
  const directive = spec.kind === 'audio' ? 'audio' : spec.kind === 'youtube' || spec.kind === 'embed' ? 'youtube' : 'video';
  const attributes: string[] = [];
  if (spec.title) attributes.push(`title="${escapeAttributeValue(spec.title)}"`);
  if (spec.poster && directive === 'video') attributes.push(`poster="${escapeAttributeValue(spec.poster)}"`);
  const suffix = attributes.length > 0 ? `{${attributes.join(' ')}}` : '';
  return `@[${directive}](${spec.src})${suffix}`;
}

/** 解析单行媒体指令，非媒体行返回 null。 */
export function parseMediaLine(line: string): MediaEmbedSpec | null {
  const match = line.trim().match(DIRECTIVE_PATTERN);
  if (!match) return null;
  const declared = match[1].toLowerCase();
  const src = match[2];
  const attributes = parseMediaAttributes(match[3]);
  const kind: MediaKind = declared === 'audio'
    ? 'audio'
    : declared === 'youtube' || declared === 'embed'
      ? 'youtube'
      : 'video';
  return { kind, src, ...attributes };
}

function lineStartOffsets(content: string): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const line of content.split('\n')) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  return offsets;
}

/**
 * 扫描文档中的全部媒体嵌入（跳过代码块），用于源码装饰与预览点击定位。
 */
export function findMediaEmbeds(content: string): MediaEmbedMatch[] {
  const offsets = lineStartOffsets(content);
  const matches: MediaEmbedMatch[] = [];
  let fence = '';

  content.split('\n').forEach((line, lineIndex) => {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!fence) fence = marker;
      else if (fence === marker) fence = '';
      return;
    }
    if (fence) return;

    const lineStart = offsets[lineIndex];
    const directive = parseMediaLine(line);
    if (directive) {
      const raw = line.trim();
      matches.push({
        ...directive,
        index: matches.length,
        from: lineStart + line.indexOf(raw),
        to: lineStart + line.indexOf(raw) + raw.length,
        line: lineIndex + 1,
        raw,
        syntax: 'directive',
      });
      return;
    }

    for (const match of line.matchAll(IMAGE_PATTERN)) {
      const src = match[2];
      const kind = mediaKindOfSource(src);
      if (!kind) continue;
      const raw = match[0];
      matches.push({
        kind,
        src,
        title: match[1] || undefined,
        index: matches.length,
        from: lineStart + (match.index ?? 0),
        to: lineStart + (match.index ?? 0) + raw.length,
        line: lineIndex + 1,
        raw,
        syntax: 'image',
      });
    }
  });

  return matches;
}

/** 按行号（优先）或源路径定位媒体嵌入，供预览点击编辑使用。 */
export function findMediaEmbedAt(content: string, line: number, src?: string): MediaEmbedMatch | null {
  const matches = findMediaEmbeds(content);
  return matches.find((match) => match.line === line && (!src || match.src === src))
    ?? matches.find((match) => match.line === line)
    ?? matches.find((match) => src !== undefined && match.src === src)
    ?? null;
}

/** 供文件选择器使用的扩展名分组。 */
export function mediaDialogFilters(kind: 'video' | 'audio' | 'auto') {
  const video = [...VIDEO_EXTENSIONS];
  const audio = [...AUDIO_EXTENSIONS];
  if (kind === 'video') return [{ name: '视频', extensions: video }];
  if (kind === 'audio') return [{ name: '音频', extensions: audio }];
  return [{ name: '媒体文件', extensions: [...video, ...audio] }];
}
