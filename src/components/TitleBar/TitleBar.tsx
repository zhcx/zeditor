import { AppIcon } from '../Icons/AppIcon';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { MenuBar } from '../MenuBar/MenuBar';
import { useAppStore } from '../../stores/appStore';
import { t } from '../../i18n';
import { formatShortcut } from '../../utils/platformShortcuts';

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
  const modified = useAppStore(state => state.tabs.find(tab => tab.id === state.activeTabId)?.modified ?? false);

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
        <button type="button" className="titlebar-command-center" data-tauri-drag-region="false" aria-label={`${t('当前文档：', language)}${activeDocumentTitle} · ${t('搜索文档与文件内容', language)}`} aria-haspopup="listbox" aria-keyshortcuts="Control+P Meta+P" title={formatShortcut(t('搜索文档与文件内容（Ctrl+P）', language))} onClick={() => window.dispatchEvent(new CustomEvent('zeditor-switch-document'))}>
          <AppIcon name="search" size={14}  />
          <span>{activeDocumentTitle}</span>
          {modified && <span className="titlebar-document-dirty" aria-label={t('未保存修改', language)} />}
          <kbd>{formatShortcut('Ctrl P')}</kbd>
        </button>
      </div>
      <div className="titlebar-controls" data-tauri-drag-region="false">
        <button
          className="titlebar-btn titlebar-minimize"
          onClick={handleMinimize}
          title={t('最小化', language)}
          aria-label={t('最小化', language)}
        >
          <AppIcon name="windowMinimize" size={14}  />
        </button>
        <button
          className="titlebar-btn titlebar-maximize"
          onClick={handleToggleMaximize}
          title={isMaximized ? t('还原', language) : t('最大化', language)}
          aria-label={isMaximized ? t('还原', language) : t('最大化', language)}
        >
          {isMaximized ? (
            <AppIcon name="windowRestore" size={14}  />
          ) : (
            <AppIcon name="windowMaximize" size={14}  />
          )}
        </button>
        <button
          className="titlebar-btn titlebar-close"
          onClick={handleClose}
          title={t('关闭', language)}
          aria-label={t('关闭', language)}
        >
          <AppIcon name="close" size={14}  />
        </button>
      </div>
    </div>
  );
}
