import { useShallow } from 'zustand/react/shallow';
import { useAIStore } from '../../stores/aiStore';
import { useAppStore } from '../../stores/appStore';

export function AICompanionPopup() {
  const {
    companionVisible,
    companionPosition,
    companionSuggestions,
    status,
    statusMessage,
    setCompanionVisible,
    applySuggestion,
    getCompanionSuggestion,
    clearResults
  } = useAIStore(useShallow(state => ({ companionVisible: state.companionVisible, companionPosition: state.companionPosition, companionSuggestions: state.companionSuggestions, status: state.status, statusMessage: state.statusMessage, setCompanionVisible: state.setCompanionVisible, applySuggestion: state.applySuggestion, getCompanionSuggestion: state.getCompanionSuggestion, clearResults: state.clearResults })));
  const currentStyle = useAppStore((state) => state.settings.ai.writing_style);

  if (!companionVisible || !companionPosition) return null;

  const isLoading = status === 'companion' || status === 'loading';
  const isError = status === 'error';
  const suggestions = companionSuggestions
    .map(suggestion => suggestion.trim())
    .filter(Boolean);

  const handleApply = (suggestion: string) => {
    applySuggestion(suggestion);
  };

  const handleRefresh = () => {
    const { editorView } = useAppStore.getState();
    if (editorView) {
      const selection = editorView.state.selection.main;
      const textBefore = editorView.state.sliceDoc(Math.max(0, selection.to - 500), selection.to);
      getCompanionSuggestion(textBefore);
    }
  };

  const handleClose = () => {
    setCompanionVisible(false);
    clearResults();
  };

  // 计算弹出框位置，确保不超出屏幕
  const popupStyle: React.CSSProperties = {
    left: Math.min(companionPosition.x, window.innerWidth - 460),
    top: Math.min(companionPosition.y + 14, window.innerHeight - 380),
  };

  return (
    <div className="ai-companion-popup" style={popupStyle}>
      <div className="ai-companion-header">
        <div>
          <div className="ai-companion-title">AI伴写</div>
          <div className="ai-companion-subtitle">根据光标前文自动续写</div>
        </div>
        <span className="style-badge">{getStyleLabel(currentStyle)}</span>
      </div>
      <div className="ai-suggestion-list">
        {isLoading ? (
          <div className="ai-suggestion-state">
            <span className="ai-spinner"></span>
            <span>正在生成更贴合上下文的续写...</span>
          </div>
        ) : isError ? (
          <div className="ai-suggestion-state error">
            {statusMessage || '生成伴写建议失败，请检查 AI 配置后重试'}
          </div>
        ) : suggestions.length > 0 ? (
          suggestions.map((suggestion, index) => (
            <button
              key={index}
              className="ai-suggestion-item"
              onClick={() => handleApply(suggestion)}
            >
              <span className="ai-suggestion-index">{index + 1}</span>
              <span className="ai-suggestion-content">{suggestion}</span>
              <span className="ai-suggestion-action">采用</span>
            </button>
          ))
        ) : (
          <div className="ai-suggestion-state muted">
            暂无可用建议，试着多写一点上下文后刷新
          </div>
        )}
      </div>
      <div className="ai-companion-footer">
        <span className="ai-companion-tip">点击任一建议插入到当前光标处</span>
        <button className="ai-companion-btn refresh" onClick={handleRefresh}>
          刷新
        </button>
        <button className="ai-companion-btn close" onClick={handleClose}>
          关闭
        </button>
      </div>
    </div>
  );
}

function getStyleLabel(style: string): string {
  const labels: Record<string, string> = {
    formal: '正式',
    casual: '活泼',
    academic: '学术',
    creative: '创意',
    custom: '自定义'
  };
  return labels[style] || style;
}
