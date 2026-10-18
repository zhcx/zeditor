/**
 * 反向链接：列出工作区里通过 `[[当前笔记]]` 引用本文的 Markdown 文件。
 *
 * 扫描只在展开面板、切换文档或手动刷新时进行；输入正文不会触发磁盘遍历。
 */
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AppIcon } from '../Icons/AppIcon';
import { openWikiBacklink, workspaceRoots } from '../../services/wikiLinks';

interface WikiBacklinkEntry {
  path: string;
  title: string;
  line: number;
  excerpt: string;
  count: number;
}

export function BacklinksSection({ documentPath }: { documentPath: string | null }) {
  const [expanded, setExpanded] = useState(true);
  // 结果与它对应的文档路径放在一起：切换文档时无需在 effect 里同步清空状态。
  const [result, setResult] = useState<{ path: string; items: WikiBacklinkEntry[] } | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!expanded) return undefined;
    if (!documentPath || !('__TAURI_INTERNALS__' in window)) return undefined;
    let cancelled = false;
    void invoke<WikiBacklinkEntry[]>('find_wiki_backlinks', {
      documentPath,
      roots: workspaceRoots(),
    })
      .then((items) => { if (!cancelled) setResult({ path: documentPath, items }); })
      .catch(() => { if (!cancelled) setResult({ path: documentPath, items: [] }); });
    return () => { cancelled = true; };
  }, [documentPath, expanded, revision]);

  const entries = result && result.path === documentPath ? result.items : [];
  const loading = '__TAURI_INTERNALS__' in window && Boolean(documentPath) && !(result && result.path === documentPath);

  const openEntry = async (entry: WikiBacklinkEntry) => {
    try {
      await openWikiBacklink(entry.path, entry.line);
    } catch {
      // 文件可能已被移动或删除：保留列表，下次刷新会去掉它。
    }
  };

  return (
    <section className="explorer-section backlinks-section">
      <button className="explorer-section-heading" onClick={() => setExpanded(value => !value)}>
        <span className={`explorer-chevron ${expanded ? 'expanded' : ''}`} aria-hidden="true">
          <AppIcon name="chevronRight" size={14} />
        </span>
        <span>反向链接</span>
        {entries.length > 0 && <span className="explorer-count">{entries.length}</span>}
      </button>
      {expanded && (
        <div role="group" className="backlinks-list">
          {!documentPath ? (
            <div className="explorer-empty-state">保存文档后可查看反向链接</div>
          ) : entries.length > 0 ? (
            <>
              {entries.map(entry => (
                <button
                  key={entry.path}
                  className="backlink-row"
                  title={`${entry.path}\n${entry.excerpt}`}
                  onClick={() => void openEntry(entry)}
                >
                  <span className="backlink-title">
                    {entry.title}
                    {entry.count > 1 && <span className="backlink-count">×{entry.count}</span>}
                  </span>
                  {entry.excerpt && <span className="backlink-excerpt">{entry.excerpt}</span>}
                </button>
              ))}
            </>
          ) : (
            <div className="explorer-empty-state">{loading ? '正在查找引用…' : '暂无反向链接'}</div>
          )}
          {documentPath && (
            <button
              className="backlink-refresh"
              onClick={() => {
                setResult(null);
                setRevision(value => value + 1);
              }}
            >
              刷新
            </button>
          )}
        </div>
      )}
    </section>
  );
}
