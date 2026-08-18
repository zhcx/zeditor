import { useEffect, useRef, useState } from 'react';

type ActivityView = 'explorer' | 'search' | 'graph' | 'library';

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
}

function ActivityIcon({ name }: { name: 'explorer' | 'search' | 'graph' | 'library' | 'ai' | 'immersive' | 'zen' | 'theme' | 'settings' }) {
  if (name === 'explorer') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3.5h9.5L19 8v12.5H5zM14 3.5V8h5M8 12h8M8 16h8" /></svg>;
  if (name === 'search') return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="5.8" /><path d="m15 15 4.5 4.5" /></svg>;
  if (name === 'graph') return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="7" r="2.2" /><circle cx="18" cy="6" r="2.2" /><circle cx="12" cy="18" r="2.2" /><path d="m7.9 7.6 8 -1M7.5 8.8l3.2 7M16.5 7.9l-3.2 7" /></svg>;
  if (name === 'library') return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="2" /><path d="M8 9h8M8 13h5M8 16h8" /></svg>;
  if (name === 'ai') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.5 5.1L18.5 10l-5 1.6L12 17l-1.5-5.4-5-1.6 5-1.9zM18.4 15.4l.6 2.1 2.1.6-2.1.7-.6 2.1-.7-2.1-2.1-.7 2.1-.6z" /></svg>;
  if (name === 'immersive') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12s3.2-5 9-5 9 5 9 5-3.2 5-9 5-9-5-9-5Z" /><circle cx="12" cy="12" r="2.4" /></svg>;
  if (name === 'zen') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h10M7 9h10M7 13h7M5 19h14" /><path d="M4 4v5M20 4v5M4 20v-5M20 20v-5" /></svg>;
  if (name === 'theme') return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M12 3v2M12 19v2M21 12h-2M5 12H3m15.4-6.4-1.4 1.4M7 17.4l-1.4 1.4m0-13.2L7 7m10 10 1.4 1.4" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="2.2" /><path d="M19 13.5a7.3 7.3 0 0 0 .05-3L21 9l-2-3.45-1.8.7a7.5 7.5 0 0 0-2.55-1.48L14.4 3h-4l-.28 1.77A7.5 7.5 0 0 0 7.6 6.25l-1.82-.7L3.8 9l1.95 1.5a7.3 7.3 0 0 0 0 3L3.8 15l1.98 3.45 1.82-.7a7.5 7.5 0 0 0 2.52 1.48L10.4 21h4l.25-1.77a7.5 7.5 0 0 0 2.55-1.48l1.8.7L21 15z" /></svg>;
}

export function ActivityBar({ activeView, chatbotVisible, settingsOpen, immersive, zen, theme, onSelectView, onOpenChat, onOpenSettings, onToggleTheme, onSelectImmersive, onSelectZen, onExitImmersive }: ActivityBarProps) {
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
        <button type="button" className={`activity-bar-button ${activeView === 'graph' ? 'active' : ''}`} onClick={() => onSelectView('graph')} title="知识图谱" aria-label="知识图谱" aria-current={activeView === 'graph' ? 'page' : undefined}>
          <ActivityIcon name="graph" />
        </button>
        <button type="button" className={`activity-bar-button ${activeView === 'library' ? 'active' : ''}`} onClick={() => onSelectView('library')} title="SuperTag 资料库" aria-label="SuperTag 资料库" aria-current={activeView === 'library' ? 'page' : undefined}>
          <ActivityIcon name="library" />
        </button>
        <button type="button" className={`activity-bar-button ${chatbotVisible ? 'active' : ''}`} onClick={onOpenChat} title="AI 对话" aria-label="AI 对话" aria-pressed={chatbotVisible}>
          <ActivityIcon name="ai" />
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
                <span className="immersive-mode-check">{immersive ? '✓' : ''}</span>
              </button>
              <button type="button" className={`immersive-mode-option ${zen ? 'selected' : ''}`} role="menuitemradio" aria-checked={zen} onClick={() => { onSelectZen(); setModeMenuOpen(false); }}>
                <span className="immersive-mode-option-icon"><ActivityIcon name="zen" /></span>
                <span><strong>沉浸写作</strong><small>隐藏预览与侧栏，专注写作</small></span>
                <span className="immersive-mode-check">{zen ? '✓' : ''}</span>
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
