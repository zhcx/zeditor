export interface SlashCommandInsertion {
  text: string;
  selectionStart?: number;
  selectionEnd?: number;
}

/** 动作型命令触发的 AI 操作；缺失时为纯文本插入命令。 */
export type SlashCommandAiAction =
  | 'continue'
  | 'polish'
  | 'translate'
  | 'summarize'
  | 'ask'
  | 'write';

export interface SlashCommand {
  id: string;
  title: string;
  description: string;
  shortcut: string;
  icon: string;
  keywords: string;
  insertion: SlashCommandInsertion;
  ai?: SlashCommandAiAction;
  /** 需要用户补充说明（问题 / 写作要求）的动作型命令。 */
  needsPrompt?: boolean;
  /** 在该项之前渲染一条分组分隔线。 */
  dividerBefore?: boolean;
}

export interface SlashCommandTrigger {
  from: number;
  to: number;
  query: string;
}

const insertion = (
  text: string,
  selectionStart = text.length,
  selectionEnd = selectionStart,
): SlashCommandInsertion => ({ text, selectionStart, selectionEnd });

export const SLASH_COMMANDS: SlashCommand[] = [
  // 仅 AI 问答置于菜单顶部，其余 AI 动作分组放到底部。
  { id: 'ai-ask', title: 'AI 问答', description: '向 AI 提问并插入回答', shortcut: '/ask', icon: '问', keywords: 'ai ask question 问答 提问 查询 搜索 智能', insertion: insertion(''), ai: 'ask', needsPrompt: true },
  { id: 'heading-1', title: '一级标题', description: '大标题', shortcut: '/h1', icon: 'H1', keywords: 'h1 heading title 标题 大标题', insertion: insertion('# ') },
  { id: 'heading-2', title: '二级标题', description: '章节标题', shortcut: '/h2', icon: 'H2', keywords: 'h2 heading title 标题 章节', insertion: insertion('## ') },
  { id: 'heading-3', title: '三级标题', description: '小节标题', shortcut: '/h3', icon: 'H3', keywords: 'h3 heading title 标题 小节', insertion: insertion('### ') },
  { id: 'heading-4', title: '四级标题', description: '细分小节', shortcut: '/h4', icon: 'H4', keywords: 'h4 heading title 标题 小节', insertion: insertion('#### ') },
  { id: 'bold', title: '加粗', description: '强调选中文字', shortcut: '/bold', icon: 'B', keywords: 'bold strong 加粗 粗体 强调', insertion: insertion('****', 2) },
  { id: 'italic', title: '斜体', description: '使用斜体强调', shortcut: '/italic', icon: 'I', keywords: 'italic emphasis 斜体 强调', insertion: insertion('**', 1) },
  { id: 'strikethrough', title: '删除线', description: '标记删除内容', shortcut: '/strike', icon: 'S', keywords: 'strike delete 删除线 划线', insertion: insertion('~~~~', 2) },
  { id: 'highlight', title: '高亮', description: '突出显示文字', shortcut: '/highlight', icon: '==', keywords: 'highlight mark 高亮 标记', insertion: insertion('====', 2) },
  { id: 'inline-code', title: '行内代码', description: '插入短代码片段', shortcut: '/inlinecode', icon: '`', keywords: 'inline code 行内代码 代码', insertion: insertion('``', 1) },
  { id: 'quote', title: '引用', description: '插入引用块', shortcut: '/quote', icon: '❝', keywords: 'quote blockquote 引用', insertion: insertion('> ') },
  { id: 'unordered-list', title: '无序列表', description: '项目列表', shortcut: '/ul', icon: '•', keywords: 'ul bullet list 无序 列表 项目', insertion: insertion('- ') },
  { id: 'ordered-list', title: '有序列表', description: '编号列表', shortcut: '/ol', icon: '1.', keywords: 'ol numbered list 有序 编号 列表', insertion: insertion('1. ') },
  { id: 'task-list', title: '任务列表', description: '插入待办事项', shortcut: '/todo', icon: '☐', keywords: 'todo task checkbox 任务 待办 清单', insertion: insertion('- [ ] ') },
  { id: 'code', title: '代码块', description: '插入多行代码', shortcut: '/code', icon: '</>', keywords: 'code fence 代码 代码块', insertion: insertion('```\n\n```', 4) },
  // 默认 3 × 3（表头 + 两行正文），与工具栏网格和功能菜单的默认表格一致。
  { id: 'table', title: '表格', description: '插入 3 × 3 表格', shortcut: '/table', icon: '▦', keywords: 'table grid 3x3 表格', insertion: insertion('| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |', 2, 5) },
  { id: 'image', title: '图片', description: '插入图片链接', shortcut: '/image', icon: '▧', keywords: 'image photo picture 图片 图像', insertion: insertion('![图片描述](https://)', 2, 6) },
  { id: 'video', title: '视频', description: '插入视频链接', shortcut: '/video', icon: '▶', keywords: 'video bilibili youtube vimeo 视频 影片', insertion: insertion('@[video](https://)', 9, 16) },
  { id: 'audio', title: '音频', description: '插入音频播放器', shortcut: '/audio', icon: '♪', keywords: 'audio music sound mp3 音频 音乐 声音 播客', insertion: insertion('@[audio](https://)', 9, 16) },
  { id: 'emoji', title: '表情', description: '插入 Emoji', shortcut: '/emoji', icon: '☺', keywords: 'emoji 表情 符号', insertion: insertion('😀') },
  { id: 'link', title: '链接', description: '插入文本链接', shortcut: '/link', icon: '↗', keywords: 'link url href 链接 网址', insertion: insertion('[链接文字](https://)', 1, 5) },
  { id: 'math', title: '公式', description: '插入行内公式', shortcut: '/math', icon: '∑', keywords: 'math latex formula 数学 公式', insertion: insertion('$公式$', 1, 3) },
  { id: 'math-block', title: '公式块', description: '插入独立公式', shortcut: '/mathblock', icon: '∑', keywords: 'math latex formula block 数学 公式块', insertion: insertion('$$\n\n$$', 3) },
  { id: 'footnote', title: '脚注', description: '插入脚注引用', shortcut: '/footnote', icon: '¹', keywords: 'footnote note 脚注 注释', insertion: insertion('[^1]', 2, 3) },
  { id: 'divider', title: '分割线', description: '插入水平分割线', shortcut: '/hr', icon: '—', keywords: 'hr divider separator 分割线 水平线', insertion: insertion('---') },
  { id: 'toc', title: '目录', description: '插入文档目录', shortcut: '/toc', icon: '☷', keywords: 'toc table contents 目录', insertion: insertion('[TOC]') },
  { id: 'details', title: '折叠内容', description: '插入可展开区域', shortcut: '/details', icon: '▸', keywords: 'details collapse 折叠 展开', insertion: insertion('<details>\n<summary>展开查看</summary>\n\n内容\n\n</details>', 19, 23) },
  { id: 'comment', title: '注释', description: '插入不显示的注释', shortcut: '/comment', icon: '※', keywords: 'comment 注释 备注', insertion: insertion('<!-- 注释 -->', 5, 7) },
  { id: 'mermaid', title: '流程图', description: '插入 Mermaid 流程图', shortcut: '/mermaid', icon: '◇', keywords: 'mermaid diagram flowchart 流程图 图表', insertion: insertion('```mermaid\nflowchart LR\n  A[开始] --> B[结束]\n```', 28, 30) },
  { id: 'gantt', title: '甘特图', description: '插入 Mermaid 甘特图', shortcut: '/gantt', icon: '▤', keywords: 'gantt chart mermaid 甘特图 项目 进度 计划 时间线', insertion: insertion('```mermaid\ngantt\n  title 项目计划\n  dateFormat YYYY-MM-DD\n  section 阶段一\n    任务1 :a1, 2024-01-01, 7d\n    任务2 :after a1, 5d\n```', 25, 29) },
  { id: 'sequence', title: '时序图', description: '插入 Mermaid 时序图', shortcut: '/sequence', icon: '⇄', keywords: 'sequence diagram mermaid 时序图 顺序图 交互', insertion: insertion('```mermaid\nsequenceDiagram\n  participant A as 用户\n  participant B as 系统\n  A->>B: 请求\n  B-->>A: 响应\n```', 46, 48) },
  { id: 'state', title: '状态图', description: '插入 Mermaid 状态图', shortcut: '/state', icon: '◉', keywords: 'state diagram mermaid 状态图 状态机', insertion: insertion('```mermaid\nstateDiagram-v2\n  [*] --> 待处理\n  待处理 --> 进行中 : 开始\n  进行中 --> 已完成 : 完成\n  已完成 --> [*]\n```', 37, 40) },
  { id: 'class-diagram', title: '类图', description: '插入 Mermaid 类图', shortcut: '/class', icon: '⊞', keywords: 'class diagram mermaid 类图 UML', insertion: insertion('```mermaid\nclassDiagram\n  class 类名 {\n    +属性1 string\n    +方法1() void\n  }\n```', 32, 34) },
  { id: 'slide', title: '幻灯片分隔', description: '插入幻灯片分隔符', shortcut: '/slide', icon: '▢', keywords: 'slide ppt presentation 幻灯片 分隔 演示', insertion: insertion('\n---\n\n') },
  // —— 底部分组：其余 AI 动作 ——
  { id: 'ai-continue', title: 'AI 续写', description: '根据上文继续写作', shortcut: '/ai', icon: '续', keywords: 'ai continue write 写作 续写 接着写 智能', insertion: insertion(''), ai: 'continue', dividerBefore: true },
  { id: 'ai-write', title: 'AI 写作', description: '按你的要求生成内容', shortcut: '/write', icon: '写', keywords: 'ai write draft 写作 生成 起草 文章 智能', insertion: insertion(''), ai: 'write', needsPrompt: true },
  { id: 'ai-polish', title: 'AI 润色', description: '润色选中的文字', shortcut: '/polish', icon: '润', keywords: 'ai polish improve 润色 改写 智能', insertion: insertion(''), ai: 'polish' },
  { id: 'ai-translate', title: 'AI 翻译', description: '翻译选中或上文内容', shortcut: '/translate', icon: '译', keywords: 'ai translate 翻译 中英 智能', insertion: insertion(''), ai: 'translate' },
  { id: 'ai-summarize', title: 'AI 总结', description: '总结为要点清单', shortcut: '/summarize', icon: '结', keywords: 'ai summarize summary 总结 摘要 要点 智能', insertion: insertion(''), ai: 'summarize' },
];

/** Detects a slash command only when `/query` is the first token on a line. */
export function findSlashCommandTrigger(
  lineText: string,
  lineStart: number,
  cursorOffset: number,
): SlashCommandTrigger | null {
  const columnOffset = cursorOffset - lineStart;
  if (columnOffset < 0 || columnOffset > lineText.length) return null;

  const beforeCursor = lineText.slice(0, columnOffset);
  const match = /^(\s*)\/([^\s/]*)$/u.exec(beforeCursor);
  if (!match) return null;

  const from = lineStart + match[1].length;
  return { from, to: cursorOffset, query: match[2] };
}

export function filterSlashCommands(query: string) {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return SLASH_COMMANDS;

  return SLASH_COMMANDS.filter((command) => {
    const searchable = `${command.title} ${command.description} ${command.shortcut.slice(1)} ${command.keywords}`.toLocaleLowerCase();
    return searchable.includes(normalized);
  });
}
