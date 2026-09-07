import { useEffect, useMemo, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';

export interface WorkspaceContextPayload {
  content: string;
  tokenEstimate: number;
  sourceNames: string[];
  retrievalOnly: boolean;
}

interface ContextSource { id: string; name: string; path?: string; content: string; sections: string[]; }
interface Heading { id: string; title: string; start: number; end: number; }

const textExtensions = ['md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'csv', 'html', 'htm', 'xml', 'log'];
const estimateTokens = (value: string) => Math.ceil(value.length / 3.5);
const extractHeadings = (content: string): Heading[] => {
  const matches = [...content.matchAll(/^(#{1,6})\s+(.+)$/gm)];
  return matches.map((match, index) => ({
    id: `${match.index}-${index}`,
    title: match[2].trim(),
    start: match.index || 0,
    end: matches[index + 1]?.index || content.length,
  }));
};
const keywords = (content: string) => [...content.toLowerCase().matchAll(/[\u4e00-\u9fa5]{2,}|[a-z][a-z0-9_-]{2,}/g)]
  .map((match) => match[0])
  .filter((word, index, words) => words.indexOf(word) === index)
  .slice(0, 6);
const localRetrieve = (content: string, query: string) => {
  const terms = query.toLowerCase().match(/[\u4e00-\u9fa5]{2,}|[a-z][a-z0-9_-]{2,}/g) || [];
  if (!terms.length) return content.slice(0, 1800);
  return content.split(/\n{2,}/).filter((chunk) => terms.some((term) => chunk.toLowerCase().includes(term))).slice(0, 6).join('\n\n').slice(0, 6000) || content.slice(0, 1800);
};

export function WorkspaceContextPanel({
  linkedDocument,
  query,
  providerLabel,
  onChange,
}: {
  linkedDocument: { title: string; path?: string; content: string } | null;
  query: string;
  providerLabel: string;
  onChange: (payload: WorkspaceContextPayload | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [sources, setSources] = useState<ContextSource[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [sections, setSections] = useState<Record<string, string[]>>({});
  const [retrievalOnly, setRetrievalOnly] = useState(true);
  const [sensitiveRules, setSensitiveRules] = useState('');

  useEffect(() => {
    const id = linkedDocument ? `current-${linkedDocument.path || linkedDocument.title}` : null;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setSources((current) => {
        const otherSources = current.filter((source) => !source.id.startsWith('current-'));
        return linkedDocument && id
          ? [...otherSources, { id, name: linkedDocument.title, path: linkedDocument.path, content: linkedDocument.content, sections: [] }]
          : otherSources;
      });
      setSelected((current) => {
        const otherSelections = current.filter((sourceId) => !sourceId.startsWith('current-'));
        return id ? [...otherSelections, id] : otherSelections;
      });
      setSections((current) => Object.fromEntries(
        Object.entries(current).filter(([sourceId]) => !sourceId.startsWith('current-')),
      ));
    });
    return () => { cancelled = true; };
  }, [linkedDocument]);

  const selectedSources = useMemo(() => sources.filter((source) => selected.includes(source.id)), [sources, selected]);
  const excludedNames = useMemo(() => sensitiveRules.split(/[\n,;]/).map((rule) => rule.trim().toLowerCase()).filter(Boolean), [sensitiveRules]);
  const prepared = useMemo(() => selectedSources
    .filter((source) => !excludedNames.some((rule) => source.name.toLowerCase().includes(rule) || source.path?.toLowerCase().includes(rule)))
    .map((source) => {
      const headings = extractHeadings(source.content);
      const selectedHeadingIds = sections[source.id] || [];
      const sectionContent = selectedHeadingIds.length
        ? headings.filter((heading) => selectedHeadingIds.includes(heading.id)).map((heading) => source.content.slice(heading.start, heading.end)).join('\n\n')
        : source.content;
      const body = retrievalOnly ? localRetrieve(sectionContent, query) : sectionContent.slice(0, 12000);
      return { ...source, body, headingCount: headings.length, keywords: keywords(sectionContent) };
    }), [selectedSources, excludedNames, sections, retrievalOnly, query]);

  useEffect(() => {
    if (!prepared.length) return onChange(null);
    const content = prepared.map((source) => `[工作区文件：${source.name}]\n标题/摘要：${source.body.slice(0, 320).replace(/\s+/g, ' ')}\n关键词：${source.keywords.join('、') || '无'}\n\n${source.body}`).join('\n\n---\n\n');
    onChange({ content, tokenEstimate: estimateTokens(content), sourceNames: prepared.map((source) => source.name), retrievalOnly });
  }, [prepared, retrievalOnly, onChange]);

  const addFiles = async () => {
    const selectedPaths = await open({ multiple: true, filters: [{ name: '可读取文本', extensions: textExtensions }] });
    if (!selectedPaths) return;
    const paths = Array.isArray(selectedPaths) ? selectedPaths : [selectedPaths];
    const newSources = await Promise.all(paths.map(async (path) => ({ id: `file-${path}`, name: path.split(/[/\\]/).pop() || path, path, content: await invoke<string>('get_text_attachment_content', { path }), sections: [] })));
    setSources((current) => [...current.filter((source) => !newSources.some((item) => item.id === source.id)), ...newSources]);
    setSelected((current) => [...new Set([...current, ...newSources.map((source) => source.id)])]);
  };

  return (
    <section className="workspace-context-panel">
      <button className="workspace-context-toggle" onClick={() => setExpanded((value) => !value)}>
        工作区上下文 {prepared.length ? `· ${prepared.length} 个文件 / 约 ${estimateTokens(prepared.map((source) => source.body).join(''))} Token` : '· 未选择'}
      </button>
      {expanded && <div className="workspace-context-body">
        <div className="workspace-context-actions"><button onClick={() => void addFiles()}>选择工作区文件</button><label><input type="checkbox" checked={retrievalOnly} onChange={(event) => setRetrievalOnly(event.target.checked)} /> 仅检索片段，不上传全文</label></div>
        {sources.map((source) => {
          const headings = extractHeadings(source.content);
          return <div className="workspace-context-source" key={source.id}>
            <label><input type="checkbox" checked={selected.includes(source.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, source.id] : current.filter((id) => id !== source.id))} /> {source.name}</label>
            <small>摘要：{source.content.slice(0, 110).replace(/\s+/g, ' ')} · {keywords(source.content).join('、') || '无关键词'}</small>
            {headings.length > 0 && <select multiple value={sections[source.id] || []} onChange={(event) => setSections((current) => ({ ...current, [source.id]: [...event.currentTarget.selectedOptions].map((option) => option.value) }))} title="选择具体章节；未选择时使用整个文件">
              {headings.map((heading) => <option key={heading.id} value={heading.id}>{heading.title}</option>)}
            </select>}
          </div>;
        })}
        <input value={sensitiveRules} onChange={(event) => setSensitiveRules(event.target.value)} placeholder="敏感文件排除规则（名称片段，逗号分隔）" />
        <p className="workspace-context-disclosure">本轮将向 <strong>{providerLabel}</strong> 发送：{prepared.length ? prepared.map((source) => source.name).join('、') : '无本地内容'}；约 {estimateTokens(prepared.map((source) => source.body).join(''))} Token。{retrievalOnly ? '仅发送本地检索命中的片段。' : '将发送所选章节/文件内容（每文件最多 12,000 字符）。'}</p>
      </div>}
    </section>
  );
}
