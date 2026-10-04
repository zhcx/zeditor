import { AppIcon } from '../Icons/AppIcon';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '../../stores/appStore';
import { filterOpenDocuments } from '../../utils/workbenchNavigation';
import { FileTypeIcon } from '../Sidebar/FileTypeIcon';
import './document-switcher.css';
import { t } from '../../i18n';

interface DocumentSwitcherProps {
  onClose: () => void;
}

export function DocumentSwitcher({ onClose }: DocumentSwitcherProps) {
  const tabs = useAppStore(state => state.tabs);
  const activeTabId = useAppStore(state => state.activeTabId);
  const language = useAppStore(state => state.settings.appearance.language);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const results = useMemo(() => {
    const matched = filterOpenDocuments(tabs, query);
    return query.trim() ? matched : [...matched].sort((left, right) => Number(right.id === activeTabId) - Number(left.id === activeTabId));
  }, [tabs, query, activeTabId]);
  const selectedIndex = Math.min(activeIndex, Math.max(0, results.length - 1));
  const selected = results[selectedIndex];

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);

  useEffect(() => {
    dialogRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected?.id]);

  const selectDocument = (id: string) => {
    useAppStore.getState().setActiveTab(id);
    onClose();
    requestAnimationFrame(() => useAppStore.getState().editorView?.focus());
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    // 输入法组合阶段保留候选选择与确认，不触发文档导航或后台快捷键。
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
      event.stopPropagation();
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      event.stopPropagation();
      if (event.key.toLowerCase() === 'p') { event.preventDefault(); onClose(); }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); onClose();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (results.length) setActiveIndex((selectedIndex + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length);
    } else if (event.key === 'Enter' && event.target === inputRef.current) {
      event.preventDefault();
      if (selected) selectDocument(selected.id);
    } else if (event.key === 'Tab') {
      const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('input, button:not([tabindex="-1"])') || []);
      const index = controls.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && index === 0) { event.preventDefault(); controls.at(-1)?.focus(); }
      else if (!event.shiftKey && index === controls.length - 1) { event.preventDefault(); controls[0]?.focus(); }
    }
  };

  return createPortal(
    <div className="document-switcher-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} className="document-switcher" role="dialog" aria-modal="true" aria-labelledby="document-switcher-title" onKeyDown={handleKeyDown}>
        <header className="document-switcher-header">
          <div><h2 id="document-switcher-title">{t('切换文档', language)}</h2><p>{t('按名称或路径查找已打开的文档', language)}</p></div>
          <button type="button" className="document-switcher-close" aria-label={t('关闭文档切换', language)} onClick={onClose}><AppIcon name="close" size={16} /></button>
        </header>
        <div className="document-switcher-search">
          <AppIcon name="search" size={20}  />
          <input ref={inputRef} value={query} onChange={event => { setQuery(event.target.value); setActiveIndex(0); }} placeholder={t('搜索文档…', language)} aria-label={t('搜索已打开的文档', language)} role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="document-switcher-results" aria-activedescendant={selected ? `switch-document-${selected.id}` : undefined} />
        </div>
        <div id="document-switcher-results" className="document-switcher-results" role="listbox" aria-label={t('已打开的文档', language)}>
          {results.map((tab, index) => (
            <button key={tab.id} id={`switch-document-${tab.id}`} type="button" role="option" aria-selected={index === selectedIndex} tabIndex={-1} className="document-switcher-item" onMouseEnter={() => setActiveIndex(index)} onClick={() => selectDocument(tab.id)}>
              <FileTypeIcon filename={tab.title} />
              <span className="document-switcher-document"><strong>{tab.path ? tab.title : t(tab.title, language)}</strong><small>{tab.path || t('尚未保存到文件', language)}</small></span>
              {tab.modified && <span className="document-switcher-dirty" title={t('未保存修改', language)} aria-label={t('未保存修改', language)} />}
              {tab.id === activeTabId && <span className="document-switcher-current">{t('当前', language)}</span>}
            </button>
          ))}
          {!results.length && <div className="document-switcher-empty">{t('没有找到相关文档', language)}<small>{t('试试更短的关键词或部分路径', language)}</small></div>}
        </div>
        <footer className="document-switcher-footer"><span><kbd>↑</kbd><kbd>↓</kbd> {t('选择', language)} <kbd>Enter</kbd> {t('打开', language)} <kbd>Esc</kbd> {t('关闭', language)}</span><span>{results.length} {t('个文档', language)}</span></footer>
      </section>
    </div>, document.body,
  );
}
