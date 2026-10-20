import { invoke } from '@tauri-apps/api/core';
import type { DocxImage } from './docxExport.ts';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Browser decoding also validates bytes and converts newer formats for Office. */
async function decodeImage(dataUrl: string): Promise<DocxImage> {
  const match = /^data:(image\/(?:png|jpe?g|gif|bmp|webp|svg\+xml|avif));base64,([a-z\d+/=\s]+)$/i.exec(dataUrl);
  if (!match || match[2].length > MAX_IMAGE_BYTES * 4 / 3 + 4) throw new Error('图片类型不受支持或超过 20 MiB。');
  const binary = atob(match[2]);
  if (binary.length > MAX_IMAGE_BYTES) throw new Error('图片超过 20 MiB。');
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (width <= 0 || height <= 0 || width * height > 40_000_000) throw new Error('图片尺寸无效或超过 4000 万像素。');
  const type = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/bmp': 'bmp' } as const)[match[1].toLowerCase()];
  if (type) return { data: Uint8Array.from(binary, c => c.charCodeAt(0)), type, width, height };
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建图片转换画布。');
  context.drawImage(image, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('无法将图片转换为 PNG。')), 'image/png'));
  if (blob.size > MAX_IMAGE_BYTES) throw new Error('转换后的图片超过 20 MiB。');
  return { data: new Uint8Array(await blob.arrayBuffer()), type: 'png', width, height };
}

export async function loadDocxImage(source: string, documentPath: string | null): Promise<DocxImage> {
  if (/^data:/i.test(source)) return decodeImage(source);
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, { signal: AbortSignal.timeout(15000), credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!response.ok) throw new Error(`远程图片下载失败（HTTP ${response.status}）。`);
    if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) throw new Error('远程图片超过 20 MiB。');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('无法读取远程图片。');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_IMAGE_BYTES) throw new Error('远程图片超过 20 MiB。');
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let binary = '';
    for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
    return decodeImage(`data:${response.headers.get('content-type')?.split(';')[0]};base64,${btoa(binary)}`);
  }
  if (!documentPath) throw new Error('请先保存文档，再导出相对路径的本地图片。');
  const dataUrl = await invoke<string>('read_export_image', { documentPath, source });
  return decodeImage(dataUrl);
}
