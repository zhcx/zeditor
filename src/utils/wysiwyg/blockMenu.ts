import { SLASH_COMMANDS, type SlashCommandInsertion } from '../slashCommands.ts';
import type { BlockRetypeTarget } from './blockOps.ts';

export type BlockInsertKind = BlockRetypeTarget | 'table' | 'image' | 'link' | 'video' | 'audio' | 'divider' | 'details' | 'toc' | 'comment' | 'mermaid' | 'gantt' | 'sequence' | 'state' | 'class-diagram' | 'markmap';

export const BLOCK_RETYPE_ITEMS: ReadonlyArray<{ target: BlockRetypeTarget; label: string }> = [
  { target: 'paragraph', label: '正文' },
  { target: 'heading1', label: '1 级标题' },
  { target: 'heading2', label: '2 级标题' },
  { target: 'heading3', label: '3 级标题' },
  { target: 'heading4', label: '4 级标题' },
  { target: 'heading5', label: '5 级标题' },
  { target: 'heading6', label: '6 级标题' },
  { target: 'bullet', label: '无序列表' },
  { target: 'ordered', label: '有序列表' },
  { target: 'task', label: '任务列表' },
  { target: 'quote', label: '引用' },
  { target: 'code', label: '代码块' },
  { target: 'math', label: '公式块' },
];

export const BLOCK_INSERT_ITEMS: ReadonlyArray<{ kind: BlockInsertKind; label: string }> = [
  ...BLOCK_RETYPE_ITEMS.map(({ target, label }) => ({ kind: target, label: target === 'paragraph' ? '段落' : label })),
  { kind: 'table', label: '表格' },
  { kind: 'image', label: '图片' },
  { kind: 'link', label: '链接' },
  { kind: 'video', label: '视频' },
  { kind: 'audio', label: '音频' },
  { kind: 'divider', label: '分隔线' },
  { kind: 'details', label: '折叠内容' },
  { kind: 'toc', label: '目录' },
  { kind: 'comment', label: '注释' },
  { kind: 'mermaid', label: '流程图' },
  { kind: 'gantt', label: '甘特图' },
  { kind: 'sequence', label: '时序图' },
  { kind: 'state', label: '状态图' },
  { kind: 'class-diagram', label: '类图' },
  { kind: 'markmap', label: '思维导图' },
];

const aliases: Partial<Record<BlockInsertKind, string>> = {
  bullet: 'unordered-list', ordered: 'ordered-list', task: 'task-list', math: 'math-block',
};

/** 复用斜杠命令模板和选区，空文本块保留可直接输入的标记。 */
export function blockInsertion(kind: BlockInsertKind): SlashCommandInsertion {
  if (kind === 'paragraph') return { text: '' };
  if (kind === 'task') return { text: '- [ ] 待办事项', selectionStart: 6, selectionEnd: 10 };
  if (kind === 'math') return { text: '$$\nx^2\n$$', selectionStart: 3, selectionEnd: 6 };
  if (/^heading[1-6]$/.test(kind)) {
    const text = `${'#'.repeat(Number(kind.slice(-1)))} `;
    return { text, selectionStart: text.length };
  }
  const command = SLASH_COMMANDS.find(item => item.id === (aliases[kind] ?? kind));
  if (!command) throw new Error(`Unsupported block insertion: ${kind}`);
  if (kind === 'video' || kind === 'audio') {
    const start = command.insertion.text.indexOf('https://');
    return { text: command.insertion.text, selectionStart: start, selectionEnd: start + 'https://'.length };
  }
  return command.insertion;
}
