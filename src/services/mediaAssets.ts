import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../stores/appStore';
import { captureImportTarget, insertImportedText } from './documentInsertion';
import {
  formatMediaEmbed,
  isRemoteMediaSource,
  mediaKindOfSource,
  type MediaEmbedSpec,
  type MediaKind,
} from '../utils/media';

/** 桌面端 import_media_asset 的返回结构。 */
export interface MediaAssetImport {
  fileName: string;
  absolutePath: string;
  relativePath: string;
  size: number;
}

const isTauriRuntime = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// 同一文档内的媒体路径解析结果缓存，避免每次重渲染都跨进程探测文件是否存在。
const resolvedMediaCache = new Map<string, { value: string | null; expiresAt: number }>();
const pendingMediaResolutions = new Map<string, Promise<Map<string, string | null>>>();
const MAX_RESOLVED_SOURCES = 512;

const cacheKey = (documentPath: string, source: string) => `${documentPath}\u0000${source}`;

export function clearResolvedMediaCache(): void {
  resolvedMediaCache.clear();
  pendingMediaResolutions.clear();
}

/** 同一路径被重新导入或换名后，让预览重新解析，避免继续使用旧结论。 */
export function invalidateResolvedSource(documentPath: string | null, source: string): void {
  const key = cacheKey(documentPath || '', source);
  resolvedMediaCache.delete(key);
  pendingMediaResolutions.delete(key);
}

/** 绝对路径 → WebView 可播放的 asset 协议地址。 */
export function toPlayableMediaUrl(absolutePath: string): string {
  return convertFileSrc(absolutePath, 'asset');
}

/**
 * 把本地媒体文件复制到文档同级的 `.assets` 目录，返回可写入 Markdown 的相对路径。
 * 未保存的文档没有落盘目录，因此要求先保存。
 */
export async function importMediaAsset(sourcePath: string): Promise<MediaAssetImport> {
  const documentPath = useAppStore.getState().currentFile;
  if (!documentPath) {
    throw new Error('请先保存文档，媒体文件会复制到文档同级的 .assets 目录');
  }
  if (!isTauriRuntime()) {
    throw new Error('浏览器预览模式不支持导入本地媒体，请使用桌面版');
  }
  return invoke<MediaAssetImport>('import_media_asset', { sourcePath, documentPath });
}

/**
 * 解析文档中的媒体引用：本地文件返回可直接播放的地址，缺失文件不进入结果。
 * 远程地址（http/https/data/blob）由 WebView 直接加载，无需解析。
 */
export async function resolveMediaSources(
  documentPath: string | null,
  sources: string[],
): Promise<Map<string, string>> {
  const playable = new Map<string, string>();
  if (!isTauriRuntime()) return playable;

  // 未保存的文档没有基准目录，但仍允许解析绝对路径（相对路径由桌面端返回缺失）。
  const baseDocument = documentPath || '';
  const localSources = [...new Set(sources)].filter(source => source && !isRemoteMediaSource(source));
  const now = Date.now();
  const pending = localSources.filter(source => {
    const key = cacheKey(baseDocument, source);
    const cached = resolvedMediaCache.get(key);
    if (cached && cached.expiresAt <= now) resolvedMediaCache.delete(key);
    return !resolvedMediaCache.has(key) && !pendingMediaResolutions.has(key);
  });
  if (pending.length > 0) {
    const request = invoke<(string | null)[]>('resolve_media_sources', { documentPath: baseDocument, sources: pending })
      .then(values => {
        const resolved = new Map<string, string | null>();
        pending.forEach((source, index) => {
          const key = cacheKey(baseDocument, source);
          const value = values[index] ?? null;
          resolved.set(source, value);
          // 失效或清空之后，旧请求不得重新污染缓存。
          if (pendingMediaResolutions.get(key) !== request) return;
          resolvedMediaCache.delete(key);
          resolvedMediaCache.set(key, { value, expiresAt: Date.now() + (value ? 30_000 : 2_000) });
        });
        while (resolvedMediaCache.size > MAX_RESOLVED_SOURCES) {
          resolvedMediaCache.delete(resolvedMediaCache.keys().next().value!);
        }
        return resolved;
      })
      .catch(() => new Map<string, string | null>())
      .finally(() => {
        for (const source of pending) {
          const key = cacheKey(baseDocument, source);
          if (pendingMediaResolutions.get(key) === request) pendingMediaResolutions.delete(key);
        }
      });
    for (const source of pending) pendingMediaResolutions.set(cacheKey(baseDocument, source), request);
  }
  // 本次请求的结果独立保留：即使缓存淘汰，也不能漏掉大文档中的媒体。
  const requests = new Set(localSources.map(source => pendingMediaResolutions.get(cacheKey(baseDocument, source))));
  const resolved = new Map((await Promise.all([...requests].filter(request => request !== undefined))).flatMap(values => [...values]));

  for (const source of sources) {
    if (!source || isRemoteMediaSource(source)) continue;
    const cached = resolvedMediaCache.get(cacheKey(baseDocument, source));
    const absolute = cached ? cached.value : resolved.get(source);
    if (absolute) playable.set(source, toPlayableMediaUrl(absolute));
  }
  return playable;
}

/** 由导入结果生成 Markdown 媒体语法。 */
export function mediaEmbedForAsset(asset: MediaAssetImport): string {
  const kind: MediaKind = mediaKindOfSource(asset.fileName) ?? 'video';
  const spec: MediaEmbedSpec = { kind, src: asset.relativePath };
  return formatMediaEmbed(spec);
}

/**
 * 导入本地媒体并插入当前文档光标处。
 * 导入失败只更新状态栏提示，调用方无需再处理异常。
 */
export async function insertMediaFromPath(sourcePath: string): Promise<boolean> {
  const target = captureImportTarget();
  const store = useAppStore.getState();
  store.setUploadStatus('uploading', 30, '正在导入媒体文件…');
  try {
    const asset = await importMediaAsset(sourcePath);
    // 同一路径此前可能被判定为缺失，导入成功后必须让预览重新解析。
    invalidateResolvedSource(target.path, asset.relativePath);
    const text = `\n${mediaEmbedForAsset(asset)}\n`;
    const current = useAppStore.getState();
    insertImportedText(target, text);
    current.setUploadStatus('success', 100, '媒体已导入并插入');
    return true;
  } catch (error) {
    useAppStore.getState().setUploadStatus('error', 0, String(error instanceof Error ? error.message : error));
    return false;
  }
}
