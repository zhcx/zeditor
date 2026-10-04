import { AppIcon } from '../Icons/AppIcon';
import type { IconName } from '../Icons/iconGeometry';
import { useEffect, useRef, useState } from 'react';

type ActivityView = 'explorer' | 'search';

interface ActivityBarProps {
  activeView: ActivityView;
  chatbotVisible: boolean;
  settingsOpen: boolean;
  immersive: boolean;
  zen: boolean;
  theme: string;
  onSelectView: (view: ActivityView) => void;
  onOpenChat: () => void;
  onOpenSettings: () => void;
  onToggleTheme: () => void;
  onSelectImmersive: () => void;
  onSelectZen: () => void;
  onExitImmersive: () => void;
  toolbarPinned: boolean;
  onToggleToolbar: () => void;
}

const ActivityIconNames = {"explorer":"folder","search":"search","ai":"assistant","immersive":"book","zen":"penLine","theme":"sun","settings":"settings","format":"format"} as const satisfies Record<string, IconName>;

function ActivityIcon({ name }: { name: 'explorer' | 'search' | 'ai' | 'immersive' | 'zen' | 'theme' | 'settings' | 'format' }) {
  return <AppIcon name={ActivityIconNames[name]} />;
}

export function ActivityBar({ activeView, chatbotVisible, settingsOpen, immersive, zen, theme, onSelectView, onOpenChat, onOpenSettings, onToggleTheme, onSelectImmersive, onSelectZen, onExitImmersive, toolbarPinned, onToggleToolbar }: ActivityBarProps) {
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const modePickerRef = useRef<HTMLDivElement>(null);
  const isDark = theme === 'system'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : theme.endsWith('-dark');

  useEffect(() => {
    if (!modeMenuOpen) return;
    const closeMenu = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
      if (event instanceof MouseEvent && modePickerRef.current?.contains(event.target as Node)) return;
      setModeMenuOpen(false);
    };
    document.addEventListener('mousedown', closeMenu);
    document.addEventListener('keydown', closeMenu);
    return () => {
      document.removeEventListener('mousedown', closeMenu);
      document.removeEventListener('keydown', closeMenu);
    };
  }, [modeMenuOpen]);

  return (
    <nav className="activity-bar" aria-label="功能导航">
      <div className="activity-bar-main">
        <button type="button" className={`activity-bar-button ${activeView === 'explorer' ? 'active' : ''}`} onClick={() => onSelectView('explorer')} title="资源管理器" aria-label="资源管理器" aria-current={activeView === 'explorer' ? 'page' : undefined}>
          <ActivityIcon name="explorer" />
        </button>
        <button type="button" className={`activity-bar-button ${activeView === 'search' ? 'active' : ''}`} onClick={() => onSelectView('search')} title="搜索" aria-label="搜索" aria-current={activeView === 'search' ? 'page' : undefined}>
          <ActivityIcon name="search" />
        </button>
        <button type="button" className={`activity-bar-button ${chatbotVisible ? 'active' : ''}`} onClick={onOpenChat} title="AI 对话" aria-label="AI 对话" aria-pressed={chatbotVisible}>
          <ActivityIcon name="ai" />
        </button>
        <button type="button" className={`activity-bar-button ${toolbarPinned ? 'active' : ''}`} onClick={onToggleToolbar} title={toolbarPinned ? '隐藏格式工具栏' : '显示格式工具栏'} aria-label={toolbarPinned ? '隐藏格式工具栏' : '显示格式工具栏'} aria-pressed={toolbarPinned}>
          <ActivityIcon name="format" />
        </button>
        <div className="activity-immersive-picker" ref={modePickerRef}>
          <button
            type="button"
            className={`activity-bar-button ${immersive || zen ? 'active' : ''}`}
            onClick={() => setModeMenuOpen((open) => !open)}
            title="沉浸模式"
            aria-label="选择沉浸模式"
            aria-haspopup="menu"
            aria-expanded={modeMenuOpen}
          >
            <ActivityIcon name={zen ? 'zen' : 'immersive'} />
          </button>
          {modeMenuOpen && (
            <div className="immersive-mode-menu" role="menu" aria-label="选择沉浸模式">
              <div className="immersive-mode-menu-title">选择沉浸模式</div>
              <button type="button" className={`immersive-mode-option ${immersive ? 'selected' : ''}`} role="menuitemradio" aria-checked={immersive} onClick={() => { onSelectImmersive(); setModeMenuOpen(false); }}>
                <span className="immersive-mode-option-icon"><ActivityIcon name="immersive" /></span>
                <span><strong>沉浸阅读</strong><small>隐藏编辑器，专注阅读预览</small></span>
                <span className="immersive-mode-check">{immersive ? <AppIcon name="check" size={14} /> : ''}</span>
              </button>
              <button type="button" className={`immersive-mode-option ${zen ? 'selected' : ''}`} role="menuitemradio" aria-checked={zen} onClick={() => { onSelectZen(); setModeMenuOpen(false); }}>
                <span className="immersive-mode-option-icon"><ActivityIcon name="zen" /></span>
                <span><strong>沉浸写作</strong><small>隐藏预览与侧栏，专注写作</small></span>
                <span className="immersive-mode-check">{zen ? <AppIcon name="check" size={14} /> : ''}</span>
              </button>
              {(immersive || zen) && <button type="button" className="immersive-mode-exit" role="menuitem" onClick={() => { onExitImmersive(); setModeMenuOpen(false); }}>返回分屏模式</button>}
            </div>
          )}
        </div>
      </div>
      <div className="activity-bar-bottom">
        <button type="button" className="activity-bar-button activity-theme-button" onClick={onToggleTheme} title={`切换为${isDark ? '明亮' : '暗色'}模式`} aria-label={`切换为${isDark ? '明亮' : '暗色'}模式`}>
          <ActivityIcon name="theme" />
        </button>
        <button type="button" className={`activity-bar-button ${settingsOpen ? 'active' : ''}`} onClick={onOpenSettings} title="设置" aria-label="设置" aria-pressed={settingsOpen}>
          <ActivityIcon name="settings" />
        </button>
      </div>
    </nav>
  );
}
