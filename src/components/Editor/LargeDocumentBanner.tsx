import { useAppStore } from '../../stores/appStore';
import type { LargeDocumentReason } from '../../utils/largeDocument';

const reasons: Record<LargeDocumentReason, string> = {
  size: '文件较大', blocks: '文档块较多', tables: '表格内容较多',
};

export function LargeDocumentBanner() {
  const performance = useAppStore(state => state.tabs.find(tab => tab.id === state.activeTabId)?.performance);
  const setLightweightMode = useAppStore(state => state.setLightweightMode);
  if (!performance) return null;
  const explanation = performance.assessment.reasons.map(reason => reasons[reason]).join('、');
  return <div className="large-document-banner" role="status">
    <span>{explanation}，{performance.lightweight ? '已启用轻量源码模式，暂不渲染预览。' : '当前使用完整视图，渲染可能较慢。'}</span>
    <button type="button" onClick={() => setLightweightMode(!performance.lightweight)}>{performance.lightweight ? '切换到默认视图' : '启用轻量模式'}</button>
  </div>;
}
