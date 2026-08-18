import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../../stores/appStore';
import { readStoredStringArray } from '../../utils/storage';
import {
  buildWorkspaceGraph,
  getBacklinks,
  getBrokenLinks,
  type WorkspaceGraphFile,
  type WorkspaceGraphSnapshot,
} from '../../utils/knowledgeGraph';

interface KnowledgeGraphPanelProps {
  style?: CSSProperties;
}

const WORKSPACE_ROOTS_KEY = 'zeditor.workspace-roots';

const isMarkdown = (path: string) => /\.(?:md|markdown|mdx)$/i.test(path);
const normalizePath = (path: string) => path.replaceAll('\\', '/');
const shortPath = (path: string) => path.split(/[\\/]/).slice(-2).join('/');

function nodePosition(index: number, count: number) {
  const centerX = 160;
  const centerY = 145;
  const radius = Math.max(58, Math.min(120, count * 13));
  const angle = (Math.PI * 2 * index) / Math.max(count, 1) - Math.PI / 2;
  return { x: centerX + Math.cos(angle) * radius, y: centerY + Math.sin(angle) * radius };
}

export function KnowledgeGraphPanel({ style }: KnowledgeGraphPanelProps) {
  const { tabs, currentFile, openFile } = useAppStore();
  const [graph, setGraph] = useState<WorkspaceGraphSnapshot | null>(null);
  const [selectedPath, setSelectedPath] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('尚未加载图谱');
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setStatus('正在扫描工作区…');
    try {
      const roots = readStoredStringArray(WORKSPACE_ROOTS_KEY);
      let files: WorkspaceGraphFile[] = [];
      if ('__TAURI_INTERNALS__' in window && roots.length > 0) {
        await Promise.all(roots.map((root) => invoke('read_folder', { path: root })));
        const nextGraph = await invoke<WorkspaceGraphSnapshot>('build_workspace_graph', { roots });
        setGraph(nextGraph);
        setSelectedPath((current) => current && nextGraph.nodes.some((node) => node.id === current)
          ? current
          : normalizePath(currentFile || nextGraph.nodes[0]?.id || ''));
        setStatus(nextGraph.nodes.length + ' 个节点，' + nextGraph.edges.length + ' 条关系');
        return;
      }
      if (files.length === 0) {
        files = tabs
          .filter((tab) => tab.path && isMarkdown(tab.path))
          .map((tab) => ({ path: tab.path as string, content: tab.content }));
      }
      const nextGraph = buildWorkspaceGraph(files);
      setGraph(nextGraph);
      setSelectedPath((current) => current && nextGraph.nodes.some((node) => node.id === current)
        ? current
        : normalizePath(currentFile || nextGraph.nodes[0]?.id || ''));
      setStatus(nextGraph.nodes.length + ' 个节点，' + nextGraph.edges.length + ' 条关系');
    } catch (error) {
      setStatus(String(error));
    } finally {
      setLoading(false);
    }
  }, [currentFile, tabs]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const visibleNodes = useMemo(() => {
    if (!graph) return [];
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return graph.nodes;
    return graph.nodes.filter((node) => node.path.toLocaleLowerCase().includes(normalizedQuery));
  }, [graph, query]);

  const positions = useMemo(() => new Map(
    visibleNodes.map((node, index) => [node.id, nodePosition(index, visibleNodes.length)]),
  ), [visibleNodes]);

  const backlinks = graph && selectedPath ? getBacklinks(graph, selectedPath) : [];
  const brokenLinks = graph ? getBrokenLinks(graph) : [];
  const visibleIds = new Set(visibleNodes.map((node) => node.id));

  return (
    <aside className="sidebar knowledge-graph-sidebar" style={style}>
      <div className="sidebar-surface">
        <header className="vscode-explorer-header">
          <span>知识图谱</span>
          <button className="knowledge-graph-refresh" type="button" onClick={() => void refresh()} disabled={loading} title="刷新图谱">
            {loading ? '…' : '↻'}
          </button>
        </header>
        <div className="knowledge-graph-controls">
          <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="搜索节点或路径" aria-label="搜索图谱节点" />
          <span className="knowledge-graph-status">{status}</span>
        </div>
        {graph && visibleNodes.length > 0 ? (
          <>
            <svg className="knowledge-graph-canvas" viewBox="0 0 320 290" role="img" aria-label="工作区知识图谱">
              {graph.edges.map((edge, index) => {
                const source = positions.get(edge.source);
                const target = positions.get(edge.target);
                if (!source || !target || !visibleIds.has(edge.source) || !visibleIds.has(edge.target)) return null;
                return <line key={edge.source + '-' + edge.target + '-' + index} x1={source.x} y1={source.y} x2={target.x} y2={target.y} className={edge.broken ? 'knowledge-graph-edge broken' : 'knowledge-graph-edge'} />;
              })}
              {visibleNodes.map((node) => {
                const point = positions.get(node.id);
                if (!point) return null;
                const active = selectedPath === node.id || currentFile === node.id;
                return (
                  <g
                    key={node.id}
                    className={'knowledge-graph-node ' + (active ? 'active' : '')}
                    transform={'translate(' + point.x + ', ' + point.y + ')'}
                    onClick={() => { setSelectedPath(node.id); void openFile(node.path); }}
                    role="button"
                    tabIndex={0}
                    aria-label={'打开 ' + node.path}
                    onKeyDown={(event) => { if (event.key === 'Enter') { setSelectedPath(node.id); void openFile(node.path); } }}
                  >
                    <circle r={active ? 11 : 8} />
                    <text y={23} textAnchor="middle">{shortPath(node.path).slice(0, 22)}</text>
                  </g>
                );
              })}
            </svg>
            <section className="knowledge-graph-details">
              <h3>{selectedPath ? shortPath(selectedPath) : '选择一个节点'}</h3>
              {backlinks.length > 0 && (
                <div>
                  <strong>反向链接</strong>
                  {backlinks.map((edge, index) => (
                    <button key={edge.source + '-' + index} type="button" onClick={() => { setSelectedPath(edge.source); void openFile(edge.source); }}>
                      {shortPath(edge.source)}{edge.label ? ' · ' + edge.label : ''}
                    </button>
                  ))}
                </div>
              )}
              {brokenLinks.length > 0 && (
                <div className="knowledge-graph-broken">
                  <strong>断链 {brokenLinks.length}</strong>
                  {brokenLinks.slice(0, 8).map((edge, index) => <span key={edge.source + '-' + edge.target + '-' + index}>{shortPath(edge.source)} → {edge.target}</span>)}
                </div>
              )}
            </section>
          </>
        ) : (
          <div className="knowledge-graph-empty">
            <strong>暂无可用图谱</strong>
            <span>打开一个工作区或至少两个 Markdown 文件后刷新。</span>
          </div>
        )}
      </div>
    </aside>
  );
}
