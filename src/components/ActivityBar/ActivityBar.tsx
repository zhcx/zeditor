import { AppIcon } from '../Icons/AppIcon';
import type { IconName } from '../Icons/iconGeometry';
import { useEffect, useRef, useState } from 'react';

type ActivityView = 'explorer' | 'search';

interface ActivityBarProps {
  activeView: ActivityView;
  sidebarVisible: boolean;
  chatbotVisible: boolean;
  settingsOpen: boolean;
  immersive: boolean;
  zen: boolean;
  wysiwyg: boolean;
  theme: string;
  onSelectView: (view: ActivityView) => void;
  onOpenChat: () => void;
  onOpenSettings: () => void;
  onToggleTheme: () => void;
  onSelectSplit: () => void;
  onSelectWysiwyg: () => void;
  onSelectImmersive: () => void;
  onSelectZen: () => void;
  onExitImmersive: () => void;
  toolbarPinned: boolean;
  onToggleToolbar: () => void;
}

const ActivityIconNames = {"explorer":"folder","search":"search","ai":"assistant","immersive":"book","zen":"penLine","wysiwyg":"penLine","theme":"sun","settings":"settings","format":"format"} as const satisfies Record<string, IconName>;

function ActivityIcon({ name }: { name: 'explorer' | 'search' | 'ai' | 'immersive' | 'zen' | 'wysiwyg' | 'theme' | 'settings' | 'format' }) {
  return <AppIcon name={ActivityIconNames[name]} />;
}

export function ActivityBar({ activeView, sidebarVisible, chatbotVisible, settingsOpen, immersive, zen, wysiwyg, theme, onSelectView, onOpenChat, onOpenSettings, onToggleTheme, onSelectSplit, onSelectWysiwyg, onSelectImmersive, onSelectZen, onExitImmersive, toolbarPinned, onToggleToolbar }: ActivityBarProps) {
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
        <button type="button" className={`activity-bar-button ${sidebarVisible && activeView === 'explorer' ? 'active' : ''}`} onClick={() => onSelectView('explorer')} title="资源管理器" aria-label="资源管理器" aria-current={sidebarVisible && activeView === 'explorer' ? 'page' : undefined}>
          <ActivityIcon name="explorer" />
        </button>
        <button type="button" className={`activity-bar-button ${sidebarVisible && activeView === 'search' ? 'active' : ''}`} onClick={() => onSelectView('search')} title="搜索当前文档（正文查找/替换）" aria-label="搜索当前文档" aria-current={sidebarVisible && activeView === 'search' ? 'page' : undefined}>
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
            className={`activity-bar-button ${immersive || zen || wysiwyg ? 'active' : ''}`}
            onClick={() => setModeMenuOpen((open) => !open)}
            title="编辑模式"
            aria-label="选择编辑模式"
            aria-haspopup="menu"
            aria-expanded={modeMenuOpen}
          >
            {/* 编辑模式是「选择模式」的入口：沿用原有的书 / 笔形图标，
                不要随模式换成 format——那会和上方「格式工具栏」按钮完全一样。 */}
            <ActivityIcon name={wysiwyg || zen ? 'zen' : 'immersive'} />
          </button>
          {modeMenuOpen && (
            <div className="immersive-mode-menu" role="menu" aria-label="选择编辑模式">
              <div className="immersive-mode-menu-title">选择编辑模式</div>
              <button type="button" className={`immersive-mode-option ${!immersive && !zen && !wysiwyg ? 'selected' : ''}`} role="menuitemradio" aria-checked={!immersive && !zen && !wysiwyg} onClick={() => { onSelectSplit(); setModeMenuOpen(false); }}>
                <span className="immersive-mode-option-icon"><ActivityIcon name="format" /></span>
                <span><strong>源码对照</strong><small>左侧源码，右侧实时预览</small></span>
                <span className="immersive-mode-check">{!immersive && !zen && !wysiwyg ? <AppIcon name="check" size={14} /> : ''}</span>
              </button>
              <button type="button" className={`immersive-mode-option ${wysiwyg ? 'selected' : ''}`} role="menuitemradio" aria-checked={wysiwyg} onClick={() => { onSelectWysiwyg(); setModeMenuOpen(false); }}>
                <span className="immersive-mode-option-icon"><ActivityIcon name="wysiwyg" /></span>
                <span><strong>所见即所得</strong><small>像写文档一样直接编辑，不显示标记</small></span>
                <span className="immersive-mode-check">{wysiwyg ? <AppIcon name="check" size={14} /> : ''}</span>
              </button>
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
              {(immersive || zen) && <button type="button" className="immersive-mode-exit" role="menuitem" onClick={() => { onExitImmersive(); setModeMenuOpen(false); }}>退出沉浸模式</button>}
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
