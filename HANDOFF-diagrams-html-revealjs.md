# Zeditor 图表 / 富文本粘贴 / 演示模式支线交接

> 2026-09-19 深入复查已完成一轮修复，最新结果见 [复查记录](docs/reviews/diagrams-html-revealjs-review.md)。下文保留首次交接快照；其中“183 项测试”、粘贴监听位置、任务列表待测等描述已由复查记录更新。

更新：2026-09-19。分支 `feature/diagrams-html-revealjs`，基线 `main@c493c09 (release: v0.4.5)`。

**当前状态：功能已开发完成并通过自检，改动全部停留在工作区，尚未提交、未发版。**
本文档描述如何接手：改动地图 → 设计不变量 → 已修缺陷 → 验证方式 → 待办与风险。

## 一、改动地图（文件 → 职责）

### 新增

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/components/Presentation/PresentationView.tsx` | 199 | 演示模式全屏组件：markdown → 幻灯片 → Reveal.js，含 Mermaid/KaTeX/代码高亮/暗色适配/Esc 退出 |
| `src/utils/markdownToSlides.ts` | 63 | 按顶层 `---` 拆分幻灯片；识别并移除 YAML frontmatter；`isSlideCompatible` |
| `src/utils/htmlToMarkdown.ts` | 332 | 纯正则 HTML→Markdown（无 DOMParser，浏览器/Node 通用）+ `shouldConvertHtmlToMarkdown` 粘贴判定 |
| `src/styles/presentation.css` | 216 | 演示浮层、退出按钮、幻灯片排版、暗色主题与 Mermaid/KaTeX 容器样式 |
| `tests/markdownToSlides.test.ts` | — | 拆分语义（代码围栏/frontmatter/首行 `---`/连续分隔符） |
| `tests/htmlToMarkdown.test.ts` | — | 转换正确性与粘贴判定边界 |

### 修改

| 文件 | 位置锚点 | 内容 |
|------|----------|------|
| `src/App.tsx` | 132-133 状态、222-226 事件监听、1115-1118 渲染 | `presentationVisible` 状态、`closePresentation`(useCallback)、监听 `zeditor-presentation-request`、懒加载渲染浮层 |
| `src/components/MenuBar/MenuBar.tsx` | 674 | 「功能 → 演示模式」菜单项，派发 `zeditor-presentation-request` |
| `src/components/Editor/Editor.tsx` | 639-656 `handlePaste` | 剪贴板 HTML → Markdown 分支（在图片分支之前），注册于 `.editor-content.monaco-host` 的 capture paste |
| `src/utils/slashCommands.ts` | 73-77 | 新增 `/gantt` `/sequence` `/state` `/class` `/slide` |
| `src/components/Preview/Preview.tsx` | 290-306 | 预览区点击任务列表 checkbox 直接改写源码 `- [ ]` ↔ `- [x]`（**本支线遗留、未经测试验证，见第五节**） |
| `package.json` / `package-lock.json` | — | 新增依赖 `reveal.js@^6.0.2`（无 Rust 侧改动） |
| `README.md` | 63-64、72、336、353 | 功能、技术栈、目录结构说明 |

## 二、关键实现与不变量（改动前务必先读）

1. **幻灯片拆分语义**（`markdownToSlides.ts`）
   - 顶层 `---`（含 `----`）为分隔符；代码围栏（``` / ~~~）内部的 `---` 不分隔；`--- 文本` 不分隔。
   - 首行 `---` **只有在到下一个 `---` 之间存在 `key: value` 行时**才判定为 YAML frontmatter，此时整块被移出幻灯片；否则首行 `---` 只是普通分隔符（会产出空首片段）。
   - 连续/结尾分隔符产生的空片段由 `PresentationView` 侧过滤，工具函数本身保留空片段（便于测试与调用方自行决定）。
2. **代码片段占位符机制**（`htmlToMarkdown.ts`）
   - `<pre><code>`、`<pre>`、行内 `<code>` 先抽成私有区占位符 `\uE000N\uE001`，在所有标签清理与实体解码之后（第 20 步）再还原。
   - 目的：代码内的 `<` `>` `&` 不被“移除残余标签”“实体解码”误伤。**不要**在占位符还原前引入会读写正文的正则。
   - 标签清理正则统一为 `<[a-zA-Z/!][^>]*>`，避免吃掉正文里的裸 `<`（如 `1 < 2`）。
3. **粘贴判定**（`shouldConvertHtmlToMarkdown(html, plainText)` → 三个条件同时满足才转换）
   - 含可映射 Markdown 语义的标签；纯文本不是 HTML 源码（`^\s*<[a-z!/]`）；转换结果与纯文本不同（`normalize` 后比较）——最后一条保证不会无意义拦截原生粘贴。
   - `Editor.handlePaste` 命中后 `preventDefault()` 并用 `controller.replaceRange` 插入；未命中则 `return`，交回 Monaco 原生粘贴。
4. **演示模式生命周期**
   - 入口：菜单派发 `zeditor-presentation-request` → `App` 置 `presentationVisible`（懒加载 chunk）。
   - 渲染：`splitMarkdownToSlides(content)` → 过滤空片段 → `md.render(renderMath(...))` → `sanitizeRenderedHtml` → `<section>`；无内容时输出提示页。
   - 退出：`window` **capture** 阶段监听 Esc（`onExitRef` 取最新回调，`handleKeyDown` 无依赖），`deck.destroy()` 会清掉 `html.reveal-full-page` 与 `body.reveal-viewport`（已实测确认）。
   - `onExit` 必须保持引用稳定（`App` 已用 `useCallback`；组件内亦用 ref 兜底），否则父级重渲染会重建 deck 并跳回第 1 页。
   - Mermaid 用动态 `import('mermaid')`，逐个替换图表后调用 `deck.layout()` 重排；`cancelled` 标志防止关闭后仍写 DOM。
5. **Reveal.js 6 的样式导入必须走 exports 映射**：`reveal.js/reveal.css`、`reveal.js/theme/white.css`。写成 `reveal.js/dist/...` 会导致生产构建失败（`is not exported under the conditions ...`）。
6. **斜杠命令占位选中**：`insertion(text, selectionStart, selectionEnd)`，`selectionStart/End` 指向待替换的占位文字（如 `项目计划`、`类名`）。`tests/slashCommands.test.ts` 已按占位文字锁定，改动命令文本必须同步改下标。

## 三、本次自检发现并修复的缺陷

1. **生产构建失败（阻断级）**：`reveal.js/dist/*.css` 不在包的 `exports` 中 → 改用 `reveal.js/reveal.css` + `reveal.js/theme/white.css`。
2. **HTML 转换器吞正文**：行内代码 `&lt;` 解码后，第 18 步“移除残余标签”会从该 `<` 一直吃到后文某个 `>`，导致内容丢失 → 引入占位符机制 + 收紧标签正则。
3. **新增 Mermaid 命令选中错位**：`/gantt` `/sequence` `/state` `/class` 的选中范围偏移 2 个字符（PowerShell 计算下标时把 ``` 反引号转义了，导致最初取值错误）→ 从源码字符串重新精确计算为 `25/29`、`46/48`、`37/40`、`32/34`，并加测试锁定。
4. **`tsc` 报错**：`htmlToMarkdown.ts` 中未使用的 `theadContent`（TS6133）；`isHeader` 无用初始化（ESLint `no-useless-assignment`）。
5. **演示模式 deck 反复重建**：`onExit` 每次渲染都是新函数 → 用 ref 稳定并移除 effect 依赖；同时移除与 capture 监听重复的 Reveal 键盘 27 映射。
6. **frontmatter 误判**：`---\n# 第一页\n---\n# 第二页` 曾因“首行 `---` 即 frontmatter”被判成单页 → 改为需要 `key: value` 才算 frontmatter；并过滤空片段，避免空白页。

## 四、验证结果

环境：Windows x64，Node v25.9.0，Vite 8.1.5。

### 已自动化（本机全绿）

```text
npm test      # 183 项通过（原 169，本次新增 14）
npm run lint  # 0 错误
npx tsc -b    # 0 错误
npm run build # 成功；PresentationView 懒加载分块 123.48 kB JS + 633.51 kB CSS
```

### 浏览器端到端实测（Vite dev + Edge，本机已跑通）

```powershell
# 1. 启动开发服务器（tauri API 均有 __TAURI_INTERNALS__ 守卫，浏览器可直接预览）
cd d:\Documents\Code\zeditor; npm run dev        # http://localhost:5173

# 2. 用 agent-browser 驱动（本机 Edge 已存在，无需下载 Chromium）
agent-browser open http://localhost:5173 --executable-path "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
agent-browser click ".monaco-editor .view-lines"     # 先点编辑器拿到焦点
agent-browser keyboard type "# 演示首页"
agent-browser press Enter
agent-browser keyboard type "---"
agent-browser press Enter
agent-browser keyboard type "## 第二页"
agent-browser click <功能菜单 ref>; agent-browser click <演示模式 ref>
agent-browser eval "document.querySelectorAll('.reveal .slides section').length"   # 期望 2
agent-browser screenshot
agent-browser press Escape
agent-browser eval "JSON.stringify({overlay:!!document.querySelector('.presentation-overlay'), htmlClass:document.documentElement.className, bodyViewport:document.body.classList.contains('reveal-viewport')})"
# 期望 {"overlay":false,"htmlClass":"","bodyViewport":false}
agent-browser close
```

实测结论：

- 演示模式：2 张幻灯片、标题/正文渲染正确、暗色主题适配、Reveal 控制条正常、`→` 翻页正常。
- 退出：`Esc` 后浮层消失，`reveal-full-page` / `reveal-viewport` 被 Reveal `destroy()` 清除，编辑器与预览恢复可用。
- 富文本粘贴：构造 `text/html + text/plain` 的 `ClipboardEvent` 后，编辑器插入的是转换结果（`## 标题`、`- 列表项`），**且未再插入纯文本**（说明 `preventDefault` 生效）。

> 注意：合成 `ClipboardEvent` 与真实系统粘贴仍有差异（首次试跑出现了未转换的假象，重复验证后确认为测试手法问题）。**真实剪贴板粘贴（网页/Word → Zeditor）尚未人工验证，见第五节第 1 条。**

## 五、未完成 / 待确认（按优先级）

1. **真实环境人工验证缺失（最高优先）**
   - 真实系统剪贴板富文本粘贴；建议同时验证：复制网页带链接段落、Word 表格、复制 HTML 源码（应走原生粘贴不转换）、复制图片（仍走图床上传分支）。
   - Tauri 桌面端（WebView2）演示模式：真实窗口尺寸、`controls` 点击、Esc 与「退出」按钮、`tauri.conf.json` CSP 是否影响 Reveal 的动态样式（参考 `HANDOFF-editor-top-blink.md` 的 CSP 教训）。
2. **`Preview.tsx` 任务列表 checkbox 切换未经测试**（本支线遗留，本次未改动其代码）
   - 代码位置 `src/components/Preview/Preview.tsx:290-306`；依赖 `li[data-source-line]` 与 `editorView.replaceRange`。
   - 已知缺口：只识别 `- [ ]` / `- [x]` / `- [X]`；用 `*`、`+` 作列表符号或带前导缩进/引用时可能静默不生效；无对应单测。
   - 建议补：`tests` 层难以覆盖 DOM，可抽纯函数（`toggleTaskLine(line)`）后加单测 + 浏览器或桌面端手测。
3. **粘贴位置粘连**：`htmlToMarkdown` 输出已被 `trim()`，在行中间粘贴会得到 `前文## 标题`，不构成合法标题。当前选择“原样插入转换结果”，若要求更友好，可在 `handlePaste` 内判断前一字符非换行且 Markdown 以块级标记开头时补 `\n`。属产品决策，未实施。
4. **`reveal.js` 主题 CSS 体积**：`PresentationView` CSS 分块 633 kB（主题内嵌字体，gzip 443 kB），仅懒加载时下载。若要瘦身，可只保留 `reveal.css` 并自写主题（`presentation.css` 已覆盖大部分排版）。
5. **`isSlideCompatible` 目前无生产调用方**（仅测试使用）。决策二选一：接入菜单做禁用/提示，或删除以免成为死代码。
6. **提交与发版尚未执行**（遵循“不主动提交”约定）：涉及版本同步 `package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml`（`tests/releaseCompliance.test.ts` 会强制一致性）、`CHANGELOG.md`、`docs/releases/v0.4.6.md`。
7. **`.codebuddy/` 目录未被忽略**（`git status` 中显示为未跟踪）。要么提交，要么加入 `.gitignore`，由仓库维护者决定。

## 六、回归命令清单

```text
npm test                 # 183 项
npm run lint
npx tsc -b
npm run build
npm run tauri dev        # 需要桌面端验证时
```

## 七、快速定位锚点

- 事件名：`zeditor-presentation-request`（`MenuBar.tsx:674` → `App.tsx:224`）
- 命令 id：`gantt` / `sequence` / `state` / `class-diagram` / `slide`（`slashCommands.ts:73-77`）
- 关键函数：`splitMarkdownToSlides` / `findFrontmatterEnd` / `htmlToMarkdown` / `shouldConvertHtmlToMarkdown` / `handlePaste`
- 已删除：仓库根目录误产生的 `-w`（一份 dev server HTML 快照）

## 八、参考

- `HANDOFF-editor-top-blink.md`：WebView2 CSP 与 Monaco 行样式注入的历史教训（演示模式的动态样式同源风险）
- Reveal.js 6 包导出映射：`node_modules/reveal.js/package.json` 的 `exports`
- `AGENTS.md`（工作区根）：提交信息中文、最小改动、注释中文
