import { AppIcon } from '../Icons/AppIcon';
import { useMemo, useState } from 'react';
import MarkdownIt from 'markdown-it';
import { save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';

type WeChatThemeId = 'jade' | 'vermilion' | 'graphite' | 'zen' | 'amber' | 'olive';
interface WeChatTheme { id: WeChatThemeId; label: string; description: string; primary: string; pale: string; ink: string; accent: string; }

const themes: WeChatTheme[] = [
  { id: 'jade', label: '翡翠指南', description: '清爽、条理清晰，适合教程与清单', primary: '#16836a', pale: '#eaf7f2', ink: '#24332f', accent: '#f3c969' },
  { id: 'vermilion', label: '朱砂论述', description: '克制有力，适合观点与分析', primary: '#b93832', pale: '#fdf0ee', ink: '#2b2524', accent: '#d99a40' },
  { id: 'graphite', label: '石墨刊读', description: '专业、现代，适合科技与设计', primary: '#3d4651', pale: '#f3f5f7', ink: '#1d232b', accent: '#708ca5' },
  { id: 'zen', label: '留白随笔', description: '安静、舒展，适合生活与长文', primary: '#556b5d', pale: '#f6f7f3', ink: '#303630', accent: '#b69c70' },
  { id: 'amber', label: '琥珀便签', description: '轻快、有温度，适合测评与工具推荐', primary: '#a85e20', pale: '#fff7e9', ink: '#3f3023', accent: '#e3b24e' },
  { id: 'olive', label: '橄榄书页', description: '编辑感、沉稳，适合案例与复盘', primary: '#58633b', pale: '#f4f5ec', ink: '#292d22', accent: '#a68d58' },
];
const md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: true });
const WECHAT_FONT_FAMILY = '"Microsoft YaHei","微软雅黑",sans-serif';
// Typography is deliberately inlined so WeChat and the app theme cannot replace it.
const textStyle = (theme: WeChatTheme) => `font-family:${WECHAT_FONT_FAMILY};color:${theme.ink};line-height:1.85;letter-spacing:0.4px;`;

function wrapTextLeaves(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  nodes.forEach((node) => {
    if (!node.nodeValue?.trim() || node.parentElement?.tagName === 'SCRIPT') return;
    const span = document.createElement('span'); span.setAttribute('leaf', ''); span.textContent = node.nodeValue; node.replaceWith(span);
  });
}

function renderWeChatHtml(markdown: string, title: string, theme: WeChatTheme) {
  const documentNode = new DOMParser().parseFromString(`<section>${md.render(markdown || '暂无内容')}</section>`, 'text/html');
  const root = documentNode.body.firstElementChild as HTMLElement;
  root.setAttribute('style', `max-width:677px;margin:0 auto;padding:4px 0;font-size:16px;${textStyle(theme)}`);
  root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6,p,blockquote,pre,ul,ol,li,table,th,td,a,img,hr,code,strong,em,del').forEach((element) => {
    const tag = element.tagName.toLowerCase();
    if (tag === 'h1') element.setAttribute('style', `margin:34px 0 18px;padding:0 0 12px;border-bottom:2px solid ${theme.primary};font-size:27px;line-height:1.35;font-weight:700;${textStyle(theme)}`);
    else if (/^h[2-6]$/.test(tag)) element.setAttribute('style', `margin:30px 0 14px;padding-left:12px;border-left:4px solid ${theme.primary};font-size:${tag === 'h2' ? 21 : 18}px;line-height:1.45;font-weight:700;${textStyle(theme)}`);
    else if (tag === 'p') element.setAttribute('style', `margin:0 0 17px;${textStyle(theme)}`);
    else if (tag === 'blockquote') element.setAttribute('style', `margin:22px 0;padding:15px 17px;border-left:4px solid ${theme.primary};background:${theme.pale};color:${theme.ink};${textStyle(theme)}`);
    else if (tag === 'pre') element.setAttribute('style', `margin:20px 0;padding:15px 16px;overflow:auto;border-radius:7px;background:#20262d;color:#edf2f7;font-family:${WECHAT_FONT_FAMILY};font-size:13px;line-height:1.65;white-space:pre;`);
    else if (tag === 'code' && element.parentElement?.tagName !== 'PRE') element.setAttribute('style', `padding:2px 5px;border-radius:3px;background:${theme.pale};color:${theme.primary};font-family:${WECHAT_FONT_FAMILY};font-size:14px;`);
    else if (tag === 'ul' || tag === 'ol') element.setAttribute('style', `margin:0 0 18px;padding-left:24px;${textStyle(theme)}`);
    else if (tag === 'li') element.setAttribute('style', `margin:7px 0;${textStyle(theme)}`);
    else if (tag === 'table') element.setAttribute('style', 'width:100%;margin:20px 0;border-collapse:collapse;font-size:14px;line-height:1.6;');
    else if (tag === 'th') element.setAttribute('style', `padding:9px 8px;border:1px solid ${theme.primary};background:${theme.primary};font-family:${WECHAT_FONT_FAMILY};color:#fff;text-align:left;`);
    else if (tag === 'td') element.setAttribute('style', `padding:9px 8px;border:1px solid ${theme.primary}44;${textStyle(theme)}`);
    else if (tag === 'a') element.setAttribute('style', `font-family:${WECHAT_FONT_FAMILY};color:${theme.primary};text-decoration:underline;text-decoration-color:${theme.accent};`);
    else if (tag === 'strong') element.setAttribute('style', `font-weight:700;${textStyle(theme)}`);
    else if (tag === 'em') element.setAttribute('style', `font-style:italic;${textStyle(theme)}`);
    else if (tag === 'del') element.setAttribute('style', `text-decoration:line-through;${textStyle(theme)}`);
    else if (tag === 'img') element.setAttribute('style', 'display:block;max-width:100%;height:auto;margin:22px auto;border-radius:4px;');
    else if (tag === 'hr') element.setAttribute('style', `margin:30px 0;border:0;border-top:1px solid ${theme.primary}55;`);
  });
  const cover = documentNode.createElement('section');
  cover.setAttribute('style', `margin:8px 0 30px;padding:30px 24px 24px;border-top:5px solid ${theme.primary};background:${theme.pale};`);
  cover.innerHTML = `<p style="margin:0 0 10px;color:${theme.primary};font-size:12px;letter-spacing:2px;font-family:${WECHAT_FONT_FAMILY};"><span leaf="">ZEDITOR · WECHAT</span></p><p style="margin:0;font-size:28px;line-height:1.35;font-weight:700;${textStyle(theme)}"><span leaf="" data-wechat-title></span></p><p style="margin:14px 0 0;color:${theme.primary};font-family:${WECHAT_FONT_FAMILY};font-size:13px;"><span leaf="">阅读这篇文章</span></p>`;
  const titleNode = cover.querySelector<HTMLElement>('[data-wechat-title]');
  if (titleNode) {
    titleNode.textContent = title;
    titleNode.removeAttribute('data-wechat-title');
  }
  root.prepend(cover); wrapTextLeaves(root);
  return root.outerHTML;
}

async function copyRichHtml(html: string) {
  if (navigator.clipboard && typeof ClipboardItem !== 'undefined') {
    await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([html.replace(/<[^>]+>/g, '')], { type: 'text/plain' }) })]); return;
  }
  const holder = document.createElement('div'); holder.contentEditable = 'true'; holder.innerHTML = html; document.body.append(holder); const range = document.createRange(); range.selectNodeContents(holder); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); document.execCommand('copy'); holder.remove();
}

export function WeChatExportDialog({ content, title, onClose }: { content: string; title: string; onClose: () => void }) {
  const [themeId, setThemeId] = useState<WeChatThemeId>('jade'); const [copied, setCopied] = useState(false);
  const theme = themes.find((item) => item.id === themeId) || themes[0];
  const html = useMemo(() => renderWeChatHtml(content, title, theme), [content, title, theme]);
  const copy = async () => { await copyRichHtml(html); setCopied(true); window.setTimeout(() => setCopied(false), 1800); };
  const saveHtml = async () => { const path = await save({ filters: [{ name: '公众号 HTML', extensions: ['html'] }], defaultPath: `${title}-公众号.html` }); if (path) await invoke('save_file_content', { path, content: html }); };
  return <div className="modal-overlay" onClick={onClose}><div className="modal-content wechat-export-modal" onClick={(event) => event.stopPropagation()}>
    <div className="modal-header"><div><h2>公众号排版导出</h2><p className="export-modal-subtitle">原创主题 · 内联样式 · 可直接粘贴到微信公众号编辑器</p></div><button className="modal-close" onClick={onClose} aria-label="关闭"><AppIcon name="close" size={16} /></button></div>
    <div className="modal-body"><div className="wechat-theme-grid">{themes.map((item) => <button key={item.id} className={item.id === themeId ? 'active' : ''} onClick={() => setThemeId(item.id)} style={{ '--wechat-primary': item.primary, '--wechat-pale': item.pale } as React.CSSProperties}><strong>{item.label}</strong><small>{item.description}</small></button>)}</div><div className="wechat-export-preview" dangerouslySetInnerHTML={{ __html: html }} /></div>
    <div className="form-actions"><button className="cancel-btn" onClick={onClose}>取消</button><button className="secondary-btn" onClick={() => void saveHtml()}>保存 HTML</button><button className="save-btn" onClick={() => void copy()}>{copied ? '已复制，可粘贴到公众号' : '复制富文本到公众号'}</button></div>
  </div></div>;
}
