import { useEffect, useMemo, useRef, useState } from 'react';
import { AppIcon } from '../Icons/AppIcon';
import { useAppStore } from '../../stores/appStore';
import { t } from '../../i18n';
import './document-search-panel.css';

interface DocumentSearchPanelProps {
  style?: React.CSSProperties;
}

interface DocumentMatch {
  from: number;
  to: number;
  line: number;
  text: string;
}

interface MatchResult {
  matches: DocumentMatch[];
  error: string;
}

// 结果列表只展示前面若干条，避免超大文档把侧栏渲染拖慢。
const MAX_MATCHES = 2000;
const MAX_RESULT_ROWS = 200;

/**
 * 在正文里找出所有匹配位置。
 * 只针对「当前正在编辑的文档」，全程在内存中完成：不遍历工作区、不读磁盘、不调后端，
 * 因此输入即时可见，也不会出现「一直在搜索」。
 */
function findDocumentMatches(content: string, query: string, caseSensitive: boolean, useRegex: boolean): MatchResult {
  if (!query) return { matches: [], error: '' };
  const found: Array<{ from: number; to: number }> = [];
  try {
    if (useRegex) {
      const regex = new RegExp(query, caseSensitive ? 'g' : 'gi');
      let hit: RegExpExecArray | null;
      while ((hit = regex.exec(content)) !== null) {
        found.push({ from: hit.index, to: hit.index + hit[0].length });
        // 零宽匹配（如 ^ 或 a*）不推进 lastIndex 会死循环。
        if (hit[0].length === 0) regex.lastIndex += 1;
        if (found.length >= MAX_MATCHES) break;
      }
    } else {
      const needle = caseSensitive ? query : query.toLowerCase();
      const haystack = caseSensitive ? content : content.toLowerCase();
      let index = haystack.indexOf(needle);
      while (index >= 0) {
        found.push({ from: index, to: index + needle.length });
        if (found.length >= MAX_MATCHES) break;
        index = haystack.indexOf(needle, index + needle.length);
      }
    }
  } catch (error) {
    return { matches: [], error: `正则表达式无效：${String(error)}` };
  }
  // 一次线性推进算出每个匹配所在行与整行文本，避免对每个匹配都重新扫描全文。
  let lineNumber = 1;
  let lineStart = 0;
  let lineEnd = content.indexOf('\n');
  const matches: DocumentMatch[] = [];
  for (const item of found) {
    while (lineEnd !== -1 && lineEnd < item.from) {
      lineNumber += 1;
      lineStart = lineEnd + 1;
      lineEnd = content.indexOf('\n', lineStart);
    }
    matches.push({
      from: item.from,
      to: item.to,
      line: lineNumber,
      text: content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd),
    });
  }
  return { matches, error: '' };
}

export function DocumentSearchPanel({ style }: DocumentSearchPanelProps) {
  const language = useAppStore(state => state.settings.appearance.language);
  const content = useAppStore(state => state.content);
  const tabs = useAppStore(state => state.tabs);
  const activeTabId = useAppStore(state => state.activeTabId);
  const [query, setQuery] = useState('');
  const [replaceWith, setReplaceWith] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const queryInputRef = useRef<HTMLInputElement>(null);
  const activeTab = tabs.find(tab => tab.id === activeTabId);
  const source = activeTab?.content ?? content;
  const documentTitle = activeTab ? (activeTab.path ? activeTab.title : t(activeTab.title, language)) : '';

  const { matches, error } = useMemo(
    () => findDocumentMatches(source, query, caseSensitive, useRegex),
    [source, query, caseSensitive, useRegex],
  );
  const currentIndex = matches.length ? Math.min(activeIndex, matches.length - 1) : 0;
  const visibleMatches = matches.slice(0, MAX_RESULT_ROWS);
  // 查询条件变化时才自动跳到首个匹配；在编辑器里改正文不应该抢走光标。
  const jumpSignature = `${query}\u0000${caseSensitive}\u0000${useRegex}`;
  const handledSignatureRef = useRef('');

  useEffect(() => {
    queryInputRef.current?.focus();
  }, []);

  const selectMatch = (match: DocumentMatch) => {
    const view = useAppStore.getState().editorView;
    if (!view) return;
    // 只改选区并滚动，不抢焦点：用户可以继续在查找框里连续输入。
    view.setSelection(match.from, match.to);
    view.revealOffset(match.from);
  };

  useEffect(() => {
    if (handledSignatureRef.current === jumpSignature) return;
    handledSignatureRef.current = jumpSignature;
    if (matches.length) selectMatch(matches[0]);
  }, [jumpSignature, matches]);

  const goTo = (delta: number) => {
    if (!matches.length) return;
    const next = (currentIndex + delta + matches.length) % matches.length;
    setActiveIndex(next);
    selectMatch(matches[next]);
  };

  /** 正则模式下用于「单个匹配」的匹配器（无 g 标志，便于对命中的子串整体替换，支持 $1 引用）。 */
  const singleMatcher = () => {
    if (!useRegex) return null;
    try {
      return new RegExp(query, caseSensitive ? '' : 'i');
    } catch {
      return null;
    }
  };

  const replacementOf = (single: RegExp | null, base: string, match: DocumentMatch) =>
    single ? base.slice(match.from, match.to).replace(single, replaceWith) : replaceWith;

  /** 按匹配位置从后往前拼接生成替换后的整篇文本，保证前面的偏移始终有效。 */
  const buildReplacedContent = (base: string, targets: DocumentMatch[], single: RegExp | null) => {
    let next = base;
    for (let index = targets.length - 1; index >= 0; index -= 1) {
      const match = targets[index];
      next = next.slice(0, match.from) + replacementOf(single, base, match) + next.slice(match.to);
    }
    return next;
  };

  /** 替换后按新的正文重新定位到同一序号的匹配，给出连续的替换体验。 */
  const reselectAfterEdit = (preferIndex: number) => {
    window.setTimeout(() => {
      const view = useAppStore.getState().editorView;
      if (!view) return;
      const next = findDocumentMatches(view.getValue(), query, caseSensitive, useRegex);
      if (!next.matches.length) return;
      const target = next.matches[Math.min(preferIndex, next.matches.length - 1)];
      view.setSelection(target.from, target.to);
      view.revealOffset(target.from);
    }, 0);
  };

  const replaceCurrent = () => {
    const view = useAppStore.getState().editorView;
    if (!view || !matches.length) return;
    // 以编辑器里的实时正文重算匹配，避免用到可能滞后的快照偏移。
    const base = view.getValue();
    const latest = findDocumentMatches(base, query, caseSensitive, useRegex).matches;
    if (!latest.length) return;
    const match = latest[Math.min(currentIndex, latest.length - 1)];
    // 走编辑器 API 而不是 store：这是一次可撤销的编辑，并且会自动同步回 store。
    view.replaceRange(match.from, match.to, replacementOf(singleMatcher(), base, match));
    reselectAfterEdit(currentIndex);
  };

  const replaceAll = () => {
    const view = useAppStore.getState().editorView;
    if (!view || !matches.length) return;
    const base = view.getValue();
    const targets = findDocumentMatches(base, query, caseSensitive, useRegex).matches;
    if (!targets.length) return;
    if (!window.confirm(`${t('确认替换', language)}：${targets.length} ${t('处匹配', language)}`)) return;
    view.replaceRange(0, view.state.doc.length, buildReplacedContent(base, targets, singleMatcher()));
    setActiveIndex(0);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      goTo(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setQuery('');
    }
  };

  const status = error
    ? error
    : !query
      ? t('输入关键词即可搜索当前文档的正文', language)
      : matches.length
        ? `${currentIndex + 1} / ${matches.length}`
        : t('没有匹配结果', language);

  return (
    <aside className="sidebar search-sidebar vscode-explorer" style={style}>
      <div className="sidebar-surface">
        <header className="vscode-explorer-header">
          <span>{t('搜索当前文档', language)}</span>
          <div className="vscode-explorer-actions">
            <button type="button" onClick={() => goTo(-1)} disabled={!matches.length} title={t('上一个匹配', language)} aria-label={t('上一个匹配', language)}><AppIcon name="chevronUp" size={14} /></button>
            <button type="button" onClick={() => goTo(1)} disabled={!matches.length} title={t('下一个匹配', language)} aria-label={t('下一个匹配', language)}><AppIcon name="chevronDown" size={14} /></button>
          </div>
        </header>
        <div className="document-find-panel">
          <div className="document-find-document" title={activeTab?.path || documentTitle}>
            {documentTitle ? <><AppIcon name="fileText" size={13} /><span>{documentTitle}</span></> : t('未打开文档', language)}
          </div>
          <input
            ref={queryInputRef}
            className="document-find-input"
            value={query}
            onChange={event => { setQuery(event.target.value); setActiveIndex(0); }}
            onKeyDown={handleKeyDown}
            placeholder={t('查找正文内容', language)}
            aria-label={t('查找正文内容', language)}
          />
          <input
            className="document-find-input"
            value={replaceWith}
            onChange={event => setReplaceWith(event.target.value)}
            placeholder={t('替换为', language)}
            aria-label={t('替换为', language)}
          />
          <div className="document-find-options">
            <label><input type="checkbox" checked={caseSensitive} onChange={event => { setCaseSensitive(event.target.checked); setActiveIndex(0); }} />{t('区分大小写', language)}</label>
            <label><input type="checkbox" checked={useRegex} onChange={event => { setUseRegex(event.target.checked); setActiveIndex(0); }} />{t('正则', language)}</label>
          </div>
          <div className="document-find-actions">
            <button type="button" onClick={replaceCurrent} disabled={!matches.length || error !== ''}>{t('替换', language)}</button>
            <button type="button" onClick={replaceAll} disabled={!matches.length || error !== ''}>{t('全部替换', language)}</button>
          </div>
          <div className={`document-find-status ${error ? 'error' : ''}`} role="status">{status}</div>
          {query && !error && matches.length > 0 && (
            <div className="document-find-results" role="list">
              {visibleMatches.map(match => (
                <button
                  key={`${match.from}:${match.to}`}
                  type="button"
                  role="listitem"
                  className={`document-find-result ${match === matches[currentIndex] ? 'active' : ''}`}
                  onClick={() => { setActiveIndex(matches.indexOf(match)); selectMatch(match); }}
                >
                  <span className="document-find-line">{match.line}</span>
                  <span className="document-find-text">{match.text.trim() || t('空行', language)}</span>
                </button>
              ))}
              {matches.length > visibleMatches.length && (
                <div className="document-find-more" aria-hidden="true">…<small>+{matches.length - visibleMatches.length}</small></div>
              )}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
