import { useCallback, useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { MenuBar } from '../MenuBar/MenuBar';
import { useAppStore } from '../../stores/appStore';
import { t } from '../../i18n';

const APP_NAME = 'Zeditor';

interface TitleBarProps {
  onRequestClose: () => void | Promise<void>;
}

export function TitleBar({ onRequestClose }: TitleBarProps) {
  const [isMaximized, setIsMaximized] = useState(false);
  const mountedRef = useRef(true);
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  const language = useAppStore(state => state.settings.appearance.language);
  const activeDocumentTitle = useAppStore(state => (
    state.tabs.find(tab => tab.id === state.activeTabId)?.title || t('未命名', state.settings.appearance.language)
  ));

  useEffect(() => {
    if (!isTauri) return undefined;
    mountedRef.current = true;

    // One-shot initial read — fire-and-forget, no effect nesting
    getCurrentWindow()
      .isMaximized()
      .then((maximized) => {
        if (mountedRef.current) {
          setIsMaximized(maximized);
        }
      })
      .catch(() => { /* not critical */ });

    return () => {
      mountedRef.current = false;
    };
  }, [isTauri]);

  const handleResize = useCallback(async () => {
    try {
      const maximized = await getCurrentWindow().isMaximized();
      if (mountedRef.current) {
        setIsMaximized(maximized);
      }
    } catch { /* not critical */ }
  }, []);

  useEffect(() => {
    if (!isTauri) return undefined;
    const unlistenPromise = getCurrentWindow().onResized(handleResize);
    return () => { unlistenPromise.then(fn => fn()); };
  }, [handleResize, isTauri]);

  useEffect(() => {
    if (!isTauri) return undefined;
    getCurrentWindow().setTitle(APP_NAME).catch(() => { /* not critical */ });
    return undefined;
  }, [isTauri]);

  const handleMinimize = useCallback(async () => {
    if (!isTauri) return;
    await getCurrentWindow().minimize();
  }, [isTauri]);

  const handleToggleMaximize = useCallback(async () => {
    if (!isTauri) return;
    await getCurrentWindow().toggleMaximize();
  }, [isTauri]);

  const handleClose = useCallback(async () => {
    if (!isTauri) return;
    await onRequestClose();
  }, [isTauri, onRequestClose]);

  return (
    <div className="titlebar">
      <div className="titlebar-menu" data-tauri-drag-region="false">
        <MenuBar />
      </div>
      <div
        className="titlebar-drag-spacer"
        data-tauri-drag-region
      >
        <div className="titlebar-command-center" role="status" aria-label={`${t('当前文档：', language)}${activeDocumentTitle}`}>
          <span>{activeDocumentTitle}</span>
        </div>
      </div>
      <div className="titlebar-controls" data-tauri-drag-region="false">
        <button
          className="titlebar-btn titlebar-minimize"
          onClick={handleMinimize}
          title={t('最小化', language)}
          aria-label={t('最小化', language)}
        >
          <svg width="12" height="1" viewBox="0 0 12 1"><rect width="12" height="1" fill="currentColor"/></svg>
        </button>
        <button
          className="titlebar-btn titlebar-maximize"
          onClick={handleToggleMaximize}
          title={isMaximized ? t('还原', language) : t('最大化', language)}
          aria-label={isMaximized ? t('还原', language) : t('最大化', language)}
        >
          {isMaximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10">
              <rect x="2" y="0" width="8" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="1.1"/>
              <rect x="0" y="2" width="8" height="8" rx="1" fill="var(--bg-elevated)" stroke="currentColor" strokeWidth="1.1"/>
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10">
              <rect x="0.5" y="0.5" width="9" height="9" rx="1" fill="none" stroke="currentColor" strokeWidth="1.1"/>
            </svg>
          )}
        </button>
        <button
          className="titlebar-btn titlebar-close"
          onClick={handleClose}
          title={t('关闭', language)}
          aria-label={t('关闭', language)}
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M0.5 0.5L9.5 9.5M9.5 0.5L0.5 9.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
        </button>
      </div>
    </div>
  );
}
