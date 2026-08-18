import { useMemo, type CSSProperties } from 'react';
import { useAppStore } from '../../stores/appStore';
import { groupSuperTagRecords } from '../../utils/superTag';

interface SuperTagPanelProps {
  style?: CSSProperties;
}

export function SuperTagPanel({ style }: SuperTagPanelProps) {
  const { tabs, openFile } = useAppStore();
  const groups = useMemo(() => groupSuperTagRecords(
    tabs.filter((tab) => tab.path).map((tab) => ({ path: tab.path as string, content: tab.content })),
  ), [tabs]);
  const fields = groups[0]?.records[0] ? Object.keys(groups[0].records[0].fields).filter((key) => key !== 'class' && key !== 'title') : [];

  return (
    <aside className="sidebar supertag-sidebar" style={style}>
      <div className="sidebar-surface">
        <header className="vscode-explorer-header"><span>SuperTag 资料库</span><span className="explorer-count">{groups.reduce((total, group) => total + group.records.length, 0)}</span></header>
        {groups.length > 0 ? groups.map((group) => (
          <section className="supertag-group" key={group.className}>
            <h3>{group.className}<small>{group.records.length} 条记录</small></h3>
            <div className="supertag-table">
              <div className="supertag-row supertag-heading">
                <span>标题</span>
                {fields.slice(0, 3).map((field) => <span key={field}>{field}</span>)}
              </div>
              {group.records.map((record) => (
                <button className="supertag-row" type="button" key={record.path} onClick={() => void openFile(record.path)} title={record.path}>
                  <strong>{record.title}</strong>
                  {fields.slice(0, 3).map((field) => <span key={field}>{Array.isArray(record.fields[field]) ? (record.fields[field] as unknown[]).join(', ') : String(record.fields[field] ?? '')}</span>)}
                </button>
              ))}
            </div>
          </section>
        )) : (
          <div className="knowledge-graph-empty">
            <strong>暂无 SuperTag 记录</strong>
            <span>为 Markdown 添加 class Frontmatter，并打开记录后即可聚合显示。</span>
          </div>
        )}
      </div>
    </aside>
  );
}
