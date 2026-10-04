import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../stores/appStore';
import type { TextDocument, TextEncoding } from '../utils/textEncoding';

/** 云端版本沿用原始字节；不确定的旧编码交由用户选择，不能作为空文本打开。 */
export async function openBase64Document(title: string, dataBase64: string, encoding?: TextEncoding, cancelled?: () => boolean) {
  try {
    const loaded = await invoke<TextDocument>('decode_text_document', { dataBase64, encoding: encoding || null });
    if (!cancelled?.()) useAppStore.getState().addTab({ title, content: loaded.content, encoding: loaded.encoding, modified: true });
  } catch (error) {
    if (cancelled?.()) return;
    if (!encoding && String(error).includes('text_encoding_required:')) {
      useAppStore.getState().setEncodingDialog({ mode: 'open', title, dataBase64 });
    } else throw error;
  }
}
