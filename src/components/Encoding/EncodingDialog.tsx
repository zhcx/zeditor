import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '../../stores/appStore';
import { TEXT_ENCODINGS, type EncodingDialogRequest, type TextEncoding } from '../../utils/textEncoding';
import { AppIcon } from '../Icons/AppIcon';
import { t } from '../../i18n';
import { openBase64Document } from '../../services/textDocuments';
import './encoding.css';

export function EncodingDialog({ request }: { request: EncodingDialogRequest }) {
  const tab = useAppStore(state => state.tabs.find(item => item.id === request.tabId));
  const language = useAppStore(state => state.settings.appearance.language);
  const text = (value: string) => t(value, language);
  const [mode, setMode] = useState(request.mode);
  const [selected, setSelected] = useState<TextEncoding>(tab?.encoding || (mode === 'open' ? 'gbk' : 'utf-8'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const panelRef = useRef<HTMLElement>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
    return () => { alive.current = false; if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);

  const close = () => { alive.current = false; useAppStore.getState().setEncodingDialog(null); };
  const apply = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const store = useAppStore.getState();
      if (mode === 'open' && request.path) await store.openFile(request.path, selected, () => !alive.current);
      else if (mode === 'open' && request.dataBase64 !== undefined) await openBase64Document(request.title || '云端版本', request.dataBase64, selected, () => !alive.current);
      else if (mode === 'reopen' && request.tabId) await store.reopenTabWithEncoding(request.tabId, selected, () => !alive.current);
      else if (request.tabId) store.setTabEncoding(request.tabId, selected);
      if (alive.current) close();
    } catch (failure) {
      if (alive.current) setError(String(failure));
    } finally { if (alive.current) setBusy(false); }
  };

  const handleKeys = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing) { event.stopPropagation(); return; }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) && (event.target as HTMLElement).closest('.encoding-options')) {
      if (busy) return;
      event.preventDefault(); event.stopPropagation();
      const current = TEXT_ENCODINGS.findIndex(option => option.value === selected);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? TEXT_ENCODINGS.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + TEXT_ENCODINGS.length) % TEXT_ENCODINGS.length;
      setSelected(TEXT_ENCODINGS[next].value);
      panelRef.current?.querySelectorAll<HTMLButtonElement>('.encoding-options button')[next]?.focus();
    } else if (event.key === 'Tab') {
      const buttons = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []);
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (!event.shiftKey && index === buttons.length - 1) { event.preventDefault(); buttons[0]?.focus(); }
      if (event.shiftKey && index === 0) { event.preventDefault(); buttons.at(-1)?.focus(); }
    }
  };

  return createPortal(
    <div className="encoding-overlay" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
      <section ref={panelRef} className="encoding-dialog" role="dialog" aria-modal="true" aria-labelledby="encoding-title" onKeyDown={handleKeys}>
        <header><div><h2 id="encoding-title">{text(mode === 'open' ? '选择打开编码' : '文字编码')}</h2><p title={request.path || tab?.path || request.title || ''}>{request.path?.split(/[\\/]/).pop() || request.title || tab?.title || text('当前文档')}</p></div><button type="button" onClick={close} aria-label={text('关闭编码选择')}><AppIcon name="close" size={18} /></button></header>
        {request.mode !== 'open' && <div className="encoding-modes">
          <button type="button" aria-pressed={mode === 'save'} disabled={busy} onClick={() => { setMode('save'); setError(''); }}>{text('选择保存编码')}</button>
          <button type="button" aria-pressed={mode === 'reopen'} disabled={busy || !tab?.path || tab.modified} title={text(tab?.modified ? '请先保存修改，再重新打开' : '从磁盘重新读取，不改写文件')} onClick={() => { setMode('reopen'); setError(''); }}>{text('用编码重新打开')}</button>
        </div>}
        <p className="encoding-description">{text(mode === 'save' ? '编码会在下次保存时使用，当前内容保持不变。' : '选择文件实际使用的编码。打开后检查文字是否正确。')}</p>
        <div className="encoding-options" role="listbox" aria-label={text('文字编码')}>
          {TEXT_ENCODINGS.map(option => <button key={option.value} type="button" role="option" aria-selected={selected === option.value} disabled={busy} onClick={() => setSelected(option.value)}><span><strong>{option.label}</strong><small>{text(option.description)}</small></span>{selected === option.value && <AppIcon name="check" size={16} />}</button>)}
        </div>
        {error && <p className="encoding-error" role="alert">{error}</p>}
        <footer><button type="button" onClick={close}>{text('取消')}</button><button type="button" className="encoding-confirm" disabled={busy || (mode !== 'open' && !tab)} onClick={() => void apply()}>{text(busy ? '读取中…' : mode === 'save' ? '使用此编码' : mode === 'open' ? '打开' : '重新打开')}</button></footer>
      </section>
    </div>, document.body,
  );
}
