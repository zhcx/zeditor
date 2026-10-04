export const TEXT_ENCODINGS = [
  { value: 'utf-8', label: 'UTF-8', description: '通用 Unicode 编码' },
  { value: 'utf-8-bom', label: 'UTF-8 with BOM', description: '带字节顺序标记' },
  { value: 'utf-16le', label: 'UTF-16 LE', description: '小端序，不带 BOM' },
  { value: 'utf-16le-bom', label: 'UTF-16 LE with BOM', description: '小端序，带 BOM' },
  { value: 'utf-16be', label: 'UTF-16 BE', description: '大端序，不带 BOM' },
  { value: 'utf-16be-bom', label: 'UTF-16 BE with BOM', description: '大端序，带 BOM' },
  { value: 'gbk', label: 'GBK', description: '简体中文旧文件常用编码' },
  { value: 'gb18030', label: 'GB18030', description: '中文与扩展 Unicode 字符' },
  { value: 'big5', label: 'Big5', description: '繁体中文' },
  { value: 'shift-jis', label: 'Shift-JIS', description: '日文' },
  { value: 'windows-1252', label: 'Windows-1252', description: '西欧语言' },
] as const;

export type TextEncoding = typeof TEXT_ENCODINGS[number]['value'];
export interface TextDocument { content: string; encoding: TextEncoding }
export interface EncodingDialogRequest { mode: 'open' | 'reopen' | 'save'; path?: string; tabId?: string; dataBase64?: string; title?: string }
export const encodingLabel = (encoding: TextEncoding = 'utf-8') => TEXT_ENCODINGS.find(item => item.value === encoding)?.label || 'UTF-8';
export const isTextEncoding = (value: unknown): value is TextEncoding => TEXT_ENCODINGS.some(item => item.value === value);
