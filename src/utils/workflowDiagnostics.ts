/**
 * GitHub Actions 工作流诊断：解析、结构、依赖、step、表达式与安全提示。
 *
 * 全部检查都在本地源码上完成，不会执行工作流、不会联网，也不依赖外部
 * actionlint（未安装时仅缺少其转发诊断）。
 */
import {
  KNOWN_EXPRESSION_CONTEXTS,
  parseActionRef,
  type WorkflowJob,
  type WorkflowModel,
  type WorkflowParseError,
} from './githubWorkflow.ts';

export type WorkflowDiagnosticSeverity = 'error' | 'warning' | 'info';

export interface WorkflowDiagnostic {
  code: string;
  severity: WorkflowDiagnosticSeverity;
  message: string;
  jobId?: string;
  stepIndex?: number;
  line?: number;
}

export interface WorkflowDiagnosticsInput {
  model: WorkflowModel | null;
  errors: readonly WorkflowParseError[];
  warnings: readonly WorkflowParseError[];
  source: string;
}

const EXPRESSION_PATTERN = /\$\{\{([\s\S]*?)\}\}/g;
const IDENTIFIER_PATTERN = /[A-Za-z_][A-Za-z0-9_-]*/g;
/** 需要固定提交引用的分支名：使用分支会让工作流随上游改动而变化。 */
const FLOATING_ACTION_REFS = new Set(['main', 'master', 'head', 'latest', 'dev', 'develop']);

/** yaml 包的 prettyErrors 会附带代码片段，这里只保留首行结论。 */
function cleanMessage(message: string): string {
  const firstLine = message.split(/\r?\n/, 1)[0] ?? '';
  return firstLine.replace(/\s*at line \d+, column \d+:?\s*$/i, '').trim();
}

/** 从报错位置（行列）反查重复键名：`  build:` → `build`。 */
function keyAtPosition(source: string, line: number, column: number): string | null {
  if (!line || !column) return null;
  const text = source.split(/\r?\n/)[line - 1] ?? '';
  const rest = text.slice(Math.max(0, column - 1));
  const match = rest.match(/^\s*("([^"]*)"|'([^']*)'|([^\s:#]+))\s*:/);
  if (!match) return null;
  return match[2] ?? match[3] ?? match[4] ?? null;
}

/** 深度优先找出一条 needs 环路（含自依赖），用于可读的循环依赖提示。 */
export function findNeedsCycle(jobs: WorkflowJob[]): string[] | null {
  const byId = new Map(jobs.map(job => [job.id, job]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  let cycle: string[] | null = null;

  const visit = (jobId: string): boolean => {
    if (cycle) return true;
    const status = state.get(jobId);
    if (status === 'visiting') {
      const start = stack.indexOf(jobId);
      cycle = [...stack.slice(start >= 0 ? start : 0), jobId];
      return true;
    }
    if (status === 'done') return false;

    state.set(jobId, 'visiting');
    stack.push(jobId);
    const job = byId.get(jobId);
    for (const need of job?.needs ?? []) {
      if (!byId.has(need)) continue;
      if (visit(need)) return true;
    }
    stack.pop();
    state.set(jobId, 'done');
    return false;
  };

  jobs.forEach((job) => {
    if (!state.has(job.id)) visit(job.id);
  });
  return cycle;
}

/** 字符串字面量里的 `a.b` 不是上下文引用，先整体替换掉再扫描。 */
function stripStringLiterals(expression: string): string {
  return expression
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/** 扫描 `${{ }}` 中引用了未知上下文的表达式。 */
function collectExpressionDiagnostics(source: string): WorkflowDiagnostic[] {
  const diagnostics: WorkflowDiagnostic[] = [];
  const lines = source.split(/\r?\n/);

  lines.forEach((lineText, index) => {
    if (!lineText.includes('${{')) return;
    EXPRESSION_PATTERN.lastIndex = 0;
    let expressionMatch: RegExpExecArray | null;
    while ((expressionMatch = EXPRESSION_PATTERN.exec(lineText)) !== null) {
      const body = stripStringLiterals(expressionMatch[1] ?? '');
      IDENTIFIER_PATTERN.lastIndex = 0;
      let identifierMatch: RegExpExecArray | null;
      const reported = new Set<string>();
      while ((identifierMatch = IDENTIFIER_PATTERN.exec(body)) !== null) {
        const name = identifierMatch[0];
        const before = body.slice(0, identifierMatch.index).trimEnd().slice(-1);
        // 属性访问（`a.b`）的右侧不是上下文标识符。
        if (before === '.') continue;
        const after = body.slice(identifierMatch.index + name.length).trimStart()[0] ?? '';
        const isContextAccess = after === '.' || after === '[';
        if (!isContextAccess) continue;
        if (KNOWN_EXPRESSION_CONTEXTS.has(name.toLowerCase())) continue;
        if (reported.has(name)) continue;
        reported.add(name);
        diagnostics.push({
          code: 'GHA-EXPR-001',
          severity: 'warning',
          message: `表达式引用了未知上下文 "${name}"：可用上下文包括 github、env、vars、needs、steps、matrix、secrets、runner 等`,
          line: index + 1,
        });
      }
    }
  });

  return diagnostics;
}

function collectJobDiagnostics(job: WorkflowJob, triggerEvents: string[], checkoutSteps: Array<{ jobId: string; stepIndex: number; line: number; uses: string }>): WorkflowDiagnostic[] {
  const diagnostics: WorkflowDiagnostic[] = [];
  const line = job.line || undefined;

  if (job.uses && job.steps.length > 0) {
    diagnostics.push({
      code: 'GHA-JOB-002',
      severity: 'error',
      message: `job "${job.id}" 同时声明了 uses 与 steps：可复用工作流调用不能再定义步骤`,
      jobId: job.id,
      line,
    });
  }

  if (!job.uses && job.steps.length === 0) {
    diagnostics.push({
      code: 'GHA-JOB-003',
      severity: 'error',
      message: `job "${job.id}" 既没有 steps 也没有 uses，不会执行任何内容`,
      jobId: job.id,
      line,
    });
  }

  if (!job.uses && !job.runsOn) {
    diagnostics.push({
      code: 'GHA-JOB-004',
      severity: 'error',
      message: `job "${job.id}" 缺少 runs-on，GitHub 无法为其选择执行器`,
      jobId: job.id,
      line,
    });
  }

  if (job.matrixIssue) {
    diagnostics.push({
      code: 'GHA-MATRIX-001',
      severity: 'warning',
      message: `job "${job.id}"：${job.matrixIssue}`,
      jobId: job.id,
      line,
    });
  }

  job.steps.forEach((step) => {
    const stepLine = step.line || line;
    const stepLabel = step.name || step.uses || step.run?.split(/\r?\n/)[0] || `步骤 ${step.index + 1}`;
    if (step.uses && step.run) {
      diagnostics.push({
        code: 'GHA-STEP-001',
        severity: 'error',
        message: `job "${job.id}" 的步骤「${stepLabel}」同时声明了 uses 与 run`,
        jobId: job.id,
        stepIndex: step.index,
        line: stepLine,
      });
    }
    if (!step.uses && !step.run) {
      diagnostics.push({
        code: 'GHA-STEP-002',
        severity: 'error',
        message: `job "${job.id}" 的步骤「${stepLabel}」缺少 run 或 uses`,
        jobId: job.id,
        stepIndex: step.index,
        line: stepLine,
      });
    }
    if (step.uses) {
      const ref = parseActionRef(step.uses);
      if (!ref.isLocal && !ref.ref) {
        diagnostics.push({
          code: 'GHA-STEP-003',
          severity: 'error',
          message: `action 引用 "${step.uses}" 未指定版本（缺少 @ref）`,
          jobId: job.id,
          stepIndex: step.index,
          line: stepLine,
        });
      } else if (!ref.isLocal && ref.ref && FLOATING_ACTION_REFS.has(ref.ref.toLowerCase())) {
        diagnostics.push({
          code: 'GHA-STEP-004',
          severity: 'warning',
          message: `action 引用 "${step.uses}" 使用分支 "${ref.ref}"，建议固定到发布标签或提交 SHA`,
          jobId: job.id,
          stepIndex: step.index,
          line: stepLine,
        });
      }
      if (ref.slug === 'actions/checkout') {
        checkoutSteps.push({ jobId: job.id, stepIndex: step.index, line: stepLine ?? 0, uses: step.uses });
      }
    }
  });

  // pull_request_target 会带着仓库写权限运行，检出 PR 头部代码等于执行不可信代码。
  if (triggerEvents.includes('pull_request_target')) {
    job.steps.forEach((step) => {
      if (!step.uses || parseActionRef(step.uses).slug !== 'actions/checkout') return;
      const withRef = step.withEntries.find(entry => entry.key === 'ref')?.value ?? '';
      if (/github\.event\.pull_request\.head/i.test(withRef)) {
        diagnostics.push({
          code: 'GHA-SEC-001',
          severity: 'warning',
          message: `job "${job.id}" 在 pull_request_target 中检出了 PR 头部代码（ref: ${withRef}），存在权限泄漏风险`,
          jobId: job.id,
          stepIndex: step.index,
          line: step.line || line,
        });
      }
    });
  }

  return diagnostics;
}

export function collectWorkflowDiagnostics(input: WorkflowDiagnosticsInput): WorkflowDiagnostic[] {
  const { model, errors, warnings, source } = input;
  const diagnostics: WorkflowDiagnostic[] = [];

  errors.forEach((error) => {
    if (error.code === 'DUPLICATE_KEY') {
      const key = keyAtPosition(source, error.line, error.column);
      // 键名命中已解析的 job 列表即为同名 job；否则是同一映射里写重了的字段。
      const isJobId = Boolean(key && model?.jobs.some(job => job.id === key));
      const scope = isJobId ? 'jobs 中存在重复的 job id' : '同一映射中出现了重复字段';
      diagnostics.push({
        code: 'GHA-JOB-001',
        severity: 'error',
        message: key ? `${scope} "${key}"` : `${scope}（同名键会被后一个覆盖）`,
        line: error.line || undefined,
      });
      return;
    }
    diagnostics.push({
      code: 'GHA-PARSE-001',
      severity: 'error',
      message: `YAML 解析失败：${cleanMessage(error.message)}`,
      line: error.line || undefined,
    });
  });

  warnings.forEach((warning) => {
    diagnostics.push({
      code: 'GHA-PARSE-002',
      severity: 'warning',
      message: `YAML 提示：${cleanMessage(warning.message)}`,
      line: warning.line || undefined,
    });
  });

  if (!model || model.jobs.length === 0) {
    if (errors.length === 0) {
      diagnostics.push({
        code: 'GHA-PARSE-003',
        severity: 'error',
        message: '未找到 jobs 映射，这不是一个可识别的工作流文件',
      });
    }
    return diagnostics;
  }

  if (model.triggers.events.length === 0) {
    diagnostics.push({
      code: 'GHA-PARSE-004',
      severity: 'warning',
      message: '缺少 on 触发器：工作流不会被自动触发（仍可手动或由其他工作流调用）',
    });
  }

  const knownJobs = new Set(model.jobs.map(job => job.id));
  model.jobs.forEach((job) => {
    job.needs.forEach((need) => {
      if (need === job.id) {
        diagnostics.push({
          code: 'GHA-NEEDS-003',
          severity: 'error',
          message: `job "${job.id}" 依赖自身，GitHub 会拒绝该工作流`,
          jobId: job.id,
          line: job.line || undefined,
        });
        return;
      }
      if (!knownJobs.has(need)) {
        diagnostics.push({
          code: 'GHA-NEEDS-001',
          severity: 'error',
          message: `job "${job.id}" 的 needs 引用了不存在的 job "${need}"`,
          jobId: job.id,
          line: job.line || undefined,
        });
      }
    });
  });

  const cycle = findNeedsCycle(model.jobs);
  if (cycle) {
    diagnostics.push({
      code: 'GHA-NEEDS-002',
      severity: 'error',
      message: `needs 存在循环依赖：${cycle.join(' → ')}`,
      jobId: cycle[0],
      line: model.jobs.find(job => job.id === cycle[0])?.line || undefined,
    });
  }

  const checkoutSteps: Array<{ jobId: string; stepIndex: number; line: number; uses: string }> = [];
  model.jobs.forEach((job) => {
    diagnostics.push(...collectJobDiagnostics(job, model.triggers.events, checkoutSteps));
  });

  if (model.triggers.events.includes('pull_request_target') && checkoutSteps.length === 0) {
    diagnostics.push({
      code: 'GHA-SEC-002',
      severity: 'info',
      message: '工作流使用 pull_request_target：该事件带有写权限，请确认没有执行来自 fork 的代码',
    });
  }

  diagnostics.push(...collectExpressionDiagnostics(source));

  const severityRank: Record<WorkflowDiagnosticSeverity, number> = { error: 0, warning: 1, info: 2 };
  return diagnostics.sort((a, b) => {
    const bySeverity = severityRank[a.severity] - severityRank[b.severity];
    if (bySeverity !== 0) return bySeverity;
    return (a.line ?? 0) - (b.line ?? 0);
  });
}

export function formatWorkflowDiagnostic(diagnostic: WorkflowDiagnostic): string {
  return `[${diagnostic.code}] ${diagnostic.message}`;
}

export function countWorkflowDiagnostics(diagnostics: readonly WorkflowDiagnostic[]): {
  errors: number;
  warnings: number;
  infos: number;
} {
  return diagnostics.reduce(
    (totals, diagnostic) => {
      if (diagnostic.severity === 'error') totals.errors += 1;
      else if (diagnostic.severity === 'warning') totals.warnings += 1;
      else totals.infos += 1;
      return totals;
    },
    { errors: 0, warnings: 0, infos: 0 },
  );
}
