# 编辑器自由布局与打开性能：第三轮交接

日期：2026-10-17。接续 [r2 交接](./wysiwyg-handoff-2026-10-17-r2.md)。

本轮按用户反馈修复源码比例、自适应、拖拽漂移、分隔线和打开 Markdown 的卡顿。保留既有未提交改动，未提交或推送。本轮不修改软件版本号。

## 修复结果

- 源码启动默认恢复 **1:1**。AI 自动宽度按可用空间的三分之一分配，默认编辑、预览、AI 等宽；用户调整后保留当前比例与宽度。
- 资源侧栏、编辑/预览分屏、校对栏、AI 栏、沉浸大纲共用 `PanelDivider`。支持鼠标/触摸拖动、方向键微调、Shift 加速和双击复位。
- 普通模式、所见即所得、沉浸阅读/写作均支持调整；不再受原侧栏 400px、AI 500px 的固定上限限制。边界由实际剩余文档空间决定。
- 窗口缩小时适配当前面板，至少给文档保留 240px；单纯缩放窗口不会覆盖用户偏好，扩大后恢复。若在受约束的窄窗口主动拖动，则以当前可见宽度形成新的布局偏好，避免松手再缩放一次。
- 分隔条统一 **4px 布局宽度 + 外扩抓取区、1px 全高线、悬停/键盘聚焦/拖动时 2px 强调线**。只高亮当前拖动条。
- 校对栏由预览内部移到文档区旁边，**源码和所见即所得均可显示、拖拽与应用建议**；编辑与预览按真正剩余空间分配，不再人为修正 flex 比例。

## 根因与实现

### 漂移与回弹

原分屏坐标基于 `.main-content` 却再次扣除侧栏；自动布局还会在松手后覆盖用户设置。旧 CSS 存在 4/7/8px 热区、窄窗口 `width: ... !important`、沉浸 AI 最小宽度、校对左侧 2px margin 等多处覆盖，状态层也仍将侧栏限制为 400px。

现在从指针按下时的实际宽度加位移计算；拖动期间每帧只更新一次，松手同步提交最后坐标。取消、失去捕获、窗口失焦与卸载均清理拖动状态。分屏拖动和状态提交统一使用 10%–90% 的边界。可折叠大纲的固定 40px 轨道在适配前扣除，避免误计文档空间。

### 打开 Markdown

- 源码编辑器跨标签复用 Monaco 实例，切换文档模型；每份文档继续独立保留撤销栈，同时保存光标和滚动视图。Monaco 本身仍会重建对应模型的视图 DOM，因此监听绑定在稳定宿主上。
- 表格把手只在视口附近测量；同帧先读完各表格几何，再统一写位置，消除逐表读写交错导致的强制重排。
- 所见即所得的表格单元格在离线 `template` 中准备可编辑属性后一次插入，避免对已连接的单元格逐个切换编辑状态；代码块语言选项按实际交互加载。
- 所见即所得首批按块复杂度控制，后续轻量正文批次更大，表格/代码批次更小。长粘贴时优先挂载光标目标，不能清除还未挂载的待恢复选区；后续批次挂载时重建校对高亮。
- 保留 `wrappingStrategy: 'advanced'`，避免重新引入中文和字间距导致长行被裁剪的问题。它仍有实际字形测量开销，不能把本轮优化理解为任意大文档均无阻塞。

### 文档安全回归

复用编辑器后，外部留存的旧控制器必须拒绝修改当前其他模型；异步剪贴板、空文档 `/ask`、`/write` 也需检查原文档快照和控制器身份。校对高亮随活动文档恢复，并验证内容快照。以上都有实际浏览器回归。

## 修改入口

| 文件 | 责任 |
| --- | --- |
| `src/components/Layout/PanelDivider.tsx` | 公共拖拽、指针捕获、提交与清理、键盘/复位 |
| `src/components/Layout/panel-divider.css` | 全部分隔条的唯一视觉规则与必要宽度约束 |
| `src/utils/panelSizing.ts` | 指针位移与窗口宽度适配纯函数 |
| `src/App.tsx` | 面板偏好和实际宽度、并列校对栏、接入公共分隔条 |
| `src/components/Immersive/ImmersiveOutline.tsx` | 大纲接收实际宽度 |
| `src/stores/appStore.ts` | 默认 0.5；移除侧栏固定 400px 提交上限 |
| `src/styles/main.css`、`src/styles/workbench.css` | 移除历史分隔条规则与窄窗口强制覆盖 |
| `src/components/Editor/Editor.tsx` | 复用实例、模型和视图切换、旧控制器和异步写入保护 |
| `src/components/Wysiwyg/WysiwygEditor.tsx`、`WysiwygCodeBlock.tsx` | 表格离线准备、代码语言选项按需加载、按复杂度分批渲染、长粘贴光标 |
| `src/components/Wysiwyg/wysiwygSession.ts`、`ProofreadHighlights.tsx` | 延迟挂载下的选区与校对标记完整性 |
| `src/utils/markdownEnhancers.tsx` | 可见表格几何测量合并 |
| `tests/panelSizing.test.ts` | 4 项位移/边界/缩放单测 |
| `tests/wysiwygRenderBudget.test.ts`、`src/utils/wysiwyg/renderBudget.ts` | 按块复杂度分配渲染预算与 2 项单测 |
| `scripts/verify-panel-layout.mjs` | 27 项真实浏览器回归、CPU 采样与截图 |
| `scripts/benchmark-document-open.mjs` | 同文档双模式首屏、完整渲染、拖拽帧间隔与生产构建测量 |
| `tests/tableImageWiring.test.ts` | 更新为复用已读取的表格矩形 |

## 已验证

- TypeScript：`npx tsc -b --force` 通过。
- Lint：通过。
- 单元测试：**581/581** 通过。
- 新布局与模式一致性浏览器回归：**27/27**，无未捕获页面异常。
- 既有 WYSIWYG 浏览器回归：**30/30**，无未捕获页面异常。
- 生产前端构建：通过；现有 `::highlight` 压缩器提示仍会输出，不影响构建。
- 独立代码审查：已修复审查发现的宽度提交、窄屏 CSS、异步跨文档写入与事件监听问题，复审无剩余可操作问题。

首轮源码性能定位记录（Windows / Edge 无头 / 1600×1000，包含 CPU profiler 开销，不包含原生文件读取）：

| 样例 | 修复前 | 最终采样 |
| --- | ---: | ---: |
| 本次读取的 r2 交接文档 | 526ms | 443ms |
| 含 120 张表格、标题、代码块的 Markdown | 574ms | 395ms |
| 上述表格样例几何读取 self CPU | 约 120ms | 约 9ms |

用户补充“所见即所得也应保持体验和性能一致”后，增加了生产构建下同文档对照。每份文档加唯一标题标记，防止把延迟预览中的旧文档误认成新首屏。最终独立采样 `test-output/document-open-production-final/results.json`：

| 样例 | 源码首屏 / 全量 | 所见即所得首屏 / 全量 |
| --- | ---: | ---: |
| r2 交接 | 360 / 400ms | 252 / 401ms |
| 260 段正文 | 144 / 153ms | 111 / 439ms |
| 120 张表格与代码 | 272 / 286ms | 85 / 956ms |

**性能边界：** 两种模式采用相同的交互验收要求；所见即所得在上述样例中首屏不慢于源码模式，但复杂文档的全部编辑块需要继续分批挂载，完整渲染时间仍不同。本轮没有承诺两种不同渲染器在任意文档下耗时相等，也没有引入会移除编辑 DOM 的虚拟滚动。开启 profiler 的数字有采样开销，不宜当成生产 SLA。

最终记录在 `test-output/panel-layout-final/`：`results.json`、CPU profile、截图、完整单测与浏览器日志、构建日志。性能数字用于本机前后定位，不能当作跨机器的性能保证。

## 重跑

```powershell
npx tsc -b --force
npm run lint
npm test
npm run build

# 独立终端启动开发服务器；修改 store 后重启，避免 HMR 模块实例不一致。
npm run dev -- --host 127.0.0.1 --port 5199 --strictPort
$env:PLAYWRIGHT_MODULE_PATH='C:\Users\zhcx\AppData\Local\npm-cache\_npx\9833c18b2d85bc59\node_modules\playwright\index.mjs'
node scripts/verify-panel-layout.mjs
node scripts/verify-wysiwyg-browser.mjs

# 对生产构建作双模式对照：单独终端启动 preview 后执行。
npm run preview -- --host 127.0.0.1 --port 5299 --strictPort
$env:ZEDITOR_TEST_URL='http://127.0.0.1:5299/'
$env:DOCUMENT_BENCH_PRODUCTION='1'
node scripts/benchmark-document-open.mjs

npm run tauri -- build --bundles nsis --no-sign --ci
```

Playwright 路径应先确认仍存在。开发服务器冷启动可能需要预热，第一次导航超时后应先检查服务和依赖优化状态。

## 恢复与限制

修改前备份：`C:\Users\zhcx\AppData\Local\Temp\zeditor-layout-before-20261017-125755\`，保留了本轮开始时已有改动的目标文件。不要用 Git HEAD 直接覆盖工作区来回退本轮，否则会丢失前一轮未提交成果。

宽度偏好保存在当前运行会话，重启回到默认值，符合本次“打开源码时 1:1”的要求。未进行安装后的真实输入法、高 DPI、多显示器人工验收。Windows 测试安装包的生成和校验结果见本文件末尾。

## Windows 测试安装包

- `npm run tauri -- build --bundles nsis --no-sign --ci` 成功，原生 release 编译用时 6 分 21 秒。
- 归档：`test-output/panel-layout-r3-2026-10-17/Zeditor_0.6.3_x64-panel-layout-r3-setup.exe`。
- 文件大小：7,949,167 字节。
- SHA-256：`9EFC62F41C5D939CC857CC1988320C61B05669E304009023E06805AC60974F2D`。
- 已确认归档副本与构建产物哈希一致。包未签名，没有自动安装或替用户启动程序。
