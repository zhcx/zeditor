import { useAIStore, type AIChangeKind, type AIEditMode } from '../../stores/aiStore';

const MODE_LABELS: Record<AIEditMode, string> = {
  ask: '询问模式',
  suggest: '建议模式',
};

const KIND_LABELS: Record<AIChangeKind, string> = {
  polish: '语言润色',
  translation: '翻译',
  fact: '事实修改',
  structure: '结构调整',
  continuation: '伴写续写',
  proofread: '校对修复',
  transform: 'AI 指令',
};

export function AIDiffConfirmDialog() {
  const { pendingEdit, editMode, setEditMode, acceptPendingEdit, rejectPendingEdit, undoLastAiRound } = useAIStore();

  if (!pendingEdit) return null;

  return (
    <div className="ai-diff-overlay" role="dialog" aria-modal="true" aria-label="确认 AI 修改">
      <section className="ai-diff-dialog">
        <header className="ai-diff-header">
          <div>
            <h3>确认 AI 修改</h3>
            <p>{KIND_LABELS[pendingEdit.kind]} · {pendingEdit.kind === 'fact' ? '请核验事实来源后再应用' : '不涉及事实核验'}</p>
          </div>
          <button className="ai-diff-close" onClick={rejectPendingEdit} aria-label="拒绝修改">×</button>
        </header>

        <div className="ai-mode-switch" aria-label="AI 操作模式">
          {(Object.keys(MODE_LABELS) as AIEditMode[]).map((mode) => (
            <button key={mode} className={editMode === mode ? 'active' : ''} onClick={() => setEditMode(mode)}>
              {MODE_LABELS[mode]}
            </button>
          ))}
        </div>
        <p className="ai-diff-reason"><strong>修改依据：</strong>{pendingEdit.reason}</p>

        <div className="ai-diff-columns">
          <article>
            <h4>修改前</h4>
            <pre>{pendingEdit.before || '（在此处插入内容）'}</pre>
          </article>
          <article>
            <h4>修改后</h4>
            <pre>{pendingEdit.after || '（删除此处内容）'}</pre>
          </article>
        </div>

        <footer className="ai-diff-actions">
          <button onClick={rejectPendingEdit}>拒绝此处</button>
          <button className="secondary" onClick={undoLastAiRound}>撤销上一轮</button>
          <button className="primary" onClick={acceptPendingEdit}>仅应用这一处</button>
        </footer>
      </section>
    </div>
  );
}
