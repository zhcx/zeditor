import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useAppStore, type TimelineEntry } from '../../stores/appStore';
import {
  createOutlineDetectionKey,
  parseMarkdownHeadings,
  selectActiveDocumentContent,
  shouldAutoRevealOutline,
} from '../../utils/markdownOutline';
import { readStoredStringArray, writeStoredStringArray } from '../../utils/storage';
import { isTextFileName } from '../../utils/fileIcon';
import {
  OPENABLE_FILE_EXTENSIONS,
  isConvertibleDocumentName,
} from '../../utils/documentFormats';
import { FileTypeIcon } from './FileTypeIcon';
import { KnowledgeGraphPanel } from '../KnowledgeGraph/KnowledgeGraphPanel';
import { SuperTagPanel } from '../SuperTag/SuperTagPanel';

interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
  file?: File;
  directoryHandle?: FileSystemDirectoryHandle;
}

interface WorkspaceFolder {
  name: string;
  path: string;
  tree: FileNode[];
}

interface RawFileNode {
  name: string;
  path: string;
  is_directory?: boolean;
  isDirectory?: boolean;
  children?: RawFileNode[];
}

interface SidebarProps {
  style?: React.CSSProperties;
  view?: 'explorer' | 'search' | 'graph' | 'library';
}

type ContextMenuState = { x: number; y: number; node: FileNode; targetType: 'file' | 'folder' | 'root' } | null;
type FsClipboard = { sourcePath: string; operation: 'copy' | 'cut' } | null;
type TimelineHoverState = { entry: TimelineEntry; x: number; y: number } | null;
type TimelineDialogState = { entry: TimelineEntry; mode: 'preview' | 'diff' } | null;
type TimelineDiffLine = { kind: 'same' | 'added' | 'removed' | 'collapsed'; text: string };
type RenameState = { path: string; name: string } | null;
type CreateState = { parentPath: string; type: 'file' | 'folder' } | null;

interface RecentHistoryEntry {
  path: string;
  title: string;
  timestamp: number;
  type: 'file' | 'folder';
}

const OPEN_EDITORS_ID = 'virtual:open-editors';
const WORKSPACE_ROOTS_KEY = 'zeditor.workspace-roots';
const isTauriRuntime = () => '__TAURI_INTERNALS__' in window;
const isDirectOpenFile = isTextFileName;
// Keep this in sync with the desktop command. These are the file types offered
// by Zeditor in the workspace, rather than only files the editor can read.
const isConvertibleFile = isConvertibleDocumentName;
const replaceNodeChildren = (nodes: FileNode[], path: string, children: FileNode[]): FileNode[] => nodes.map(node => {
  if (node.path === path) return { ...node, children };
  return node.children ? { ...node, children: replaceNodeChildren(node.children, path, children) } : node;
});

const splitTimelineLines = (value: string) => value.split(/\r?\n/);

const buildTimelineDiff = (versionContent: string, currentContent: string): TimelineDiffLine[] => {
  const previous = splitTimelineLines(versionContent);
  const current = splitTimelineLines(currentContent);
  let prefix = 0;
  while (prefix < previous.length && prefix < current.length && previous[prefix] === current[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < previous.length - prefix
    && suffix < current.length - prefix
    && previous[previous.length - 1 - suffix] === current[current.length - 1 - suffix]
  ) suffix += 1;

  const lines: TimelineDiffLine[] = [];
  const context = 3;
  if (prefix > context) lines.push({ kind: 'collapsed', text: `… 前方 ${prefix - context} 行未变化 …` });
  for (let index = Math.max(0, prefix - context); index < prefix; index += 1) {
    lines.push({ kind: 'same', text: previous[index] });
  }

  const previousChanged = previous.slice(prefix, previous.length - suffix);
  const currentChanged = current.slice(prefix, current.length - suffix);
  if (previousChanged.length * currentChanged.length > 40000) {
    previousChanged.forEach(text => lines.push({ kind: 'removed', text }));
    currentChanged.forEach(text => lines.push({ kind: 'added', text }));
  } else {
    const table = Array.from({ length: previousChanged.length + 1 }, () => new Uint16Array(currentChanged.length + 1));
    for (let previousIndex = previousChanged.length - 1; previousIndex >= 0; previousIndex -= 1) {
      for (let currentIndex = currentChanged.length - 1; currentIndex >= 0; currentIndex -= 1) {
        table[previousIndex][currentIndex] = previousChanged[previousIndex] === currentChanged[currentIndex]
          ? table[previousIndex + 1][currentIndex + 1] + 1
          : Math.max(table[previousIndex + 1][currentIndex], table[previousIndex][currentIndex + 1]);
      }
    }
    let previousIndex = 0;
    let currentIndex = 0;
    while (previousIndex < previousChanged.length || currentIndex < currentChanged.length) {
      if (previousIndex < previousChanged.length && currentIndex < currentChanged.length && previousChanged[previousIndex] === currentChanged[currentIndex]) {
        lines.push({ kind: 'same', text: previousChanged[previousIndex] });
        previousIndex += 1;
        currentIndex += 1;
      } else if (currentIndex < currentChanged.length && (previousIndex === previousChanged.length || table[previousIndex][currentIndex + 1] >= table[previousIndex + 1][currentIndex])) {
        lines.push({ kind: 'added', text: currentChanged[currentIndex] });
        currentIndex += 1;
      } else {
        lines.push({ kind: 'removed', text: previousChanged[previousIndex] });
        previousIndex += 1;
      }
    }
  }

  for (let index = previous.length - suffix; index < Math.min(previous.length, previous.length - suffix + context); index += 1) {
    lines.push({ kind: 'same', text: previous[index] });
  }
  if (suffix > context) lines.push({ kind: 'collapsed', text: `… 后方 ${suffix - context} 行未变化 …` });
  return lines;
};

type DirectoryHandleWithEntries = FileSystemDirectoryHandle & {
  entries: () => AsyncIterableIterator<[string, FileSystemHandle]>;
};

const getFolderName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path;
const normalizeNode = (node: RawFileNode): FileNode => ({
  name: node.name,
  path: node.path,
  isDirectory: Boolean(node.isDirectory ?? node.is_directory),
  children: node.children?.map(normalizeNode),
});

function Chevron({ expanded }: { expanded: boolean }) {
  return <span className={`explorer-chevron ${expanded ? 'expanded' : ''}`} aria-hidden="true" />;
}

function FolderIcon({ open: isOpen = false }: { open?: boolean }) {
  return <span className={`explorer-icon folder-icon ${isOpen ? 'open' : ''}`} aria-hidden="true" />;
}

function ExplorerActionIcon({ type }: { type: 'newFile' | 'openFile' | 'openFolder' }) {
  if (type === 'newFile') {
    return <svg className="explorer-action-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>;
  }
  if (type === 'openFile') {
    return <svg className="explorer-action-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.8h5l3 3v9.4H4zM9 1.8v3.3h3M6 8h4M6 10.5h4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  }
  return (
    <svg className="explorer-action-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M1.75 4.25h4.1l1.4 1.5h7v6.5H1.75z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FileIcon({ filename }: { filename: string }) {
  return <FileTypeIcon filename={filename} />;
}

function SearchSidebar({ style }: SidebarProps) {
  const { openFile } = useAppStore();
  const [query, setQuery] = useState('');
  const [replaceWith, setReplaceWith] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [extensions, setExtensions] = useState('md,markdown,txt');
  const [ignoreDirs, setIgnoreDirs] = useState('.git,node_modules,target,dist');
  const [results, setResults] = useState<Array<{ path: string; line_number: number; column: number; line: string }>>([]);
  const [diffs, setDiffs] = useState<Array<{ path: string; replacements: number; diff: string }>>([]);
  const [status, setStatus] = useState('');
  const [searching, setSearching] = useState(false);
  const searchSequence = useRef(0);
  const [history, setHistory] = useState<string[]>(() => readStoredStringArray('zeditor.workspace-search-history'));

  const options = (applyReplace = false) => ({
    roots: readStoredStringArray(WORKSPACE_ROOTS_KEY), query,
    caseSensitive, useRegex,
    extensions: extensions.split(',').map(value => value.trim()).filter(Boolean),
    ignoreDirs: ignoreDirs.split(',').map(value => value.trim()).filter(Boolean),
    replaceWith: replaceWith || undefined, applyReplace,
  });

  const runSearch = async (applyReplace = false) => {
    if (!query.trim()) return;
    const currentRequest = ++searchSequence.current;
    setSearching(true); setStatus('');
    try {
      if (!isTauriRuntime()) throw new Error('工作区搜索仅在桌面应用中可用');
      const response = await invoke<{ matches: typeof results; diffs: typeof diffs; scanned_files: number; truncated: boolean; applied: boolean }>('workspace_search', { options: options(applyReplace) });
      if (currentRequest !== searchSequence.current) return;
      setResults(response.matches); setDiffs(response.diffs);
      setStatus(`${response.scanned_files} 个文件，${response.matches.length} 处匹配${response.truncated ? '（结果已截断）' : ''}${response.applied ? '；替换已写入' : ''}`);
      const next = [query, ...history.filter(item => item !== query)].slice(0, 12);
      setHistory(next); writeStoredStringArray('zeditor.workspace-search-history', next);
    } catch (error) { setStatus(String(error)); } finally { setSearching(false); }
  };

  const openResult = async (result: typeof results[number]) => {
    await openFile(result.path);
    window.setTimeout(() => {
      const view = useAppStore.getState().editorView; if (!view) return;
      const line = view.state.doc.line(Math.min(result.line_number, view.state.doc.lines));
      view.dispatch({ selection: { anchor: Math.min(line.from + result.column - 1, line.to) }, scrollIntoView: true }); view.focus();
    }, 0);
  };

  return (
    <aside className="sidebar search-sidebar" style={style}>
      <div className="sidebar-surface">
        <header className="vscode-explorer-header"><span>搜索</span></header>
        <div className="document-search-panel">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void runSearch(); }}
            placeholder="搜索工作区"
            aria-label="搜索工作区"
            autoFocus
          />
          <input value={replaceWith} onChange={(event) => setReplaceWith(event.target.value)} placeholder="替换为（先生成 Diff）" aria-label="替换为" />
          <div className="document-search-options">
            <label><input type="checkbox" checked={caseSensitive} onChange={event => setCaseSensitive(event.target.checked)} /> 区分大小写</label>
            <label><input type="checkbox" checked={useRegex} onChange={event => setUseRegex(event.target.checked)} /> 正则</label>
          </div>
          <input value={extensions} onChange={event => setExtensions(event.target.value)} placeholder="文件类型，如 md,ts" aria-label="文件类型筛选" />
          <input value={ignoreDirs} onChange={event => setIgnoreDirs(event.target.value)} placeholder="忽略目录，如 node_modules" aria-label="忽略目录" />
          <div className="document-search-actions"><button onClick={() => void runSearch()} disabled={searching}>{searching ? '搜索中…' : '搜索'}</button><button onClick={() => { searchSequence.current += 1; setSearching(false); setStatus('已取消显示结果'); }}>取消</button>{replaceWith && <button onClick={() => void runSearch(false)} disabled={searching}>预览 Diff</button>}{diffs.length > 0 && <button onClick={() => { if (window.confirm(`确认写入 ${diffs.length} 个文件的替换？`)) void runSearch(true); }} disabled={searching}>确认替换</button>}</div>
          {history.length > 0 && <div className="document-search-history">历史：{history.map(item => <button key={item} onClick={() => setQuery(item)}>{item}</button>)}</div>}
          {status && <div className="document-search-count">{status}</div>}
          {query.trim() ? (
            <div className="document-search-results" role="list">
              {results.map((result) => (
                <button key={`${result.path}-${result.line_number}-${result.column}`} className="document-search-result" onClick={() => void openResult(result)} role="listitem">
                  <strong>{getFolderName(result.path)}</strong>
                  <small>{result.path} · 第 {result.line_number} 行，第 {result.column} 列</small>
                  <span>{result.line || '空行'}</span>
                </button>
              ))}
              {diffs.map(diff => <pre className="document-search-diff" key={diff.path}>{diff.diff}</pre>)}
              {!results.length && !diffs.length && !searching && <div className="explorer-empty-state">没有匹配结果</div>}
            </div>
          ) : <div className="document-search-empty">输入关键词，在已打开的工作区中递归搜索。</div>}
        </div>
      </div>
    </aside>
  );
}

export function Sidebar({ style, view = 'explorer' }: SidebarProps) {
  if (view === 'graph') return <KnowledgeGraphPanel style={style} />;
  if (view === 'library') return <SuperTagPanel style={style} />;
  return view === 'search' ? <SearchSidebar style={style} /> : <ExplorerSidebar style={style} />;
}

function ExplorerSidebar({ style }: SidebarProps) {
  const {
    sidebarVisible,
    outlineVisible,
    setOutlineVisible,
    content,
    settings,
    openFile,
    convertDocument,
    tabs,
    activeTabId,
    currentFile,
    timeline,
    restoreTimelineEntry,
    deleteTimelineEntry,
    cleanupTimeline,
  } = useAppStore();
  const [workspaceFolders, setWorkspaceFolders] = useState<WorkspaceFolder[]>([]);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set([OPEN_EDITORS_ID]));
  const [loadedFolders, setLoadedFolders] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const [timelineHover, setTimelineHover] = useState<TimelineHoverState>(null);
  const [timelineDialog, setTimelineDialog] = useState<TimelineDialogState>(null);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [recentHistory, setRecentHistory] = useState<RecentHistoryEntry[]>([]);
  const [renaming, setRenaming] = useState<RenameState>(null);
  const [creating, setCreating] = useState<CreateState>(null);
  const [renameValue, setRenameValue] = useState('');
  const [fsClipboard, setFsClipboard] = useState<FsClipboard>(null);
  const knownTreeSizeRef = useRef(new Map<string, number>());
  const activeTimeline = activeTabId ? timeline[activeTabId] || [] : [];
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const outlineContent = selectActiveDocumentContent(tabs, activeTabId, content);
  const headings = useMemo(() => parseMarkdownHeadings(outlineContent), [outlineContent]);
  const hasOutlineHeadings = headings.length > 0;
  const outlineDetectionKey = createOutlineDetectionKey(activeTabId, hasOutlineHeadings);
  const previousOutlineDetectionKey = useRef<string | null>(null);

  useEffect(() => {
    const shouldReveal = shouldAutoRevealOutline(
      previousOutlineDetectionKey.current,
      outlineDetectionKey,
      hasOutlineHeadings,
      outlineVisible,
    );
    previousOutlineDetectionKey.current = outlineDetectionKey;
    if (shouldReveal) setOutlineVisible(true);
  }, [hasOutlineHeadings, outlineDetectionKey, outlineVisible, setOutlineVisible]);

  useEffect(() => {
    cleanupTimeline();
  }, [cleanupTimeline]);

  const readBrowserFolder = useCallback(async (handle: FileSystemDirectoryHandle, parentPath: string): Promise<FileNode[]> => {
    const entries: FileNode[] = [];
    const fileReads: Array<Promise<FileNode>> = [];
    for await (const [name, entry] of (handle as DirectoryHandleWithEntries).entries()) {
      const path = `${parentPath}/${name}`;
      if (entry.kind === 'directory') {
        entries.push({ name, path, isDirectory: true, children: [], directoryHandle: entry as FileSystemDirectoryHandle });
      } else if (isDirectOpenFile(name) || isConvertibleFile(name)) {
        fileReads.push((entry as FileSystemFileHandle).getFile().then((file) => ({ name, path, isDirectory: false, file })));
        if (fileReads.length >= 32) entries.push(...await Promise.all(fileReads.splice(0)));
      }
    }
    entries.push(...await Promise.all(fileReads));
    return entries.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
  }, []);

  const readFolder = useCallback(async (folderPath: string) => {
    const tree = await invoke<RawFileNode[]>('read_folder', { path: folderPath });
    return (tree || []).map(normalizeNode);
  }, []);

  const addWorkspaceFolder = useCallback(async (folderPath: string, browserHandle?: FileSystemDirectoryHandle) => {
    if (workspaceFolders.some((folder) => folder.path === folderPath)) {
      setExpandedNodes(previous => new Set(previous).add(folderPath));
      return;
    }
    try {
      const tree = browserHandle
        ? await readBrowserFolder(browserHandle, folderPath)
        : await readFolder(folderPath);
      setWorkspaceFolders(previous => previous.some((folder) => folder.path === folderPath)
        ? previous
        : [...previous, { name: browserHandle?.name || getFolderName(folderPath), path: folderPath, tree }]);
      if (tree.length > 0) knownTreeSizeRef.current.set(folderPath, tree.length);
      if (!folderPath.startsWith('web://')) {
        const roots = readStoredStringArray(WORKSPACE_ROOTS_KEY);
        if (!roots.includes(folderPath)) writeStoredStringArray(WORKSPACE_ROOTS_KEY, [...roots, folderPath]);
      }
      setLoadedFolders(previous => new Set(previous).add(folderPath));
      setExpandedNodes(previous => new Set(previous).add(folderPath));
    } catch (error) {
      console.error('Failed to load folder contents:', error);
    }
  }, [readBrowserFolder, readFolder, workspaceFolders]);

  // ── 历史记录管理 ──────────────────────────────────────────
  const HISTORY_KEY = 'zeditor.explorer-history';
  const loadHistory = useCallback(() => {
    try {
      const stored = localStorage.getItem(HISTORY_KEY);
      if (!stored) return [];
      const parsed: RecentHistoryEntry[] = JSON.parse(stored);
      const retentionMs = settings.explorer.history_retention_days * 24 * 60 * 60 * 1000;
      const cutoff = Date.now() - retentionMs;
      return parsed.filter(entry => entry.timestamp > cutoff).slice(0, 50);
    } catch { return []; }
  }, [settings.explorer.history_retention_days]);

  const addToHistory = useCallback((path: string, title: string, type: 'file' | 'folder') => {
    const entries = loadHistory();
    const filtered = entries.filter(entry => entry.path !== path);
    filtered.unshift({ path, title, timestamp: Date.now(), type });
    const trimmed = filtered.slice(0, 50);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed)); } catch { /* ignore */ }
    setRecentHistory(trimmed);
  }, [loadHistory]);

  // Load history on mount and when settings change
  useEffect(() => {
    const timer = window.setTimeout(() => setRecentHistory(loadHistory()), 0);
    return () => window.clearTimeout(timer);
  }, [loadHistory]);

  useEffect(() => {
    const activeTab = tabs.find(tab => tab.id === activeTabId);
    if (!activeTab?.path) return;
    void invoke('update_recent_file', { path: activeTab.path, title: activeTab.title }).catch(() => undefined);
    queueMicrotask(() => addToHistory(activeTab.path as string, activeTab.title, 'file'));
  }, [activeTabId, tabs, addToHistory]);

  useEffect(() => {
    if (!currentFile || currentFile.startsWith('web://')) return;
    const parent = currentFile.replace(/[\\/][^\\/]+$/, '');
    if (parent && !workspaceFolders.some((folder) => folder.path === parent)) {
      queueMicrotask(() => {
        void addWorkspaceFolder(parent);
      });
    }
  }, [addWorkspaceFolder, currentFile, workspaceFolders]);

  // ── 内联重命名 ──────────────────────────────────────────
  const startRenaming = (path: string, currentName: string) => {
    setRenaming({ path, name: currentName });
    setRenameValue(currentName);
    setContextMenu(null);
    setCreating(null);
  };

  const commitRename = async () => {
    if (!renaming || !renameValue.trim()) { setRenaming(null); return; }
    const parent = renaming.path.substring(0, renaming.path.length - renaming.name.length);
    const newPath = `${parent}${renameValue.trim()}`;
    if (newPath === renaming.path) { setRenaming(null); return; }
    try {
      if (isTauriRuntime()) {
        await invoke('rename_fs_item', { oldPath: renaming.path, newPath });
      }
      // Refresh the parent folder
      const parentDir = renaming.path.replace(/[\\/][^\\/]+$/, '');
      void refreshWorkspaceFolder(parentDir);
    } catch (error) {
      console.error('重命名失败:', error);
    }
    setRenaming(null);
  };

  // ── 创建文件/文件夹 ──────────────────────────────────────
  const startCreating = (parentPath: string, type: 'file' | 'folder') => {
    setCreating({ parentPath, type });
    setRenameValue('');
    setContextMenu(null);
    setRenaming(null);
  };

  const commitCreate = async () => {
    if (!creating || !renameValue.trim()) { setCreating(null); return; }
    const newPath = `${creating.parentPath}/${renameValue.trim()}`;
    try {
      if (isTauriRuntime()) {
        if (creating.type === 'file') {
          await invoke('create_file', { path: newPath, content: '' });
        } else {
          await invoke('create_directory', { path: newPath });
        }
      }
      void refreshWorkspaceFolder(creating.parentPath);
    } catch (error) {
      console.error('创建失败:', error);
    }
    setCreating(null);
  };

  // ── 删除 ────────────────────────────────────────────────
  const deleteFsItem = async (path: string) => {
    const name = path.split(/[\\/]/).pop() || '项目';
    if (!window.confirm(`确定要删除「${name}」吗？此操作不可撤销。`)) return;
    try {
      if (isTauriRuntime()) {
        await invoke('delete_fs_item', { path });
      }
      const parentDir = path.replace(/[\\/][^\\/]+$/, '');
      void refreshWorkspaceFolder(parentDir);
    } catch (error) {
      console.error('删除失败:', error);
    }
    setContextMenu(null);
  };

  // ── 刷新文件夹 ──────────────────────────────────────────
  const refreshWorkspaceFolder = useCallback(async (folderPath: string) => {
    try {
      const tree = await invoke<RawFileNode[]>('read_folder', { path: folderPath });
      const normalized = (tree || []).map(normalizeNode);
      if (normalized.length === 0) return;
      setWorkspaceFolders(previous => {
        // 如果 folderPath 直接匹配某个工作区根路径，直接替换整棵树
        const rootMatch = previous.find(f => f.path === folderPath);
        if (rootMatch) {
          return previous.map(f => f.path === folderPath ? { ...f, tree: normalized } : f);
        }
        // 否则作为子目录刷新，找到包含该路径的工作区根，替换其子孙节点
        return previous.map(folder =>
          folder.path === folderPath || folderPath.startsWith(folder.path + '/') || folderPath.startsWith(folder.path + '\\')
            ? { ...folder, tree: replaceNodeChildren(folder.tree, folderPath, normalized) }
            : folder
        );
      });
    } catch (error) {
      console.error('刷新文件夹失败:', error);
    }
  }, []);

  // ── 自动刷新（Polling） ──────────────────────────────────
  const refreshIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const refreshVersionRef = useRef(0);

  useEffect(() => {
    if (!settings.explorer.auto_refresh) {
      if (refreshIntervalRef.current) { clearInterval(refreshIntervalRef.current); refreshIntervalRef.current = null; }
      return;
    }
    const intervalMs = Math.max(1000, settings.explorer.refresh_interval_seconds * 1000);
    refreshIntervalRef.current = setInterval(async () => {
      const foldersToRefresh = workspaceFolders
        .filter(f => expandedNodes.has(f.path))
        .map(f => f.path);
      if (foldersToRefresh.length === 0) return;
      const version = ++refreshVersionRef.current;
      for (const folderPath of foldersToRefresh) {
        if (version !== refreshVersionRef.current) break;
        const tree = await invoke<RawFileNode[]>('read_folder', { path: folderPath }).catch(() => null);
        if (!tree || version !== refreshVersionRef.current) continue;
        const normalized = (tree || []).map(normalizeNode);
        if (normalized.length === 0 && (knownTreeSizeRef.current.get(folderPath) ?? 0) > 0) continue;
        if (normalized.length > 0) knownTreeSizeRef.current.set(folderPath, normalized.length);
        setWorkspaceFolders(previous => previous.map(f => f.path === folderPath
          ? { ...f, tree: normalized }
          : f
        ));
      }
    }, intervalMs);
    return () => { if (refreshIntervalRef.current) clearInterval(refreshIntervalRef.current); };
  }, [settings.explorer.auto_refresh, settings.explorer.refresh_interval_seconds, workspaceFolders, expandedNodes]);

  // ── 监听 store 刷新事件 ─────────────────────────────────
  useEffect(() => {
    const onReset = () => {
      setWorkspaceFolders([]);
      setExpandedNodes(new Set([OPEN_EDITORS_ID]));
      setLoadedFolders(new Set());
      // Re-add workspace roots from localStorage
      const roots = readStoredStringArray(WORKSPACE_ROOTS_KEY);
      for (const root of roots) { void addWorkspaceFolder(root); }
    };
    const onRefresh = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.path) {
        refreshWorkspaceFolder(detail.path);
      }
    };
    window.addEventListener('zeditor-reset-explorer', onReset);
    window.addEventListener('zeditor-refresh-folder', onRefresh as EventListener);
    return () => {
      window.removeEventListener('zeditor-reset-explorer', onReset);
      window.removeEventListener('zeditor-refresh-folder', onRefresh as EventListener);
    };
  }, [addWorkspaceFolder, refreshWorkspaceFolder]);

  // ── 关闭右键菜单（点击菜单外部时关闭）────────────────────
  useEffect(() => {
    const close = (event: MouseEvent) => {
      // 点击在菜单内部时不关闭，让 button 的 click 事件正常触发
      if ((event.target as HTMLElement)?.closest('.context-menu')) return;
      setContextMenu(null);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  // ── 屏蔽资源管理器区域的浏览器原生右键菜单 ────────────────
  const explorerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = explorerRef.current;
    if (!el) return;
    const prevent = (event: MouseEvent) => {
      // Allow our custom context menu to handle it
      if ((event.target as HTMLElement)?.closest('.context-menu')) return;
      event.preventDefault();
    };
    el.addEventListener('contextmenu', prevent);
    return () => el.removeEventListener('contextmenu', prevent);
  }, []);

  // ── 复制路径 ─────────────────────────────────────────────
  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
    } catch { /* 部分环境下剪贴板不可用 */ }
    setContextMenu(null);
  };

  // ── 在文件管理器中显示 ───────────────────────────────────
  const revealInFileManager = (path: string) => {
    if (isTauriRuntime()) {
      void invoke('reveal_in_file_manager', { path });
    }
    setContextMenu(null);
  };

  // ── 系统剪贴板 (文件操作) ────────────────────────────────
  const copyToClipboard = (path: string) => {
    setFsClipboard({ sourcePath: path, operation: 'copy' });
    setContextMenu(null);
  };

  const cutToClipboard = (path: string) => {
    setFsClipboard({ sourcePath: path, operation: 'cut' });
    setContextMenu(null);
  };

  const pasteFromClipboard = async (targetDir: string) => {
    if (!fsClipboard) return;
    setContextMenu(null);
    const sourceName = fsClipboard.sourcePath.split(/[\\/]/).pop() || 'item';
    const destPath = `${targetDir}/${sourceName}`;
    try {
      if (fsClipboard.operation === 'cut') {
        // 如果目标路径与源相同，跳过
        if (fsClipboard.sourcePath === destPath) { setFsClipboard(null); return; }
        await invoke('rename_fs_item', { oldPath: fsClipboard.sourcePath, newPath: destPath });
      } else {
        await invoke('copy_fs_item', { source: fsClipboard.sourcePath, destination: destPath });
      }
      setFsClipboard(null);
      void refreshWorkspaceFolder(targetDir);
    } catch (error) {
      console.error('粘贴失败:', error);
    }
  };

  const getClipboardLabel = () => {
    if (!fsClipboard) return '';
    const name = fsClipboard.sourcePath.split(/[\\/]/).pop() || '';
    return fsClipboard.operation === 'cut' ? `粘贴 ${name} (剪切)` : `粘贴 ${name}`;
  };

  const toggleExpanded = (path: string) => {
    setExpandedNodes(previous => {
      const next = new Set(previous);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const toggleFolder = async (node: FileNode) => {
    if (expandedNodes.has(node.path)) {
      toggleExpanded(node.path);
      return;
    }
    setExpandedNodes(previous => new Set(previous).add(node.path));
    if (loadedFolders.has(node.path)) return;
    try {
      const children = node.directoryHandle
        ? await readBrowserFolder(node.directoryHandle, node.path)
        : await readFolder(node.path);
      setWorkspaceFolders(previous => previous.map((folder) => ({
        ...folder,
        tree: replaceNodeChildren(folder.tree, node.path, children || []),
      })));
      setLoadedFolders(previous => new Set(previous).add(node.path));
    } catch (error) {
      console.error('Failed to load folder children:', error);
    }
  };

  const openTreeFile = async (node: FileNode) => {
    if (node.file && isDirectOpenFile(node.name)) {
      useAppStore.getState().addTab({ path: node.path, title: node.name, content: await node.file.text(), modified: false });
    } else if (isDirectOpenFile(node.name)) {
      await openFile(node.path);
    } else if (node.file) {
      // Browser folders have no native file path, so conversion must run in the
      // desktop application where the optional Zeditor converter module is available.
      window.alert('文件转换仅在桌面应用中可用，请使用桌面版打开此文件夹。');
    } else {
      try {
      await convertDocument(node.path);
      } catch {
        // convertDocument already sets the error status and message via the store.
        // Nothing else to do here — the folder state remains intact.
      }
    }
  };

  const scrollToHeading = (line: number) => {
    const { editorView } = useAppStore.getState();
    if (!editorView) return;
    const position = editorView.state.doc.line(line).from;
    editorView.dispatch({ selection: { anchor: position }, scrollIntoView: true });
    editorView.focus();
  };

  const handleOpenFolder = async () => {
    try {
      if (!isTauriRuntime()) {
        const picker = (window as Window & { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
        if (!picker) throw new Error('请使用最新版 Chrome 或 Edge 选择文件夹。');
        const handle = await picker();
        const path = `web://${handle.name}`;
        await addWorkspaceFolder(path, handle);
        return;
      }
      const selected = await open({ directory: true, multiple: true });
      if (selected) {
        for (const folderPath of (Array.isArray(selected) ? selected : [selected])) {
          const path = folderPath as string;
          await addWorkspaceFolder(path);
          addToHistory(path, getFolderName(path), 'folder');
        }
      }
    } catch (error) {
      console.error('Failed to open folder:', error);
    }
  };

  const handleOpenFile = async () => {
    try {
      const selected = await open({
        filters: [{ name: '可编辑文本与可转换文档', extensions: OPENABLE_FILE_EXTENSIONS }],
        multiple: true,
      });
      if (!selected) return;
      for (const path of (Array.isArray(selected) ? selected : [selected])) await openFile(path as string);
      setExpandedNodes(previous => new Set(previous).add(OPEN_EDITORS_ID));
    } catch (error) {
      console.error('Failed to open file:', error);
    }
  };

  const renderNodes = (nodes: FileNode[], depth = 0) => nodes.map(node => {
    const expanded = expandedNodes.has(node.path);
    const active = currentFile === node.path;
    return (
      <div key={node.path} role="treeitem" aria-expanded={node.isDirectory ? expanded : undefined}>
        <button
          className={`explorer-row ${node.isDirectory ? 'folder-row' : 'file-row'} ${active ? 'active' : ''}`}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          onClick={() => node.isDirectory ? void toggleFolder(node) : void openTreeFile(node)}
          onContextMenu={event => {
            event.preventDefault();
            setContextMenu({
              x: event.clientX,
              y: event.clientY,
              node,
              targetType: node.isDirectory ? (depth === 0 ? 'root' : 'folder') : 'file',
            });
          }}
          title={`${node.path}${!node.isDirectory && !isDirectOpenFile(node.name) ? '\n点击即可转换为 Markdown' : ''}`}
        >
          {node.isDirectory ? <Chevron expanded={expanded} /> : <span className="explorer-chevron-spacer" />}
          {node.isDirectory ? <FolderIcon open={expanded} /> : <FileIcon filename={node.name} />}
          <span className="explorer-name">{node.name}</span>
        </button>
        {node.isDirectory && expanded && (
          <div role="group" className="explorer-children">
            {node.children?.length ? renderNodes(node.children, depth + 1) : (
              <div className="explorer-empty-folder" style={{ paddingLeft: `${38 + depth * 14}px` }}>空文件夹</div>
            )}
          </div>
        )}
      </div>
    );
  });

  if (!sidebarVisible && !outlineVisible) return null;

  const openEditorsExpanded = expandedNodes.has(OPEN_EDITORS_ID);

  return (
    <aside className="sidebar explorer-sidebar vscode-explorer" ref={explorerRef} style={style}>
      <div className="sidebar-surface">
        <header className="vscode-explorer-header">
          <span>资源管理器</span>
          <div className="vscode-explorer-actions">
            <button onClick={() => { useAppStore.getState().addTab(); setExpandedNodes(previous => new Set(previous).add(OPEN_EDITORS_ID)); }} title="新建文件" aria-label="新建文件"><ExplorerActionIcon type="newFile" /></button>
            <button onClick={() => void handleOpenFile()} title="打开文件" aria-label="打开文件"><ExplorerActionIcon type="openFile" /></button>
            <button onClick={() => void handleOpenFolder()} title="打开文件夹" aria-label="打开文件夹"><ExplorerActionIcon type="openFolder" /></button>
          </div>
        </header>

        <div className="vscode-explorer-tree" role="tree" aria-label="资源管理器">
          <section className="explorer-section">
            <button className="explorer-section-heading" onClick={() => toggleExpanded(OPEN_EDITORS_ID)}>
              <Chevron expanded={openEditorsExpanded} />
              <span>打开的编辑器</span>
              <span className="explorer-count">{tabs.length}</span>
            </button>
            {openEditorsExpanded && (
              <div role="group">
                {tabs.length ? tabs.map(tab => (
                  <button
                    key={tab.id}
                    className={`explorer-row file-row open-editor-row ${tab.id === activeTabId ? 'active' : ''}`}
                    style={{ paddingLeft: 12 }}
                    onClick={() => useAppStore.getState().setActiveTab(tab.id)}
                    title={tab.path || tab.title}
                  >
                    <span className="explorer-chevron-spacer" aria-hidden="true" />
                    <FileIcon filename={tab.title} />
                    <span className="explorer-name">{tab.title}</span>
                    {tab.modified && <span className="explorer-dirty" title="未保存更改" />}
                    <span
                      className="explorer-close"
                      role="button"
                      aria-label="关闭编辑器"
                      onClick={event => { event.stopPropagation(); useAppStore.getState().closeTab(tab.id); }}
                    >×</span>
                  </button>
                )) : <div className="explorer-empty-state">没有打开的编辑器</div>}
              </div>
            )}
          </section>

          <section className="explorer-section workspace-section">
            {workspaceFolders.length ? workspaceFolders.map((folder) => {
              const expanded = expandedNodes.has(folder.path);
              return (
                <div key={folder.path} className="workspace-folder-root" role="treeitem" aria-expanded={expanded}>
                  <button
                    className="explorer-section-heading workspace-heading"
                    onClick={() => toggleExpanded(folder.path)}
                    title={folder.path}
                  >
                    <Chevron expanded={expanded} />
                    <FolderIcon open={expanded} />
                    <span className="explorer-name">{folder.name}</span>
                  </button>
                  {expanded && <div role="group" className="explorer-list">{renderNodes(folder.tree)}</div>}
                </div>
              );
            }) : (
              <>
                <div className="explorer-section-heading workspace-heading" role="heading" aria-level={2}>
                  <Chevron expanded />
                  <span>无打开的文件夹</span>
                </div>
                <div className="workspace-empty-state">
                  <p>尚未打开文件夹。</p>
                  <button className="open-workspace-button" onClick={() => void handleOpenFolder()}>打开文件夹</button>
                  <p className="workspace-hint">可一次选择多个文件夹，也可再次点击文件夹按钮继续添加。</p>
                </div>
              </>
            )}
          </section>

          <section className="explorer-section outline-section">
            <button className="explorer-section-heading" onClick={() => setOutlineVisible(!outlineVisible)}>
              <Chevron expanded={outlineVisible} />
              <span>大纲</span>
              {headings.length > 0 && <span className="explorer-count">{headings.length}</span>}
            </button>
            {outlineVisible && (
              <div role="group" className="outline-explorer-list">
                {headings.length ? headings.map((heading, index) => (
                  <button
                    key={`${heading.line}-${index}`}
                    className="outline-explorer-row"
                    style={{ paddingLeft: `${24 + (heading.level - 1) * 12}px` }}
                    onClick={() => scrollToHeading(heading.line)}
                    title={heading.text}
                  >
                    <span className="outline-level">H{heading.level}</span>
                    <span>{heading.text}</span>
                  </button>
                )) : <div className="explorer-empty-state">当前文档没有标题</div>}
              </div>
            )}
          </section>

          <section className="explorer-section history-section">
            <button className="explorer-section-heading" onClick={() => setHistoryExpanded(expanded => !expanded)}>
              <Chevron expanded={historyExpanded} />
              <span>近期记录</span>
              {recentHistory.length > 0 && <span className="explorer-count">{recentHistory.length}</span>}
            </button>
            {historyExpanded && (
              <div role="group" className="history-explorer-list">
                {recentHistory.length ? recentHistory.map(entry => (
                  <button
                    key={`${entry.type}-${entry.path}-${entry.timestamp}`}
                    className="explorer-row file-row history-row"
                    style={{ paddingLeft: 12 }}
                    onClick={() => {
                      if (entry.type === 'file') {
                        void openFile(entry.path);
                      } else {
                        if (!workspaceFolders.some(f => f.path === entry.path)) {
                          void addWorkspaceFolder(entry.path);
                        }
                        setExpandedNodes(prev => new Set(prev).add(entry.path));
                      }
                    }}
                    onContextMenu={event => {
                      event.preventDefault();
                      setContextMenu({
                        x: event.clientX,
                        y: event.clientY,
                        node: { name: entry.title, path: entry.path, isDirectory: entry.type === 'folder' },
                        targetType: entry.type === 'folder' ? 'folder' : 'file',
                      });
                    }}
                    title={entry.path}
                  >
                    <span className="explorer-chevron-spacer" aria-hidden="true" />
                    {entry.type === 'folder' ? <FolderIcon /> : <FileIcon filename={entry.title} />}
                    <span className="explorer-name">{entry.title}</span>
                    <small className="history-time">
                      {new Date(entry.timestamp).toLocaleDateString([], { month: '2-digit', day: '2-digit' })}
                    </small>
                  </button>
                )) : <div className="explorer-empty-state">近期打开的文件和文件夹将显示在此处</div>}
              </div>
            )}
          </section>

          <section className="explorer-section timeline-section">
            <button className="explorer-section-heading" onClick={() => setTimelineExpanded(expanded => !expanded)}>
              <Chevron expanded={timelineExpanded} />
              <span>时间线</span>
              {activeTab && <span className="timeline-file-name">{activeTab.title}</span>}
              {activeTimeline.length > 0 && <span className="explorer-count">{activeTimeline.length}</span>}
            </button>
            {timelineExpanded && (
              <div role="group" className="timeline-explorer-list">
                {activeTimeline.length ? activeTimeline.map(entry => (
                  <div
                    key={entry.id}
                    className="timeline-explorer-row"
                    onClick={() => setTimelineDialog({ entry, mode: 'preview' })}
                    onMouseEnter={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      setTimelineHover({
                        entry,
                        x: Math.min(rect.right + 8, window.innerWidth - 350),
                        y: Math.min(rect.top, window.innerHeight - 220),
                      });
                    }}
                    onMouseLeave={() => setTimelineHover(null)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setTimelineDialog({ entry, mode: 'preview' });
                      }
                    }}
                    aria-label={`${entry.operation || entry.label}，打开版本详情`}
                  >
                    <span className="timeline-version-icon" aria-hidden="true" />
                    <span className="timeline-entry-text">
                      <strong>{entry.label}</strong>
                      <small>{new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · {entry.content.length} 字符</small>
                    </span>
                    <span className="timeline-row-actions" aria-label="版本操作">
                      <button onClick={(event) => { event.stopPropagation(); setTimelineDialog({ entry, mode: 'diff' }); }} title="与当前内容对比" aria-label="与当前内容对比">≠</button>
                      <button onClick={(event) => { event.stopPropagation(); if (activeTabId) restoreTimelineEntry(activeTabId, entry.id); }} title="恢复此版本" aria-label="恢复此版本">↶</button>
                      <button onClick={(event) => { event.stopPropagation(); if (activeTabId) deleteTimelineEntry(activeTabId, entry.id); }} title="删除此记录" aria-label="删除此记录">×</button>
                    </span>
                  </div>
                )) : <div className="explorer-empty-state">编辑后将在此保留版本记录</div>}
              </div>
            )}
          </section>
        </div>
      </div>

      {timelineHover && (
        <div className="timeline-operation-popover" role="tooltip" style={{ left: timelineHover.x, top: timelineHover.y }}>
          <div className="timeline-popover-heading">本地编辑</div>
          <div className="timeline-popover-time">
            {new Date(timelineHover.entry.timestamp).toLocaleString()} · {timelineHover.entry.content.length} 字符
          </div>
          <div className="timeline-popover-operation">{timelineHover.entry.operation || timelineHover.entry.label}</div>
          <div className="timeline-popover-hint">点击查看版本；可预览、对比、恢复或删除。</div>
        </div>
      )}

      {timelineDialog && activeTabId && (
        <div className="timeline-version-overlay" role="presentation" onMouseDown={() => setTimelineDialog(null)}>
          <section className="timeline-version-dialog" role="dialog" aria-modal="true" aria-label="历史版本详情" onMouseDown={(event) => event.stopPropagation()}>
            <header className="timeline-version-dialog-header">
              <div>
                <strong>历史版本</strong>
                <small>{new Date(timelineDialog.entry.timestamp).toLocaleString()} · {timelineDialog.entry.content.length} 字符</small>
              </div>
              <button onClick={() => setTimelineDialog(null)} title="关闭" aria-label="关闭">×</button>
            </header>
            <div className="timeline-version-operation">{timelineDialog.entry.operation || timelineDialog.entry.label}</div>
            <div className="timeline-version-tabs">
              <button className={timelineDialog.mode === 'preview' ? 'active' : ''} onClick={() => setTimelineDialog(dialog => dialog ? { ...dialog, mode: 'preview' } : dialog)}>版本预览</button>
              <button className={timelineDialog.mode === 'diff' ? 'active' : ''} onClick={() => setTimelineDialog(dialog => dialog ? { ...dialog, mode: 'diff' } : dialog)}>与当前对比</button>
            </div>
            {timelineDialog.mode === 'preview' ? (
              <pre className="timeline-version-content">{timelineDialog.entry.content || '（空文档）'}</pre>
            ) : (
              <div className="timeline-diff-content" aria-label="当前内容差异">
                {buildTimelineDiff(timelineDialog.entry.content, activeTab?.content ?? content).map((line, index) => (
                  <div key={`${line.kind}-${index}`} className={`timeline-diff-line ${line.kind}`}>
                    <span>{line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : line.kind === 'collapsed' ? '…' : ' '}</span>
                    <code>{line.text || ' '}</code>
                  </div>
                ))}
              </div>
            )}
            <footer className="timeline-version-actions">
              <button className="timeline-delete-action" onClick={() => { deleteTimelineEntry(activeTabId, timelineDialog.entry.id); setTimelineDialog(null); }}>删除记录</button>
              <span />
              <button onClick={() => setTimelineDialog(null)}>取消</button>
              <button className="timeline-restore-action" onClick={() => { restoreTimelineEntry(activeTabId, timelineDialog.entry.id); setTimelineDialog(null); }}>恢复此版本</button>
            </footer>
          </section>
        </div>
      )}

      {contextMenu && (
        <div className="context-menu" style={{ position: 'fixed', top: contextMenu.y, left: contextMenu.x, zIndex: 1000 }} onClick={event => event.stopPropagation()}>
          {/* ── 顶部操作 ── */}
          {contextMenu.targetType === 'file' && (
            <button className="context-menu-item" onClick={() => { void openTreeFile(contextMenu.node); setContextMenu(null); }}>
              打开文件
            </button>
          )}
          {contextMenu.targetType !== 'file' && (
            <button className="context-menu-item" onClick={() => {
              if (!expandedNodes.has(contextMenu.node.path)) { void toggleFolder(contextMenu.node); }
              setContextMenu(null);
            }}>
              {expandedNodes.has(contextMenu.node.path) ? '折叠文件夹' : '展开文件夹'}
            </button>
          )}

          <div className="context-menu-divider" />

          {/* ── 新建 ── */}
          {contextMenu.targetType !== 'file' && (
            <>
              <button className="context-menu-item" onClick={() => { startCreating(contextMenu.node.path, 'file'); }}>
                新建文件
              </button>
              <button className="context-menu-item" onClick={() => { startCreating(contextMenu.node.path, 'folder'); }}>
                新建文件夹
              </button>
              <div className="context-menu-divider" />
            </>
          )}
          {contextMenu.targetType === 'file' && (
            <>
              <button className="context-menu-item" onClick={() => {
                const parentDir = contextMenu.node.path.replace(/[\\/][^\\/]+$/, '');
                startCreating(parentDir, 'folder');
              }}>
                新建文件夹
              </button>
              <div className="context-menu-divider" />
            </>
          )}

          {/* ── 复制 / 剪切 / 粘贴 ── */}
          <button className="context-menu-item" onClick={() => { copyToClipboard(contextMenu.node.path); }}>
            复制
          </button>
          <button className="context-menu-item" onClick={() => { cutToClipboard(contextMenu.node.path); }}>
            剪切
          </button>
          {contextMenu.targetType !== 'file' && fsClipboard && (
            <button className="context-menu-item" onClick={() => { void pasteFromClipboard(contextMenu.node.path); }}>
              {getClipboardLabel()}
            </button>
          )}

          <div className="context-menu-divider" />

          {/* ── 路径 / 资源管理器 ── */}
          <button className="context-menu-item" onClick={() => { void copyPath(contextMenu.node.path); }}>
            复制路径
          </button>
          <button className="context-menu-item" onClick={() => { revealInFileManager(contextMenu.node.path); }}>
            在资源管理器中打开
          </button>

          <div className="context-menu-divider" />

          {/* ── 重命名 / 刷新 / 删除 ── */}
          <button className="context-menu-item" onClick={() => { startRenaming(contextMenu.node.path, contextMenu.node.name); }}>
            重命名
          </button>
          {(contextMenu.targetType === 'folder' || contextMenu.targetType === 'root') && (
            <button className="context-menu-item" onClick={() => {
              void refreshWorkspaceFolder(contextMenu.node.path);
              setContextMenu(null);
            }}>
              刷新
            </button>
          )}
          <button className="context-menu-item danger" onClick={() => { void deleteFsItem(contextMenu.node.path); }}>
            删除
          </button>
        </div>
      )}

      {renaming && (
        <div className="inline-rename-overlay" onClick={() => setRenaming(null)}>
          <div className="inline-rename-dialog" onClick={event => event.stopPropagation()}>
            <input
              autoFocus
              value={renameValue}
              onChange={event => setRenameValue(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') void commitRename();
                if (event.key === 'Escape') setRenaming(null);
              }}
              placeholder="输入新名称"
            />
            <div className="inline-rename-actions">
              <button onClick={() => setRenaming(null)}>取消</button>
              <button onClick={() => void commitRename()}>确认</button>
            </div>
          </div>
        </div>
      )}

      {creating && (
        <div className="inline-rename-overlay" onClick={() => setCreating(null)}>
          <div className="inline-rename-dialog" onClick={event => event.stopPropagation()}>
            <input
              autoFocus
              value={renameValue}
              onChange={event => setRenameValue(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') void commitCreate();
                if (event.key === 'Escape') setCreating(null);
              }}
              placeholder={creating.type === 'file' ? '输入文件名 (如: 笔记.md)' : '输入文件夹名'}
            />
            <div className="inline-rename-actions">
              <button onClick={() => setCreating(null)}>取消</button>
              <button onClick={() => void commitCreate()}>确认</button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
