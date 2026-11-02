/**
 * 行内粘贴：把 Markdown 渲染成可以直接插入编辑 DOM 的节点。
 *
 * 纯文本按 Markdown 语法解释（与源码模式的粘贴保持一致），但只接受能放进
 * 现有段落的行内内容。标题、列表、表格、媒体块等结构返回 null，调用方改用
 * 源码级替换；否则把块级 DOM 塞进段落会在回写时产生错误源码。
 */
import { renderMarkdownSource } from '../markdownPipeline.ts';
import { sanitizeRenderedHtml } from '../safeHtml.ts';

/** 不能出现在行内片段里的结构：块级容器、媒体与表单控件。 */
const NON_INLINE_SELECTOR = [
  'p', 'div', 'ul', 'ol', 'li', 'blockquote', 'pre', 'table',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'figure', 'section', 'article',
  'header', 'footer', 'aside', 'nav', 'video', 'audio', 'iframe', 'input',
  'textarea', 'select', 'svg', '.media-embed', '.katex-block',
].join(', ');

/** 渲染结果里只允许一个段落；其余空白文本节点忽略。 */
function meaningfulChildren(parent: DocumentFragment): Node[] {
  return Array.from(parent.childNodes).filter(node =>
    node.nodeType === 1 || (node.nodeType === 3 && Boolean(node.textContent?.trim())));
}

export function renderInlinePasteFragment(markdown: string): DocumentFragment | null {
  let html: string;
  try {
    html = sanitizeRenderedHtml(renderMarkdownSource(markdown));
  } catch {
    return null;
  }
  // 与可编辑块的渲染保持一致：softbreak 的 HTML 换行只是排版空白。
  html = html.replace(/(<br\s*\/?>)\r?\n/g, '$1');

  const template = document.createElement('template');
  template.innerHTML = html;
  const children = meaningfulChildren(template.content);
  if (children.length !== 1) return null;
  const paragraph = children[0];
  if (!(paragraph instanceof Element) || paragraph.tagName !== 'P') return null;
  if (paragraph.querySelector(NON_INLINE_SELECTOR)) return null;

  const fragment = document.createDocumentFragment();
  while (paragraph.firstChild) fragment.append(paragraph.firstChild);
  return fragment.childNodes.length > 0 ? fragment : null;
}
