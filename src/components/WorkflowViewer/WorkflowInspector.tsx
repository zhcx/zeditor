import { useState } from 'react';
import type { WorkflowJob, WorkflowModel, WorkflowStep } from '../../utils/githubWorkflow';
import { formatWorkflowDiagnostic, type WorkflowDiagnostic } from '../../utils/workflowDiagnostics';
import { workflowPatchKey, type WorkflowPatch } from '../../utils/workflowEdits';

interface WorkflowInspectorProps {
  model: WorkflowModel;
  selectedJobId: string | null;
  stepIndex: number | null;
  diagnostics: readonly WorkflowDiagnostic[];
  patches: readonly WorkflowPatch[];
  /** 独立工作流文件可改字段；Markdown 代码围栏内为只读。 */
  editable: boolean;
  onSelectJob: (jobId: string) => void;
  onSelectStep: (stepIndex: number | null) => void;
  onQueuePatch: (patch: WorkflowPatch) => void;
  onRemovePatch: (key: string) => void;
  onJumpToLine?: (line: number) => void;
}

interface PatchFieldProps {
  label: string;
  value: string;
  placeholder?: string;
  multiline?: boolean;
  editable: boolean;
  queued: boolean;
  onCommit: (value: string) => void;
}

/**
 * 表单字段以模型值为初值，失焦（多行用 Ctrl/Cmd + Enter）时把改动排进补丁队列，
 * 不直接改写源码——这样同一字段多次修改只会产生一条待保存记录。
 */
function PatchField({ label, value, placeholder, multiline, editable, queued, onCommit }: PatchFieldProps) {
  const [draft, setDraft] = useState(value);
  const [syncedValue, setSyncedValue] = useState(value);
  // 源码变化（保存后重新解析）时把草稿同步回模型值：
  // 用渲染期派生替代 effect，避免级联渲染。
  if (syncedValue !== value) {
    setSyncedValue(value);
    setDraft(value);
  }

  const commit = () => {
    if (!editable) return;
    if (draft === value) return;
    onCommit(draft);
  };

  if (!editable) {
    return (
      <div className="workflow-field is-readonly">
        <span className="workflow-field-label">{label}</span>
        <span className="workflow-field-static">{value || '—'}</span>
      </div>
    );
  }

  return (
    <label className="workflow-field">
      <span className="workflow-field-label">
        {label}
        {queued && <em className="workflow-field-queued">已排队</em>}
      </span>
      {multiline ? (
        <textarea
          value={draft}
          rows={3}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              commit();
            }
          }}
        />
      ) : (
        <input
          value={draft}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              (event.target as HTMLInputElement).blur();
            }
          }}
        />
      )}
    </label>
  );
}

interface WithKeyAdderProps {
  onAdd: (key: string, value: string) => void;
}

/** `with` 新增键值：输入态属于组件自身，切换 job / step 时用 key 重置。 */
function WithKeyAdder({ onAdd }: WithKeyAdderProps) {
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');

  return (
    <div className="workflow-with-row is-new">
      <input
        className="workflow-with-key-input"
        placeholder="键"
        spellCheck={false}
        value={key}
        onChange={(event) => setKey(event.target.value)}
      />
      <input
        placeholder="值"
        spellCheck={false}
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <button
        type="button"
        className="workflow-with-action"
        disabled={!key.trim()}
        onClick={() => {
          const nextKey = key.trim();
          if (!nextKey) return;
          onAdd(nextKey, value);
          setKey('');
          setValue('');
        }}
      >
        添加
      </button>
    </div>
  );
}

function severityLabel(severity: WorkflowDiagnostic['severity']): string {
  if (severity === 'error') return '错误';
  if (severity === 'warning') return '警告';
  return '提示';
}

function stepTitle(step: WorkflowStep): string {
  if (step.name) return step.name;
  if (step.uses) return step.uses;
  if (step.run) return step.run.split(/\r?\n/)[0];
  return `步骤 ${step.index + 1}`;
}

export function WorkflowInspector({
  model,
  selectedJobId,
  stepIndex,
  diagnostics,
  patches,
  editable,
  onSelectJob,
  onSelectStep,
  onQueuePatch,
  onRemovePatch,
  onJumpToLine,
}: WorkflowInspectorProps) {
  const job: WorkflowJob | null = model.jobs.find(item => item.id === selectedJobId) ?? null;
  const step = job && stepIndex !== null ? job.steps[stepIndex] ?? null : null;
  const queuedKeys = new Set(patches.map(workflowPatchKey));
  const removedWithKeys = new Set(
    patches.filter(patch => patch.kind === 'with.remove').map(patch => patch.key),
  );
  const jobDiagnostics = job ? diagnostics.filter(item => item.jobId === job.id) : [];

  const triggers = model.triggers;
  const hasTriggerFilters = triggers.branches.length > 0 || triggers.tags.length > 0
    || triggers.paths.length > 0 || triggers.cron.length > 0 || triggers.types.length > 0;

  return (
    <div className="workflow-inspector">
      <section className="workflow-panel">
        <header className="workflow-panel-header">
          <h4>触发器</h4>
          <span className="workflow-panel-note">只读</span>
        </header>
        {triggers.events.length === 0 ? (
          <p className="workflow-panel-empty">未声明 on 触发器</p>
        ) : (
          <div className="workflow-chips">
            {triggers.events.map(event => <span key={event} className="workflow-chip">{event}</span>)}
          </div>
        )}
        {hasTriggerFilters && (
          <dl className="workflow-trigger-detail">
            {triggers.branches.length > 0 && <><dt>branches</dt><dd>{triggers.branches.join(', ')}</dd></>}
            {triggers.tags.length > 0 && <><dt>tags</dt><dd>{triggers.tags.join(', ')}</dd></>}
            {triggers.paths.length > 0 && <><dt>paths</dt><dd>{triggers.paths.join(', ')}</dd></>}
            {triggers.types.length > 0 && <><dt>types</dt><dd>{triggers.types.join(', ')}</dd></>}
            {triggers.cron.length > 0 && <><dt>cron</dt><dd>{triggers.cron.join(', ')}</dd></>}
            {triggers.dispatchInputs.length > 0 && <><dt>inputs</dt><dd>{triggers.dispatchInputs.join(', ')}</dd></>}
          </dl>
        )}
        {hasTriggerFilters && <p className="workflow-panel-empty">触发器结构复杂，当前只读；需要调整请在源码中修改。</p>}
      </section>

      <section className="workflow-panel">
        <header className="workflow-panel-header">
          <h4>诊断</h4>
          <span className="workflow-panel-note">{diagnostics.length} 条</span>
        </header>
        {diagnostics.length === 0 ? (
          <p className="workflow-panel-empty">未发现问题</p>
        ) : (
          <ul className="workflow-diagnostic-list">
            {diagnostics.map((diagnostic, index) => (
              <li key={`${diagnostic.code}-${diagnostic.line}-${index}`} className={`is-${diagnostic.severity}`}>
                <button
                  type="button"
                  className="workflow-diagnostic-body"
                  title={formatWorkflowDiagnostic(diagnostic)}
                  onClick={() => {
                    if (diagnostic.jobId) {
                      onSelectJob(diagnostic.jobId);
                      onSelectStep(diagnostic.stepIndex ?? null);
                    }
                    if (diagnostic.line && onJumpToLine) onJumpToLine(diagnostic.line);
                  }}
                >
                  <span className="workflow-diagnostic-code">{diagnostic.code}</span>
                  <span className="workflow-diagnostic-severity">{severityLabel(diagnostic.severity)}</span>
                  <span className="workflow-diagnostic-message">{diagnostic.message}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="workflow-panel">
        <header className="workflow-panel-header">
          <h4>Job</h4>
          <span className="workflow-panel-note">{model.jobs.length} 个</span>
        </header>
        <label className="workflow-field">
          <span className="workflow-field-label">选择 job</span>
          <select
            value={selectedJobId ?? ''}
            onChange={(event) => onSelectJob(event.target.value)}
          >
            <option value="" disabled>请选择 job</option>
            {model.jobs.map(item => (
              <option key={item.id} value={item.id}>{item.name ? `${item.id}（${item.name}）` : item.id}</option>
            ))}
          </select>
        </label>

        {!job ? (
          <p className="workflow-panel-empty">在画布或上方列表中选择一个 job 查看详情。</p>
        ) : (
          <div className="workflow-job-detail">
            <div className="workflow-job-meta">
              <span className="workflow-chip is-strong">{job.id}</span>
              {job.needs.length > 0 && <span className="workflow-meta-text">needs: {job.needs.join(', ')}</span>}
              {jobDiagnostics.length > 0 && (
                <span className="workflow-meta-text is-warning">{jobDiagnostics.length} 条诊断</span>
              )}
              {onJumpToLine && (
                <button
                  type="button"
                  className="workflow-link-button"
                  onClick={() => onJumpToLine(job.line)}
                >
                  跳到源码
                </button>
              )}
            </div>

            {job.uses ? (
              <>
                <PatchField
                  key={`${job.id}-name`}
                  label="name"
                  value={job.name}
                  placeholder="job 显示名"
                  editable={editable}
                  queued={queuedKeys.has(`job:${job.id}:name`)}
                  onCommit={(value) => onQueuePatch({ kind: 'job.set', jobId: job.id, field: 'name', value })}
                />
                <div className="workflow-field is-readonly">
                  <span className="workflow-field-label">uses</span>
                  <span className="workflow-field-static">{job.uses}</span>
                </div>
                <p className="workflow-panel-empty">可复用工作流调用不能再定义 steps，替换引用请直接改源码。</p>
              </>
            ) : (
              <>
                <PatchField
                  key={`${job.id}-name`}
                  label="name"
                  value={job.name}
                  placeholder="job 显示名"
                  editable={editable}
                  queued={queuedKeys.has(`job:${job.id}:name`)}
                  onCommit={(value) => onQueuePatch({ kind: 'job.set', jobId: job.id, field: 'name', value })}
                />
                <PatchField
                  key={`${job.id}-runs-on`}
                  label="runs-on"
                  value={job.runsOn ?? ''}
                  placeholder="ubuntu-latest"
                  editable={editable}
                  queued={queuedKeys.has(`job:${job.id}:runs-on`)}
                  onCommit={(value) => onQueuePatch({ kind: 'job.set', jobId: job.id, field: 'runs-on', value })}
                />
                <PatchField
                  key={`${job.id}-if`}
                  label="if"
                  value={job.if ?? ''}
                  placeholder="github.ref == 'refs/heads/main'"
                  editable={editable}
                  queued={queuedKeys.has(`job:${job.id}:if`)}
                  onCommit={(value) => onQueuePatch({ kind: 'job.set', jobId: job.id, field: 'if', value })}
                />
              </>
            )}
          </div>
        )}
      </section>

      {job && !job.uses && (
        <section className="workflow-panel">
          <header className="workflow-panel-header">
            <h4>Steps</h4>
            <span className="workflow-panel-note">{job.steps.length} 个</span>
          </header>
          {job.steps.length === 0 ? (
            <p className="workflow-panel-empty">该 job 还没有 steps。</p>
          ) : (
            <ol className="workflow-step-list">
              {job.steps.map((item) => {
                const stepDiagnostics = diagnostics.filter(
                  diagnostic => diagnostic.jobId === job.id && diagnostic.stepIndex === item.index,
                );
                const hasError = stepDiagnostics.some(diagnostic => diagnostic.severity === 'error');
                return (
                  <li key={item.index}>
                    <button
                      type="button"
                      className={`workflow-step-item ${stepIndex === item.index ? 'is-active' : ''}`}
                      onClick={() => onSelectStep(stepIndex === item.index ? null : item.index)}
                    >
                      <span className="workflow-step-index">{item.index + 1}</span>
                      <span className="workflow-step-title">{stepTitle(item)}</span>
                      {hasError && <span className="workflow-step-dot is-error" aria-label="存在错误" />}
                    </button>
                  </li>
                );
              })}
            </ol>
          )}

          {step && (
            <div className="workflow-step-detail">
              <h5>步骤 {step.index + 1}</h5>
              {step.uses && (
                <div className="workflow-field is-readonly">
                  <span className="workflow-field-label">uses</span>
                  <span className="workflow-field-static">{step.uses}</span>
                </div>
              )}
              <PatchField
                key={`${job.id}-${step.index}-name`}
                label="name"
                value={step.name}
                editable={editable}
                queued={queuedKeys.has(`step:${job.id}:${step.index}:name`)}
                onCommit={(value) => onQueuePatch({ kind: 'step.set', jobId: job.id, stepIndex: step.index, field: 'name', value })}
              />
              {step.uses ? null : (
                <PatchField
                  key={`${job.id}-${step.index}-run`}
                  label="run"
                  value={step.run ?? ''}
                  multiline
                  editable={editable}
                  queued={queuedKeys.has(`step:${job.id}:${step.index}:run`)}
                  onCommit={(value) => onQueuePatch({ kind: 'step.set', jobId: job.id, stepIndex: step.index, field: 'run', value })}
                />
              )}
              <PatchField
                key={`${job.id}-${step.index}-cwd`}
                label="working-directory"
                value={step.workingDirectory ?? ''}
                editable={editable}
                queued={queuedKeys.has(`step:${job.id}:${step.index}:working-directory`)}
                onCommit={(value) => onQueuePatch({ kind: 'step.set', jobId: job.id, stepIndex: step.index, field: 'working-directory', value })}
              />
              <PatchField
                key={`${job.id}-${step.index}-if`}
                label="if"
                value={step.if ?? ''}
                editable={editable}
                queued={queuedKeys.has(`step:${job.id}:${step.index}:if`)}
                onCommit={(value) => onQueuePatch({ kind: 'step.set', jobId: job.id, stepIndex: step.index, field: 'if', value })}
              />

              <div className="workflow-with-block">
                <div className="workflow-with-header">
                  <span>with</span>
                  <small>action 输入参数</small>
                </div>
                {step.withEntries.length === 0 && !editable && <p className="workflow-panel-empty">未声明输入参数</p>}
                {step.withEntries.map((entry) => {
                  const removed = removedWithKeys.has(entry.key);
                  return (
                    <div key={entry.key} className={`workflow-with-row ${removed ? 'is-removed' : ''}`}>
                      <span className="workflow-with-key" title={entry.key}>{entry.key}</span>
                      {editable ? (
                        <input
                          defaultValue={entry.value}
                          key={`${job.id}-${step.index}-${entry.key}-${entry.value}`}
                          spellCheck={false}
                          disabled={removed}
                          onBlur={(event) => {
                            const value = event.target.value;
                            if (value === entry.value) return;
                            onQueuePatch({ kind: 'with.set', jobId: job.id, stepIndex: step.index, key: entry.key, value });
                          }}
                        />
                      ) : (
                        <span className="workflow-field-static">{entry.value}</span>
                      )}
                      {editable && (
                        removed ? (
                          <button
                            type="button"
                            className="workflow-with-action"
                            onClick={() => onRemovePatch(`with:${job.id}:${step.index}:${entry.key}`)}
                          >
                            撤销删除
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="workflow-with-action is-danger"
                            onClick={() => onQueuePatch({ kind: 'with.remove', jobId: job.id, stepIndex: step.index, key: entry.key })}
                          >
                            删除
                          </button>
                        )
                      )}
                    </div>
                  );
                })}
                {editable && (
                  <WithKeyAdder
                    key={`${job.id}:${step.index}`}
                    onAdd={(key, value) => onQueuePatch({
                      kind: 'with.set',
                      jobId: job.id,
                      stepIndex: step.index,
                      key,
                      value,
                    })}
                  />
                )}
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
