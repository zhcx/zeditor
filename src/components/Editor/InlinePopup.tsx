import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { t, type AppLanguage } from '../../i18n';
import { isOpenableUrl, type InlineTarget } from '../../utils/inlineTargets';

/** 弹窗字段的当前值；只包含当前 kind 用到的键。 */
export interface InlinePopupFields {
  label?: string;
  url?: string;
  src?: string;
  alt?: string;
  title?: string;
  latex?: string;
  name?: string;
  /** 脚注定义内容（弹窗内编辑，确认时回写定义行）。 */
  content?: string;
  target?: string;
  display?: string;
}

export interface InlinePopupProps {
  target: InlineTarget;
  /** 目标所在行左下角的视口坐标。 */
  anchor: { left: number; top: number };
  /** 打开时是否自动聚焦第一个输入框（Ctrl+K 为 true，点击为 false）。 */
  autoFocus: boolean;
  language: AppLanguage;
  onApply: (fields: InlinePopupFields) => void;
  onOpen: (url: string) => void;
  onCopy: (text: string) => void;
  onDelete: () => void;
  onBrowse?: () => void;
  onJumpToDefinition: () => void;
  onClose: () => void;
}

const KIND_LABELS: Record<InlineTarget['kind'], string> = {
  link: '链接',
  image: '图片',
  math: '数学公式',
  footnote: '脚注',
  wikilink: 'Wiki 链接',
};

/**
 * 内联弹窗：悬浮在内联结构（链接 / 图片 / 公式 / 脚注 / Wiki 链接）旁的就地
 * 编辑窗。Enter 确认、Esc 关闭、点击弹窗外部关闭；公式带 KaTeX 实时预览。
 */
export function InlinePopup({
  target, anchor, autoFocus, language, onApply, onOpen, onCopy, onDelete, onBrowse, onJumpToDefinition, onClose,
}: InlinePopupProps) {
  const [fields, setFields] = useState<InlinePopupFields>(() => ({
    ...(target.label ? { label: target.label.text } : {}),
    ...(target.url ? { url: target.url.text } : {}),
    ...(target.src ? { src: target.src.text } : {}),
    ...(target.alt ? { alt: target.alt.text } : {}),
    ...(target.title !== undefined ? { title: target.title } : {}),
    ...(target.latex !== undefined ? { latex: target.latex } : {}),
    ...(target.name !== undefined ? { name: target.name } : {}),
    ...(target.kind === 'footnote' ? { content: target.definition?.text ?? '' } : {}),
    ...(target.target ? { target: target.target.text } : {}),
    ...(target.display !== undefined ? { display: target.display ? 'block' : 'inline' } : {}),
  }));
  const containerRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<{ left: number; top: number }>({ left: anchor.left, top: anchor.top });

  // 弹窗高度在渲染后才知道：空间不足时翻转到目标行上方，水平方向夹在窗口内。
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const height = element.offsetHeight;
    const width = element.offsetWidth;
    const below = anchor.top + 6;
    const top = below + height > window.innerHeight - 8 && anchor.top - height - 12 > 8
      ? Math.max(8, anchor.top - height - 12)
      : below;
    const left = Math.min(Math.max(8, anchor.left), Math.max(8, window.innerWidth - width - 8));
    setPlacement({ left, top });
  }, [anchor, fields.latex, target.kind]);

  useEffect(() => {
    if (!autoFocus) return;
    const firstInput = containerRef.current?.querySelector<HTMLElement>('input, textarea');
    firstInput?.focus();
    if (firstInput instanceof HTMLInputElement || firstInput instanceof HTMLTextAreaElement) firstInput.select();
  }, [autoFocus]);

  // 点击弹窗外部关闭（弹窗挂在 body 上，编辑器里的下一次点击也算外部）。
  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener('mousedown', handlePointerDown, true);
    return () => window.removeEventListener('mousedown', handlePointerDown, true);
  }, [onClose]);

  /** 输入框内 Enter 确认；Esc 在任何字段里都关闭。 */
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    const isTextarea = event.target instanceof HTMLTextAreaElement;
    if (event.key === 'Enter' && (!isTextarea || event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      event.stopPropagation();
      onApply(fields);
    }
  };

  const setField = (key: keyof InlinePopupFields) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const value = event.target.value;
    setFields((previous) => ({ ...previous, [key]: value }));
  };

  /** KaTeX 实时预览：先按严格模式探测错误，再以宽松模式渲染内容。 */
  const mathPreview = useMemo(() => {
    if (target.kind !== 'math') return null;
    const latex = fields.latex ?? '';
    if (!latex.trim()) return { html: '', error: '' };
    try {
      katex.renderToString(latex, { displayMode: target.display, throwOnError: true, strict: false });
      return { html: katex.renderToString(latex, { displayMode: target.display, throwOnError: false, strict: false }), error: '' };
    } catch (error) {
      return {
        html: katex.renderToString(latex, { displayMode: target.display, throwOnError: false, strict: false }),
        error: error instanceof Error ? error.message.replace(/^KaTeX parse error:\s*/, '') : String(error),
      };
    }
  }, [target.kind, target.display, fields.latex]);

  const applyButton = (
    <button type="button" className="inline-popup-button primary" onClick={() => onApply(fields)}>
      {t('确认', language)}
      <kbd>Enter</kbd>
    </button>
  );

  return createPortal(
    <div
      ref={containerRef}
      className="inline-popup"
      role="dialog"
      aria-label={t(KIND_LABELS[target.kind], language)}
      style={{ left: placement.left, top: placement.top }}
      onKeyDown={handleKeyDown}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="inline-popup-header">
        <span className="inline-popup-kind">{t(KIND_LABELS[target.kind], language)}</span>
        <button type="button" className="inline-popup-close" aria-label={t('关闭', language)} onClick={onClose}>✕</button>
      </div>

      <div className="inline-popup-fields">
        {target.kind === 'link' && (
          <>
            <label className="inline-popup-field">
              <span>{t('文字', language)}</span>
              <input value={fields.label ?? ''} onChange={setField('label')} placeholder={t('链接文字', language)} />
            </label>
            <label className="inline-popup-field">
              <span>URL</span>
              <input value={fields.url ?? ''} onChange={setField('url')} placeholder="https://…" />
            </label>
          </>
        )}

        {target.kind === 'image' && (
          <>
            <label className="inline-popup-field">
              <span>{t('来源', language)}</span>
              <input value={fields.src ?? ''} onChange={setField('src')} placeholder=".assets/图片.png 或 https://…" />
            </label>
            <label className="inline-popup-field">
              <span>{t('替代文本', language)}</span>
              <input value={fields.alt ?? ''} onChange={setField('alt')} />
            </label>
            <label className="inline-popup-field">
              <span>{t('标题', language)}</span>
              <input value={fields.title ?? ''} onChange={setField('title')} />
            </label>
            {target.attrs && <div className="inline-popup-hint">{t('尺寸属性将原样保留', language)}<code>{target.attrs}</code></div>}
          </>
        )}

        {target.kind === 'math' && (
          <>
            <label className="inline-popup-field">
              <span>LaTeX</span>
              <textarea
                value={fields.latex ?? ''}
                onChange={setField('latex')}
                rows={Math.min(6, Math.max(2, (fields.latex ?? '').split('\n').length))}
                spellCheck={false}
              />
            </label>
            <div className="inline-popup-preview">
              {mathPreview?.error
                ? <div className="inline-popup-preview-error">{mathPreview.error}</div>
                : <div className="inline-popup-preview-body" dangerouslySetInnerHTML={{ __html: mathPreview?.html ?? '' }} />}
            </div>
          </>
        )}

        {target.kind === 'footnote' && (
          <>
            <label className="inline-popup-field">
              <span>{t('标记', language)}</span>
              <input value={fields.name ?? ''} onChange={setField('name')} />
            </label>
            <label className="inline-popup-field">
              <span>{t('内容', language)}</span>
              <textarea
                value={fields.content ?? ''}
                onChange={setField('content')}
                rows={Math.min(6, Math.max(2, (fields.content ?? '').split('\n').length))}
                placeholder={target.definition ? undefined : t('未找到定义，确认后会在文末创建', language)}
              />
            </label>
          </>
        )}

        {target.kind === 'wikilink' && (
          <>
            <label className="inline-popup-field">
              <span>{t('目标', language)}</span>
              <input value={fields.target ?? ''} onChange={setField('target')} placeholder="notes/卡片.md" />
            </label>
            <label className="inline-popup-field">
              <span>{t('显示文字', language)}</span>
              <input value={fields.label ?? ''} onChange={setField('label')} placeholder={t('可选', language)} />
            </label>
          </>
        )}
      </div>

      <div className="inline-popup-actions">
        {target.kind === 'link' && (
          <>
            <button type="button" className="inline-popup-button" disabled={!isOpenableUrl(fields.url ?? '')} onClick={() => onOpen(fields.url ?? '')}>{t('打开', language)}</button>
            <button type="button" className="inline-popup-button" onClick={() => onCopy(fields.url ?? '')}>{t('复制', language)}</button>
            <button type="button" className="inline-popup-button danger" onClick={onDelete}>{t('移除链接', language)}</button>
            {applyButton}
          </>
        )}
        {target.kind === 'image' && (
          <>
            {onBrowse && <button type="button" className="inline-popup-button" onClick={onBrowse}>{t('浏览', language)}</button>}
            <button type="button" className="inline-popup-button" onClick={() => onCopy(fields.src ?? '')}>{t('复制', language)}</button>
            <button type="button" className="inline-popup-button danger" onClick={onDelete}>{t('删除', language)}</button>
            {applyButton}
          </>
        )}
        {target.kind === 'math' && (
          <>
            {applyButton}
            <button type="button" className="inline-popup-button danger" onClick={onDelete}>{t('删除', language)}</button>
          </>
        )}
        {target.kind === 'footnote' && (
          <>
            <button type="button" className="inline-popup-button" disabled={!target.definition} onClick={onJumpToDefinition}>{t('跳转到定义', language)}</button>
            <button type="button" className="inline-popup-button danger" onClick={onDelete}>{t('删除', language)}</button>
            {applyButton}
          </>
        )}
        {target.kind === 'wikilink' && (
          <>
            <button type="button" className="inline-popup-button" onClick={() => onCopy(fields.target ?? '')}>{t('复制', language)}</button>
            <button type="button" className="inline-popup-button danger" onClick={onDelete}>{t('删除', language)}</button>
            {applyButton}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
