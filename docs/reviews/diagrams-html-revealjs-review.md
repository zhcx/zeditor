# 图表、富文本粘贴与演示模式复查

日期：2026-09-19。分支：`feature/diagrams-html-revealjs`。版本仍为 0.4.5。

本轮以 `HANDOFF-diagrams-html-revealjs.md` 为范围，检查相关实现、依赖源码、自动化测试和浏览器行为。接手时已有未提交改动，全部保留；本轮未提交、未发版，未修改 Rust 后端。

## 修复结果

| 问题 | 修复与验证 |
| --- | --- |
| 富文本有时仍按纯文本粘贴 | Monaco 的 CopyPasteController 在编辑器根节点提前注册 capture listener，并截断后续监听。改到父容器 capture，限定事件目标在编辑器内，转换后停止传播。两个输入引擎均通过浏览器回归。 |
| 块内容与光标前后正文粘连，行内格式附加换行 | 新增 `prepareMarkdownPaste`：块内容补段落边界，行内格式去掉转换器附加的结尾换行，兼容 CRLF。 |
| 一次撤销连带撤销此前的编辑 | `EditorController.replaceRange` 前后设置 Monaco undo stop，程序化替换按次撤销；粘贴和任务切换均验证。 |
| 预览任务复选框不能点击、切换方向错误 | 插件默认输出 disabled；仅在预览 DOM 启用任务框，演示模式仍只读。按源码切换标记，支持 `-`、`*`、`+`、有序列表、缩进和引用，校验预览是否过期。 |
| 同类型嵌套列表丢内容，嵌套有序列表缩进不合法 | 从最内层列表转换，子项按父项编号宽度缩进，保留多层子项及同级项。 |
| 实体重复解码和标题/列表中的转义文本丢失 | 延后正文实体解码并只解码一次；数值实体支持完整 Unicode，非法码点使用替代字符。 |
| 属性读取混淆 `data-src` 与 `src` | 属性匹配增加名称边界。 |
| 代码块空行、内嵌反引号、高亮标签处理错误 | 代码先保护；清理外围空行后还原；按内容选择足够长的围栏；移除高亮标签但保留代码文本与 `<br>` 换行；占位符避免与原文碰撞。 |
| 嵌套引用、表格竖线和单元格换行丢失 | 引用从内向外处理；表格内竖线转义，换行转为 `<br>`；链接和表格中的强调格式保留。 |
| 围栏行带文字也会关闭代码块 | 关闭围栏要求相同标记、足够长度且无尾随内容；四空格缩进的代码不再误开启顶层围栏。 |
| 演示仍保留编辑器焦点，外链可导航整个应用 | 进入时转移焦点，限制 Tab 焦点范围，退出恢复焦点；外链交给独立窗口或系统浏览器，并限制协议。 |
| Mermaid 异步加载失败不被捕获，关闭后仍排队渲染 | 返回 import promise，串行渲染图表，每次开始及完成时检查取消状态；非取消错误记录到控制台。 |
| Mermaid 只显示图形，不显示节点文字 | 截图发现默认 HTML 标签通过 foreignObject 输出，被 DOMPurify 清洗移除。预览和演示都设置 `htmlLabels: false`，使用 SVG 文字；浏览器回归断言两个区域的节点 A、B 文本确实存在。 |
| 暗色演示表格继承白色主题文字色 | 演示根节点继承应用文字颜色。 |

## 验证结果

- 接手基线：183 项单元测试通过。
- 修复后：`npm test` 195 项通过；`npm run lint` 通过；`npm run build` 通过，包含 `tsc -b`。
- Edge + Vite 独立会话：EditContext / textarea 富文本粘贴、行内粘贴、HTML 源码直通、独立撤销、任务列表变体及撤销通过。
- 演示：菜单进入、两页拆分、键盘翻页和控制按钮、Mermaid 图形及节点文字、只读任务框、焦点转移、外链、Esc 退出、按钮退出、再次进入及全局 class 清理通过。
- 浏览器回归脚本：`scripts/verify-diagrams-browser.js`，使用合成 ClipboardEvent；只应在独立测试会话运行，它会替换测试标签页内容。

复现命令（先在另一终端启动开发服务器）：

```powershell
npm run dev -- --host 127.0.0.1 --port 5178 --strictPort
```

```powershell
agent-browser --session zeditor-review open http://127.0.0.1:5178 --executable-path 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$script = Get-Content -LiteralPath scripts/verify-diagrams-browser.js -Encoding UTF8 -Raw
$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($script))
agent-browser --session zeditor-review eval -b $encoded
agent-browser --session zeditor-review close
```

## 验证边界与后续事项

- 真实剪贴板验证尝试受浏览器权限限制：`navigator.clipboard.write` 返回 `NotAllowedError`，`execCommand('copy')` 返回 false。网页/Word → 系统剪贴板 → 编辑器的完整流程仍需桌面验证。
- Tauri / WebView2 窗口、原生图床上传链路未实测。CSP 中已有 `style-src 'unsafe-inline'` 及对应配置，本轮只进行了静态检查，不能视为桌面实测。
- 转换器仍为正则实现，未声明支持任意 HTML DOM、Word 合并单元格或所有命名实体；复杂文档应继续增加真实样例。
- 保留单页文档进入演示的能力，未将 `isSlideCompatible` 用作菜单禁用条件。
- Reveal 白色主题内嵌字体造成的 CSS 体积仍待优化。生产构建仍提示主包体积较大，以及 UnsavedChangesDialog 同时静态/动态导入；均不阻断本次构建。
- `.codebuddy/` 的跟踪策略、版本升级、提交和发版保持原状态。
