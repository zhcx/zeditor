import { parseDocumentReferences } from './documentAnalysis.ts';

export interface WorkspaceGraphFile {
  path: string;
  content: string;
}

export interface WorkspaceGraphNode {
  id: string;
  path: string;
  type: string;
}

export interface WorkspaceGraphEdge {
  source: string;
  target: string;
  label?: string;
  mode: 'link' | 'tip' | 'revision' | 'supertag' | 'pdf-card';
  broken: boolean;
}

export interface WorkspaceGraphSnapshot {
  nodes: WorkspaceGraphNode[];
  edges: WorkspaceGraphEdge[];
  generatedAt: number;
}

function normalizePath(path: string) {
  const parts: string[] = [];
  for (const part of path.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function fileType(path: string) {
  const extension = path.split('.').pop()?.toLowerCase();
  if (!extension) return 'other';
  if (['md', 'markdown', 'mdx'].includes(extension)) return 'markdown';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(extension)) return 'image';
  if (['pdf', 'doc', 'docx', 'txt', 'rtf'].includes(extension)) return 'document';
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'json', 'css'].includes(extension)) return 'code';
  return extension;
}

export function buildWorkspaceGraph(files: WorkspaceGraphFile[], generatedAt = Date.now()): WorkspaceGraphSnapshot {
  const normalizedFiles = files
    .map((file) => ({ path: normalizePath(file.path), content: file.content }))
    .filter((file, index, all) => file.path && all.findIndex((candidate) => candidate.path === file.path) === index)
    .sort((left, right) => left.path.localeCompare(right.path));
  const fileSet = new Set(normalizedFiles.map((file) => file.path));
  const nodes = normalizedFiles.map((file) => ({ id: file.path, path: file.path, type: fileType(file.path) }));
  const edges: WorkspaceGraphEdge[] = [];

  for (const file of normalizedFiles) {
    for (const reference of parseDocumentReferences(file.content, file.path)) {
      if (/^(?:[a-z]+:)?\/\//i.test(reference.targetPath)) continue;
      edges.push({
        source: file.path,
        target: reference.targetPath,
        label: reference.label,
        mode: reference.mode,
        broken: !fileSet.has(reference.targetPath),
      });
    }
  }

  return { nodes, edges, generatedAt };
}

export function getBacklinks(graph: WorkspaceGraphSnapshot, targetPath: string) {
  const normalizedTarget = normalizePath(targetPath);
  return graph.edges.filter((edge) => edge.target === normalizedTarget);
}

export function getBrokenLinks(graph: WorkspaceGraphSnapshot) {
  return graph.edges.filter((edge) => edge.broken);
}
