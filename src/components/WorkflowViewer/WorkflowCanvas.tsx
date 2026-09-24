import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { workflowEdgePath, type WorkflowGraph, type WorkflowGraphNode } from '../../utils/workflowGraph';
import { displayWidth } from '../../utils/markdownTable.ts';
import type { WorkflowDiagnostic } from '../../utils/workflowDiagnostics';

interface WorkflowCanvasProps {
  graph: WorkflowGraph;
  selectedJobId: string | null;
  onSelectJob: (jobId: string) => void;
  diagnostics: readonly WorkflowDiagnostic[];
  /** 内联预览里使用紧凑排版。 */
  compact?: boolean;
  svgRef?: React.RefObject<SVGSVGElement | null>;
}

const MIN_SCALE = 0.6;
const MAX_SCALE = 1.8;
const SCALE_STEP = 0.15;

/**
 * 画布配色随主题切换，并作为 `<style>` 写进 SVG 内部：
 * 导出的 SVG 因此自带样式，脱离应用后仍能正常显示。
 */
const PALETTES = {
  dark: {
    canvas: '#1b1f24',
    node: '#262b33',
    nodeSelected: '#2d3a4d',
    stroke: '#3a4149',
    strokeSelected: '#58a6ff',
    title: '#e4e8ed',
    subtitle: '#98a2af',
    muted: '#6e7782',
    badgeText: '#98a2af',
    edge: '#4a525c',
    edgeActive: '#58a6ff',
    error: '#f47067',
    warning: '#d29922',
  },
  light: {
    canvas: '#ffffff',
    node: '#f7f8fa',
    nodeSelected: '#eef4ff',
    stroke: '#dce0e6',
    strokeSelected: '#2d6ae0',
    title: '#222a35',
    subtitle: '#5b6572',
    muted: '#8a93a1',
    badgeText: '#5b6572',
    edge: '#c3c9d2',
    edgeActive: '#2d6ae0',
    error: '#d0545f',
    warning: '#b07708',
  },
} as const;

/** 按显示宽度截断：中日韩字符按 2 个宽度单位计算。 */
function truncateToWidth(text: string, maxUnits: number): string {
  if (displayWidth(text) <= maxUnits) return text;
  let width = 0;
  let output = '';
  for (const char of text) {
    const next = width + displayWidth(char);
    if (next > maxUnits - 1) break;
    width = next;
    output += char;
  }
  return `${output}…`;
}

function useResolvedTheme(): 'dark' | 'light' {
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (typeof document !== 'undefined' && document.documentElement.dataset.theme?.endsWith('-dark') ? 'dark' : 'light'),
  );

  useEffect(() => {
    const handleThemeChange = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      setTheme(detail?.endsWith('-dark') ? 'dark' : 'light');
    };
    window.addEventListener('zeditor-theme-change', handleThemeChange);
    return () => window.removeEventListener('zeditor-theme-change', handleThemeChange);
  }, []);

  return theme;
}

function nodeBadges(node: WorkflowGraphNode): string[] {
  const badges: string[] = [];
  badges.push(node.isReusable ? '可复用工作流' : `${node.stepCount} 步`);
  if (node.matrixKeys.length > 0) badges.push(`矩阵 ${node.matrixKeys.join('/')}`);
  return badges;
}

export function WorkflowCanvas({ graph, selectedJobId, onSelectJob, diagnostics, compact, svgRef }: WorkflowCanvasProps) {
  const theme = useResolvedTheme();
  const palette = PALETTES[theme];
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  const diagnosticsByJob = useMemo(() => {
    const map = new Map<string, { errors: number; warnings: number }>();
    diagnostics.forEach((diagnostic) => {
      if (!diagnostic.jobId) return;
      const entry = map.get(diagnostic.jobId) ?? { errors: 0, warnings: 0 };
      if (diagnostic.severity === 'error') entry.errors += 1;
      else if (diagnostic.severity === 'warning') entry.warnings += 1;
      map.set(diagnostic.jobId, entry);
    });
    return map;
  }, [diagnostics]);

  const connectedJobs = useMemo(() => {
    if (!selectedJobId) return null;
    const related = new Set<string>([selectedJobId]);
    graph.edges.forEach((edge) => {
      if (edge.fromJobId === selectedJobId) related.add(edge.toJobId);
      if (edge.toJobId === selectedJobId) related.add(edge.fromJobId);
    });
    return related;
  }, [graph.edges, selectedJobId]);

  const applyScale = useCallback((next: number) => {
    const container = containerRef.current;
    const clamped = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Number(next.toFixed(2))));
    setScale((current) => {
      if (!container || Math.abs(clamped - current) < 0.001) return clamped;
      // 以视口中心为锚点缩放，避免放大后目标节点跑出可视区域。
      const ratio = clamped / current;
      const centerX = container.scrollLeft + container.clientWidth / 2;
      const centerY = container.scrollTop + container.clientHeight / 2;
      window.requestAnimationFrame(() => {
        container.scrollLeft = centerX * ratio - container.clientWidth / 2;
        container.scrollTop = centerY * ratio - container.clientHeight / 2;
      });
      return clamped;
    });
  }, []);

  const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    // 普通滚轮交给容器滚动，只有按住 Ctrl/Cmd 时才缩放。
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    applyScale(scale + (event.deltaY < 0 ? SCALE_STEP : -SCALE_STEP));
  }, [applyScale, scale]);

  const renderNode = (node: WorkflowGraphNode) => {
    const selected = node.jobId === selectedJobId;
    const dimmed = connectedJobs !== null && !connectedJobs.has(node.jobId);
    const counts = diagnosticsByJob.get(node.jobId);
    const badges = nodeBadges(node);
    const showIdLine = node.label !== node.jobId;
    // SVG 没有自动布局：徽章按估算宽度横向累加偏移。
    const badgeOffsets: number[] = [];
    let cursor = 14;
    badges.forEach((badge) => {
      badgeOffsets.push(cursor);
      cursor += displayWidth(badge) * 6.2 + 12;
    });

    return (
      <g
        key={node.id}
        className={`workflow-node ${selected ? 'is-selected' : ''} ${dimmed ? 'is-dimmed' : ''}`}
        transform={`translate(${node.x} ${node.y})`}
        role="button"
        tabIndex={0}
        aria-label={`job ${node.jobId}`}
        aria-pressed={selected}
        onClick={(event) => {
          event.stopPropagation();
          onSelectJob(node.jobId);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelectJob(node.jobId);
          }
        }}
      >
        <rect
          width={node.width}
          height={node.height}
          rx={10}
          fill={selected ? palette.nodeSelected : palette.node}
          stroke={selected ? palette.strokeSelected : palette.stroke}
          strokeWidth={selected ? 1.6 : 1}
        />
        {counts && (counts.errors > 0 || counts.warnings > 0) && (
          <circle cx={node.width - 14} cy={14} r={5} fill={counts.errors > 0 ? palette.error : palette.warning} />
        )}
        <text className="workflow-node-title" x={14} y={26} fill={palette.title}>
          {truncateToWidth(node.label, 24)}
        </text>
        <text className="workflow-node-id" x={14} y={44} fill={palette.muted}>
          {truncateToWidth(showIdLine ? node.jobId : node.subtitle, 26)}
        </text>
        {showIdLine && (
          <text className="workflow-node-subtitle" x={14} y={62} fill={palette.subtitle}>
            {truncateToWidth(node.subtitle, 26)}
          </text>
        )}
        {badges.map((badge, index) => (
          <text key={badge} className="workflow-node-badge" x={badgeOffsets[index]} y={node.height - 10} fill={palette.badgeText}>
            {badge}
          </text>
        ))}
      </g>
    );
  };

  const style = [
    `.workflow-canvas-root{background:${palette.canvas}}`,
    `.workflow-node-title{font:600 13px sans-serif}`,
    `.workflow-node-id{font:400 11px monospace}`,
    `.workflow-node-subtitle{font:400 11.5px monospace}`,
    `.workflow-node-badge{font:500 10.5px sans-serif}`,
    `.workflow-edge{fill:none;stroke:${palette.edge};stroke-width:1.4}`,
    `.workflow-edge.is-active{stroke:${palette.edgeActive};stroke-width:1.8}`,
    `.workflow-edge.is-back{stroke-dasharray:5 4}`,
    `.workflow-node{cursor:pointer}`,
    `.workflow-node.is-dimmed{opacity:.45}`,
    `.workflow-node:focus-visible rect{stroke:${palette.strokeSelected};stroke-width:2}`,
  ].join('');

  const edgeMarkerId = `workflow-arrow-${theme}`;

  return (
    <div className={`workflow-canvas ${compact ? 'is-compact' : ''}`}>
      <div className="workflow-canvas-toolbar">
        <span className="workflow-canvas-hint">Ctrl + 滚轮缩放，拖动滚动条平移，点击 job 查看详情</span>
        <div className="workflow-canvas-zoom">
          <button type="button" onClick={() => applyScale(scale - SCALE_STEP)} aria-label="缩小">−</button>
          <span>{Math.round(scale * 100)}%</span>
          <button type="button" onClick={() => applyScale(scale + SCALE_STEP)} aria-label="放大">+</button>
          <button type="button" onClick={() => applyScale(1)} aria-label="重置缩放">重置</button>
        </div>
      </div>
      <div ref={containerRef} className="workflow-canvas-viewport" onWheel={handleWheel}>
        <svg
          ref={svgRef}
          className="workflow-canvas-root"
          width={graph.width * scale}
          height={graph.height * scale}
          viewBox={`0 0 ${graph.width} ${graph.height}`}
          role="img"
          aria-label="工作流依赖图"
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <style>{style}</style>
            <marker
              id={edgeMarkerId}
              markerWidth="9"
              markerHeight="9"
              refX="7"
              refY="3"
              orient="auto"
              markerUnits="strokeWidth"
            >
              <path d="M0,0 L0,6 L8,3 z" fill={palette.edge} />
            </marker>
          </defs>
          {graph.edges.map((edge) => {
            const from = graph.nodes.find(node => node.id === edge.from);
            const to = graph.nodes.find(node => node.id === edge.to);
            if (!from || !to) return null;
            const active = selectedJobId !== null
              && (edge.fromJobId === selectedJobId || edge.toJobId === selectedJobId);
            return (
              <path
                key={edge.id}
                className={`workflow-edge ${active ? 'is-active' : ''} ${edge.backEdge ? 'is-back' : ''}`}
                d={workflowEdgePath(from, to)}
                markerEnd={`url(#${edgeMarkerId})`}
              />
            );
          })}
          {graph.nodes.map(renderNode)}
        </svg>
      </div>
      <div className="workflow-canvas-legend">
        <span><i className="workflow-legend-dot is-error" /> 错误</span>
        <span><i className="workflow-legend-dot is-warning" /> 警告</span>
        <span><i className="workflow-legend-line is-back" /> 回边（循环或自依赖）</span>
      </div>
    </div>
  );
}
