/**
 * 结构化编辑补丁：把表单里的字段修改排成队列，保存时一次性应用到 YAML 的
 * 具体语法树（CST），从而保留注释、锚点与原有缩进。
 *
 * 补丁只描述「改哪个字段、改成什么」，不携带语法树，因此可以作为普通数据
 * 放在 React 状态里排队，也便于单测。目标路径在应用前会重新校验，文档被
 * 外部修改后不会误建新的 job / step。
 */
import { isMap, isNode, isSeq, parse as parseYaml, stringify, type Node as YamlNode } from 'yaml';
import { nodeToText, parseWorkflowDocument } from './githubWorkflow.ts';

export type WorkflowJobField = 'name' | 'runs-on' | 'if';
export type WorkflowStepField = 'name' | 'run' | 'if' | 'working-directory';

export type WorkflowPatch =
  | { kind: 'job.set'; jobId: string; field: WorkflowJobField; value: string }
  | { kind: 'step.set'; jobId: string; stepIndex: number; field: WorkflowStepField; value: string }
  | { kind: 'with.set'; jobId: string; stepIndex: number; key: string; value: string }
  | { kind: 'with.remove'; jobId: string; stepIndex: number; key: string };

export interface WorkflowPatchIssue {
  patch: WorkflowPatch;
  reason: string;
}

export interface WorkflowPatchResult {
  source: string;
  /** 实际写入文档的补丁标识。 */
  applied: string[];
  issues: WorkflowPatchIssue[];
}

const FIELD_LABELS: Record<WorkflowJobField | WorkflowStepField, string> = {
  name: 'name',
  'runs-on': 'runs-on',
  run: 'run',
  if: 'if',
  'working-directory': 'working-directory',
};

/** 同目标补丁的去重键：同一字段重复编辑时只保留最后一次。 */
export function workflowPatchKey(patch: WorkflowPatch): string {
  switch (patch.kind) {
    case 'job.set':
      return `job:${patch.jobId}:${patch.field}`;
    case 'step.set':
      return `step:${patch.jobId}:${patch.stepIndex}:${patch.field}`;
    case 'with.set':
      return `with:${patch.jobId}:${patch.stepIndex}:${patch.key}`;
    case 'with.remove':
      return `with:${patch.jobId}:${patch.stepIndex}:${patch.key}`;
    default:
      return 'unknown';
  }
}

export function describeWorkflowPatch(patch: WorkflowPatch): string {
  switch (patch.kind) {
    case 'job.set':
      return `job ${patch.jobId} · ${FIELD_LABELS[patch.field]}`;
    case 'step.set':
      return `job ${patch.jobId} · 步骤 ${patch.stepIndex + 1} · ${FIELD_LABELS[patch.field]}`;
    case 'with.set':
      return `job ${patch.jobId} · 步骤 ${patch.stepIndex + 1} · with.${patch.key}`;
    case 'with.remove':
      return `job ${patch.jobId} · 步骤 ${patch.stepIndex + 1} · 删除 with.${patch.key}`;
    default:
      return '未知修改';
  }
}

/**
 * `runs-on` 允许数组写法（`runs-on: [self-hosted, linux]`），
 * 因此在 form 值以流式集合开头时尝试按 YAML 解析。
 */
function coercePatchValue(field: WorkflowPatch['kind'] | WorkflowJobField, value: string): unknown {
  const trimmed = value.trim();
  const isFlowCollection = (trimmed.startsWith('[') && trimmed.endsWith(']'))
    || (trimmed.startsWith('{') && trimmed.endsWith('}'));
  if (!isFlowCollection) return value;
  if (field !== 'runs-on') return value;
  try {
    const parsed = parseYaml(trimmed);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // 解析失败时按普通字符串写入，避免把非法流式结构塞进语法树。
  }
  return value;
}

/** `with:` 的值最终都会转成字符串，数字 / 布尔按字面量写入以免被加引号。 */
function coerceWithValue(value: string): unknown {
  const trimmed = value.trim();
  if (/^(?:true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return value;
}

function currentText(node: YamlNode | undefined): string {
  return node ? nodeToText(node) : '';
}

/**
 * 把补丁队列应用到工作流源码。
 * `preserveFormat: false` 时改用规范化输出（会丢注释，与设置项一致）。
 */
export function applyWorkflowPatches(
  source: string,
  patches: readonly WorkflowPatch[],
  options: { preserveFormat?: boolean } = {},
): WorkflowPatchResult {
  const preserveFormat = options.preserveFormat !== false;
  const issues: WorkflowPatchIssue[] = [];
  const applied: string[] = [];
  if (patches.length === 0) return { source, applied, issues };

  const { document } = parseWorkflowDocument(source);
  const root = document.contents as YamlNode | null;
  if (!isMap(root)) {
    return {
      source,
      applied,
      issues: patches.map(patch => ({ patch, reason: '文档根节点不是映射，无法应用补丁' })),
    };
  }

  const jobsNode = root.get('jobs', true);
  if (!isMap(jobsNode)) {
    return {
      source,
      applied,
      issues: patches.map(patch => ({ patch, reason: '未找到 jobs 映射，无法应用补丁' })),
    };
  }

  // 路径相对于 jobs 映射；getIn 默认会解包标量，keepScalar=true 才能拿到节点。
  const stepPath = (jobId: string, stepIndex: number) => [jobId, 'steps', stepIndex];
  const stepWithPath = (jobId: string, stepIndex: number) => [...stepPath(jobId, stepIndex), 'with'];

  /**
   * 写入前显式建节点：`setIn` 传入 JS 集合会延迟到序列化时才建节点，
   * 那时再想改成流式（`runs-on: [a, b]`）就来不及了。替换标量时把行内
   * 与前置注释搬到新节点上，避免 `name: 构建 # 说明` 的注释丢失。
   */
  const setValue = (path: Array<string | number>, value: unknown, flow = false) => {
    const previous = jobsNode.getIn(path, true) as YamlNode | null;
    const comment = previous && isNode(previous) ? previous.comment : undefined;
    const commentBefore = previous && isNode(previous) ? previous.commentBefore : undefined;

    const node = document.createNode(value);
    if (flow && (isSeq(node) || isMap(node))) node.flow = true;
    jobsNode.setIn(path, node);

    if (!comment && !commentBefore) return;
    const next = jobsNode.getIn(path, true) as YamlNode | null;
    if (!next || !isNode(next)) return;
    if (comment) next.comment = comment;
    if (commentBefore) next.commentBefore = commentBefore;
  };
  const resolveStep = (patch: WorkflowPatch, jobId: string, stepIndex: number): WorkflowPatchIssue | null => {
    const jobNode = jobsNode.get(jobId, true);
    if (!isMap(jobNode)) return { patch, reason: `未找到 job "${jobId}"，已跳过` };
    const stepsNode = jobNode.get('steps', true);
    if (!isSeq(stepsNode)) return { patch, reason: `job "${jobId}" 没有可编辑的 steps 列表，已跳过` };
    const node = stepsNode.items[stepIndex];
    if (!isMap(node)) return { patch, reason: `job "${jobId}" 的第 ${stepIndex + 1} 个步骤已不存在，已跳过` };
    return null;
  };

  patches.forEach((patch) => {
    const key = workflowPatchKey(patch);

    if (patch.kind === 'job.set') {
      const jobNode = jobsNode.get(patch.jobId, true);
      if (!isMap(jobNode)) {
        issues.push({ patch, reason: `未找到 job "${patch.jobId}"，已跳过` });
        return;
      }
      if (currentText(jobNode.get(patch.field, true) as YamlNode | undefined) === patch.value.trim()) return;
      const value = coercePatchValue(patch.field, patch.value);
      // 写成流式（`[a, b]`）时保持流式，更接近手写风格。
      setValue([patch.jobId, patch.field], value, typeof value === 'object' && value !== null);
      applied.push(key);
      return;
    }

    if (patch.kind === 'step.set') {
      const issue = resolveStep(patch, patch.jobId, patch.stepIndex);
      if (issue) {
        issues.push(issue);
        return;
      }
      const stepNode = jobsNode.getIn(stepPath(patch.jobId, patch.stepIndex), true);
      if (isMap(stepNode) && currentText(stepNode.get(patch.field, true) as YamlNode | undefined) === patch.value.trim()) return;
      jobsNode.setIn([...stepPath(patch.jobId, patch.stepIndex), patch.field], patch.value);
      applied.push(key);
      return;
    }

    if (patch.kind === 'with.set') {
      const issue = resolveStep(patch, patch.jobId, patch.stepIndex);
      if (issue) {
        issues.push(issue);
        return;
      }
      const withNode = jobsNode.getIn(stepWithPath(patch.jobId, patch.stepIndex), true);
      if (withNode !== undefined && !isMap(withNode)) {
        issues.push({ patch, reason: `步骤 ${patch.stepIndex + 1} 的 with 不是键值映射，已跳过` });
        return;
      }
      if (isMap(withNode) && currentText(withNode.get(patch.key, true) as YamlNode | undefined) === patch.value.trim()) return;
      setValue([...stepWithPath(patch.jobId, patch.stepIndex), patch.key], coerceWithValue(patch.value));
      applied.push(key);
      return;
    }

    const issue = resolveStep(patch, patch.jobId, patch.stepIndex);
    if (issue) {
      issues.push(issue);
      return;
    }
    const withNode = jobsNode.getIn(stepWithPath(patch.jobId, patch.stepIndex), true);
    if (!isMap(withNode) || !withNode.has(patch.key)) {
      issues.push({ patch, reason: `未找到 with.${patch.key}，已跳过` });
      return;
    }
    jobsNode.deleteIn([...stepPath(patch.jobId, patch.stepIndex), 'with', patch.key]);
    applied.push(key);
    const remaining = jobsNode.getIn([...stepPath(patch.jobId, patch.stepIndex), 'with']) as YamlNode | undefined;
    if (isMap(remaining) && remaining.items.length === 0) {
      jobsNode.deleteIn([...stepPath(patch.jobId, patch.stepIndex), 'with']);
    }
  });

  if (applied.length === 0) return { source, applied, issues };

  const nextSource = preserveFormat
    // yaml 的 CST 输出会保留注释与节点风格；关闭流式内边距是为了让
    // `[main]` 这类原有写法不被改写成 `[ main ]`。
    ? document.toString({ lineWidth: 0, flowCollectionPadding: false })
    // 规范化输出：丢弃注释、锚点与自定义缩进，只保留数据本身。
    : stringify(document.toJS(), { lineWidth: 0 });
  return { source: nextSource, applied, issues };
}
