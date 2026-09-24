/**
 * GitHub Actions 工作流解析：把 workflow YAML 归一化成查看器与结构化编辑器
 * 需要的模型（jobs / needs / steps / triggers），并保留每个节点的源码行号。
 *
 * 这里只做「阅读与审阅」所需的解析，不会执行工作流，也不会联网拉取 action
 * 元数据；所有结果都来自本地源码。
 */
import {
  LineCounter,
  isMap,
  isPair,
  isScalar,
  isSeq,
  parseDocument,
  type Node as YamlNode,
} from 'yaml';
import { hasWorkflowShape, isWorkflowLikeFile } from './workflowShape.ts';

export {
  WORKFLOW_FENCE_LANGUAGES,
  hasWorkflowShape,
  isWorkflowFilePath,
  isWorkflowLikeFile,
  isYamlFileName,
} from './workflowShape.ts';

/** 超过该长度的内容不再按工作流解析，避免拖慢预览渲染。 */
const MAX_WORKFLOW_SOURCE_LENGTH = 200_000;

/** GitHub 表达式可用的上下文标识符（用于未知上下文诊断）。 */
export const KNOWN_EXPRESSION_CONTEXTS = new Set([
  'github', 'env', 'vars', 'job', 'jobs', 'steps', 'runner', 'secrets', 'strategy',
  'matrix', 'needs', 'inputs', 'always', 'success', 'failure', 'cancelled', 'hashfiles',
  'contains', 'startswith', 'endswith', 'format', 'join', 'tojson', 'fromjson',
]);

export interface WorkflowStep {
  /** steps 数组中的下标，用作结构化编辑的定位键。 */
  index: number;
  name: string;
  uses: string | null;
  run: string | null;
  if: string | null;
  workingDirectory: string | null;
  withEntries: Array<{ key: string; value: string }>;
  line: number;
}

export interface WorkflowJob {
  id: string;
  name: string;
  runsOn: string | null;
  if: string | null;
  /** 可复用工作流（`uses: owner/repo/.github/workflows/x.yml@ref`）。 */
  uses: string | null;
  needs: string[];
  steps: WorkflowStep[];
  matrixKeys: string[];
  /** `strategy.matrix` 结构异常时的说明（正常为 null）。 */
  matrixIssue: string | null;
  line: number;
}

export interface WorkflowTriggerInfo {
  events: string[];
  branches: string[];
  tags: string[];
  paths: string[];
  types: string[];
  cron: string[];
  dispatchInputs: string[];
}

export interface WorkflowModel {
  name: string | null;
  jobs: WorkflowJob[];
  triggers: WorkflowTriggerInfo;
  /** workflow 顶层第一行（用于「跳转到源码」）。 */
  line: number;
}

export interface WorkflowParseError {
  message: string;
  code: string | null;
  line: number;
  column: number;
}

export interface WorkflowParseResult {
  model: WorkflowModel | null;
  errors: WorkflowParseError[];
  warnings: WorkflowParseError[];
}

function emptyTriggers(): WorkflowTriggerInfo {
  return { events: [], branches: [], tags: [], paths: [], types: [], cron: [], dispatchInputs: [] };
}

function lineOf(lineCounter: LineCounter, node: YamlNode | null | undefined): number {
  const range = node?.range;
  if (!range) return 0;
  return lineCounter.linePos(range[0]).line;
}

/** 读取映射字段；keepScalar=true 保证标量也返回节点而不是解包后的原始值。 */
function mapField(map: YamlNode | null | undefined, key: string): YamlNode | null {
  if (!isMap(map)) return null;
  return (map.get(key, true) as YamlNode | undefined) ?? null;
}

/** 把任意 YAML 标量 / 序列 / 映射转成可展示的单行文本。 */
export function nodeToText(node: YamlNode | null | undefined): string {
  if (!node) return '';
  if (isScalar(node)) {
    const value = node.value;
    return value === null || value === undefined ? '' : String(value);
  }
  if (isSeq(node)) {
    return node.items.map(item => nodeToText(item as YamlNode)).filter(Boolean).join(', ');
  }
  if (isMap(node)) {
    return node.items
      .map((item) => {
        if (!isPair(item)) return '';
        return `${nodeToText(item.key as YamlNode)}: ${nodeToText(item.value as YamlNode)}`;
      })
      .filter(Boolean)
      .join(', ');
  }
  return '';
}

function textList(node: YamlNode | null | undefined): string[] {
  if (!node) return [];
  if (isScalar(node)) {
    const text = nodeToText(node).trim();
    return text ? [text] : [];
  }
  if (isSeq(node)) {
    return node.items.map(item => nodeToText(item as YamlNode).trim()).filter(Boolean);
  }
  return [];
}

function buildStep(node: YamlNode, index: number, lineCounter: LineCounter): WorkflowStep {
  const map = isMap(node) ? node : null;
  const withNode = mapField(map, 'with');
  const runNode = mapField(map, 'run');
  const withEntries: Array<{ key: string; value: string }> = [];

  if (isMap(withNode)) {
    withNode.items.forEach((item) => {
      if (!isPair(item)) return;
      const key = nodeToText(item.key as YamlNode).trim();
      if (!key) return;
      withEntries.push({ key, value: nodeToText(item.value as YamlNode) });
    });
  }

  return {
    index,
    name: nodeToText(mapField(map, 'name')).trim(),
    uses: nodeToText(mapField(map, 'uses')).trim() || null,
    run: isScalar(runNode) ? String(runNode.value ?? '') : (nodeToText(runNode) || null),
    if: nodeToText(mapField(map, 'if')).trim() || null,
    workingDirectory: nodeToText(mapField(map, 'working-directory')).trim() || null,
    withEntries,
    line: lineOf(lineCounter, node),
  };
}

/** 校验 `strategy.matrix` 结构，返回可读的问题说明。 */
function inspectMatrix(matrixNode: YamlNode | null): string | null {
  if (!matrixNode) return null;
  if (!isMap(matrixNode)) return 'strategy.matrix 需要是键值映射（例如 os: [ubuntu-latest]）';
  const includeNode = matrixNode.get('include', true);
  const excludeNode = matrixNode.get('exclude', true);
  if (includeNode !== undefined && !isSeq(includeNode)) return 'matrix.include 需要是数组';
  if (excludeNode !== undefined && !isSeq(excludeNode)) return 'matrix.exclude 需要是数组';
  return null;
}

function buildJob(id: string, node: YamlNode, lineCounter: LineCounter, line: number): WorkflowJob {
  const map = isMap(node) ? node : null;
  const stepsNode = mapField(map, 'steps');
  const steps = isSeq(stepsNode)
    ? stepsNode.items.map((item, index) => buildStep(item as YamlNode, index, lineCounter))
    : [];
  const matrixNode = mapField(mapField(map, 'strategy'), 'matrix');

  return {
    id,
    name: nodeToText(mapField(map, 'name')).trim(),
    runsOn: nodeToText(mapField(map, 'runs-on')).trim() || null,
    if: nodeToText(mapField(map, 'if')).trim() || null,
    uses: nodeToText(mapField(map, 'uses')).trim() || null,
    needs: textList(mapField(map, 'needs')),
    steps,
    matrixKeys: isMap(matrixNode)
      ? matrixNode.items
        .map(item => (isPair(item) ? nodeToText(item.key as YamlNode).trim() : ''))
        .filter(key => key && key !== 'include' && key !== 'exclude')
      : [],
    matrixIssue: inspectMatrix(matrixNode),
    line,
  };
}

function collectEventFilters(eventValue: YamlNode | null, triggers: WorkflowTriggerInfo): void {
  if (isMap(eventValue)) {
    triggers.branches.push(...textList(mapField(eventValue, 'branches')));
    triggers.branches.push(...textList(mapField(eventValue, 'branches-ignore')));
    triggers.tags.push(...textList(mapField(eventValue, 'tags')));
    triggers.tags.push(...textList(mapField(eventValue, 'tags-ignore')));
    triggers.paths.push(...textList(mapField(eventValue, 'paths')));
    triggers.paths.push(...textList(mapField(eventValue, 'paths-ignore')));
    triggers.types.push(...textList(mapField(eventValue, 'types')));
    const inputsNode = mapField(eventValue, 'inputs');
    if (isMap(inputsNode)) {
      triggers.dispatchInputs.push(...inputsNode.items
        .map(item => (isPair(item) ? nodeToText(item.key as YamlNode).trim() : ''))
        .filter(Boolean));
    }
    return;
  }

  // `schedule` 是「事件值为序列」的常见写法：`on.schedule[].cron`。
  if (isSeq(eventValue)) {
    eventValue.items.forEach((item) => {
      const cron = nodeToText(mapField(item as YamlNode, 'cron')).trim();
      if (cron) triggers.cron.push(cron);
    });
  }
}

function buildTriggers(onNode: YamlNode | null): WorkflowTriggerInfo {
  const triggers = emptyTriggers();
  if (!onNode) return triggers;

  if (isScalar(onNode)) {
    const event = nodeToText(onNode).trim();
    if (event) triggers.events.push(event);
    return triggers;
  }

  if (isSeq(onNode)) {
    triggers.events.push(...textList(onNode));
    return triggers;
  }

  if (isMap(onNode)) {
    onNode.items.forEach((item) => {
      if (!isPair(item)) return;
      const event = nodeToText(item.key as YamlNode).trim();
      if (!event) return;
      triggers.events.push(event);
      collectEventFilters(item.value as YamlNode, triggers);
    });
  }

  const dedupe = (values: string[]) => Array.from(new Set(values));
  triggers.events = dedupe(triggers.events);
  triggers.branches = dedupe(triggers.branches);
  triggers.tags = dedupe(triggers.tags);
  triggers.paths = dedupe(triggers.paths);
  triggers.types = dedupe(triggers.types);
  triggers.cron = dedupe(triggers.cron);
  triggers.dispatchInputs = dedupe(triggers.dispatchInputs);
  return triggers;
}

function toParseErrors(
  errors: readonly { message: string; code?: string; linePos?: readonly { line: number; col: number }[] }[],
): WorkflowParseError[] {
  return errors.map(error => ({
    message: error.message,
    code: error.code ?? null,
    line: error.linePos?.[0]?.line ?? 0,
    column: error.linePos?.[0]?.col ?? 0,
  }));
}

/**
 * 判断一段文本是否「看起来像」GitHub Actions 工作流：
 * 顶层存在 `jobs`，且每个 job 都声明了 `runs-on` 或 `uses`（可复用工作流）。
 */
export function looksLikeWorkflowYaml(source: string): boolean {
  if (!source || source.length > MAX_WORKFLOW_SOURCE_LENGTH) return false;
  if (!hasWorkflowShape(source)) return false;

  const document = parseDocument(source, { uniqueKeys: false, prettyErrors: false });
  const jobs = document.get('jobs', true) as YamlNode | undefined;
  if (!isMap(jobs) || jobs.items.length === 0) return false;

  return jobs.items.every((item) => {
    if (!isPair(item) || !isMap(item.value)) return false;
    return item.value.has('runs-on') || item.value.has('uses');
  });
}

/**
 * `.github/workflows/` 下的 YAML，或内容形态可识别为工作流的 YAML 文件。
 * 目录约定优先：即时有语法错误也交给查看器展示诊断。
 */
export function isWorkflowSourceFile(path: string | null | undefined, source: string): boolean {
  return isWorkflowLikeFile(path, source);
}

/** 解析语法树与行号表；供诊断与结构化编辑复用。 */
export function parseWorkflowDocument(source: string) {
  const lineCounter = new LineCounter();
  const document = parseDocument(source, {
    lineCounter,
    uniqueKeys: true,
    prettyErrors: true,
    strict: false,
  });
  return { document, lineCounter };
}

/**
 * 解析工作流源码。即使存在语法错误也会尽量给出部分模型，
 * 让查看器能画出一部分依赖图并同时展示诊断。
 */
export function parseWorkflow(source: string): WorkflowParseResult {
  const errors: WorkflowParseError[] = [];
  const warnings: WorkflowParseError[] = [];
  if (!source.trim()) return { model: null, errors, warnings };

  const { document, lineCounter } = parseWorkflowDocument(source);
  errors.push(...toParseErrors(document.errors));
  warnings.push(...toParseErrors(document.warnings));

  const jobsNode = document.get('jobs', true) as YamlNode | undefined;
  const jobs: WorkflowJob[] = [];
  if (isMap(jobsNode)) {
    jobsNode.items.forEach((item) => {
      if (!isPair(item)) return;
      const id = nodeToText(item.key as YamlNode).trim();
      if (!id) return;
      // job 的定位行取 `build:` 键所在行，而不是映射值的首个字段。
      jobs.push(buildJob(id, item.value as YamlNode, lineCounter, lineOf(lineCounter, item.key as YamlNode)));
    });
  }

  // 没有 jobs 也没有语法错误时，说明只是普通 YAML，调用方应回退到代码块渲染。
  if (jobs.length === 0 && errors.length === 0) {
    return { model: null, errors, warnings };
  }

  const name = nodeToText(document.get('name', true) as YamlNode | undefined).trim() || null;
  const model: WorkflowModel = {
    name,
    jobs,
    // YAML 1.1 会把裸键 `on` 解析为布尔真，这里同时兼容两种键。
    triggers: buildTriggers(
      ((document.get('on', true) ?? document.get('true', true)) as YamlNode | undefined) ?? null,
    ),
    line: 1,
  };
  return { model, errors, warnings };
}

/** 解析 `uses:` 引用，返回 slug 与 ref（本地路径与 docker 引用单独标记）。 */
export function parseActionRef(uses: string): { slug: string; ref: string | null; isLocal: boolean } {
  const value = uses.trim();
  if (value.startsWith('./') || value.startsWith('.\\')) return { slug: value, ref: null, isLocal: true };
  if (value.startsWith('docker://')) return { slug: value, ref: null, isLocal: true };
  const atIndex = value.lastIndexOf('@');
  if (atIndex <= 0) return { slug: value, ref: null, isLocal: false };
  return { slug: value.slice(0, atIndex), ref: value.slice(atIndex + 1) || null, isLocal: false };
}

/** 供画布展示的 job 副标题：优先可复用工作流引用，其次 runs-on。 */
export function jobSubtitle(job: WorkflowJob): string {
  if (job.uses) return job.uses;
  return job.runsOn || '未指定 runs-on';
}
