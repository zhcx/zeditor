import { AppIcon } from '../Icons/AppIcon';
import { useShallow } from 'zustand/react/shallow';
import { lazy, Suspense, useEffect, useRef } from 'react';
import { useAppStore } from '../../stores/appStore';
const UnsavedChangesDialog = lazy(() => import('../UnsavedChangesDialog/UnsavedChangesDialog').then(m => ({ default: m.UnsavedChangesDialog })));
import { useTabClose } from '../../hooks/useTabClose';
import { getAdjacentTabId } from '../../utils/workbenchNavigation';
import { FileTypeIcon } from '../Sidebar/FileTypeIcon';

export function TabsBar() {
  const { tabs, activeTabId, setActiveTab, addTab } = useAppStore(useShallow(state => ({ tabs: state.tabs, activeTabId: state.activeTabId, setActiveTab: state.setActiveTab, addTab: state.addTab })));
  const { requestTabClose, pendingCloseTab, saving, resolveTabClose } = useTabClose();
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const active = Array.from(tabsRef.current?.querySelectorAll<HTMLElement>('[data-tab-id]') || []).find(tab => tab.dataset.tabId === activeTabId);
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId, tabs.length]);

  const handleCloseTab = (event: React.MouseEvent, id: string) => {
    event.preventDefault();
    event.stopPropagation();
    requestTabClose(id);
  };

  const handleTabDoubleClick = (event: React.MouseEvent, id: string) => {
    event.preventDefault();
    event.stopPropagation();
    requestTabClose(id);
  };

  return (
    <div className="tabsbar">
      <div ref={tabsRef} className="tabs-container" role="tablist" aria-label="打开的文档" onDoubleClick={event => {
        if (event.target === event.currentTarget) addTab();
      }}>
        {tabs.map(tab => (
          <div
            key={tab.id}
            className={`tab ${tab.id === activeTabId ? 'active' : ''}`}
            role="tab"
            data-tab-id={tab.id}
            title={tab.path || tab.title}
            tabIndex={tab.id === activeTabId ? 0 : -1}
            aria-selected={tab.id === activeTabId}
            onClick={() => setActiveTab(tab.id)}
            onDoubleClick={event => handleTabDoubleClick(event, tab.id)}
            onKeyDown={event => {
              // 关闭按钮保留自己的 Enter/Space 行为，不让父标签拦截。
              if (event.target !== event.currentTarget) return;
              const next = getAdjacentTabId(tabs.map(tab => tab.id), tab.id, event.key);
              if (next) {
                event.preventDefault();
                setActiveTab(next);
                Array.from(tabsRef.current?.querySelectorAll<HTMLElement>('[data-tab-id]') || []).find(tab => tab.dataset.tabId === next)?.focus({ preventScroll: true });
                return;
              }
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setActiveTab(tab.id);
              }
            }}
          >
            <span className="tab-file-icon" aria-hidden="true"><FileTypeIcon filename={tab.title} /></span>
            <span className="tab-title">
              {tab.title}
              {tab.modified && <span className="tab-modified" title="未保存修改" aria-label="未保存修改">●</span>}
            </span>
            <button type="button" className="tab-close" onClick={event => handleCloseTab(event, tab.id)} title="关闭标签页" aria-label={`关闭 ${tab.title}`}><AppIcon name="close" size={16} /></button>
          </div>
        ))}
      </div>
      <button type="button" className="new-tab-btn" onClick={() => addTab()} title="新建标签页" aria-label="新建标签页"><AppIcon name="plus" size={16} /></button>
      {pendingCloseTab && (
        <Suspense fallback={null}>
          <UnsavedChangesDialog
            tabs={[pendingCloseTab]}
            scope="tab"
            busy={saving}
            onAction={(action) => { void resolveTabClose(action); }}
          />
        </Suspense>
      )}
    </div>
  );
}
