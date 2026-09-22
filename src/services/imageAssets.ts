import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../stores/appStore';
import { formatImageMarkdown, type ImageSpec } from '../utils/imageSyntax';
import { invalidateResolvedSource } from './mediaAssets';

/** 桌面端 import_image_asset / import_image_bytes 的返回结构。 */
export interface ImageAssetImport {
  fileName: string;
  absolutePath: string;
  relativePath: string;
  size: number;
}

const isTauriRuntime = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** 图片必须落到文档同级的 `.assets`，未保存的文档没有基准目录。 */
function requireDocumentPath(): string {
  const documentPath = useAppStore.getState().currentFile;
  if (!documentPath) {
    throw new Error('请先保存文档，图片会复制到文档同级的 .assets 目录');
  }
  if (!isTauriRuntime()) {
    throw new Error('浏览器预览模式不支持导入本地图片，请使用桌面版');
  }
  return documentPath;
}

function fileNameStem(fileName: string): string {
  return fileName.replace(/\.[^.\\/]+$/, '');
}

/** 由导入结果生成 Markdown 图片语法，替代文本默认取文件名。 */
export function imageMarkdownForAsset(asset: ImageAssetImport, alt?: string): string {
  const spec: ImageSpec = {
    alt: alt?.trim() || fileNameStem(asset.fileName),
    src: asset.relativePath,
  };
  return formatImageMarkdown(spec);
}

export async function importImageAsset(sourcePath: string): Promise<ImageAssetImport> {
  const documentPath = requireDocumentPath();
  return invoke<ImageAssetImport>('import_image_asset', { sourcePath, documentPath });
}

export async function importImageBytes(dataBase64: string, extension: string): Promise<ImageAssetImport> {
  const documentPath = requireDocumentPath();
  return invoke<ImageAssetImport>('import_image_bytes', { dataBase64, extension, documentPath });
}

/** 在光标处插入图片语法；没有编辑器实例时退化为追加到文档末尾。 */
function insertImageMarkdown(markdown: string): void {
  const store = useAppStore.getState();
  const text = `\n${markdown}\n`;
  if (!store.editorView) {
    store.setContent(`${store.content}${text}`);
    return;
  }
  const selection = store.editorView.getSelection();
  const cursor = selection.from + text.length;
  store.editorView.replaceRange(selection.from, selection.to, text, { from: cursor, to: cursor });
  store.editorView.focus();
}

async function runImport(
  action: () => Promise<ImageAssetImport>,
  alt: string | undefined,
  pendingMessage: string,
  successMessage: string,
): Promise<boolean> {
  useAppStore.getState().setUploadStatus('uploading', 40, pendingMessage);
  try {
    const asset = await action();
    invalidateResolvedSource(useAppStore.getState().currentFile, asset.relativePath);
    insertImageMarkdown(imageMarkdownForAsset(asset, alt));
    useAppStore.getState().setUploadStatus('success', 100, successMessage);
    return true;
  } catch (error) {
    useAppStore.getState().setUploadStatus('error', 0, String(error instanceof Error ? error.message : error));
    return false;
  }
}

/** 导入本地图片文件并插入当前文档，失败只更新状态栏提示。 */
export async function insertImageFromPath(sourcePath: string, alt?: string): Promise<boolean> {
  return runImport(() => importImageAsset(sourcePath), alt, '正在导入图片…', '图片已导入并插入');
}

/** 导入剪贴板图片数据并插入当前文档。 */
export async function insertImageFromBytes(dataBase64: string, extension: string, alt?: string): Promise<boolean> {
  return runImport(() => importImageBytes(dataBase64, extension), alt, '正在保存剪贴板图片…', '图片已复制到 .assets 并插入');
}
