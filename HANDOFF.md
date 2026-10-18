# HANDOFF：feat/editor-display-wheel-block-menu

## 当前接续状态（2026-10-18 v0.6.5 已发布）

- 版本号已升到 **0.6.5**，稳定性审查修复已提交（`ca03ce7`），发布改动为 `756f2c0`，已快进合并到 `main` 并推送 GitHub；标签 `v0.6.5` 已推送。
- GitHub Actions 发布成功（run 39135604211，约 26 分钟）：质量门禁 10m13s，macOS Apple Silicon / Intel、Linux x64、Windows x64 四个平台构建全部通过，Release <https://github.com/zhcx/zeditor/releases/tag/v0.6.5> 已上传 9 个资产（MSI、NSIS、两个 DMG、两个 `.app.tar.gz`、deb、rpm、AppImage）。
- 文档站（Deploy Docs）随 `main` 自动部署成功；README、CHANGELOG、`docs/releases/v0.6.5.md`、使用指南与文档站已同步到 v0.6.5。
- 以下「本轮审查修复保留在本地工作区」为审查当时的记录，已过时。
- 已修复增量分块边界、Wiki/脚注光标与 Enter 完整性、脚注定义/悬停、空标题折叠、Wiki 路径/反向链接/异步导航，以及 macOS 菜单、CLI 子进程环境和签名配置问题。
- 完整验证：TypeScript、ESLint、构建、Rust fmt/严格 Clippy 通过；前端 687 项通过；Rust 182 项通过、3 项原有忽略项；隔离 Edge 浏览器 44 个场景通过。
- 300 段落拖动 P95 约 16.8 ms，但仍有少量长任务；真实 macOS 原生行为、签名公证和安装运行尚需对应环境复测。本轮没有重新打安装包。
- 详细问题、修改和验证边界见 [稳定性审查记录](docs/reviews/2026-10-18-stability-audit.md)。审查前快照在 `test-output/工作交流旧版本号-20261018-稳定性审查前-211705/`。

---

> 以下保留上一轮随 `c2c6ef4` 提交的交接内容供追溯。其中“未提交”、测试数量、签名配置和产物状态均为历史记录；继续工作以本页顶部及本轮审查记录为准。

最后更新：2026-10-18
版本：0.6.4（未发版）
基线：`f0795ea`（main），支线最新提交 `096965d`（显示增强）
状态：**工作区有大量未提交改动**（macOS 适配、性能优化、双向链接、脚注悬停预览）

## 1. 当前状态一览

| 项目 | 状态 |
| --- | --- |
| 分支 | `feat/editor-display-wheel-block-menu`，跟踪 `origin` 同名分支 |
| 已提交 | `096965d feat(editor): improve display controls and block actions` |
| 未提交 | 40 个修改文件 + 6 个新增文件（约 +1477 / −99，不含新增文件） |
| 版本号 | 仍为 0.6.4，`CHANGELOG.md` 未补本轮记录 |
| TypeScript | `npx tsc -b` 通过 |
| ESLint | `npm run lint` 通过（0 error / 0 warning） |
| 前端测试 | `npm test`：**652 项全通过** |
| Rust | `cargo check` 通过；`cargo test wiki_link_tests` 3 项通过；**完整 Rust 套件未跑** |
| 打包 | 2026-10-18 20:55 完成：`.app` 16 MB、DMG 13 MB、SHA-256 `3d516fb6…8355395d` |
| 签名 | ad-hoc 完整（`codesign --verify --deep --strict` 通过）；**未公证** |
| UI 点击自动化 | **未做**（系统未授予 `osascript` 辅助访问权限） |
| 运行中实例 | 可能仍是 20:46 的旧包；验证新功能前请退出并重新启动 20:55 的产物 |

产物（不入库）：
- `src-tauri/target/release/bundle/macos/Zeditor.app`
- `src-tauri/target/release/bundle/dmg/Zeditor_0.6.4_aarch64.dmg`

临时演示目录（不入库）：`/tmp/zeditor-wiki-demo/`，包含 `笔记A.md`、`笔记B.md`、`笔记C.md`，用于验证 wiki 链接、标题跳转与反向链接。

## 2. 未提交文件地图

### 新增

| 文件 | 作用 |
| --- | --- |
| `src/utils/wikiLinks.ts` | Wiki 链接解析、显示文本、回写、标题/块锚点匹配、输入闭合匹配 |
| `src/services/wikiLinks.ts` | 目标解析（已开标签 → Rust）、打开并定位、30s 缓存、批量未解析解析 |
| `src/components/Sidebar/BacklinksSection.tsx` | 侧栏「反向链接」面板 |
| `src/utils/footnotes.ts` | 脚注定义解析、引用定位、输入闭合匹配 |
| `tests/wikiLinks.test.ts` | Wiki 链接纯函数测试 |
| `tests/footnotes.test.ts` | 脚注解析/匹配测试 |

### 修改（按主题）

| 主题 | 文件 |
| --- | --- |
| macOS 手势/快捷键 | `src/utils/platform.ts`、`LineWidthWheel.tsx`、`Editor.tsx`、`WysiwygEditor.tsx`、`WysiwygChrome.tsx`、`StatusBar.tsx`、`LineWidthSetting.tsx` |
| macOS 菜单 | `src/components/MenuBar/MenuBar.tsx`、`src/utils/nativeMenu.ts`、`src/i18n/index.ts` |
| macOS 发布/外观 | `src-tauri/Info.plist`、`src-tauri/tauri.macos.conf.json`、`.github/workflows/build.yml`、`src-tauri/src/commands.rs`、`src/styles/macos.css` |
| macOS Agent | `src-tauri/src/agent/process.rs` |
| 性能 | `WysiwygChrome.tsx`、`wysiwygSession.ts`、`src/utils/wysiwyg/blocks.ts`、`headingFolds.ts`、`WysiwygEditor.tsx`、`StatusBar.tsx`、`src/stores/appStore.ts`、`Preview.tsx`、`App.tsx`、`Editor.tsx` |
| 双向链接 | `src/utils/markdownPipeline.ts`、`src/utils/wysiwyg/inlineSerialize.ts`、`wysiwygSession.ts`、`Preview.tsx`、`Editor.tsx`、`WysiwygEditor.tsx`、`markdownEnhancers.tsx`、`Sidebar.tsx`、`src-tauri/src/commands.rs`、`src-tauri/src/main.rs` |
| 脚注悬停 | `src/utils/footnotes.ts`（新增）、`markdownPipeline.ts`、`inlineSerialize.ts`、`wysiwygSession.ts`、`markdownEnhancers.tsx`、`Editor.tsx`、`src/styles/main.css` |
| 样式 | `src/styles/main.css`、`workbench.css`、`wysiwyg.css`、`macos.css` |
| 文档 | `docs/reference/shortcuts.md`、`docs/reference/faq.md`、`docs/guide/editing.md`、`docs/usage-guide.md` |
| 测试 | `tests/macosAdaptation.test.ts`、`editorDisplayWiring.test.ts`、`wysiwygBlocks.test.ts`、`wysiwygInline.test.ts`、`markdownPipeline.test.ts`、`chatHistoryAndContextMenu.test.ts` |

## 3. macOS 适配

- **手势与主修饰键**：`isPrimaryModifier()` 在 macOS 只认 ⌘，Ctrl 留给系统右键；`isNativeMenuActive()` 判断原生菜单是否接管快捷键。
- **行宽滚轮**：`LineWidthWheel` 在 macOS 用 ⌘+滚轮，并排除触控板捏合（WKWebView 捏合也带 `ctrlKey`）；keyup 监听 Meta。
- **链接点击**：预览单击 wiki 链接；源码/所见即所得用 ⌘+点击（Windows/Linux Ctrl+点击）。macOS Ctrl+点击不再触发打开链接。
- **原生菜单**：新增「编辑 → 查找…」⌘F；文件快捷键、⌘⇧T / ⌘⇧I 在原生菜单生效时让位，避免一次按键执行两次。
- **折叠快捷键**：⌘⌥[ / ⌘⌥]（Windows/Linux Ctrl+Alt+[ / ]），Monaco 与所见即所得都可用。
- **小屏菜单**：右键菜单纵向由实测高度夹紧，不再用固定 660px 估算把 13" MacBook 的菜单顶到窗口上方。
- **辅助功能**：`prefers-reduced-transparency` 下关闭 `backdrop-filter`。
- **发布**：`tauri.macos.conf.json` 显式 `signingIdentity: "-"`，无证书时也生成完整 ad-hoc 签名；CI 的 `APPLE_*` secrets 存在时自动签名并公证。
- **Info.plist**：补 `LSApplicationCategoryType`、`NSHumanReadableCopyright`。
- **更新检查**：识别 `_universal.dmg`；更新弹窗区分 DMG / AppImage / deb，并给出 macOS 安装说明。
- **Agent CLI**：macOS GUI 进程补 `/opt/homebrew/bin`、`/usr/local/bin`、volta/cargo/nvm 路径。

## 4. 性能优化

1. **所见即所得每次按键**
   - `WysiwygChrome.refresh` 在「光标折叠 + 非表格 + 块内无 `/`」时直接返回，不再读 `getBoundingClientRect`，也不再调用 `getSelectionOffsets()` / `getVisibleSource()`（两者各会整块 DOM → Markdown 序列化）。
   - `wysiwygSession.renderInlineMarker` 先用 `CharacterData.data` + 光标前一个字符快速失败，避免每次按键复制整段文本；wiki / 脚注仍走完整匹配。
2. **每 250ms 写回**
   - `replaceBlockSource` 先用单块解析判断结构是否稳定；稳定时只更新该块并平移后续偏移/行号，跳过全文 `markdown-it` 解析与重新分块。类型、可编辑性、覆盖范围变化时自动退回全文解析。
3. **折叠**
   - `findHeadingFoldSections` 改为栈扫描 + 预计算 lastNonBlank，消除 O(标题数²)。
   - 所见即所得用 `hidden: Set` / `collapsedSections` 缓存隐藏判定与自动展开，DOM 访问器不再每次 `sections.some()`。
   - Monaco folding provider 按「model + version + 开关签名」缓存。
4. **React / store**
   - `StatusBar` 不再订阅 `content`；摘要/大纲改为点击时从 store 取值。
   - `setContent` 的字数统计改为 160ms 防抖（`scheduleWordCount`），其它入口仍立即刷新。
   - `Preview` 的 `isEmpty` 改为无分配字符测试；图片列表只在图片弹窗/菜单打开时扫描。
   - 分屏滚动同步 effect 不再依赖 `previewRenderVersion`，改为 ref 触发 80ms 防抖重建，避免每次预览渲染拆装滚动监听与 3 个 ResizeObserver。
5. **Monaco**：`largeFileOptimizations`、`maxTokenizationLineLength: 20000`、`stopRenderingLineAfter: 10000`、`renderValidationDecorations: 'off'`。

> 未重新运行浏览器帧率脚本（`scripts/verify-editor-display.mjs` 需要外部 Playwright），因此不声明实测 P95 收益。

## 5. Obsidian 双向链接

- **语法**：`[[笔记]]`、`[[笔记|别名]]`、`[[笔记#标题]]`、`[[笔记#标题|别名]]`、`[[#本文标题]]`、`[[#^块id]]`；`![[嵌入]]` 未实现。
- **渲染**：`markdownPipeline` 的 `wiki_link_rendering` core rule 把 text token 拆成 `.wiki-link` span（`data-wiki-target` / `data-wiki-anchor`），代码块与行内代码不受影响。
- **点击**：预览单击打开目标笔记；源码/所见即所得 ⌘/Ctrl+点击打开；普通点击在源码/所见即所得中仍打开原有编辑弹窗。
- **定位**：`#标题` 先按原文、再按 `createHeadingAnchorBase` 归一化匹配；`#^id` 查行尾块 id。
- **未解析**：`markdownEnhancers` 批量调用解析服务并加 `is-unresolved`（虚线），点击失败在状态栏提示。
- **反向链接**：`find_wiki_backlinks` 扫描工作区根 + 文档目录（最多 2000 文件、单文件 2MB、忽略 `.git`/`node_modules`/`.obsidian` 等），返回文件、首次命中行、摘录与次数；侧栏「大纲」下方显示。
- **解析缓存**：前端 30s TTL，输入期间同一目标不反复扫盘；已打开的标签优先，重名时只有唯一 basename 才采用。
- **所见即所得回写**：`inlineSerialize` 识别 `span[data-wiki-target]` 还原 `[[…]]`；表格内 `|` 转义；显示文字被改写时作为别名写回。
- **输入即渲染**：`matchWikiLinkAt` 在 `]]` 闭合时把文本换成链接元素，避免方括号被转义。

## 6. 脚注悬停预览

- **解析**：`footnotes.ts` 解析 `[^name]: 内容`、4 空格/Tab 续行、空行、围栏代码内忽略、同名取第一个。
- **渲染**：`footnote_references` core rule 把正文 `[^name]` 渲染为 `<sup class="footnote-ref" data-footnote-name data-footnote-content>`；定义行保持原文；无定义加 `is-unresolved`。
- **浮层**：`markdownEnhancers` 给引用绑定 pointerenter/leave 与 focus/blur，在 body 上创建 `.footnote-popover`，内容用 `renderMarkdownToHtml` 净化渲染；支持上下翻转、鼠标移入浮层、滚动/缩放收起。
- **源码模式**：Monaco hover provider 在 `[^name]` 上显示定义内容；定义按 model 版本缓存。
- **回写**：`inlineSerialize` 识别 `sup[data-footnote-name]` 输出 `[^name]`；所见即所得输入 `[^name]` 闭合时即时换成 sup（行首 `[^name]:` 保持文本，避免定义行被破坏）。

## 7. 回归红线（改动前先看测试）

- `tests/macosAdaptation.test.ts`：原生菜单结构、`edit.find` 加速键、`signingIdentity === '-'`、macOS 窗口配置与权限、`⌘` 文案。**改原生菜单项必须同步 `predefined` 数组断言。**
- `tests/editorDisplayWiring.test.ts`：`findHeadingFoldSections(blockDocument.blocks)`、`showFoldingControls: folding ? ...`、`markdownFoldingRanges(model.getLinesContent(`、`guides: { indentation: display.indentGuides` 等源码接线断言。
- `tests/wysiwygBlocks.test.ts`：局部更新必须与全文重新分块逐字段一致；结构变化必须回退。
- `tests/wysiwygInline.test.ts`：普通文本转义（`[`/`]`）、wiki 链接、脚注引用回写。
- `tests/markdownPipeline.test.ts`：wiki 链接 span、脚注 sup 与定义行不转换、代码内不转换。
- `tests/chatHistoryAndContextMenu.test.ts`：右键菜单不再断言 `const menuHeight = 660`，改为按实测高度夹紧。

## 8. 已知限制与风险

- 未提交、未发版；版本号 0.6.4，`CHANGELOG.md` 未补。
- 未跑完整 Rust 测试套件；未在 Intel（x86_64）macOS 上验证；未配置 Apple 证书，DMG 未公证。
- 反向链接不是实时索引：只在展开面板、切换文档或手动刷新时扫描；工作区很大时首次扫描会慢，预算外的文件不纳入。
- 双向链接：无 `![[嵌入]]`、无自动补全、无法写字面 `[[…]]`、重名取文档目录/工作区第一个匹配、导出 PDF/HTML 中不可跳转。
- 脚注：定义行在预览中仍是普通文本，没有文末脚注列表排版；悬停浮层不支持点击固定。
- macOS：滚动条仍是 8px 常显（非 overlay）；无原生 vibrancy；macOS 更新只能下载 DMG 手动安装。

## 9. 后续待办（优先级）

1. **P0**：整理提交/PR；补 `CHANGELOG` 与版本号（建议 0.6.5）；跑完整 `cargo test`；CI 双架构构建。
2. **P1**：反向链接增加保存后自动刷新（或轻量索引）；wiki 重名候选选择器；wiki 自动补全与 `![[嵌入]]`；脚注文末列表与定义行隐藏；脚本化浏览器回归（wiki/脚注/输入性能）。
3. **P2**：配置 `APPLE_*` secrets 与公证；产出 universal 包；macOS overlay 滚动条 / 原生 vibrancy；macOS 自动更新体验。

## 10. 常用命令

```bash
# 本机 node 可能被 bun 代理，使用真实 Node 的 PATH
export PATH="/Users/zhcx/.nvm/versions/node/v24.15.0/bin:$PATH"

npm test                 # 前端 652 项
npx tsc -b               # 类型检查
npm run lint             # ESLint
cd src-tauri && cargo test
npm run tauri build      # 前端 + Rust release + .app/DMG

# 产物校验
codesign --verify --deep --strict src-tauri/target/release/bundle/macos/Zeditor.app
hdiutil verify src-tauri/target/release/bundle/dmg/Zeditor_0.6.4_aarch64.dmg
```

快速接手：先 `git status` 看清未提交范围 → 读 `src/utils/wikiLinks.ts`、`footnotes.ts`、`markdownPipeline.ts` → 跑 `npm test` → 退出旧实例并重启 20:55 的打包产物验证界面。

---

## 历史记录：编辑显示增强（已提交 096965d）

> 以下为上一轮交接原文，保留用于追溯。其中「未提交 Git」「版本号 0.6.4」等表述已过时；当前交付状态以本文上半部分为准。

## Git 分支交付（2026-10-18）

- 本轮源码、测试和交接记录整理至 `feat/editor-display-wheel-block-menu`，基于 `main` 的 `f0795ea` 创建。
- 交付包含比例行宽、Ctrl＋滚轮、折叠与光标修复，以及扩展块菜单。安装包、日志和本地备份不纳入 Git。
- 下文“尚未提交 Git”等表述保留为开发时的历史记录；当前交付状态以该分支的提交记录为准。

## 2026-10-18 增补：Ctrl＋滚轮与块菜单

- 编辑/预览区域支持 **Ctrl＋鼠标滚轮**：上滚调宽、下滚调窄，每 100px 滚动累计为一档（2%），范围 40%–100%；兼容 line/page 单位和触控板小增量。关闭限制行宽时，首次收窄会自动开启。短暂显示当前百分比。
- 连续滚动复用 `src/utils/lineWidthPreview.ts` 的局部预览与 Monaco 冻结布局，180ms 停顿、松开 Ctrl、失焦、切换模式或打开设置时提交一次；不拦截设置、菜单、对话框及已有 SVG/工作流画布的缩放操作。设置滑块也改用同一预览实现。
- 块菜单前两项改为 **转换为 → 在下方插入**。转换包含正文、1–6 级标题、无序/有序/任务列表、引用、代码和公式；表格、含嵌套专用结构等不能安全转换的块仍禁用转换。
- 插入覆盖正文、全部六级标题、列表、引用、代码、公式、表格、图片、链接、视频/音频、分隔线、折叠内容、目录、注释，以及流程/甘特/时序/状态/类图和思维导图。复用现有斜杠模板与选区，子菜单沿用已有滚动及视口定位。
- 空任务和空公式改用可替换占位内容。公式、媒体、注释等只读块插入后自动打开块源码编辑器并选中可修改部分；Ctrl+Enter 保存、Esc 关闭。任务渲染时消除复选框后的重复排版空格，使源码偏移与 DOM 选区一致，避免占位文字替换不完整。
- `insertBlockAfter` 补齐尾部分隔，保留后续段落独立，模板换行跟随文档 CRLF/LF，并保留撤销。图片链接/图床和本地导入均按所选块的下方位置插入；取消图片对话框不会修改文档。本地图片复用原有 `.assets` 导入服务。
- 已验证：632 项 Node 测试、TypeScript、lint；`scripts/verify-wheel-block-menu.mjs` 的 25 项隔离 Edge 场景，涵盖真实 Ctrl+滚轮、一次保存、菜单顺序、转换/插入/撤销、立即输入和本地图片位置（文件选择与复制返回值为测试模拟，无本机文件操作）；无页面错误。上一轮 `verify-editor-display.mjs` 的滑块与两种模式长文档性能回归仍通过，P95 帧间隔约 16.8ms。
- 本轮原文件和旧安装包快照：`test-output/工作交流旧版本号-20261018-滚轮菜单前-152813/`，附恢复说明。保留前轮所有未提交改动，尚未提交 Git。
- **本轮安装包位于独立目录**：`src-tauri/target/wheel-menu/release/bundle/nsis/Zeditor_0.6.4_x64-setup.exe`，另有同目录体系下的 MSI。常规 `tauri build` 已完成新程序编译，但旧 `target/release/zeditor.exe` 正在运行，复制产物时被 Windows 拒绝；未关闭用户程序。改用新编译的 `target/release/deps/zeditor.exe`，设置独立 `CARGO_TARGET_DIR` 后运行 `tauri bundle --ci`，退出码 0，两个安装包生成成功。**原 target/release/zeditor.exe 及其旧 bundle 仍是上一轮版本，勿用它们验证本轮功能。** 新产物大小、时间与 SHA-256 见 `test-output/wheel-menu-artifacts.json`。

## 2026-10-18 后续修复（以下内容优先于原交接记录）

- 行宽改为各编辑框自身宽度的 **40%–100%**，默认 **80%**，步长 1%。继续使用 `editor.line_width`；旧 480–2400px 值在读取显示设置时回退为 80%，其它设置不变。CSS 变量改为 `--content-width`。源码文档卡片必须同时指定百分比 `flex-basis`，否则原来的 `flex-grow: 1` 会撑回全宽。
- 滑块固定与反弹根因：旧滑块为受控 `value`，拖动时却只改 DOM，不更新 React 状态；浏览器复现时滑块实际值 780，读数却为 760px。改由独立 `LineWidthSetting.tsx` 管理即时交互状态，不再让大设置面板每帧重渲染；局部 CSS 预览按 rAF 合并，松手/键盘松键/失焦才提交，pointerup+blur 不重复保存。Esc 中断拖动会移除未提交预览与冻结布局。
- 长文档拖动：设置遮罩暂时关闭背景模糊；所见即所得与阅读预览暂时跳过屏外段落布局；源码拖动时冻结 Monaco 宿主的实际像素宽度，只预览外围版心比例，松手恢复宿主自适应后按既有 advanced 策略精确折行一次。**没有改变字间距测量、wordWrap 或普通窗口缩放行为。**
- 浏览器实测（隔离 Edge，300 段约 5 万字）：优化前连续调宽帧间隔约 100–150ms；优化后两种模式 95% 帧间隔约 16.8ms。松手完成整篇精确排版仍有一次约 100–165ms 的工作，不能据此声称所有设备/文档全程无长帧。原始结果位于 `test-output/editor-display-results.json`。
- 源码缩进折叠改为栈扫描，锚点保留父项，只有一个子项也能折叠；空行与围栏边界有回归测试。
- 所见即所得关闭“折叠缩进”后立即展开隐藏子项；标题折叠按标签保存在本次应用会话内，切换模式/标签再回来仍保留，并清理已关闭标签的缓存。
- 所见即所得方向键越过折叠块；Enter 新段落、撤销重做或外部定位的光标落入折叠区时自动展开相关标题后恢复选区，避免输入错误落回标题。大纲/控制器定位在展开后补一次滚动。
- 已验证：TypeScript、lint、624 项 Node 测试；Rust 显示设置缺省和序列化往返测试。浏览器验证真实鼠标拖动、键盘、无回弹、一次保存、Esc、两种编辑模式、关闭限制全宽、960/1440/2560 窗口、折叠的源码完整性与输入导航。独立审查复核了 Enter、方向键、撤销重做和外部定位。
- 回归命令：`$env:PLAYWRIGHT_MODULE_PATH='已有 Playwright 的 index.mjs 路径'; node scripts/verify-editor-display.mjs`，默认开发地址 `http://127.0.0.1:1425`，也可通过 `ZEDITOR_TEST_URL` 指定。测试仅使用隔离浏览器的内存文档。
- 修复前源码、原交接与旧安装包已保存至 `test-output/工作交流旧版本号-20261018-显示修复前-143054/`，保留相对路径并附恢复说明。Git 仍未提交，版本号仍为 0.6.4。
- **本轮 Windows 打包已完成（2026-10-18 15:00，Asia/Shanghai）**：`npm run tauri build` 退出码 0，产出 `src-tauri/target/release/bundle/nsis/Zeditor_0.6.4_x64-setup.exe`（7,964,662 字节）和 `src-tauri/target/release/bundle/msi/Zeditor_0.6.4_x64_en-US.msi`（9,732,096 字节）。程序与安装包的 SHA-256 已记入 `test-output/display-artifacts.json`。Rust 仅有原有 `main.rs:338` 的 unused `app_handle` 警告。

---

以下为修复前的交接原文，像素行宽及相关实现说明已被上面的比例方案替代。

- 日期：2026-10-18
- 版本：0.6.4（未改版本号）
- 范围：源码对照（Monaco）与所见即所得（WysiwygEditor）两种编辑模式的显示类能力 + 状态栏视图状态按钮 + 设置面板「显示设置」区块，以及打包
- 状态：已实现、已自测、已出安装包；未提交 git

---

## 一、功能与入口

| 功能 | 入口 | 源码对照 | 所见即所得 |
|---|---|---|---|
| 限制行宽（+ 行宽 480–2400px） | 设置 → 编辑器 → 显示设置 | 文档卡片收窄居中，行号栏与滚动条随正文移动 | 文档收窄居中 |
| 折叠标题 | 同上 | Monaco 行号栏悬停出折叠箭头；`Ctrl+Shift+[ / ]` 仍可用 | 标题左侧箭头折叠整段，折叠时箭头常驻 |
| 折叠缩进 | 同上 | 每个缩进块的独立折叠范围（2 空格缩进） | 点击列表项标记区折叠子项，标记变 `▾` / `▸` |
| 缩进参考线 | 同上 | `guides.indentation` | 嵌套列表左缘竖线 |
| 视图状态按钮 | 同上（可关闭） | 状态栏显示当前视图，点击在「源码对照 ↔ 所见即所得」切换 | 同左 |
| 保存状态指示器 | 状态栏最左（始终显示） | 绿点「已就绪/已保存」、黄点「未保存修改」、蓝点「保存中…」，悬停给出说明 | 同左 |

显示类开关**即时生效**（不等「保存」），且默认全部开启；旧 `settings.json` 缺字段时按开启处理。

---

## 二、改动文件地图

### 新增

| 文件 | 作用 |
|---|---|
| `src/utils/editorDisplay.ts` | 显示设置归一化：`DEFAULT_LINE_WIDTH=780`、`LINE_WIDTH_MIN=480`、`LINE_WIDTH_MAX=2400`、`LINE_WIDTH_STEP=20`、`normalizeLineWidth`、`resolveEditorDisplay` |
| `src/utils/markdownFolding.ts` | 纯函数折叠范围：`markdownFoldingRanges(lines, {headings, indentation})`，跳过代码围栏，末尾空行不入范围，同起点范围去重 |
| `src/utils/wysiwyg/headingFolds.ts` | 块模型折叠：`findHeadingFoldSections(blocks)`、`foldedBlockIndexes(sections, collapsedKeys)`；折叠键 `${level}:${title}#${occurrence}` |
| `src/styles/reading-view.css` | 行宽（含 gutter 变量）、折叠箭头、列表折叠标记、缩进参考线、状态栏视图状态按钮样式 |
| `tests/editorDisplay.test.ts` | 默认值 / 开关 / 行宽归一化与上限 |
| `tests/markdownFolding.test.ts` | 标题分节、围栏、缩进块、空行、开关关闭 |
| `tests/wysiwygHeadingFolds.test.ts` | 分节范围、末尾空段落、重名标题、隐藏块集合 |
| `tests/editorDisplayWiring.test.ts` | 接线断言：provider / 设置项 / CSS 变量 / 状态栏 / Rust 字段 / Esc |

### 修改

| 文件 | 改动 |
|---|---|
| `src/App.tsx` | 新增显示设置 effect：写 `--content-max-width` 与 `documentElement.dataset.readableLineWidth/indentGuides/foldIndentation`；引入 `reading-view.css`（在 `wysiwyg.css` 之后、`macos.css` 之前） |
| `src/components/Editor/Editor.tsx` | 模块级 `markdownFoldingProvider` + `foldingRangesChanged` 发射器（`registerFoldingRangeProvider('markdown', …)`）；`guides: { indentation, bracketPairs: false }`、`showFoldingControls`、两个开关都关时 `editor.unfoldAll`；`detectIndentation: false` 与 `prepareMarkdownModel`（`tabSize/indentSize = 2`） |
| `src/components/Wysiwyg/WysiwygEditor.tsx` | 标题分节计算、`collapsedHeadings`、隐藏块渲染跳过、`foldStateRef` + 稳定 `toggleHeadingFold`（折叠时把光标带回标题行首）、块视图新增 `foldKey/folded/foldIndentation/onToggleFold`、`toggleListFoldAt` + `foldCacheRef` |
| `src/components/Settings/SettingsPanel.tsx` | 「显示设置」区块（限制行宽、行宽滑块、折叠标题、折叠缩进、缩进参考线、视图状态按钮）；`applyEditorDisplay` 即时保存；行宽拖动预览（rAF，不触发 React 重渲染）；Esc 关闭面板 |
| `src/components/StatusBar/StatusBar.tsx` | 保存状态移到最左并加 `title` 说明；`VIEW_STATES` 改为两态切换（`toggleViewMode`） |
| `src/stores/appStore.ts` | `Settings['editor']` 新增 6 个可选字段 + 默认值（见下） |
| `src-tauri/src/commands.rs` | `EditorSettings` 新增 6 个字段（`serde(default = …)`）+ `default_line_width() -> 780` |
| `src/i18n/index.ts` | 9 条文案（显示设置 / 限制行宽 / 行宽 / 正文区域的最大宽度 / 折叠标题 / 折叠缩进 / 缩进参考线 / 视图状态按钮 + 按钮说明）；未用「显示」，因为它与 WebDAV「显示密码」按钮同文冲突 |
| `src/styles/main.css` | `.settings-main .settings-range:focus/:focus-visible` 去掉 `.setting-item input:focus` 的 3px 光晕 |
| `src/styles/workbench.css`、`src/styles/macos.css` | 全局 `:focus-visible` 描边排除 `.settings-range`（否则按 Esc 切到键盘模式时滑轨会套一圈蓝框） |

> `src-tauri/Cargo.toml` 在 `git status` 里显示为已修改，但内容无差异，只是行尾（LF→CRLF）变化，可忽略/还原。

---

## 三、关键实现细节

### 1. 限制行宽（CSS 变量 + 三个 data 标记）

`App.tsx` 的 effect 负责把设置写进 DOM：

```ts
root.style.setProperty('--content-max-width', `${display.lineWidth}px`);
root.dataset.readableLineWidth = display.readableLineLength ? 'on' : 'off';
root.dataset.indentGuides = display.indentGuides ? 'on' : 'off';
root.dataset.foldIndentation = display.foldIndentation ? 'on' : 'off';
```

**行宽 = 文字宽度**，不是盒宽。`reading-view.css` 里把正文两侧排版留白单独定义成变量，计算最大宽度时加回去：

```css
:root { --content-max-width: 780px;
        --wysiwyg-gutter: clamp(52px, 5vw, 96px);
        --preview-gutter: clamp(20px, 2.6vw, 36px);
        --immersive-gutter: clamp(28px, 5vw, 72px); }

[data-readable-line-width="on"] .wysiwyg-surface > .wysiwyg-document {
  max-width: calc(var(--content-max-width) + 2 * var(--wysiwyg-gutter)); }
```

源码模式作用于 `.monaco-document-card`（`width:100% + max-width + margin-inline:auto`，flex 项靠 auto margin 居中），`box-sizing: border-box` 不变，**不改 `wordWrapColumn`**（折行仍按视口，`editorLayout` 测试会守住这点）。

### 2. 源码模式折叠（Monaco provider）

- provider 在模块作用域注册一次；**请求时**才读设置，所以开关切换不需要重新注册。
- 注册了自定义 provider 后 Monaco **不再回退缩进推断**，因此「折叠标题」「折叠缩进」可各自独立生效；两者都关时 provider 返回 `[]` 且 `folding: false`。
- 设置变化时 effect 里 `updateOptions` + `foldingRangesChanged.fire()` 让 Monaco 重算；关闭时先 `editor.unfoldAll`。
- 缩进按 2 列（`tabSize/indentSize=2`、`detectIndentation:false`），与所见即所得列表 2 空格一致。

### 3. 所见即所得折叠

- `findHeadingFoldSections(blocks)` 一次算出所有分节（标题 → 下一个同级/更高级标题前，尾部空段落剔除）；`foldedBlockIndexes` 得到要隐藏的块索引，渲染时 `if (hiddenBlocks.has(index)) return null`。**隐藏块仍在源码里**，展开原样回来。
- 折叠键含标题级别、文字与同名序号，改正文不会漂移；改标题文字等于换了一把键，旧折叠状态自然失效。
- `toggleHeadingFold` 必须稳定引用（否则每次输入都让所有块视图重渲染），所以用 `foldStateRef` 读最新分节/折叠集合；折叠时若光标在将被隐藏的块里，把选区移到标题行首（否则选区停在已卸载节点上，继续输入没反应）。
- 列表折叠（折叠缩进）走 DOM：点击落在「有子列表的 li」的标记区（内容盒左侧 −34px…+2px、首行高度内）时 `classList.toggle('is-folded')`；CSS 隐藏 `.is-folded > ul/ol`。li 的 `class` 不进入「DOM → 源码」序列化，**源码不受影响**。命中测试用 `foldCacheRef` 缓存（按 `renderRevision + source.length`），输入时失效。

### 4. 设置面板

- `applyEditorDisplay(patch)`：同时更新 `localSettings` 与 `saveSettings({...latest, editor:{...latest.editor, ...patch}})` → 即时生效。
- 行宽滑块：`onChange` 只直接改 `<output>` 文本、`--range-progress` 与 `--content-max-width`（`requestAnimationFrame` 合并，每帧最多写一次），**不触发 React 重渲染**；`pointerup / keyup / blur` 才 `commitLineWidth` 落盘。之前每帧改 state + 写 CSS 变量会让整块面板重渲染、Monaco/预览/所见即所得同时重排，拖动明显卡顿。
- Esc：`window` 级 `keydown`，`cancelRef.current()` 执行「取消」语义（撤回字号/行宽预览并关闭）；`event.defaultPrevented`（下拉、字体选择已处理）或 `.webdav-history-dialog` 仍打开时不关闭面板。

### 5. 状态栏

- 保存状态第一个渲染：`saveState`（`saving/modified/saved/ready`）+ `title` 说明 + `aria-live="polite"`。
- 视图状态按钮**只在两种持久编辑方式之间切换**：沉浸阅读/写作会 `display:none` 整个状态栏（`.immersive-mode-active .statusbar`），切进去就没有切回来的入口；沉浸态仍有活动栏「书」图标、功能菜单、右上角退出按钮与 `Esc` 四个出口。
- `show_view_state_button=false` 时只渲染纯文字标签。

---

## 四、设置与持久化

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `readable_line_length` | bool | `true` | 限制行宽 |
| `line_width` | number / u32 | `780` | 480–2400，按 20 取整 |
| `fold_headings` | bool | `true` | 折叠标题 |
| `fold_indentation` | bool | `true` | 折叠缩进 |
| `indent_guides` | bool | `true` | 缩进参考线 |
| `show_view_state_button` | bool | `true` | 状态栏视图状态按钮 |

- TS：`src/stores/appStore.ts`（`Settings['editor']` 可选字段 + 默认值块）
- Rust：`src-tauri/src/commands.rs` 的 `EditorSettings`，每个字段 `#[serde(default = "...")]`；`default_line_width()` 返回 780
- 读取链路：Rust `get_settings` → `...saved.editor` 展开 → 缺字段保留默认；写入链路：前端整体提交 → serde 反序列化（缺字段用默认值），旧配置文件不掉字段

---

## 五、验证与打包

```powershell
cd d:/Documents/code/zeditor
npx tsc -b            # 通过
npm run lint          # 通过（0 error / 0 warning）
npm test              # 619 项全通过（含新增 4 个测试文件、20 项）
npm run tauri build   # 前端构建 + Rust release + MSI/NSIS
cd src-tauri; cargo check     # 通过；仅有既有警告 main.rs:338 unused `app_handle`
```

产物（x64，版本 0.6.4，未签名）：

| 路径 | 大小 |
|---|---|
| `src-tauri/target/release/zeditor.exe` | ≈14.8 MB |
| `src-tauri/target/release/bundle/msi/Zeditor_0.6.4_x64_en-US.msi` | ≈9.3 MB |
| `src-tauri/target/release/bundle/nsis/Zeditor_0.6.4_x64-setup.exe` | ≈7.6 MB |

- 打包工具链已缓存：`%LOCALAPPDATA%\tauri\NSIS`、`%LOCALAPPDATA%\tauri\WixTools314`，离线可打包。
- `tauri.conf.json` 的 `beforeBuildCommand` 已是 `npm run build`，`bundle.targets: "all"`（Windows 上即 msi + nsis）。
- release 全量编译约 6.5 分钟；只改前端时 `tauri-build` 会因 `dist` 变化重新编译 crate，约 1–2 分钟。

---

## 六、已知限制与设计取舍

1. **阅读预览（分屏右侧）与沉浸阅读不折叠**：与 Obsidian 一致，折叠只发生在编辑视图。
2. **源码模式行宽按整张卡片算**（含行号栏 ~50px），同一 `line_width` 下源码文字比所见即所得略窄。
3. **列表折叠状态存在 DOM 上**：块重渲染（内容变化后规范化重建）会复位；源码不受影响。
4. **任务列表项**（`list-style:none`）不会显示 `▾/▸` 标记，但标记区点击仍可折叠。
5. **折叠键绑定标题文字**：改标题 = 换键，原折叠状态失效（不会串到别的标题）。
6. 行宽上限 2400px；需要真正“铺满且不封顶”请关闭「限制行宽」。
7. 设置面板盖住编辑区，拖动行宽时的实时反馈主要在面板数值与滑块上（编辑区在模糊背景后面）。
8. 安装包未签名，首次安装 Windows SmartScreen 会提示“仍要运行”。
9. 折叠箭头等 `.12s` 过渡由 `main.css` 的全局 `@media (prefers-reduced-motion: reduce)` 统一压缩，无需单独处理。

---

## 七、后续可做（按优先级）

1. **折叠状态持久化**：按文档路径 + 折叠键记到内存/会话，切换标签回来仍折叠（Obsidian 行为）。
2. **大纲与折叠联动**：点大纲标题时若该节被折叠自动展开。
3. **源码模式行宽扣除行号栏**：让两种模式的文字宽度严格一致（需要读 Monaco `layoutInfo.contentLeft`）。
4. **阅读预览折叠**：若要支持，可复用 `markdownFoldingRanges` 生成 `<details>` 或按行切片隐藏。
5. **状态栏保存项可点击**：点击立即保存（`Ctrl+S` 的等价入口）。
6. 折叠箭头 / 参考线跟随主题的对比度微调（暗色主题下 `--text-muted` 偏弱）。
7. **本次未更新 `CHANGELOG.md` 与 `docs/` 文档站点**，也未改版本号（仍是 0.6.4）；正式发版前需补一条 v0.6.5 记录并同步站点。

---

## 八、常见改动指引

- **改行宽默认/上下限**：`src/utils/editorDisplay.ts`（常量）＋ `src-tauri/src/commands.rs`（`default_line_width` 与注释）＋ `src/stores/appStore.ts`（默认值块）＋ `tests/editorDisplay.test.ts`。
- **新增一个显示开关**：① `editorDisplay.ts` 加字段与默认值；② `appStore.ts` 加可选字段与默认值；③ `commands.rs` 加 `#[serde(default = "default_xxx")]` 字段与默认函数；④ `SettingsPanel.tsx` 的「显示设置」加 `SettingToggle` + `applyEditorDisplay`；⑤ 若需要 CSS，在 `reading-view.css` 加 `[data-xxx="on"]` 规则并在 `App.tsx` effect 写 `dataset`；⑥ `tests/editorDisplayWiring.test.ts` 补断言。
- **改折叠规则**：源码模式改 `src/utils/markdownFolding.ts`（纯函数，先补 `tests/markdownFolding.test.ts`）；所见即所得改 `src/utils/wysiwyg/headingFolds.ts`（先补 `tests/wysiwygHeadingFolds.test.ts`）。
- **改视图状态按钮的切换目标**：`StatusBar.tsx` 的 `VIEW_STATES` 与 `toggleViewMode`。注意不要把会隐藏状态栏的模式（`immersive` / `zen`）放进循环。
- **调所见即所得左侧留白**：`reading-view.css` 的 `--wysiwyg-gutter`（同时决定折叠箭头与块手柄的两列空间，最小 52px）。
