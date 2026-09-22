import { useMemo, useState } from 'react';

interface SyntaxItem {
  id: string;
  group: string;
  title: string;
  summary: string;
  code: string;
  result: string;
  tip?: string;
}

const fence = (language: string, ...lines: string[]) => [`\`\`\`${language}`, ...lines, '```'].join('\n');

const SYNTAX_ITEMS: SyntaxItem[] = [
  { id: 'heading', group: '基础排版', title: '标题', summary: '在行首输入 1～6 个 #，# 越少，标题级别越高。# 后必须留一个空格。', code: '# 一级标题\n## 二级标题\n### 三级标题\n#### 四级标题\n##### 五级标题\n###### 六级标题', result: '显示六级层次分明的标题，并自动进入文档大纲。', tip: '一篇文章通常只使用一个一级标题。' },
  { id: 'paragraph', group: '基础排版', title: '段落与换行', summary: '空一行开始新段落；行尾输入两个空格再回车，可以只换行而不分段。', code: '这是第一段。\n\n这是第二段。\n这一行末尾有两个空格  \n所以这里只换行。', result: '第一、第二段之间有段落间距，最后两行仍属于同一段。' },
  { id: 'emphasis', group: '基础排版', title: '粗体、斜体与删除线', summary: '用成对的标记包住文字。标记和文字之间不要留空格。', code: '**粗体**\n*斜体*\n***粗斜体***\n~~删除线~~', result: '分别显示粗体、斜体、粗斜体和带删除线的文字。' },
  { id: 'extended-text', group: '基础排版', title: '高亮、下划线、上标与下标', summary: '这些是 Zeditor 支持的扩展写法，适合重点和公式说明。', code: '==高亮文字==\n<u>下划线文字</u>\nX<sup>2</sup>\nH<sub>2</sub>O', result: '显示高亮、下划线、上标和下标效果。', tip: 'HTML 标签属于扩展语法，发布到其他平台前请确认目标平台支持。' },
  { id: 'escape', group: '基础排版', title: '转义特殊符号', summary: '如果只想显示 Markdown 符号本身，请在符号前加反斜杠。', code: '\\*这不是斜体\\*\n\\# 这不是标题\n\\[这不是链接\\]', result: '页面会原样显示星号、# 和方括号。' },

  { id: 'unordered-list', group: '内容组织', title: '无序列表', summary: '在行首输入 -、+ 或 *，后面留一个空格。缩进两个或四个空格可创建子列表。', code: '- 水果\n  - 苹果\n  - 香蕉\n- 蔬菜', result: '显示带圆点的两级列表。' },
  { id: 'ordered-list', group: '内容组织', title: '有序列表', summary: '输入“数字 + 英文句点 + 空格”。实际显示时会自动连续编号。', code: '1. 安装 Zeditor\n2. 新建文档\n3. 开始写作', result: '显示 1、2、3 编号列表。' },
  { id: 'tasks', group: '内容组织', title: '任务列表', summary: '在无序列表标记后添加 [ ] 或 [x]，分别代表未完成和已完成。', code: '- [x] 创建文档\n- [ ] 完成初稿\n- [ ] 检查并发布', result: '显示三个带复选框的任务，其中第一项已完成。' },
  { id: 'quote', group: '内容组织', title: '引用与嵌套引用', summary: '在行首输入 > 和空格。连续使用多个 > 可以嵌套。', code: '> 这是引用内容。\n>\n> 引用中也能分段。\n>> 这是嵌套引用。', result: '显示一段带左侧引导线的引用，其中包含二级引用。' },
  { id: 'divider', group: '内容组织', title: '分隔线', summary: '单独一行输入三个或更多 -、* 或 _。前后最好各空一行。', code: '上半部分\n\n---\n\n下半部分', result: '两段文字之间显示一条水平分隔线。' },
  { id: 'details', group: '内容组织', title: '可折叠内容', summary: '使用 details 和 summary 标签隐藏较长的补充说明。', code: '<details>\n<summary>点击展开</summary>\n\n这里是折叠的详细内容。\n\n</details>', result: '默认只显示“点击展开”，点击后显示详细内容。' },
  { id: 'toc', group: '内容组织', title: '自动目录', summary: '单独输入 [TOC]，根据文档标题生成目录。', code: '[TOC]', result: '预览中显示由各级标题组成的文档目录。', tip: '先规范使用标题层级，目录结构才会清晰。' },

  { id: 'link', group: '链接与媒体', title: '链接', summary: '方括号中写显示文字，紧跟的圆括号中写网址；网址后可加可选标题。', code: '[访问 GitHub](https://github.com "GitHub 首页")\n\n<https://github.com>', result: '第一行显示命名链接，第二行直接把网址变成可点击链接。' },
  { id: 'image', group: '链接与媒体', title: '图片', summary: '在链接语法前加 !。替代文字用于图片加载失败和无障碍阅读，路径后可加标题与显示尺寸。', code: '![一张风景图片](https://example.com/photo.jpg "可选标题")\n\n![本地截图](.assets/截图.png){width=420}', result: '第一行显示网络图片，第二行按 420 像素宽显示本地图片；文件缺失时显示可读提示。', tip: '点击工具栏“图片”选择本地文件会自动复制到文档同级的 .assets 目录；也可以把图片直接拖入窗口或粘贴。双击预览中的图片可修改路径、替代文本与尺寸，右键可快速调整大小。' },
  { id: 'video', group: '链接与媒体', title: '视频', summary: '在线视频填写平台链接，本地视频填写相对路径，预览都会渲染成播放器。', code: '@[video](https://www.youtube.com/watch?v=VIDEO_ID)\n\n@[video](.assets/demo.mp4)\n\n@[video](.assets/demo.mp4){title="演示片段" poster=".assets/cover.jpg"}', result: '第一条是隐私增强的 YouTube 播放器，后两条是带进度、音量与全屏的本地视频播放器，第三条额外显示标题与封面。', tip: '推荐点击工具栏“插入媒体”：选择本地文件会复制到文档同级的 .assets 目录，素材不会随文档移动而失效。' },
  { id: 'audio', group: '链接与媒体', title: '音频', summary: '音频使用 @[audio](...) 写法，支持本地文件与 mp3、wav 等直链。', code: '@[audio](.assets/podcast.mp3){title="第 1 期"}', result: '显示带播放、进度与音量控制的音频播放器，下方是说明文字。', tip: '图片语法中的媒体文件会被自动识别，例如 ![](demo.mp4) 同样渲染成播放器。' },
  { id: 'emoji', group: '链接与媒体', title: 'Emoji', summary: 'Emoji 可以像普通文字一样直接插入标题、段落和列表。', code: '## 今日进度 🚀\n\n- [x] 完成初稿 ✅\n- [ ] 发布文章 📣', result: '显示包含原生 Emoji 的标题和任务列表。' },

  { id: 'inline-code', group: '代码与数据', title: '行内代码', summary: '用一对反引号包住短命令、变量名或文件名。', code: '运行 `npm run build` 构建项目。', result: 'npm run build 会以等宽字体和代码背景显示。' },
  { id: 'code-block', group: '代码与数据', title: '代码块与语法高亮', summary: '用三反引号包住多行代码，开头反引号后写语言名称可启用高亮。', code: fence('javascript', 'function greet(name) {', '  return `你好，${name}！`;', '}', '', "console.log(greet('Zeditor'));"), result: '显示带 JavaScript 语法高亮的代码块。', tip: '常见语言标记包括 javascript、typescript、python、bash、json、css 和 html。' },
  { id: 'table', group: '代码与数据', title: '表格与对齐', summary: '第一行是表头，第二行用 --- 分隔。冒号控制左对齐、居中和右对齐。', code: '| 项目 | 状态 | 进度 |\n| :--- | :---: | ---: |\n| 需求 | 完成 | 100% |\n| 开发 | 进行中 | 60% |', result: '显示三列表格：第一列左对齐，第二列居中，第三列右对齐。', tip: '点击工具栏表格网格拖动选择行列，或用 Ctrl+Shift+T 插入。光标停在表格内会出现浮动工具栏，可增删行列、切换对齐、整理格式；Tab / Shift+Tab 切换单元格，方向键移动，Enter 新增一行。预览中拖动表头右侧竖线可调整列宽，双击把手恢复自动宽度（列宽只影响预览，不写入文档）。' },

  { id: 'math', group: '图表与扩展', title: '数学公式', summary: '单个 $ 用于行内公式，两个 $$ 用于独占一行的块级公式，语法采用 LaTeX。', code: '质能方程是 $E = mc^2$。\n\n$$\n\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n$$', result: '第一条公式嵌入句子，求和公式居中独立显示。' },
  { id: 'flowchart', group: '图表与扩展', title: 'Mermaid 流程图', summary: '在 mermaid 代码块中描述节点和连接关系。', code: fence('mermaid', 'flowchart TD', '  A[开始] --> B{是否完成?}', '  B -- 是 --> C[发布]', '  B -- 否 --> D[继续编辑]', '  D --> B'), result: '渲染为带判断分支的流程图。' },
  { id: 'sequence', group: '图表与扩展', title: 'Mermaid 时序图', summary: '时序图用 participant 定义参与者，用箭头表示消息顺序。', code: fence('mermaid', 'sequenceDiagram', '  participant U as 用户', '  participant A as 应用', '  U->>A: 打开文档', '  A-->>U: 显示预览'), result: '渲染为用户与应用之间的交互时序图。' },
  { id: 'gantt', group: '图表与扩展', title: 'Mermaid 甘特图', summary: '甘特图适合展示项目阶段、日期和任务依赖。', code: fence('mermaid', 'gantt', '  title 写作计划', '  dateFormat YYYY-MM-DD', '  section 内容', '  初稿 :done, a1, 2026-07-01, 3d', '  修订 :active, after a1, 2d', '  发布 :after a1, 2026-07-06, 1d'), result: '渲染为包含初稿、修订和发布阶段的甘特图。' },
  { id: 'html', group: '图表与扩展', title: 'HTML 与注释', summary: '需要更精细控制时可以嵌入 HTML；注释只在源码中可见。', code: '<div align="center">居中的文字</div>\n\n<!-- 这条备注不会出现在预览中 -->', result: '第一行居中显示，注释在预览中隐藏。', tip: '仅在 Markdown 本身无法表达时使用 HTML，以保持文档易读。' },
  { id: 'page-break', group: '图表与扩展', title: '导出分页符', summary: '需要控制 PDF 或打印分页时，插入带 page-break-after 的空元素。', code: '<div style="page-break-after: always;"></div>', result: '导出或打印时从下一页继续后续内容。' },
];

const GROUPS = [...new Set(SYNTAX_ITEMS.map((item) => item.group))];

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

export function MarkdownSyntaxGuide() {
  const [query, setQuery] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
  const visibleItems = useMemo(() => normalizedQuery
    ? SYNTAX_ITEMS.filter((item) => `${item.title} ${item.summary} ${item.group} ${item.code}`.toLocaleLowerCase('zh-CN').includes(normalizedQuery))
    : SYNTAX_ITEMS, [normalizedQuery]);

  const copy = async (id: string, code: string) => {
    await copyText(code);
    setCopiedId(id);
    window.setTimeout(() => setCopiedId((current) => current === id ? null : current), 1600);
  };

  const fullExample = SYNTAX_ITEMS.map((item) => `<!-- ${item.title} -->\n${item.code}`).join('\n\n');

  return (
    <div className="markdown-syntax-guide">
      <aside className="syntax-guide-sidebar" aria-label="Markdown 语法分类">
        <div className="syntax-guide-start">
          <strong>3 分钟快速开始</strong>
          <ol>
            <li>标记后通常要留空格</li>
            <li>段落之间空一行</li>
            <li>边写边看右侧预览</li>
          </ol>
        </div>
        <nav>
          {GROUPS.map((group) => (
            <button key={group} onClick={() => document.getElementById(`syntax-${visibleItems.find((item) => item.group === group)?.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
              <span>{group}</span><small>{SYNTAX_ITEMS.filter((item) => item.group === group).length}</small>
            </button>
          ))}
        </nav>
      </aside>

      <main className="syntax-guide-main">
        <div className="syntax-guide-toolbar">
          <label className="syntax-guide-search">
            <span aria-hidden="true">⌕</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索语法，例如：表格、流程图、图片" aria-label="搜索 Markdown 语法" />
          </label>
          <button className="syntax-copy-all" onClick={() => void copy('all', fullExample)}>{copiedId === 'all' ? '已复制完整示例' : '复制完整示例'}</button>
        </div>

        <div className="syntax-guide-intro">
          <div><span>入门指南</span><h3>从一个符号开始写 Markdown</h3></div>
          <p>每项都包含可直接粘贴的语法和预期效果。建议先复制示例到新文档，再替换成自己的内容。</p>
        </div>

        <div className="syntax-guide-list">
          {visibleItems.map((item) => (
            <section id={`syntax-${item.id}`} className="syntax-guide-card" key={item.id}>
              <div className="syntax-card-heading">
                <div><span>{item.group}</span><h4>{item.title}</h4></div>
                <button onClick={() => void copy(item.id, item.code)} aria-label={`复制${item.title}语法`}>{copiedId === item.id ? '已复制' : '复制语法'}</button>
              </div>
              <p className="syntax-card-summary">{item.summary}</p>
              <div className="syntax-card-example">
                <div className="syntax-code-label">MARKDOWN</div>
                <pre><code>{item.code}</code></pre>
              </div>
              <div className="syntax-card-result"><strong>你会看到</strong><span>{item.result}</span></div>
              {item.tip && <div className="syntax-card-tip"><strong>提示</strong><span>{item.tip}</span></div>}
            </section>
          ))}
          {visibleItems.length === 0 && <div className="syntax-guide-empty"><strong>没有找到相关语法</strong><span>试试“标题”“列表”“图片”或“Mermaid”。</span></div>}
        </div>
      </main>
    </div>
  );
}
