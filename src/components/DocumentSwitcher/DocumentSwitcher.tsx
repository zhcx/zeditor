import { AppIcon } from '../Icons/AppIcon';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore, type Tab } from '../../stores/appStore';
import { filterOpenDocuments } from '../../utils/workbenchNavigation';
import { readStoredStringArray } from '../../utils/storage';
import { FileTypeIcon } from '../Sidebar/FileTypeIcon';
import './document-switcher.css';
import { t } from '../../i18n';

interface DocumentSwitcherProps {
  onClose: () => void;
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
  scanned_files: number;
  truncated: boolean;
  applied: boolean;
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
  | { kind: 'document'; key: string; tab: Tab }
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
  return { top, left, width, maxHeight: Math.max(240, window.innerHeight - top - 12) };
}

function splitList(value: string): string[] {
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path;
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

export function DocumentSwitcher({ onClose }: DocumentSwitcherProps) {
  const tabs = useAppStore(state => state.tabs);
  const activeTabId = useAppStore(state => state.activeTabId);
  const language = useAppStore(state => state.settings.appearance.language);
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
  const documents = useMemo(() => {
    const matched = filterOpenDocuments(tabs, query);
    return trimmedQuery ? matched : [...matched].sort((left, right) => Number(right.id === activeTabId) - Number(left.id === activeTabId));
  }, [tabs, query, trimmedQuery, activeTabId]);
  // 键盘上下键在「打开的文档 + 工作区内容」的同一条扁平轨道上移动。
  const rows = useMemo<SwitchRow[]>(() => [
    ...documents.map(tab => ({ kind: 'document' as const, key: `doc:${tab.id}`, tab })),
    ...visibleGroups.flatMap(group => group.matches.map(match => ({
      kind: 'match' as const,
      key: `match:${match.path}\u0000${match.line_number}\u0000${match.column}`,
      match,
    }))),
  ], [documents, visibleGroups]);
  const matchGroupOffsets = useMemo(() => {
    const offsets: number[] = [];
    let scanned = 0;
    for (const group of visibleGroups) { offsets.push(scanned); scanned += group.matches.length; }
    return offsets;
  }, [visibleGroups]);
  const selectedIndex = Math.min(activeIndex, Math.max(0, rows.length - 1));
  const selected = rows[selectedIndex];
  const workspaceSearchEnabled = canSearchWorkspace && trimmedQuery.length >= MIN_WORKSPACE_QUERY;
  const searching = workspaceSearchEnabled && !activeSearch;
  const place = useCallback(() => setPosition(measure()), []);

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
        options: { ...searchOptions, replaceWith: undefined, applyReplace: false },
      });
      if (request !== searchSequence.current) return;
      setWorkspaceSearch({ fingerprint, matches: response.matches, scannedFiles: response.scanned_files, truncated: response.truncated, error: '' });
    } catch (error) {
      if (request !== searchSequence.current) return;
      setWorkspaceSearch({ fingerprint, matches: [], scannedFiles: 0, truncated: false, error: String(error) });
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
        options: { ...searchOptions, replaceWith, applyReplace },
      });
      if (request !== searchSequence.current) return;
      setDiffState({ fingerprint, diffs: response.diffs, applied: response.applied });
      setWorkspaceSearch({ fingerprint, matches: response.matches, scannedFiles: response.scanned_files, truncated: response.truncated, error: '' });
      // 写入后重新检索一次，让列表反映替换后的真实内容。
      if (applyReplace) await runWorkspaceSearch();
    } catch (error) {
      if (request !== searchSequence.current) return;
      setWorkspaceSearch({ fingerprint, matches: [], scannedFiles: 0, truncated: false, error: String(error) });
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

  const openMatch = async (match: WorkspaceSearchMatch) => {
    try {
      await useAppStore.getState().openFile(match.path);
    } catch {
      return; // store 已经给出打开失败的原因。
    }
    onClose();
    window.setTimeout(() => {
      const state = useAppStore.getState();
      const view = state.editorView;
      if (!view || state.currentFile !== match.path) return;
      const line = view.state.doc.line(Math.min(match.line_number, view.state.doc.lines));
      view.dispatch({ selection: { anchor: Math.min(line.from + match.column - 1, line.to) }, scrollIntoView: true });
      view.focus();
    }, 0);
  };

  const activateRow = (row: SwitchRow) => {
    if (row.kind === 'document') openDocument(row.tab.id);
    else void openMatch(row.match);
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

  const hint = !trimmedQuery
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
      {hint && <div className="document-switcher-hint">{hint}</div>}
      <div id="document-switcher-results" className="document-switcher-results" role="listbox" aria-label={t('已打开的文档', language)}>
        {documents.length > 0 && (
          <div className="document-switcher-group" role="group" aria-label={t('已打开的文档', language)}>
            <div className="document-switcher-group-title">{t('已打开的文档', language)}<span className="document-switcher-group-count">{documents.length}</span></div>
            {documents.map((tab, index) => (
              <button key={tab.id} id={`switch-row-${index}`} type="button" role="option" aria-selected={index === selectedIndex} tabIndex={-1} className="document-switcher-item" onMouseEnter={() => setActiveIndex(index)} onClick={() => openDocument(tab.id)}>
                <FileTypeIcon filename={tab.title} />
                <span className="document-switcher-document"><strong>{tab.path ? tab.title : t(tab.title, language)}</strong><small>{tab.path || t('尚未保存到文件', language)}</small></span>
                {tab.modified && <span className="document-switcher-dirty" title={t('未保存修改', language)} aria-label={t('未保存修改', language)} />}
                {tab.id === activeTabId && <span className="document-switcher-current">{t('当前', language)}</span>}
              </button>
            ))}
          </div>
        )}
        {workspaceSearchEnabled && (
          <div className="document-switcher-group" role="group" aria-label={t('工作区内容', language)}>
            <div className="document-switcher-group-title">
              {t('工作区内容', language)}
              {workspaceStatus && <span className="document-switcher-group-status">{workspaceStatus}</span>}
            </div>
            {visibleGroups.map((group, groupIndex) => (
              <div className="document-switcher-file" key={group.path}>
                <div className="document-switcher-file-title">
                  <FileTypeIcon filename={group.path} />
                  <span className="document-switcher-file-name">{fileNameOf(group.path)}</span>
                  <small>{group.path}</small>
                  <span className="document-switcher-group-count">{group.total}</span>
                </div>
                {group.matches.map((match, matchIndex) => {
                  const rowIndex = documents.length + matchGroupOffsets[groupIndex] + matchIndex;
                  return (
                    <button key={`${match.line_number}:${match.column}`} id={`switch-row-${rowIndex}`} type="button" role="option" aria-selected={rowIndex === selectedIndex} tabIndex={-1} className="document-switcher-item document-switcher-match" onMouseEnter={() => setActiveIndex(rowIndex)} onClick={() => void openMatch(match)}>
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
        {!documents.length && !workspaceSearchEnabled && (
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
