import type { AgentEditorContext } from '../types/agent';

export interface ActiveDocumentSnapshot {
  id: string | null;
  title: string;
  path: string | null;
  content: string;
}

export interface AutomaticEditorContext {
  key: string;
  context: AgentEditorContext;
}

const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

export const buildAutomaticEditorContext = (document: ActiveDocumentSnapshot): AutomaticEditorContext | null => {
  if (!document.path && !document.content.trim()) return null;
  const key = `${document.id || document.path || 'untitled'}:${document.path || 'untitled'}`;
  return {
    key,
    context: {
      label: document.path ? fileName(document.path) : document.title || '当前文档',
      path: document.path || undefined,
      content: document.content,
      selection: false,
    },
  };
};

export const formatAssistantInsertion = (text: string, beforeText = '') => {
  const prefix = beforeText.length > 0 && !beforeText.endsWith('\n\n') ? '\n\n' : '';
  return `${prefix}---\n\n${text}`;
};
