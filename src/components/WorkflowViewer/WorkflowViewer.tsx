import { useCallback, useMemo, useRef, useState } from 'react';
import { save as chooseSaveFile } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { parseWorkflow } from '../../utils/githubWorkflow';
import { buildWorkflowGraph, workflowToMermaid } from '../../utils/workflowGraph';
import { collectWorkflowDiagnostics, countWorkflowDiagnostics } from '../../utils/workflowDiagnostics';
import {
  applyWorkflowPatches,
  describeWorkflowPatch,
  workflowPatchKey,
  type WorkflowPatch,
} from '../../utils/workflowEdits';
import { WorkflowCanvas } from './WorkflowCanvas';
import { WorkflowInspector } from './WorkflowInspector';
import '../../styles/workflow-viewer.css';

export interface WorkflowViewerProps {
  /** workflow YAML 源码（独立文件内容，或 Markdown 代码围栏内的文本）。 */
  source: string;
  /** 内联在 Markdown 代码块中：只读、紧凑排版。 */
  embedded?: boolean;
  /** 独立工作流文件：允许结构化编辑并通过 onApply 写回编辑器。 */
  editable?: boolean;
  /** 保存时是否保留注释与原有格式（关闭则输出规范化 YAML）。 */
  preserveFormat?: boolean;
  onApply?: (nextSource: string) => void;
  onJumpToLine?: (line: number) => void;
  /** 内联时的源码行偏移：把块内相对行号换算成文档行号。 */
  lineOffset?: number;
  /** 头部展示的标题（通常是文件名）。 */
  title?: string;
}

interface ViewerStatus {
  kind: 'info' | 'success' | 'error';
  text: string;
}

const isDesktopRuntime = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function exportFileName(title: string | undefined): string {
  const base = (title || 'workflow').split(/[\\/]/).pop() || 'workflow';
  const stem = base.replace(/\.(?:ya?ml)$/i, '').replace(/[^\w.-]+/g, '-');
  return `${stem || 'workflow'}.svg`;
}

/**
 * GitHub Actions 工作流查看器：左侧源码由编辑器负责，这里渲染依赖图（DAG）、
 * job / step 详情、诊断与结构化编辑。查看器自身不联网、不执行工作流。
 */
export function WorkflowViewer({
  source,
  embedded,
  editable,
  preserveFormat = true,
  onApply,
  onJumpToLine,
  lineOffset = 0,
  title,
}: WorkflowViewerProps) {
  const parsed = useMemo(() => parseWorkflow(source), [source]);
  const model = parsed.model;
  const diagnostics = useMemo(() => collectWorkflowDiagnostics({
    model,
    errors: parsed.errors,
    warnings: parsed.warnings,
    source,
  }), [model, parsed.errors, parsed.warnings, source]);
  const graph = useMemo(() => (model ? buildWorkflowGraph(model) : null), [model]);

  const [selectedJobIdState, setSelectedJobId] = useState<string | null>(null);
  // step 选中记录其所属 job，切换 job 时自然视为未选中，无需 effect 重置。
  const [stepSelection, setStepSelection] = useState<{ jobId: string; index: number } | null>(null);
  const [patches, setPatches] = useState<WorkflowPatch[]>([]);
  const [status, setStatus] = useState<ViewerStatus | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const canEdit = Boolean(editable && onApply);

  // 派生当前选中：列表变化后自动落到第一个 job，避免用 effect 写回状态。
  const selectedJobId = model && selectedJobIdState && model.jobs.some(job => job.id === selectedJobIdState)
    ? selectedJobIdState
    : (model?.jobs[0]?.id ?? null);
  const stepIndex = stepSelection && selectedJobId && stepSelection.jobId === selectedJobId
    ? stepSelection.index
    : null;
  const selectStep = (index: number | null) => {
    setStepSelection(index === null || !selectedJobId ? null : { jobId: selectedJobId, index });
  };

  const jumpToLine = useCallback((line: number) => {
    onJumpToLine?.(line + lineOffset);
  }, [lineOffset, onJumpToLine]);

  const queuePatch = useCallback((patch: WorkflowPatch) => {
    const key = workflowPatchKey(patch);
    setPatches((current) => [...current.filter(item => workflowPatchKey(item) !== key), patch]);
    setStatus(null);
  }, []);

  const removePatch = useCallback((key: string) => {
    setPatches((current) => current.filter(item => workflowPatchKey(item) !== key));
  }, []);

  const handleSave = useCallback(() => {
    if (!onApply || patches.length === 0) return;
    const result = applyWorkflowPatches(source, patches, { preserveFormat });
    if (result.applied.length === 0) {
      setStatus({ kind: 'error', text: result.issues[0]?.reason ?? '没有可写入的修改' });
      return;
    }

    onApply(result.source);
    setPatches([]);
    const skipped = result.issues.length > 0 ? `，${result.issues.length} 处已跳过（目标已变化）` : '';
    setStatus({
      kind: 'success',
      text: `已写回编辑器 ${result.applied.length} 处修改${skipped}，按 Ctrl+S 保存文件`,
    });
  }, [onApply, patches, preserveFormat, source]);

  const handleCopyMermaid = useCallback(async () => {
    if (!model) return;
    try {
      await navigator.clipboard.writeText(workflowToMermaid(model));
      setStatus({ kind: 'success', text: '已复制 Mermaid 流程图（可用于 README）' });
    } catch (error) {
      setStatus({ kind: 'error', text: `复制失败：${String(error)}` });
    }
  }, [model]);

  const readSvg = useCallback((): string | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    return `<?xml version="1.0" encoding="UTF-8"?>\n${svg.outerHTML}`;
  }, []);

  const handleCopySvg = useCallback(async () => {
    const svg = readSvg();
    if (!svg) return;
    try {
      await navigator.clipboard.writeText(svg);
      setStatus({ kind: 'success', text: '已复制 SVG 源码' });
    } catch (error) {
      setStatus({ kind: 'error', text: `复制失败：${String(error)}` });
    }
  }, [readSvg]);

  const handleDownloadSvg = useCallback(async () => {
    const svg = readSvg();
    if (!svg) return;
    if (!isDesktopRuntime()) {
      setStatus({ kind: 'info', text: '浏览器预览模式请使用「复制 SVG」' });
      return;
    }
    try {
      const target = await chooseSaveFile({
        title: '导出工作流图',
        defaultPath: exportFileName(title),
        filters: [{ name: 'SVG', extensions: ['svg'] }],
      });
      if (typeof target !== 'string') return;
      await writeTextFile(target, svg);
      setStatus({ kind: 'success', text: `已导出到 ${target}` });
    } catch (error) {
      setStatus({ kind: 'error', text: `导出失败：${String(error)}` });
    }
  }, [readSvg, title]);

  const totals = countWorkflowDiagnostics(diagnostics);
  const heading = model?.name || title || 'GitHub Actions 工作流';
  const stepCount = model?.jobs.reduce((sum, job) => sum + job.steps.length, 0) ?? 0;

  if (!model || !graph) {
    return (
      <div className={`workflow-viewer ${embedded ? 'is-embedded' : ''}`}>
        <header className="workflow-viewer-header">
          <div className="workflow-viewer-heading">
            <strong>GitHub Actions 工作流</strong>
            <span className="workflow-viewer-subtitle">无法解析出 jobs，已按普通 YAML 处理</span>
          </div>
        </header>
        <ul className="workflow-diagnostic-list is-standalone">
          {diagnostics.length === 0 && <li className="is-info">没有可展示的内容</li>}
          {diagnostics.map((diagnostic, index) => (
            <li key={`${diagnostic.code}-${index}`} className={`is-${diagnostic.severity}`}>
              <span className="workflow-diagnostic-code">{diagnostic.code}</span>
              <span className="workflow-diagnostic-severity">{diagnostic.severity === 'error' ? '错误' : '警告'}</span>
              <span className="workflow-diagnostic-message">{diagnostic.message}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className={`workflow-viewer ${embedded ? 'is-embedded' : ''}`}>
      <header className="workflow-viewer-header">
        <div className="workflow-viewer-heading">
          <strong>{heading}</strong>
          <span className="workflow-viewer-subtitle">
            {model.jobs.length} 个 job · {stepCount} 个步骤
            {graph.cyclicJobIds.length > 0 ? ' · 存在循环依赖' : ''}
          </span>
        </div>
        <div className="workflow-viewer-stats">
          {totals.errors > 0 && <span className="workflow-stat is-error">{totals.errors} 错误</span>}
          {totals.warnings > 0 && <span className="workflow-stat is-warning">{totals.warnings} 警告</span>}
          {totals.errors === 0 && totals.warnings === 0 && <span className="workflow-stat is-ok">检查通过</span>}
        </div>
        <div className="workflow-viewer-actions">
          <button type="button" onClick={() => void handleCopyMermaid()}>复制 Mermaid</button>
          <button type="button" onClick={() => void handleCopySvg()}>复制 SVG</button>
          <button type="button" onClick={() => void handleDownloadSvg()}>导出 SVG</button>
          {canEdit && (
            <>
              <button
                type="button"
                className="is-primary"
                disabled={patches.length === 0}
                onClick={handleSave}
              >
                保存{patches.length > 0 ? ` (${patches.length})` : ''}
              </button>
              <button
                type="button"
                disabled={patches.length === 0}
                onClick={() => { setPatches([]); setStatus(null); }}
              >
                放弃修改
              </button>
            </>
          )}
        </div>
      </header>

      {status && <p className={`workflow-viewer-status is-${status.kind}`}>{status.text}</p>}

      {canEdit && patches.length > 0 && (
        <ul className="workflow-patch-queue">
          {patches.map((patch) => {
            const key = workflowPatchKey(patch);
            return (
              <li key={key}>
                <span>{describeWorkflowPatch(patch)}</span>
                <button type="button" onClick={() => removePatch(key)} aria-label="移除该修改">×</button>
              </li>
            );
          })}
        </ul>
      )}

      <WorkflowCanvas
        graph={graph}
        selectedJobId={selectedJobId}
        onSelectJob={setSelectedJobId}
        diagnostics={diagnostics}
        compact={embedded}
        svgRef={svgRef}
      />

      <WorkflowInspector
        model={model}
        selectedJobId={selectedJobId}
        stepIndex={stepIndex}
        diagnostics={diagnostics}
        patches={patches}
        editable={canEdit}
        onSelectJob={setSelectedJobId}
        onSelectStep={selectStep}
        onQueuePatch={queuePatch}
        onRemovePatch={removePatch}
        onJumpToLine={onJumpToLine ? jumpToLine : undefined}
      />
    </div>
  );
}
