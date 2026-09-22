/**
 * 图片语法工具。
 *
 * 支持的源码写法：
 * - `![替代文本](.assets/图.png)`                     基础写法
 * - `![替代文本](../pic/图.png "标题")`               带标题
 * - `![替代文本](.assets/图.png){width=320 height=200}`  预览尺寸
 *
 * 尺寸只写成像素数字（也接受 `320px`），别的值一律忽略，
 * 避免把任意字符串塞进 `<img>` 属性。
 */
// 说明：本模块保持零依赖，便于 node:test 直接加载（Node 的 TS 解析要求显式扩展名，
// 跨模块相对导入会让测试加载失败）。属性写法与媒体指令共用 `{key="value"}` 约定。

/** 允许复制进 `.assets` 的图片扩展名，与桌面端 `IMAGE_EXTENSIONS` 保持一致。 */
export const IMAGE_FILE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico', 'tif', 'tiff', 'heic'];

export interface ImageSpec {
  alt: string;
  src: string;
  title?: string;
  width?: number;
  height?: number;
}

export interface ImageMatch extends ImageSpec {
  /** 源码起始偏移 */
  from: number;
  /** 源码结束偏移 */
  to: number;
  /** 1 起的行号 */
  line: number;
  /** 原始源码文本 */
  raw: string;
}

const IMAGE_PATTERN = /!\[([^\]]*)\]\(\s*([^\s)]+)(?:\s+(?:"([^"]*)"|'([^']*)'))?\s*\)(?:\s*\{([^}]*)\})?/g;

const imageExtensions = new Set(IMAGE_FILE_EXTENSIONS);

/** 取源路径的扩展名（小写、忽略 query 与 hash）。 */
export function imageExtensionOfSource(source: string): string {
  const withoutHash = source.trim().split('#')[0];
  const withoutQuery = withoutHash.split('?')[0];
  const match = withoutQuery.match(/\.([a-z0-9]+)$/i);
  return match ? match[1].toLowerCase() : '';
}

export function isImageFilePath(path: string): boolean {
  return imageExtensions.has(imageExtensionOfSource(path));
}

/** 图片语法中的尺寸值：只接受像素数字。 */
export function normalizeImageSize(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.trim().match(/^(\d{1,5})(?:px)?$/i);
  if (!match) return undefined;
  const size = Number(match[1]);
  return Number.isFinite(size) && size > 0 ? size : undefined;
}

const ATTRIBUTE_PATTERN = /(\w+)\s*=\s*("((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s}]+))/g;

function attributePairs(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const pairs: Record<string, string> = {};
  for (const match of raw.matchAll(ATTRIBUTE_PATTERN)) {
    const value = (match[3] ?? match[4] ?? match[5] ?? '').replace(/\\(["\\])/g, '$1');
    if (value) pairs[match[1].toLowerCase()] = value;
  }
  return pairs;
}

export function parseImageAttributes(raw: string | undefined): { width?: number; height?: number } {
  const pairs = attributePairs(raw);
  const width = normalizeImageSize(pairs.width);
  const height = normalizeImageSize(pairs.height);
  return {
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
  };
}

export function formatImageMarkdown(spec: ImageSpec): string {
  const alt = spec.alt ?? '';
  const title = spec.title ? ` "${spec.title.replace(/"/g, '\\"')}"` : '';
  const attributes: string[] = [];
  if (spec.width) attributes.push(`width=${Math.round(spec.width)}`);
  if (spec.height) attributes.push(`height=${Math.round(spec.height)}`);
  const suffix = attributes.length > 0 ? `{${attributes.join(' ')}}` : '';
  return `![${alt}](${spec.src}${title})${suffix}`;
}

/** 设置尺寸：宽高都不传时移除尺寸属性，恢复原始大小。 */
export function withImageSize(spec: ImageSpec, width?: number, height?: number): ImageSpec {
  return { ...spec, width, height };
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
 * 扫描文档中的图片语法（跳过代码围栏）。
 * 写成 `![]()` 的音视频由媒体通道转成播放器占位元素，预览里不会出现 `<img>`，
 * 因此这里不需要再区分媒体扩展名。
 */
export function findImages(content: string): ImageMatch[] {
  const offsets = lineStartOffsets(content);
  const matches: ImageMatch[] = [];
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
    for (const match of line.matchAll(IMAGE_PATTERN)) {
      const src = match[2];
      if (!src) continue;
      const raw = match[0];
      const title = match[3] ?? match[4];
      matches.push({
        alt: match[1] ?? '',
        src,
        ...(title ? { title } : {}),
        ...parseImageAttributes(match[5]),
        from: lineStart + (match.index ?? 0),
        to: lineStart + (match.index ?? 0) + raw.length,
        line: lineIndex + 1,
        raw,
      });
    }
  });

  return matches;
}

/** 按源路径（必要时再比对替代文本）定位图片，供预览交互回写源码。 */
export function findImage(content: string, src: string, alt?: string): ImageMatch | null {
  const images = findImages(content);
  return images.find((image) => image.src === src && (alt === undefined || image.alt === alt))
    ?? images.find((image) => image.src === src)
    ?? null;
}

/** 文件选择器使用的扩展名分组。 */
export function imageDialogFilters() {
  return [{ name: '图片', extensions: [...IMAGE_FILE_EXTENSIONS] }];
}
