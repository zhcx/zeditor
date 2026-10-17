import { useEffect } from 'react';
import { useAIStore } from '../../stores/aiStore';
import { useAppStore } from '../../stores/appStore';
import type { WysiwygSession } from './wysiwygSession';

/** CSS 高亮不向 contenteditable 插入包装节点，不影响选区、输入法和源码写回。 */
export function ProofreadHighlights({ session, version, renderedBlocks }: { session: WysiwygSession; version: number; renderedBlocks?: number }) {
  const results = useAIStore(state => state.proofreadResults);
  const snapshot = useAIStore(state => state.proofreadSnapshot);
  const tabId = useAppStore(state => state.activeTabId);
  useEffect(() => {
    if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return;
    const name = 'wysiwyg-proofread';
    const source = session.getSource();
    CSS.highlights.delete(name);
    if (snapshot?.activeTabId !== tabId || snapshot?.content !== source) return;
    const ranges: Range[] = [];
    for (const result of results) {
      if (result.from < 0 || result.to <= result.from || source.slice(result.from, result.to) !== result.original) continue;
      const start = session.rangeOfOffset(result.from);
      const end = session.rangeOfOffset(result.to);
      if (!start || !end) continue;
      const range = start.cloneRange();
      range.setEnd(end.startContainer, end.startOffset);
      if (!range.collapsed) ranges.push(range);
    }
    const highlight = new Highlight(...ranges);
    if (ranges.length > 0) CSS.highlights.set(name, highlight);
    return () => { if (CSS.highlights.get(name) === highlight) CSS.highlights.delete(name); };
  }, [results, snapshot, tabId, session, version, renderedBlocks]);
  return null;
}
