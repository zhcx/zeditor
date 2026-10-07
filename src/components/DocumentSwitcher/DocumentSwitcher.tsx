import { AppIcon } from '../Icons/AppIcon';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore, type Tab } from '../../stores/appStore';
import { filterOpenDocuments } from '../../utils/workbenchNavigation';
import { readStoredStringArray } from '../../utils/storage';
import {
  parentDirectoryOf,
  readRecentHistory,
  type RecentHistoryEntry,
} from '../../utils/recentHistory';
import { formatShortcut } from '../../utils/platformShortcuts';
import { FileTypeIcon } from '../Sidebar/FileTypeIcon';
import './document-switcher.css';
import { t } from '../../i18n';

interface DocumentSwitcherProps {
  onClose: () => void;
  /** 「搜索当前文档」命令需要把侧边栏切到搜索视图，该状态由 App 持有，故以回调注入。 */
  onRevealActivityView?: (view: 'explorer' | 'search') => void;
}

/** 快捷命令：复用应用里已有的动作（store 方法或既有 CustomEvent），不另造一套处理链。 */
interface QuickCommand {
  id: string;
  label: string;
  shortcut?: string;
  run: () => void;
}

interface WorkspaceSearchMatch {
  path: string;
  line_number: number;
  column: number;
  line: string;
}

interface WorkspaceSearchDiff {
  path: string;
  replacements: number;
  diff: string;
}

interface WorkspaceSearchResponse {
  matches: WorkspaceSearchMatch[];
  diffs: WorkspaceSearchDiff[];
  files: string[];
  scanned_files: number;
  truncated: boolean;
  applied: boolean;
}

/** 已打开文档（含未保存修改）正文里的命中：完全在前端内存中检索，零延迟、零磁盘 IO。 */
interface DocumentContentHit {
  tabId: string;
  title: string;
  line: number;
  column: number;
  text: string;
}

interface DropdownPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

interface ContentGroup {
  path: string;
  matches: WorkspaceSearchMatch[];
  total: number;
}

interface WorkspaceSearchState {
  fingerprint: string;
  matches: WorkspaceSearchMatch[];
  files: string[];
  scannedFiles: number;
  truncated: boolean;
  error: string;
}

interface DiffState {
  fingerprint: string;
  diffs: WorkspaceSearchDiff[];
  applied: boolean;
}

type SwitchRow =
  | { kind: 'command'; key: string; command: QuickCommand }
  | { kind: 'recent'; key: string; entry: RecentHistoryEntry }
  | { kind: 'document'; key: string; tab: Tab }
  | { kind: 'docContent'; key: string; hit: DocumentContentHit }
  | { kind: 'file'; key: string; path: string }
  | { kind: 'match'; key: string; match: WorkspaceSearchMatch };

interface DropdownSearchOptions {
  roots: string[];
  query: string;
  caseSensitive: boolean;
  useRegex: boolean;
  extensions: string[];
  ignoreDirs: string[];
}

const WORKSPACE_ROOTS_KEY = 'zeditor.workspace-roots';
// 工作区内容检索会遍历目录并读取文件，保留最小长度与防抖，避免刚输入就整盘扫描。
const MIN_WORKSPACE_QUERY = 2;
const SEARCH_DEBOUNCE_MS = 320;
const MAX_MATCHES_PER_FILE = 5;
const MAX_MATCH_ROWS = 60;
// 各分组的展示上限：即时层（打开的文档）优先，磁盘检索结果按预算截断。
const MAX_DOC_CONTENT_ROWS = 30;
const MAX_FILE_ROWS = 40;
const MAX_COMMAND_ROWS = 12;
const MAX_RECENT_ROWS = 8;
// 单个文档只扫描前 1MB：打开超大文件时仍能保证每次输入瞬间出结果。
const MAX_DOC_CONTENT_CHARS = 1_000_000;

const isTauriRuntime = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// 标题栏的搜索入口就是下拉的锚点，面板始终贴在它下方而不是屏幕正中。
const getTrigger = () => document.querySelector<HTMLElement>('.titlebar-command-center');

// 与入口等宽但不小于 320px、不大于 520px，并夹在视口内；入口被响应式隐藏时退回水平居中。
function measure(): DropdownPosition {
  const rect = getTrigger()?.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const width = Math.min(520, Math.max(rect?.width ?? 0, 320), viewportWidth - 16);
  const center = rect?.width ? rect.left + rect.width / 2 : viewportWidth / 2;
  const left = Math.min(Math.max(center - width / 2, 8), Math.max(8, viewportWidth - width - 8));
  const top = rect?.height ? rect.bottom + 6 : 44;
  return { top, left, width, maxHeight: Math.max(340, window.innerHeight - top - 12) };
}

function splitList(value: string): string[] {
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** 已打开文档的切分缓存：键为标签页 id，内容变化时自动失效。 */
const docLineCache = new Map<string, { content: string; lines: string[] }>();

/**
 * 在「已打开文档的内存正文」里找命中行。
 * 这是「搜索正在编辑的内容」唯一正确的数据源：尚未保存的修改也一定搜得到，
 * 而且完全在前端内存中完成，每敲一个键都能瞬间出结果，不碰磁盘、不受预算限制。
 * 用 indexOf 而非正则，避免大文档上的正则开销造成输入卡顿。
 */
function findDocumentContentHits(tabs: Tab[], query: string, caseSensitive: boolean): DocumentContentHit[] {
  if (!query) return [];
  const needle = caseSensitive ? query : query.toLowerCase();
  const hits: DocumentContentHit[] = [];
  // 每敲一个键都重新切分大文档会明显掉帧；内容未变时复用上次切分结果，并顺带清理已关闭文档。
  const liveIds = new Set(tabs.map(tab => tab.id));
  for (const id of docLineCache.keys()) {
    if (!liveIds.has(id)) docLineCache.delete(id);
  }
  for (const tab of tabs) {
    if (!tab.content) continue;
    let cached = docLineCache.get(tab.id);
    if (!cached || cached.content !== tab.content) {
      const scanned = tab.content.length > MAX_DOC_CONTENT_CHARS ? tab.content.slice(0, MAX_DOC_CONTENT_CHARS) : tab.content;
      cached = { content: tab.content, lines: scanned.split('\n') };
      docLineCache.set(tab.id, cached);
    }
    const lines = cached.lines;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const haystack = caseSensitive ? line : line.toLowerCase();
      const column = haystack.indexOf(needle);
      if (column < 0) continue;
      hits.push({ tabId: tab.id, title: tab.title, line: index + 1, column: column + 1, text: line });
      if (hits.length >= MAX_DOC_CONTENT_ROWS) return hits;
    }
  }
  return hits;
}

function groupMatchesByPath(matches: WorkspaceSearchMatch[]): ContentGroup[] {
  const byPath = new Map<string, WorkspaceSearchMatch[]>();
  for (const match of matches) {
    const bucket = byPath.get(match.path);
    if (bucket) bucket.push(match);
    else byPath.set(match.path, [match]);
  }
  return [...byPath].map(([path, group]) => ({ path, matches: group, total: group.length }));
}

// 单文件只展示前若干条，并按总量截断，避免上千条匹配把下拉撑爆。
function limitGroups(groups: ContentGroup[]): ContentGroup[] {
  const limited: ContentGroup[] = [];
  let budget = MAX_MATCH_ROWS;
  for (const group of groups) {
    if (budget <= 0) break;
    const take = Math.min(MAX_MATCHES_PER_FILE, group.matches.length, budget);
    limited.push({ path: group.path, matches: group.matches.slice(0, take), total: group.total });
    budget -= take;
  }
  return limited;
}

// Rust 端 WorkspaceSearchOptions 是 snake_case，且 serde 只原样匹配嵌套结构体字段
// （Tauri 仅转换命令的顶层参数名），camelCase 会被判为缺失字段，这里统一做键名转换。
// replace_with 传 null 表示 Option::None，缺省该字段反而会反序列化失败。
function toWorkspaceSearchPayload(options: DropdownSearchOptions, replaceWith: string | null, applyReplace: boolean) {
  return {
    roots: options.roots,
    query: options.query,
    case_sensitive: options.caseSensitive,
    use_regex: options.useRegex,
    extensions: options.extensions,
    ignore_dirs: options.ignoreDirs,
    replace_with: replaceWith,
    apply_replace: applyReplace,
  };
}

export function DocumentSwitcher({ onClose, onRevealActivityView }: DocumentSwitcherProps) {
  const tabs = useAppStore(state => state.tabs);
  const activeTabId = useAppStore(state => state.activeTabId);
  const language = useAppStore(state => state.settings.appearance.language);
  const historyRetentionDays = useAppStore(state => state.settings.explorer.history_retention_days);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [extensions, setExtensions] = useState('');
  const [ignoreDirs, setIgnoreDirs] = useState('');
  const [replaceWith, setReplaceWith] = useState('');
  // 首次渲染时入口已经挂载，直接测量即可避免在 effect 里再触发一次渲染。
  const [position, setPosition] = useState<DropdownPosition>(measure);
  const [workspaceSearch, setWorkspaceSearch] = useState<WorkspaceSearchState | null>(null);
  const [diffState, setDiffState] = useState<DiffState | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const searchSequence = useRef(0);
  const workspaceRoots = useMemo(() => readStoredStringArray(WORKSPACE_ROOTS_KEY).filter(root => !root.startsWith('web://')), []);
  const canSearchWorkspace = isTauriRuntime() && workspaceRoots.length > 0;
  const trimmedQuery = query.trim();
  // 与 VS Code 一致：输入 `>` 进入命令模式，只列出快捷命令。
  const commandMode = trimmedQuery.startsWith('>');
  const commandQuery = commandMode ? trimmedQuery.slice(1).trim().toLowerCase() : '';
  const searchOptions = useMemo<DropdownSearchOptions>(() => ({
    roots: workspaceRoots,
    query: trimmedQuery,
    caseSensitive,
    useRegex,
    extensions: splitList(extensions),
    ignoreDirs: splitList(ignoreDirs),
  }), [workspaceRoots, trimmedQuery, caseSensitive, useRegex, extensions, ignoreDirs]);
  // 指纹把「输入 + 高级选项」压成一次比较：只有与当前输入一致的结果才参与渲染，
  // 因此换关键词时旧结果会立刻失效，无需在 effect 里清空状态。
  const fingerprint = useMemo(() => JSON.stringify(searchOptions), [searchOptions]);
  const activeSearch = workspaceSearch?.fingerprint === fingerprint ? workspaceSearch : null;
  const activeDiffs = diffState?.fingerprint === fingerprint ? diffState.diffs : [];
  const contentGroups = useMemo(() => groupMatchesByPath(activeSearch?.matches ?? []), [activeSearch]);
  const visibleGroups = useMemo(() => limitGroups(contentGroups), [contentGroups]);
  // 快捷命令：全部指向应用里已有的动作（store 方法或既有 CustomEvent），
  // 标签与快捷键沿用「文件 / 功能」菜单的用词，保证与菜单一致。
  const commands = useMemo<QuickCommand[]>(() => [
    { id: 'new-file', label: t('新建文件', language), shortcut: 'Ctrl+N', run: () => useAppStore.getState().addTab() },
    { id: 'find-in-document', label: t('搜索当前文档', language), run: () => onRevealActivityView?.('search') },
    { id: 'check-links', label: t('检查链接', language), shortcut: 'Ctrl+Alt+V', run: () => window.dispatchEvent(new CustomEvent('zeditor-check-links')) },
    { id: 'ai-palette', label: t('AI 指令面板', language), shortcut: 'Ctrl+J', run: () => window.dispatchEvent(new CustomEvent('zeditor-ai-palette')) },
    { id: 'presentation', label: t('演示模式', language), run: () => window.dispatchEvent(new CustomEvent('zeditor-presentation-request')) },
    { id: 'mode-split', label: t('分屏模式', language), run: () => useAppStore.getState().setMode('split') },
    { id: 'mode-immersive', label: t('沉浸阅读', language), run: () => useAppStore.getState().setMode('immersive') },
    { id: 'mode-zen', label: t('沉浸写作', language), run: () => useAppStore.getState().setMode('zen') },
    { id: 'export-html', label: t('导出为 HTML', language), run: () => window.dispatchEvent(new CustomEvent('zeditor-export-request', { detail: { format: 'html' } })) },
    { id: 'export-word', label: t('导出为 Word', language), run: () => window.dispatchEvent(new CustomEvent('zeditor-export-request', { detail: { format: 'word' } })) },
    { id: 'settings', label: t('设置', language), run: () => useAppStore.getState().setSettingsOpen(true) },
  ], [language, onRevealActivityView]);
  // 空输入展示全部命令，输入 `>` 后按命令名过滤；正常搜索时不占用结果区。
  const visibleCommands = useMemo(() => {
    if (trimmedQuery && !commandMode) return [];
    const filtered = commandQuery
      ? commands.filter(command => command.label.toLowerCase().includes(commandQuery) || command.id.includes(commandQuery))
      : commands;
    return filtered.slice(0, MAX_COMMAND_ROWS);
  }, [commands, commandMode, commandQuery, trimmedQuery]);
  // 近期文件与侧边栏「近期记录」共用同一份 localStorage 数据；这里只取文件，打开文件夹仍走资源管理器。
  const recentFiles = useMemo(() => {
    if (trimmedQuery) return [];
    return readRecentHistory(historyRetentionDays)
      .filter(entry => entry.type === 'file')
      .slice(0, MAX_RECENT_ROWS);
  }, [trimmedQuery, historyRetentionDays]);
  const documents = useMemo(() => {
    if (commandMode) return [];
    const matched = filterOpenDocuments(tabs, query);
    return trimmedQuery ? matched : [...matched].sort((left, right) => Number(right.id === activeTabId) - Number(left.id === activeTabId));
  }, [tabs, query, trimmedQuery, activeTabId, commandMode]);
  // 即时层：打开文档的正文明文命中（含未保存内容），不依赖后端、不做预算截断。
  const docContentHits = useMemo(
    () => (!commandMode && trimmedQuery ? findDocumentContentHits(tabs, trimmedQuery, caseSensitive) : []),
    [tabs, trimmedQuery, caseSensitive, commandMode],
  );
  // 文件名命中也来自后端的内存匹配结果，首次遍历后同样接近即时。
  const workspaceFiles = useMemo(() => (activeSearch?.files ?? []).slice(0, MAX_FILE_ROWS), [activeSearch]);
  // 键盘上下键在「快捷命令 + 近期文件 + 打开的文档 + 文档内容 + 工作区文件 + 工作区内容」同一条扁平轨道上移动。
  const rows = useMemo<SwitchRow[]>(() => [
    ...visibleCommands.map(command => ({ kind: 'command' as const, key: `cmd:${command.id}`, command })),
    ...recentFiles.map(entry => ({ kind: 'recent' as const, key: `recent:${entry.path}`, entry })),
    ...documents.map(tab => ({ kind: 'document' as const, key: `doc:${tab.id}`, tab })),
    ...docContentHits.map(hit => ({ kind: 'docContent' as const, key: `content:${hit.tabId}:${hit.line}:${hit.column}`, hit })),
    ...workspaceFiles.map(path => ({ kind: 'file' as const, key: `file:${path}`, path })),
    ...visibleGroups.flatMap(group => group.matches.map(match => ({
      kind: 'match' as const,
      key: `match:${match.path}\u0000${match.line_number}\u0000${match.column}`,
      match,
    }))),
  ], [visibleCommands, recentFiles, documents, docContentHits, workspaceFiles, visibleGroups]);
  // 文档内容命中按文档分组展示（各文档的命中在数组里本就是连续的）。
  const docContentGroups = useMemo(() => {
    const byTab = new Map<string, DocumentContentHit[]>();
    for (const hit of docContentHits) {
      const bucket = byTab.get(hit.tabId);
      if (bucket) bucket.push(hit);
      else byTab.set(hit.tabId, [hit]);
    }
    return [...byTab].map(([tabId, hits]) => ({ tabId, hits }));
  }, [docContentHits]);
  // 行的扁平下标统一由 key 反查，避免各分组各自算偏移出错。
  const rowIndexOf = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((row, index) => map.set(row.key, index));
    return map;
  }, [rows]);
  const rowIndex = (key: string) => rowIndexOf.get(key) ?? 0;
  const selectedIndex = Math.min(activeIndex, Math.max(0, rows.length - 1));
  const selected = rows[selectedIndex];
  const workspaceSearchEnabled = !commandMode && canSearchWorkspace && trimmedQuery.length >= MIN_WORKSPACE_QUERY;
  const searching = workspaceSearchEnabled && !activeSearch;
  // 位置没变就不要 setState：滚动/窗口变化会高频触发，每次都新建对象会让整个面板反复重渲染。
  const place = useCallback(() => {
    setPosition(current => {
      const next = measure();
      const unchanged = current.top === next.top && current.left === next.left
        && current.width === next.width && current.maxHeight === next.maxHeight;
      return unchanged ? current : next;
    });
  }, []);

  useLayoutEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [place]);

  // 点击面板和标题栏入口之外的位置收起；入口自身交回给切换事件处理开合。
  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target || panelRef.current?.contains(target) || target.closest('.titlebar-command-center')) return;
      onClose();
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [onClose]);

  useEffect(() => {
    panelRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected?.key]);

  const runWorkspaceSearch = useCallback(async () => {
    if (!canSearchWorkspace || searchOptions.query.length < MIN_WORKSPACE_QUERY) return;
    const request = ++searchSequence.current;
    try {
      const response = await invoke<WorkspaceSearchResponse>('workspace_search', {
        options: toWorkspaceSearchPayload(searchOptions, null, false),
      });
      if (request !== searchSequence.current) return;
      setWorkspaceSearch({ fingerprint, matches: response.matches, files: response.files, scannedFiles: response.scanned_files, truncated: response.truncated, error: '' });
    } catch (error) {
      if (request !== searchSequence.current) return;
      setWorkspaceSearch({ fingerprint, matches: [], files: [], scannedFiles: 0, truncated: false, error: String(error) });
    }
  }, [canSearchWorkspace, searchOptions, fingerprint]);

  // 输入停顿后再检索工作区内容，避免每个字符都整盘扫描。
  useEffect(() => {
    if (!workspaceSearchEnabled) return undefined;
    const timer = window.setTimeout(() => { void runWorkspaceSearch(); }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [workspaceSearchEnabled, runWorkspaceSearch]);

  const runReplaceSearch = useCallback(async (applyReplace: boolean) => {
    if (!canSearchWorkspace || searchOptions.query.length < MIN_WORKSPACE_QUERY || !replaceWith) return;
    const request = ++searchSequence.current;
    try {
      const response = await invoke<WorkspaceSearchResponse>('workspace_search', {
        options: toWorkspaceSearchPayload(searchOptions, replaceWith, applyReplace),
      });
      if (request !== searchSequence.current) return;
      setDiffState({ fingerprint, diffs: response.diffs, applied: response.applied });
      setWorkspaceSearch({ fingerprint, matches: response.matches, files: response.files, scannedFiles: response.scanned_files, truncated: response.truncated, error: '' });
      // 写入后重新检索一次，让列表反映替换后的真实内容。
      if (applyReplace) await runWorkspaceSearch();
    } catch (error) {
      if (request !== searchSequence.current) return;
      setWorkspaceSearch({ fingerprint, matches: [], files: [], scannedFiles: 0, truncated: false, error: String(error) });
      setDiffState(null);
    }
  }, [canSearchWorkspace, searchOptions, fingerprint, replaceWith, runWorkspaceSearch]);

  const confirmReplace = () => {
    if (!replaceWith) return;
    const matches = activeSearch?.matches.length ?? 0;
    if (!window.confirm(`${t('确认替换', language)}：${matches} ${t('处匹配', language)}`)) return;
    void runReplaceSearch(true);
  };

  // 收起时把焦点交还给入口，避免焦点落回页面根节点导致后续快捷键失效。
  const dismiss = () => {
    onClose();
    const previous = previousFocusRef.current;
    previousFocusRef.current = null;
    const target = previous?.isConnected ? previous : getTrigger();
    requestAnimationFrame(() => target?.focus({ preventScroll: true }));
  };

  const openDocument = (id: string) => {
    useAppStore.getState().setActiveTab(id);
    onClose();
    requestAnimationFrame(() => useAppStore.getState().editorView?.focus());
  };

  // 打开磁盘文件并定位到行列；命中行可能来自「工作区文件」（只有路径）或「工作区内容」。
  const revealLocation = async (path: string, lineNumber: number, column: number) => {
    try {
      await useAppStore.getState().openFile(path);
    } catch {
      return; // store 已经给出打开失败的原因。
    }
    onClose();
    window.setTimeout(() => {
      const state = useAppStore.getState();
      const view = state.editorView;
      if (!view || state.currentFile !== path) return;
      const line = view.state.doc.line(Math.min(lineNumber, view.state.doc.lines));
      view.dispatch({ selection: { anchor: Math.min(line.from + column - 1, line.to) }, scrollIntoView: true });
      view.focus();
    }, 0);
  };

  // 命中已打开文档的正文：直接切到该标签页并定位，内容已在内存里，不读磁盘。
  const openDocumentContent = (hit: DocumentContentHit) => {
    useAppStore.getState().setActiveTab(hit.tabId);
    onClose();
    window.setTimeout(() => {
      const state = useAppStore.getState();
      const view = state.editorView;
      // 编辑器尚未切到目标标签页时不要定位，否则会把光标跳到错误的文档里。
      if (!view || state.activeTabId !== hit.tabId) return;
      const line = view.state.doc.line(Math.min(hit.line, view.state.doc.lines));
      view.dispatch({ selection: { anchor: Math.min(line.from + hit.column - 1, line.to) }, scrollIntoView: true });
      view.focus();
    }, 0);
  };

  // 打开近期文件：只打开并聚焦编辑器，不强制把光标放到首行。
  const openRecentFile = async (path: string) => {
    try {
      await useAppStore.getState().openFile(path);
    } catch {
      return; // store 已经给出打开失败的原因。
    }
    onClose();
    requestAnimationFrame(() => useAppStore.getState().editorView?.focus());
  };

  // 命令执行后立即收起面板，把焦点交还给工作区。
  const runCommand = (command: QuickCommand) => {
    dismiss();
    command.run();
  };

  const activateRow = (row: SwitchRow) => {
    if (row.kind === 'command') runCommand(row.command);
    else if (row.kind === 'recent') void openRecentFile(row.entry.path);
    else if (row.kind === 'document') openDocument(row.tab.id);
    else if (row.kind === 'docContent') openDocumentContent(row.hit);
    else if (row.kind === 'file') void revealLocation(row.path, 1, 1);
    else void revealLocation(row.match.path, row.match.line_number, row.match.column);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    // 输入法组合阶段保留候选选择与确认，不触发文档导航或后台快捷键。
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
      event.stopPropagation();
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      event.stopPropagation();
      if (event.key.toLowerCase() === 'p') { event.preventDefault(); dismiss(); }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); dismiss();
      return;
    }
    // 高级选项里的输入框保留各自的默认键位（光标、Tab 跳格）。
    if (event.target !== inputRef.current) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (rows.length) setActiveIndex((selectedIndex + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (selected) activateRow(selected);
    }
  };

  // 点到标题、路径等非交互区域时把焦点留在搜索框，保持「边输边选」的连续感。
  const handlePanelMouseDown = (event: React.MouseEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest('button, input, label, pre')) return;
    inputRef.current?.focus();
  };

  // 焦点离开面板（Tab 跳格或点到别处）时收起，点击面板内的非聚焦区域不受影响。
  const handlePanelBlur = (event: React.FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next && !event.currentTarget.contains(next)) onClose();
  };

  const hint = commandMode
    ? ''
    : !trimmedQuery
      ? t('输入关键词即可搜索已打开的文档与工作区文件内容', language)
      : trimmedQuery.length < MIN_WORKSPACE_QUERY
        ? t('输入至少 2 个字符以搜索工作区内容', language)
        : !isTauriRuntime()
          ? t('工作区搜索仅在桌面应用中可用', language)
          : !workspaceRoots.length
            ? t('请先在资源管理器中打开一个文件夹', language)
            : '';
  const workspaceStatus = searching
    ? t('搜索中…', language)
    : activeSearch?.error
      ? activeSearch.error
      : activeSearch
        ? `${activeSearch.scannedFiles} ${t('个文件', language)} · ${activeSearch.matches.length} ${t('处匹配', language)}${activeSearch.truncated ? ` · ${t('结果已截断', language)}` : ''}`
        : '';

  return createPortal(
    <section
      ref={panelRef}
      className="document-switcher"
      style={{ top: position.top, left: position.left, width: position.width, maxHeight: position.maxHeight }}
      onKeyDown={handleKeyDown}
      onBlur={handlePanelBlur}
      onMouseDown={handlePanelMouseDown}
    >
      <div className="document-switcher-search">
        <AppIcon name="search" size={16} />
        <input ref={inputRef} value={query} onChange={event => { setQuery(event.target.value); setActiveIndex(0); }} placeholder={t('搜索文档或文件内容…', language)} aria-label={t('搜索已打开的文档', language)} role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="document-switcher-results" aria-activedescendant={selected ? `switch-row-${selectedIndex}` : undefined} />
      </div>
      {hint && (
        <div className="document-switcher-hint">
          <span>{hint}</span>
          {!trimmedQuery && <span className="document-switcher-hint-tip">{t('输入 > 查看快捷命令', language)}</span>}
        </div>
      )}
      <div id="document-switcher-results" className="document-switcher-results" role="listbox" aria-label={t('已打开的文档', language)}>
        {/* 快捷命令：与「文件 / 功能」菜单同源的动作用词，右侧显示快捷键。 */}
        {visibleCommands.length > 0 && (
          <div className="document-switcher-group" role="group" aria-label={t('快捷命令', language)}>
            <div className="document-switcher-group-title">{t('快捷命令', language)}<span className="document-switcher-group-count">{visibleCommands.length}</span></div>
            {visibleCommands.map(command => {
              const index = rowIndex(`cmd:${command.id}`);
              return (
                <button key={command.id} id={`switch-row-${index}`} type="button" role="option" aria-selected={index === selectedIndex} tabIndex={-1} className="document-switcher-item document-switcher-command" onMouseEnter={() => setActiveIndex(index)} onClick={() => runCommand(command)}>
                  <span className="document-switcher-command-label">{command.label}</span>
                  {command.shortcut && <kbd className="document-switcher-shortcut">{formatShortcut(command.shortcut)}</kbd>}
                </button>
              );
            })}
          </div>
        )}
        {/* 近期文件：与侧边栏「近期记录」共用同一份 localStorage 数据。 */}
        {recentFiles.length > 0 && (
          <div className="document-switcher-group" role="group" aria-label={t('近期文件', language)}>
            <div className="document-switcher-group-title">{t('近期文件', language)}<span className="document-switcher-group-count">{recentFiles.length}</span></div>
            {recentFiles.map(entry => {
              const index = rowIndex(`recent:${entry.path}`);
              return (
                <button key={entry.path} id={`switch-row-${index}`} type="button" role="option" aria-selected={index === selectedIndex} tabIndex={-1} className="document-switcher-item document-switcher-recent" onMouseEnter={() => setActiveIndex(index)} onClick={() => void openRecentFile(entry.path)}>
                  <FileTypeIcon filename={entry.title} />
                  <span className="document-switcher-recent-title">{entry.title}</span>
                  <small className="document-switcher-recent-dir">{parentDirectoryOf(entry.path)}</small>
                </button>
              );
            })}
          </div>
        )}
        {documents.length > 0 && (
          <div className="document-switcher-group" role="group" aria-label={t('已打开的文档', language)}>
            <div className="document-switcher-group-title">{t('已打开的文档', language)}<span className="document-switcher-group-count">{documents.length}</span></div>
            {documents.map(tab => {
              const index = rowIndex(`doc:${tab.id}`);
              return (
                <button key={tab.id} id={`switch-row-${index}`} type="button" role="option" aria-selected={index === selectedIndex} tabIndex={-1} className="document-switcher-item" onMouseEnter={() => setActiveIndex(index)} onClick={() => openDocument(tab.id)}>
                  <FileTypeIcon filename={tab.title} />
                  <span className="document-switcher-document"><strong>{tab.path ? tab.title : t(tab.title, language)}</strong><small>{tab.path || t('尚未保存到文件', language)}</small></span>
                  {tab.modified && <span className="document-switcher-dirty" title={t('未保存修改', language)} aria-label={t('未保存修改', language)} />}
                  {tab.id === activeTabId && <span className="document-switcher-current">{t('当前', language)}</span>}
                </button>
              );
            })}
          </div>
        )}
        {/* 即时层：已打开文档的正文命中（含未保存修改），完全来自内存，输入即可见。 */}
        {docContentGroups.length > 0 && (
          <div className="document-switcher-group" role="group" aria-label={t('文档内容', language)}>
            <div className="document-switcher-group-title">{t('文档内容', language)}<span className="document-switcher-group-count">{docContentHits.length}</span></div>
            {docContentGroups.map(group => {
              const tab = tabs.find(item => item.id === group.tabId);
              return (
                <div className="document-switcher-file" key={group.tabId}>
                  <div className="document-switcher-file-title">
                    <FileTypeIcon filename={group.hits[0].title} />
                    <span className="document-switcher-file-name">{tab?.path ? tab.title : t(group.hits[0].title, language)}</span>
                    <small>{tab?.path || t('尚未保存到文件', language)}</small>
                    <span className="document-switcher-group-count">{group.hits.length}</span>
                  </div>
                  {group.hits.map(hit => {
                    const index = rowIndex(`content:${hit.tabId}:${hit.line}:${hit.column}`);
                    return (
                      <button key={`${hit.line}:${hit.column}`} id={`switch-row-${index}`} type="button" role="option" aria-selected={index === selectedIndex} tabIndex={-1} className="document-switcher-item document-switcher-match" onMouseEnter={() => setActiveIndex(index)} onClick={() => openDocumentContent(hit)}>
                        <span className="document-switcher-match-line">{hit.line}</span>
                        <span className="document-switcher-match-text">{hit.text.trim() || t('空行', language)}</span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
        {workspaceFiles.length > 0 && (
          <div className="document-switcher-group" role="group" aria-label={t('工作区文件', language)}>
            <div className="document-switcher-group-title">{t('工作区文件', language)}<span className="document-switcher-group-count">{workspaceFiles.length}</span></div>
            {workspaceFiles.map(path => {
              const index = rowIndex(`file:${path}`);
              return (
                <button key={path} id={`switch-row-${index}`} type="button" role="option" aria-selected={index === selectedIndex} tabIndex={-1} className="document-switcher-item" onMouseEnter={() => setActiveIndex(index)} onClick={() => void revealLocation(path, 1, 1)}>
                  <FileTypeIcon filename={path} />
                  <span className="document-switcher-document"><strong>{fileNameOf(path)}</strong><small>{path}</small></span>
                </button>
              );
            })}
          </div>
        )}
        {workspaceSearchEnabled && (
          <div className="document-switcher-group" role="group" aria-label={t('工作区内容', language)}>
            <div className="document-switcher-group-title">
              {t('工作区内容', language)}
              {workspaceStatus && <span className="document-switcher-group-status">{workspaceStatus}</span>}
            </div>
            {visibleGroups.map(group => (
              <div className="document-switcher-file" key={group.path}>
                <div className="document-switcher-file-title">
                  <FileTypeIcon filename={group.path} />
                  <span className="document-switcher-file-name">{fileNameOf(group.path)}</span>
                  <small>{group.path}</small>
                  <span className="document-switcher-group-count">{group.total}</span>
                </div>
                {group.matches.map(match => {
                  const index = rowIndex(`match:${match.path}\u0000${match.line_number}\u0000${match.column}`);
                  return (
                    <button key={`${match.line_number}:${match.column}`} id={`switch-row-${index}`} type="button" role="option" aria-selected={index === selectedIndex} tabIndex={-1} className="document-switcher-item document-switcher-match" onMouseEnter={() => setActiveIndex(index)} onClick={() => void revealLocation(match.path, match.line_number, match.column)}>
                      <span className="document-switcher-match-line">{match.line_number}</span>
                      <span className="document-switcher-match-text">{match.line.trim() || t('空行', language)}</span>
                    </button>
                  );
                })}
                {group.total > group.matches.length && <div className="document-switcher-match-more" aria-hidden="true">…<small>+{group.total - group.matches.length}</small></div>}
              </div>
            ))}
            {searching && <div className="document-switcher-empty">{t('搜索中…', language)}</div>}
            {!searching && activeSearch && !activeSearch.error && !activeSearch.matches.length && <div className="document-switcher-empty">{t('没有匹配结果', language)}</div>}
            {activeDiffs.map(diff => <pre className="document-switcher-diff" key={`diff:${diff.path}`}>{diff.diff}</pre>)}
            {diffState?.applied && diffState.fingerprint === fingerprint && <div className="document-switcher-applied">{t('替换已写入', language)}</div>}
          </div>
        )}
        {!rows.length && !workspaceSearchEnabled && (
          <div className="document-switcher-empty">{t('没有找到相关文档', language)}<small>{t('试试更短的关键词或部分路径', language)}</small></div>
        )}
      </div>
      {advancedOpen && (
        <div className="document-switcher-advanced">
          <div className="document-switcher-advanced-row">
            <label><input type="checkbox" checked={caseSensitive} onChange={event => { setCaseSensitive(event.target.checked); setActiveIndex(0); }} /> {t('区分大小写', language)}</label>
            <label><input type="checkbox" checked={useRegex} onChange={event => { setUseRegex(event.target.checked); setActiveIndex(0); }} /> {t('正则', language)}</label>
          </div>
          <input value={extensions} onChange={event => setExtensions(event.target.value)} placeholder={t('文件类型筛选', language)} aria-label={t('文件类型筛选', language)} />
          <input value={ignoreDirs} onChange={event => setIgnoreDirs(event.target.value)} placeholder={t('忽略目录', language)} aria-label={t('忽略目录', language)} />
          <div className="document-switcher-advanced-row">
            <input value={replaceWith} onChange={event => setReplaceWith(event.target.value)} placeholder={t('替换为', language)} aria-label={t('替换为', language)} />
            <button type="button" onClick={() => void runReplaceSearch(false)} disabled={!replaceWith || searching}>{t('预览 Diff', language)}</button>
            <button type="button" onClick={confirmReplace} disabled={!replaceWith || searching}>{t('确认替换', language)}</button>
          </div>
        </div>
      )}
      <footer className="document-switcher-footer">
        <span><kbd>↑</kbd><kbd>↓</kbd> {t('选择', language)} <kbd>Enter</kbd> {t('打开', language)} <kbd>Esc</kbd> {t('关闭', language)}</span>
        <button type="button" className="document-switcher-advanced-toggle" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen(open => !open)}>
          <AppIcon name="settings" size={13} />{t('高级选项', language)}
        </button>
      </footer>
    </section>, document.body,
  );
}
