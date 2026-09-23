/**
 * 去掉选中文本里的行内修饰，只留纯文字：
 * HTML 行内标签（u / sup / sub / mark 等）与 Markdown 的粗体、斜体、删除线、
 * 高亮、行内代码。工具栏「清除行内格式」与编辑器右键菜单共用。
 */
export function stripInlineFormatting(text: string): string {
  return text
    .replace(/<\/?(?:u|sup|sub|mark|strong|em|del)>/gi, '')
    .replace(/(\*\*|__|~~|==|`)/g, '')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1');
}
