/**
 * 工作流依赖图：由 `needs:` 关系计算分层布局（DAG），供 SVG 画布渲染，
 * 并可导出为 Mermaid flowchart 文本用于 README 等文档。
 *
 * 循环依赖不会让布局失败：构成环的边会被标记为回边（不参与分层），
 * 由诊断模块负责报错。
 */
import { jobSubtitle, type WorkflowJob, type WorkflowModel } from './githubWorkflow.ts';

export interface WorkflowGraphNode {
  id: string;
  jobId: string;
  label: string;
  subtitle: string;
  layer: number;
  row: number;
  x: number;
  y: number;
  width: number;
  height: number;
  stepCount: number;
  needs: string[];
  isReusable: boolean;
  matrixKeys: string[];
}

export interface WorkflowGraphEdge {
  id: string;
  from: string;
  to: string;
  fromJobId: string;
  toJobId: string;
  /** 参与环路的回边：画出来但不影响分层。 */
  backEdge: boolean;
}

export interface WorkflowGraph {
  nodes: WorkflowGraphNode[];
  edges: WorkflowGraphEdge[];
  width: number;
  height: number;
  layerCount: number;
  cyclicJobIds: string[];
  unknownNeeds: Array<{ jobId: string; jobIdRaw: string }>;
}

const NODE_WIDTH = 232;
const NODE_HEIGHT = 86;
const H_GAP = 96;
const V_GAP = 26;
const PADDING = 24;

const nodeIdOf = (jobId: string) => `job-${jobId}`;

/**
 * 分层：`needs` 的入边决定列。Kahn 拓扑推进后仍留在环里的 job
 * 用不动点迭代补层，保证布局总能完成。
 */
function assignLayers(jobs: WorkflowJob[], edges: WorkflowGraphEdge[]): { layers: Map<string, number>; cyclic: string[] } {
  const layers = new Map<string, number>();
  const incoming = new Map<string, WorkflowGraphEdge[]>();
  const outgoing = new Map<string, WorkflowGraphEdge[]>();
  jobs.forEach((job) => {
    layers.set(job.id, 0);
    incoming.set(job.id, []);
    outgoing.set(job.id, []);
  });

  edges.forEach((edge) => {
    if (edge.backEdge) return;
    incoming.get(edge.toJobId)?.push(edge);
    outgoing.get(edge.fromJobId)?.push(edge);
  });

  const indegree = new Map<string, number>();
  jobs.forEach(job => indegree.set(job.id, incoming.get(job.id)?.length ?? 0));

  const queue = jobs.filter(job => (indegree.get(job.id) ?? 0) === 0).map(job => job.id);
  const settled = new Set<string>();
  while (queue.length > 0) {
    const jobId = queue.shift() as string;
    settled.add(jobId);
    (outgoing.get(jobId) ?? []).forEach((edge) => {
      const nextLayer = (layers.get(jobId) ?? 0) + 1;
      if (nextLayer > (layers.get(edge.toJobId) ?? 0)) layers.set(edge.toJobId, nextLayer);
      const remaining = (indegree.get(edge.toJobId) ?? 0) - 1;
      indegree.set(edge.toJobId, remaining);
      if (remaining === 0) queue.push(edge.toJobId);
    });
  }

  // 环内节点：按已定层的上游反复收敛，有限次迭代兜底。
  const leftovers = jobs.filter(job => !settled.has(job.id));
  for (let pass = 0; pass < leftovers.length + 1; pass += 1) {
    let changed = false;
    leftovers.forEach((job) => {
      (incoming.get(job.id) ?? []).forEach((edge) => {
        if (!settled.has(edge.fromJobId) && !leftovers.some(item => item.id === edge.fromJobId)) return;
        const nextLayer = (layers.get(edge.fromJobId) ?? 0) + 1;
        if (nextLayer > (layers.get(job.id) ?? 0)) {
          layers.set(job.id, nextLayer);
          changed = true;
        }
      });
    });
    if (!changed) break;
  }

  return { layers, cyclic: leftovers.map(job => job.id) };
}

export function buildWorkflowGraph(model: WorkflowModel): WorkflowGraph {
  const jobs = model.jobs;
  const known = new Set(jobs.map(job => job.id));
  const unknownNeeds: Array<{ jobId: string; jobIdRaw: string }> = [];

  // 先建边，同时识别未知引用与自依赖；自依赖视为回边。
  const edges: WorkflowGraphEdge[] = [];
  jobs.forEach((job) => {
    job.needs.forEach((need) => {
      if (!known.has(need)) {
        unknownNeeds.push({ jobId: job.id, jobIdRaw: need });
        return;
      }
      edges.push({
        id: `${need}->${job.id}`,
        from: nodeIdOf(need),
        to: nodeIdOf(job.id),
        fromJobId: need,
        toJobId: job.id,
        backEdge: need === job.id,
      });
    });
  });

  // 深度优先标记回边：遇到正在访问中的节点即为环。
  const state = new Map<string, 'visiting' | 'done'>();
  const adjacency = new Map<string, WorkflowGraphEdge[]>();
  jobs.forEach(job => adjacency.set(job.id, []));
  edges.forEach(edge => adjacency.get(edge.fromJobId)?.push(edge));

  const cyclic = new Set<string>();
  const visit = (jobId: string) => {
    state.set(jobId, 'visiting');
    (adjacency.get(jobId) ?? []).forEach((edge) => {
      const status = state.get(edge.toJobId);
      if (status === 'visiting') {
        edge.backEdge = true;
        cyclic.add(edge.fromJobId);
        cyclic.add(edge.toJobId);
        return;
      }
      if (status === undefined) visit(edge.toJobId);
    });
    state.set(jobId, 'done');
  };
  jobs.forEach(job => {
    if (!state.has(job.id)) visit(job.id);
  });

  const { layers, cyclic: leftoverCyclic } = assignLayers(jobs, edges);
  leftoverCyclic.forEach(jobId => cyclic.add(jobId));

  const rowByLayer = new Map<number, number>();
  const nodes: WorkflowGraphNode[] = jobs.map((job) => {
    const layer = layers.get(job.id) ?? 0;
    const row = rowByLayer.get(layer) ?? 0;
    rowByLayer.set(layer, row + 1);
    return {
      id: nodeIdOf(job.id),
      jobId: job.id,
      label: job.name || job.id,
      subtitle: jobSubtitle(job),
      layer,
      row,
      x: PADDING + layer * (NODE_WIDTH + H_GAP),
      y: PADDING + row * (NODE_HEIGHT + V_GAP),
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      stepCount: job.steps.length,
      needs: job.needs,
      isReusable: Boolean(job.uses),
      matrixKeys: job.matrixKeys,
    };
  });

  const layerCount = nodes.reduce((max, node) => Math.max(max, node.layer + 1), 0);
  const maxRows = rowByLayer.size > 0 ? Math.max(...Array.from(rowByLayer.values())) : 0;
  const width = layerCount > 0 ? PADDING * 2 + layerCount * NODE_WIDTH + (layerCount - 1) * H_GAP : PADDING * 2;
  const height = maxRows > 0 ? PADDING * 2 + maxRows * NODE_HEIGHT + (maxRows - 1) * V_GAP : PADDING * 2;

  return {
    nodes,
    edges,
    width,
    height,
    layerCount,
    cyclicJobIds: Array.from(cyclic),
    unknownNeeds,
  };
}

/** 依赖边路径：从上游节点右侧连到下游节点左侧的三次贝塞尔曲线。 */
export function workflowEdgePath(from: WorkflowGraphNode, to: WorkflowGraphNode): string {
  const startX = from.x + from.width;
  const startY = from.y + from.height / 2;
  const endX = to.x;
  const endY = to.y + to.height / 2;
  const curve = Math.max(36, Math.min(160, Math.abs(endX - startX) * 0.5));

  // 回边（环或自依赖）绕到节点下方，避免与正向边重叠。
  if (endX <= startX + 1) {
    const laneY = Math.max(from.y + from.height, to.y + to.height) + 34;
    return [
      `M ${startX} ${startY}`,
      `C ${startX + curve} ${laneY}, ${endX - curve} ${laneY}, ${endX} ${endY}`,
    ].join(' ');
  }

  return `M ${startX} ${startY} C ${startX + curve} ${startY}, ${endX - curve} ${endY}, ${endX} ${endY}`;
}

function escapeMermaidLabel(text: string): string {
  return text
    .replace(/"/g, "'")
    .replace(/\r?\n/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 导出为 Mermaid flowchart（有损：丢失运行状态与 step 细节）。
 * 目标场景是嵌入 README / 文档，因此保留 `<br/>` 换行（GitHub 按 HTML 标签渲染）。
 */
export function workflowToMermaid(model: WorkflowModel): string {
  const mermaidId = new Map<string, string>();
  model.jobs.forEach((job, index) => mermaidId.set(job.id, `J${index}`));

  const lines: string[] = ['flowchart LR'];
  const triggerLabel = model.triggers.events.join(', ');
  if (triggerLabel) lines.push(`  %% on: ${escapeMermaidLabel(triggerLabel)}`);
  if (model.name) lines.push(`  %% workflow: ${escapeMermaidLabel(model.name)}`);

  model.jobs.forEach((job) => {
    const title = escapeMermaidLabel(job.name || job.id);
    const detail = escapeMermaidLabel(
      job.uses ? `可复用工作流` : `${jobSubtitle(job)} · ${job.steps.length} 步`,
    );
    lines.push(`  ${mermaidId.get(job.id)}["${title}<br/>${detail}"]`);
  });

  model.jobs.forEach((job) => {
    job.needs.forEach((need) => {
      const from = mermaidId.get(need);
      const to = mermaidId.get(job.id);
      if (!from || !to) return;
      lines.push(`  ${from} --> ${to}`);
    });
  });

  return lines.join('\n');
}
