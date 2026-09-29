import type { AIChangeKind } from '../stores/aiStore';

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
