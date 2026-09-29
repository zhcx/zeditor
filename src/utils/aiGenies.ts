import type { AIChangeKind } from '../stores/aiStore';
import type { EditorController } from '../types/editor';
import type { SlashCommand, SlashCommandAiAction } from './slashCommands';

/** 精灵作用范围：选区 / 段落 / 全文（参考 VMark AI Genies 的范围系统）。 */
export type GenieScope = 'selection' | 'block' | 'document';

/** 结果应用方式：替换原文 / 在目标位置后插入。 */
export type GenieAction = 'replace' | 'insert';

/** 精灵执行目标：由面板按范围（选区/段落/全文）从编辑器提取。 */
export interface GenieTarget {
  scope: GenieScope;
  text: string;
  from: number;
  to: number;
  /** insert 动作的插入点（replace 时忽略）。 */
  insertAt: number;
}

export interface GenieDefinition {
  id: string;
  name: string;
  description: string;
  category: string;
  scope: GenieScope;
  action: GenieAction;
  icon: string;
  /** 后端 ai_request 动作名；continue 由前端特判，自定义精灵用 transform。 */
  backendAction: string;
  /** transform 动作的用户指令（模板去掉 {{content}} 后的剩余部分）。 */
  instruction?: string;
  /** 精灵级模型覆盖；空表示跟随全局设置。 */
  model?: string;
  kind: AIChangeKind;
  /** 是否来自用户 genies/ 目录的自定义精灵。 */
  custom?: boolean;
}

/** 提取结果文本：不同后端动作使用不同的 data 字段名。 */
export function extractGenieText(data: unknown, backendAction: string): string {
  if (!data || typeof data !== 'object') return '';
  const record = data as Record<string, unknown>;
  const keys: Record<string, string[]> = {
    rewrite: ['rewritten'],
    translate: ['translated'],
    summarize: ['summary'],
    outline: ['outline'],
  };
  for (const key of keys[backendAction] || ['text']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

/** 内置精灵（13 个，4 个分类，对齐 VMark 内置精灵清单）。 */
export const BUILTIN_GENIES: GenieDefinition[] = [
  // ✏️ 编辑
  { id: 'polish', name: '润色', description: '提升清晰度和流畅性', category: '编辑', scope: 'selection', action: 'replace', icon: '✨', backendAction: 'polish', kind: 'polish' },
  { id: 'condense', name: '精简', description: '删除冗余，使文本更简洁', category: '编辑', scope: 'selection', action: 'replace', icon: '✂️', backendAction: 'condense', kind: 'polish' },
  { id: 'simplify', name: '简化', description: '用更简单的语言表达', category: '编辑', scope: 'selection', action: 'replace', icon: '🌱', backendAction: 'simplify', kind: 'polish' },
  { id: 'rewrite', name: '改写', description: '用不同方式表达相同内容', category: '编辑', scope: 'selection', action: 'replace', icon: '🔄', backendAction: 'rewrite', kind: 'polish' },
  // 💡 创意
  { id: 'expand', name: '扩展', description: '将想法发展为完整段落', category: '创意', scope: 'selection', action: 'replace', icon: '📈', backendAction: 'expand', kind: 'polish' },
  { id: 'vivid', name: '生动化', description: '添加感官细节和意象', category: '创意', scope: 'selection', action: 'replace', icon: '🎨', backendAction: 'vivid', kind: 'polish' },
  { id: 'continue', name: '续写', description: '从当前位置继续写作', category: '创意', scope: 'block', action: 'insert', icon: '✍️', backendAction: 'continue', kind: 'continuation' },
  // 📋 结构
  { id: 'summarize', name: '摘要', description: '总结全文要点', category: '结构', scope: 'document', action: 'insert', icon: '📋', backendAction: 'summarize', kind: 'structure' },
  { id: 'outline', name: '大纲', description: '生成写作大纲', category: '结构', scope: 'document', action: 'insert', icon: '🗺️', backendAction: 'outline', kind: 'structure' },
  { id: 'title', name: '标题', description: '建议多个标题选项', category: '结构', scope: 'document', action: 'insert', icon: '🏷️', backendAction: 'title', kind: 'structure' },
  // 🔧 工具
  { id: 'translate', name: '翻译', description: '中英互译，保留 Markdown 结构', category: '工具', scope: 'selection', action: 'replace', icon: '🌐', backendAction: 'translate', kind: 'translation' },
  { id: 'proofread', name: '校对', description: '检查拼写、语法与标点错误', category: '工具', scope: 'selection', action: 'replace', icon: '🔍', backendAction: 'proofread', kind: 'proofread' },
];

/** 把自定义精灵文件的模板转成指令：去掉 {{content}} 占位符后的剩余部分。 */
export function templateToInstruction(template: string): string {
  return template
    .replace(/\{\{\s*content\s*\}\}/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 由自由格式输入构造一次性精灵。 */
export function freeformGenie(instruction: string, scope: GenieScope): GenieDefinition {
  return {
    id: `freeform-${Date.now()}`,
    name: '自由指令',
    description: instruction.slice(0, 40),
    category: '自由指令',
    scope,
    action: 'replace',
    icon: '💬',
    backendAction: 'transform',
    instruction,
    kind: 'polish',
  };
}

/** 按范围从编辑器提取精灵目标。选区为空时回退到段落（VMark 回退行为）。 */
export function extractGenieTarget(view: EditorController, scope: GenieScope, fallback = true): GenieTarget | null {
  const docLength = view.state.doc.length;
  const fullText = view.state.sliceDoc(0, docLength);
  const head = view.state.selection.main.to;

  if (scope === 'selection') {
    const sel = view.state.selection.main;
    if (!sel.empty) {
      return { scope, text: view.state.sliceDoc(sel.from, sel.to), from: sel.from, to: sel.to, insertAt: sel.to };
    }
    return fallback ? extractGenieTarget(view, 'block', false) : null;
  }

  if (scope === 'block') {
    // 段落 = 光标前后最近的空行之间（Markdown 块级近似）。
    let start = fullText.lastIndexOf('\n\n', Math.max(0, head - 1));
    start = start === -1 ? 0 : start + 2;
    let end = fullText.indexOf('\n\n', head);
    if (end === -1) end = docLength;
    if (start > end) start = end;
    const blockText = fullText.slice(start, end);
    if (!blockText.trim()) return null;
    return { scope, text: blockText, from: start, to: end, insertAt: end };
  }

  if (!fullText.trim()) return null;
  return { scope, text: fullText, from: 0, to: docLength, insertAt: head };
}

/** 斜杠命令 AI 动作 → 精灵基础定义：/ask、/write 等复用 runGenie 执行链路。 */
const SLASH_AI_BASE: Record<SlashCommandAiAction, Omit<GenieDefinition, 'id' | 'category' | 'instruction'>> = {
  ask: { name: 'AI 问答', description: '向 AI 提问并插入回答', backendAction: 'transform', scope: 'document', action: 'insert', icon: '💬', kind: 'polish' },
  write: { name: 'AI 写作', description: '按你的要求生成内容', backendAction: 'transform', scope: 'document', action: 'insert', icon: '📝', kind: 'polish' },
  continue: { name: 'AI 续写', description: '根据上文继续写作', backendAction: 'continue', scope: 'block', action: 'insert', icon: '✍️', kind: 'continuation' },
  polish: { name: 'AI 润色', description: '润色当前段落或选区', backendAction: 'polish', scope: 'selection', action: 'replace', icon: '✨', kind: 'polish' },
  translate: { name: 'AI 翻译', description: '翻译当前段落或选区', backendAction: 'translate', scope: 'selection', action: 'replace', icon: '🌐', kind: 'translation' },
  summarize: { name: 'AI 总结', description: '总结全文要点', backendAction: 'summarize', scope: 'document', action: 'insert', icon: '📋', kind: 'structure' },
};

/** 把斜杠命令的 AI 动作映射为精灵定义；/ask、/write 必须提供补充说明（问题 / 写作要求）。 */
export function slashAiGenie(command: SlashCommand, prompt?: string): GenieDefinition | null {
  const action = command.ai;
  if (!action) return null;
  const needsPrompt = action === 'ask' || action === 'write';
  if (needsPrompt && !prompt?.trim()) return null;
  return {
    id: `slash-${action}`,
    category: 'AI',
    ...SLASH_AI_BASE[action],
    instruction: needsPrompt ? prompt!.trim() : undefined,
  };
}
