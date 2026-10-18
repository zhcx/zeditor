# 2026-10-18 新增功能稳定性审查

审查分支：`feat/editor-display-wheel-block-menu`。审查基线：`c2c6ef4`，版本仍为 0.6.4。本轮修改保留在本地工作区，未提交、未推送、未发版。

## 已确认并修复的问题

| 范围 | 问题与影响 | 修复 |
| --- | --- | --- |
| 增量分块 | 只判断单块类型，会漏掉相邻列表合并、未闭合围栏/HTML 吞块、Setext 标题边界、清空段落及换行变化，造成后续块位置与全文解析不一致 | 快路径限于换行、缩进和结构均稳定的可编辑段落/标题，其余走完整解析；普通文字编辑保留快路径 |
| 脚注渲染 | `[^n]: 单词` 被 MarkdownIt 当作普通链接定义，定义消失、引用变成 URL；公式预处理还会把定义原文变成 KaTeX HTML | 增加脚注定义规则；预处理前提取原始定义，保护定义前缀；普通 Markdown 引用保持原行为 |
| 脚注编辑 | 定义括号和带下划线的名称被回写转义；Enter 分割破坏前缀；多行续行缩进在普通段落 DOM 中丢失 | 保留完整定义前缀并统一偏移映射；多行定义使用现有块源码编辑，保留空格、Tab 和空行续行 |
| 脚注悬停 | 所见即所得逐块渲染时拿不到其他块中的定义，定义修改后提示过期，新输入的引用没有事件监听 | 编辑表面统一委托事件，悬停读取最新全文；只更新引用元数据，不重建编辑 DOM；浮层自身允许滚动 |
| Wiki/脚注光标 | 原子元素内部没有正确的源码映射，相邻链接可能点中前一个；Enter 克隆半个原子导致重复链接，格式化 Wiki 段落的光标回退失效 | 原子映射到源码两侧，点击落入所点元素内部偏移；结构编辑前吸附范围到原子边界 |
| 标题折叠 | 在末尾空标题上使用折叠快捷键，可能折叠前一个无关章节 | 查找章节时同时校验首尾块索引 |
| Wiki 解析 | 其他目录已开的同名笔记抢占当前目录目标；显式错误路径退化成任意同名文件；未完整支持 `.markdown` | 桌面端先按上下文解析磁盘路径；显式路径不做同名兜底；歧义目标保持未解析；两种 Markdown 扩展名均支持 |
| 异步导航 | 慢解析/慢读取完成后可能打断用户已经切换的标签或新的导航；编辑器尚未载入目标内容就定位 | 正反向链接共用导航序号、原标签检查及现有文件读取取消回调；编辑器正文就绪后再定位 |
| 反向链接 | 代码和注释中的示例被算作引用；正向解析与反向匹配规则不一致；空列表无法刷新；纯浏览器显示永久加载 | 共用目标解析规则，排除围栏/行内/缩进代码、转义及 HTML 注释；空结果保留刷新入口；浏览器不进入原生加载状态 |
| 扫描负载 | 目录只有非 Markdown 文件时原文件数限制不能约束遍历；大量不同 Wiki 目标同时启动原生扫描 | 增加 30,000 目录项预算，保留深度/文件预算；同请求合并，单批最多 4 个扫描；缓存包含工作区根及标签路径 |
| macOS 菜单 | 原生菜单闭包保存旧正文，导出可能漏掉最新修改；AI 面板/链接检查快捷键被窗口与原生菜单重复执行；过期菜单异步安装 | 点击时读取最新菜单动作；原生加速键生效时窗口监听让位；取消过期安装，保留 F2 回退 |
| macOS CLI | 能发现绝对路径但子进程缺少 Node/Homebrew 等 PATH，脚本及其工具仍启动失败；PATH 缺失时还可能找不到系统工具 | 仅扩展子进程环境，优先 CLI 所在运行时目录，继承已有路径并补齐安装目录及 `/usr/bin`、`/bin`、`/usr/sbin`、`/sbin` |
| macOS CI | 默认 ad-hoc identity 及空 `APPLE_*` 环境变量触发错误签名路径；嵌套辅助程序的签名顺序不当 | 去掉强制 identity，按配置导出签名/公证变量并提前拒绝不完整凭证；辅助程序先于主程序签名 |

主要修改位置：`src/utils/wysiwyg/`、`src/components/Wysiwyg/`、`src/utils/markdownPipeline.ts`、`src/utils/markdownEnhancers.tsx`、`src/services/wikiLinks.ts`、`src/components/Sidebar/BacklinksSection.tsx`、`src/components/MenuBar/MenuBar.tsx`、`src/App.tsx`、`src-tauri/src/commands.rs`、`src-tauri/src/agent/process.rs`、macOS 构建配置。

## 验证

| 检查 | 结果 |
| --- | --- |
| `node node_modules/typescript/bin/tsc -b` | 通过 |
| `npm run lint` | 通过，0 error / 0 warning |
| `npm test` | 687 项通过，0 失败 |
| `npm run build` | 通过 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | 通过 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings` | 通过 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | 182 项通过，3 项原有忽略项，0 失败 |
| `scripts/verify-editor-display.mjs` | 隔离 Edge，10 个场景通过：滑块跟随、无反弹、源码/预览/WYS 比例、960/1440/2560 视口、折叠、Escape 取消及长文档拖动 |
| `scripts/verify-wheel-block-menu.mjs` | 隔离 Edge，25 个场景通过：滚轮行宽、快捷键、块转换/插入、连续编辑与撤销等 |
| `scripts/verify-notes-stability.mjs` | 隔离 Edge，9 个场景通过：脚注全文悬停/动态输入/定义更新、单行定义 Enter、多行源码编辑、Wiki 相邻点击/结构编辑/撤销、空标题折叠 |
| `git -c core.whitespace=cr-at-eol diff --check` | 通过 |

增量分块另完成 12,336 组与全文解析的差分比较。新回归覆盖正向/反向链接在文件读取期间遇到手动切换标签或更新导航，四种组合均先复现失败，再验证修复。

300 段落实测中，所见即所得和分屏拖动的 P95 帧间隔均约 16.8 ms，低于脚本 50 ms 阈值；最大帧间隔约 166.7 ms，仍观察到少量 68–181 ms 长任务。这是本机单次测量，不能据此宣称所有长文档均无卡顿。

## 验证边界与记录

- 当前环境为 Windows。未在真实 macOS 设备上复测原生菜单、签名、公证或 Intel/Apple Silicon 安装运行；已验证配置逻辑和可在 Windows 执行的回归，macOS 发布仍需对应 CI/设备验证。
- Rust 原有忽略项涉及真实本地 CLI、长文本 Agent 调用及代理回退，没有把它们计入通过数量。
- 构建保留 Lightning CSS 对现有 `::highlight(wysiwyg-proofread)` 的识别警告；构建退出码为 0。该功能已有浏览器能力检查，没有为消除警告而修改标准 CSS 语法。
- 浏览器测试只使用隔离会话和内存文档。未覆盖用户运行中的桌面程序或重新生成安装包。
- 审查前快照：`test-output/工作交流旧版本号-20261018-稳定性审查前-211705/`；其他基线文件可由 `c2c6ef4` 恢复。该目录及验证日志不入库。
- 验证日志：`test-output/audit-final-*.log`、`audit-display-browser.log`、`audit-wheel-browser.log`、`audit-notes-browser.log`。浏览器脚本需要可用的 Playwright；本轮复用了本机缓存，无新增项目依赖。
