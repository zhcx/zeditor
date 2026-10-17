# 编辑器第四轮：代码语言提示与标题转换修复

日期：2026-10-17。接续 [r3 布局与性能交接](./wysiwyg-handoff-2026-10-17-r3.md)。本轮保留已有未提交成果，没有提交或推送。

## 完成内容

### 代码预览语言提示

- 源码对照的预览区、沉浸阅读的代码块顶部显示简洁语言栏，沿用主题颜色、细边框和 8px 圆角。
- 已识别语言直接显示原名称；未注册高亮的语言也保留名称；未指定语言显示“纯文本”。
- 提示仅作用于预览；所见即所得保留现有语言选择控件，不叠加第二个提示。
- 代码文本不变。语言名以 `textContent` 插入；未知语言的 class 按 HTML 属性转义，不能插入标签或属性。
- 图表增强仍能以原 `code.parentElement` 替换完整 `pre`，不会遗留语言栏。

### 选中文字转换标题

用户反馈：在任一编辑模式选择文字后，从快捷栏选标题，文字没有变成标题，而是在旁边出现一行空标题。

已复现于源码、所见即所得、沉浸写作三种模式。根因是 `Toolbar` 的 H1–H6 动作调用 `insertBlock`：只插入标记和换行，没有转换已有文字。右键菜单另有独立实现，只处理选区首行，行为也不一致。

现在固定工具栏、浮动快捷栏、右键菜单共用 `headingFormatting`：

- 在现有行添加或替换标题标记，不插入空标题行或额外换行。
- 部分文字被选中时，转换所在整行，保持全部文字和原选区内容。
- 多行选区逐行处理非空行，保留空行；选区结束于下一行开头时，不修改该未选中行。
- 原有标题切换级别时替换旧标记，不重复叠加。
- 保留 CRLF 等换行形式；通过一次文档替换形成一笔撤销记录。
- 无选区时转换光标所在行，实际空行仍可创建待输入的空标题。

例：选择“需要转换的文字”后设为二级标题，源码由原行变成 `## 需要转换的文字`，前后段落与空行保持不变。

## 修改文件

| 文件 | 内容 |
| --- | --- |
| `src/components/Preview/Preview.tsx` | 渲染代码语言提示 |
| `src/components/Preview/code-language.css` | 语言栏与代码区样式 |
| `src/utils/markdownPipeline.ts` | 保留并安全转义未知语言 class |
| `src/utils/headingFormatting.ts` | 按选区转换标题，映射选区与统一执行入口 |
| `src/components/Toolbar/Toolbar.tsx` | 固定/浮动工具栏切到统一标题转换 |
| `src/components/Editor/EditorContextMenu.tsx` | 右键菜单采用同一逻辑 |
| `tests/markdownPipeline.test.ts` | 未知语言和属性转义回归 |
| `tests/headingFormatting.test.ts` | 单行、部分、多行、CRLF、六级标题、无选区和幂等回归 |
| `scripts/verify-code-language-preview.mjs` | 预览、阅读、主题、所见即所得不重复、源码不变 |
| `scripts/verify-heading-formatting.mjs` | 三种模式下浮动/固定/右键入口、显示、选区、撤销重做 |

## 验证

- TypeScript、Lint、生产前端构建通过。
- 完整单元测试：**589/589**。
- 代码语言提示浏览器回归：**4/4**。
- 标题转换浏览器回归：**13/13**，实际标题显示、选区保留、撤销重做通过。
- 既有布局与模式一致性回归：**27/27**。
- 既有所见即所得编辑回归：**30/30**。
- 合计 **74 项浏览器用例**，无未捕获页面异常。
- 独立只读代码审查：未发现可操作的数据丢失或选区问题。

回归截图和日志：`test-output/code-language-preview/`、`test-output/heading-formatting/`、`test-output/code-preview-heading-r4-2026-10-17/`。

## 恢复与重跑

本轮修改前备份：`C:\Users\zhcx\AppData\Local\Temp\zeditor-code-language-before-20261017-140207\`，包含预览、渲染管线、工具栏、公共右键菜单和管线测试的本轮开始状态。

```powershell
npx tsc -b --force
npm run lint
npm test
npm run build

npm run dev -- --host 127.0.0.1 --port 5199 --strictPort
$env:PLAYWRIGHT_MODULE_PATH='C:\Users\zhcx\AppData\Local\npm-cache\_npx\9833c18b2d85bc59\node_modules\playwright\index.mjs'
node scripts/verify-code-language-preview.mjs
node scripts/verify-heading-formatting.mjs
node scripts/verify-panel-layout.mjs
node scripts/verify-wysiwyg-browser.mjs

npm run tauri -- build --bundles nsis --no-sign --ci
```

保留 r3 的宽度、自适应与性能行为。未执行安装后的真实输入法、高 DPI 人工验收。

## Windows 安装包

- 原生 release 与 NSIS 打包成功，编译耗时 5 分 59 秒。
- 归档：`test-output/code-preview-heading-r4-2026-10-17/Zeditor_0.6.3_x64-code-preview-heading-r4-setup.exe`。
- 大小：7,950,678 字节。
- SHA-256：`82022938584A042281F1085CACD7830FE21F8037B9CE16B9E5D6333685DE150F`。
- 归档副本与构建产物哈希一致；测试包未签名，未自动安装。
