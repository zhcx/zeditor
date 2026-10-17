# 所见即所得编辑器：菜单 / 布局 / 性能收口轮交接说明

> 本文件是 `docs/wysiwyg-handoff-2026-10-17.md`（同日凌晨那份）**之后**的工作记录。
> 两份合起来才是完整现状：第一份讲"两笔提交 + 8 文件"的编辑表面修复，本份讲其后
> 的菜单共享化、块菜单扩展、布局自适应、性能二阶段与分隔条统一。
> 所有数字均为本机（Windows / Edge Chromium / 1920×1080 视口或 1400×860）实测。

## 一、当前状态速览

**分支**：`feature/wysiwyg-editor`，HEAD = `2fff5fb`（未推送）。

| 项 | 状态 |
| --- | --- |
| 已提交 | `faf1554`（另一会话：功能 + 性能 + 回归基建，31 文件）、`2fff5fb`（编辑表面视觉 + 就地源码编辑，11 文件） |
| 未提交 | **18 个修改 + 2 个新文件**（`EditorContextMenu.tsx`、本目录上一份 handoff），见第二节 |
| 静态检查 | `npx tsc -b --force` 0 错误；`npm run lint` 0 错误 |
| 单元测试 | `npm test` **575/575** |
| 生产构建 | `npm run build` 通过（主包 ~959KB / 编辑器 chunk ~3.76MB） |
| 浏览器回归 | `scripts/verify-wysiwyg-browser.mjs` **30/30**，无未捕获页面异常 |
| 打包产物 | `test-output/` 下 7 个阶段包，最新 `wysiwyg-width-divider-2026-10-17/`（SHA-256 `C16D3560…6BEDD386`） |

**未提交改动规模**：`18 files changed, +571 / −631`（`Editor.tsx` 净减 480 行，主要是右键菜单整体搬走）。

## 二、本份 handoff 覆盖的改动

### 2.1 右键菜单：抽成两种编辑器共用的组件

- 新增 `src/components/Editor/EditorContextMenu.tsx`（约 470 行）：从 `Editor.tsx` 整体搬出
  `ContextSubmenu`、`ContextMenuIcon`、图标映射、全部动作（AI 润色/翻译、撤销重做、剪切复制
  粘贴、复制为、格式子菜单、标题子菜单、插入子菜单、表格子菜单、导出、在文件夹中显示）。
- `Editor.tsx` 只保留"算出打开位置"的 `handleContextMenu`（构造 `EditorContextMenuState`），
  渲染改为 `<EditorContextMenu state={...} onClose={...} onInsertImage={...} onPasteFallback={...} />`。
- 组件**内部**从 `useAppStore(store => store.editorView)` 取控制器，宿主不再传 `controller`
  （否则宿主渲染期读 `ref.current` 会触发 `react-hooks/refs`）。插入图表格外友好：两种模式各自的
  图片链路通过 `onInsertImage` 回调交回宿主。
- 所见即所得在 `.wysiwyg-surface` 的 `onContextMenu` 里接入：先把光标落到右键处（不在选区内时），
  再按位置 / 选区 / 是否在表格内构造 state；`canUndo/canRedo` 来自 `wysiwygSession.canUndo()`。
- 表格动作改为**直接经控制器改文档**（`applyTableAction` + `replaceRange`），不再依赖
  `zeditor-table-action` / `zeditor-insert-table` 事件，两种模式行为一致。

### 2.2 块按钮：补上"在下方插入 / 转换为"

`BlockActions.tsx` 由平铺 5 个按钮扩为两个子菜单 + 块操作：

| 子菜单 | 项 |
| --- | --- |
| 在下方插入 | 段落 / 表格 / 代码块 / 引用 / 分隔线 |
| 转换为 | 正文 / 1~3 级标题 / 无序列表 / 有序列表 / 引用 |

- `wysiwygSession` 新增 `insertBlockAfter(index, markdown)`（空模板退化为插入段落）与
  `setBlockKind(index, target)`；`blockOps.retypeBlock(source, target)` 负责"逐行剥前缀 + 补前缀"。
- 表格 / 代码块 / HTML / 解析不出结构的块自动禁用"转换为"（`canRetype`）。
- 子菜单交互：**点击只打开、不做 toggle**（hover 已经展开时点一下会把它翻回去）；子菜单 portal
  到 body，容器额外阻止 `pointerdown` 冒泡，否则按下的瞬间子菜单被卸载、click 收不到。

### 2.3 设置：编辑模式立即生效

`SettingsPanel` 的模式项原来只改"默认值"（保存后下次启动才生效）。现改为调用 `setMode(next)`
（内部同时持久化 `settings.editor.mode`），选中值显示当前运行时模式，文案改为"切换后立即生效"。

### 2.4 布局自适应（本轮被返工过一次，重点看这一节）

**第一次只改了 `.wysiwyg-document`（1680 上限）→ 用户反馈"未修复"。原因：其余视图仍是固定像素限宽。**

现在所有内容容器的 `max-width` 都是 `100%`，宽度完全跟随窗口：

| 文件 | 选择器 | 旧值 → 新值 |
| --- | --- | --- |
| `wysiwyg.css` | `.wysiwyg-surface > .wysiwyg-document` | `min(100%,1680px)` → `100%` |
| `main.css` | `.preview-container` | `880px` → `100%` |
| `main.css` | `.preview-document`、`.preview-pane .preview-document` | `1120px` → `100%` |
| `main.css` | `.editor-content .cm-content`（两处） | `820px` / `1120px` → `100%` |
| `main.css` | `.immersive-preview .preview-document` / `.preview-card` | `820px` / `940px` → `100%` |
| `main.css` | `.zen-editor-pane .editor-document-card` | `920px` → `100%` |
| `workbench.css` | `.immersive-reading .immersive-preview .preview-document` | `920px` → `100%` |

同时：`DEFAULT_EDITOR_RATIO`（`App.tsx`）与 store 的 `splitRatio` 由 **0.5 → 0.6**（分屏给编辑区 6 成）。
`balanceDocumentPanes` 在**没有并排预览面板**时直接 return——此前它照样按固定比例改写编辑区宽度，
表现为"AI 侧栏打开后编辑区缩到某个宽度就拖不动"。

实测（1920 视口、左侧栏 250 开启）：

| 模式 | 容器宽 | 内容宽 |
| --- | --- | --- |
| 所见即所得 | 1612 | **1612** |
| 源码对照 · 编辑区 / 预览 | — | **963 / 632**（60/40） |
| 沉浸阅读 | — | **1686**（原 920） |
| 沉浸写作 | — | **1696**（原 920） |

### 2.5 分隔条：四条统一为 1px 贯穿线

规则集中在 `main.css` 里四条 divider 选择器并列的公共段：

```css
.divider.resizable::after,
.sidebar-divider.resizable::after,
.proofread-divider::after,
.chatbot-divider::after {
  top: 0; bottom: 0; width: 1px; border-radius: 0;
  background: var(--border-color);
}
```

热区一律 **4px 透明**（`::before` 再向外扩 4px 作为抓取区），hover / 拖动时统一 **2px 强调色**。

两处历史覆盖必须注意（这次就是被它们挡住的）：

- `main.css` 约 5142 行：`.divider.resizable::after` 原为"半透明 `--border-strong`、上下各留 12%
  空隙"，已改为 `top/bottom: 0` + `--border-color`；
- `main.css` 约 5291 行：`.proofread-divider` 原为 **8px 热区** + `--border-soft` 短线，已改为 4px + 统一线。

活动栏右边框也统一为 `--border-color`（与分隔条同色）。实测三条（侧栏 / 分屏 / AI）在 1920 下均为
`1px rgb(54, 60, 69)`、`top: 0 / bottom: 0`。

### 2.6 性能：打开文档与拖拽

**打开大文档**（260 块、约 660 行）：

| 指标 | 优化前 | 现在 |
| --- | --- | --- |
| 首屏可见（前 40 块） | — | **95ms** |
| 全部块渲染完成 | ~1000ms | **308ms** |

手段（都在 `WysiwygEditor.tsx`）：

1. **首屏分批渲染**：`renderState = { tabId, budget }`，初始 60 块，之后每帧 +40；`budget` 由
   `tabId` 派生，切换文档自动退回首屏值（不需要重置副作用）。渲染 `blocks.slice(0, budget)`。
2. **手柄测量门控**：`observeHandleMeasure` 用**单例 IntersectionObserver**（rootMargin 500px）
   只对进入视口附近的块安排测量；同帧测量合并进一次 `requestAnimationFrame`；内容未变
   （`kind + source + renderRevision`）跳过；块上 `pointerenter` 时**强制重测**（手柄是 hover 才出现的，
   保证要用的那一刻一定准）。
3. **聚焦不触发隐式滚动**：`wysiwygSession` 里 4 处 `focus()` 全部加 `{ preventScroll: true }`，
   滚动交给显式的 `revealElement`。

**面板拖拽**：`html.panel-resizing` 下给 `.document-pane / .editor-pane / .preview-pane` 加
`contain: layout` + `will-change: flex, width`（刻意不加 `paint`，否则会裁剪浮动工具栏）。
实测帧间隔 p50 **16.7ms** / p95 16.8ms / max 17ms；AI 面板拖动时编辑区宽度实时跟随（745 → 585 → 805）。

### 2.7 视觉细节

- 代码块字体与正文同族：`.app .wysiwyg-document .wysiwyg-block :is(pre, pre code)` 与
  `.app :is(.preview-document, .preview-container) :is(pre, pre code)` 均 `font-family: inherit`。
- 活动栏「编辑模式」图标不再随模式变成 `format`（那会与「格式工具栏」按钮完全一样），改为
  书（源码对照/沉浸阅读）与笔（所见即所得/沉浸写作）。
- 段间距压缩（上一轮）：文字间隙 13.0 → **8.1px**，段落块高 25.8 → 22.7；段落行高 1.62，且规则要
  **同时命中 `<p>`**（`.preview-document p` 显式 1.84 会盖掉只作用于 section 的行高）。
- 块按钮改为 VS Code 风格（26×26 圆角块 + 实心点阵 `grip` 图标，hover 只提亮底色）。
- 表格快捷栏改为以整张表格为锚点、按实测尺寸在绘制前定位（`ResizeObserver` 跟随），
  实测 36px 单行、贴在表格上方 12px、不遮挡不溢出。
- 删除空块后光标回到**上一块末尾**（此前落在删除点，视觉上"下一行跳上来"）。

## 三、架构更新

**新增**：`src/components/Editor/EditorContextMenu.tsx`（右键菜单，含 `ContextSubmenu` 导出给块菜单复用）。

**新增 API**：

| 文件 | 新增 |
| --- | --- |
| `wysiwygSession.ts` | `insertBlockAfter`、`setBlockKind`、`canUndo`、`canRedo` |
| `utils/wysiwyg/blockOps.ts` | `retypeBlock`、`BlockRetypeTarget` |
| `utils/wysiwyg/undoStack.ts` | `canUndo` / `canRedo` |
| `WysiwygEditor.tsx`（模块级） | `scheduleHandleMeasure` / `observeHandleMeasure` |

**数据流变化**：

1. 右键菜单的动作只依赖 `EditorController` + store；两种模式共用同一份实现，差异仅在宿主传入的
   `onInsertImage` / `onPasteFallback`。
2. 块菜单 → `BlockActions` 回调 → `wysiwygSession.setBlockKind / insertBlockAfter` → 会话重建 → 写回 store。
3. 打开文档：`addTab` → 会话规范化 → `snapshot` → 渲染 `slice(0, budget)` → 逐帧补齐。

## 四、不能破坏的前提（在第一份基础上新增）

1. **分隔条只在公共规则里定义**：宽度 4px 透明热区 + `::after` 1px `--border-color` 贯穿 +
   hover/拖动 2px 强调色。不要在文件后部再加只针对某一个 divider 的 `width/background/top/bottom` 覆盖
   （历史上有两处，见 2.5）。
2. **内容容器不要写死像素 `max-width`**：如需可读性上限，请统一走一个变量（当前是 `100%`）。
   改样式前先 `grep` 所有同名选择器——本轮被 5 处历史限宽与 2 处历史分隔条覆盖坑过两次。
3. **手柄测量只能对视口附近块执行**，并且同帧合并；否则打开 240 块文档会多出约 400ms 的强制布局。
4. **`EditorContextMenu` 不要接收 `controller` prop**：它从 `store.editorView` 取；宿主传 ref 值会在
   渲染期读 ref，触发 `react-hooks/refs`。
5. **`balanceDocumentPanes` 必须在没有 preview 兄弟节点时 return**，否则编辑区宽度被锁在固定比例。
6. **`renderBudget` 的预算必须跟 `tabId` 走**，否则切到更大的文档时第一帧会全量渲染。
7. **段落行高规则要同时命中 section 与 `<p>`**（见 2.7）。
8. **块菜单子菜单：点击只打开不 toggle；子菜单容器要阻止 `pointerdown`。**
9. 探针（playwright）在 dev server 热更新之后必须重启 server，否则 `import('/src/stores/appStore.ts')`
   拿到的是新模块实例，页面用的还是旧实例，`setMode` 看起来"无效"（见第七节）。

## 五、关键决策与理由

| 决策 | 理由 |
| --- | --- |
| 右键菜单抽公共组件而非各写一套 | 菜单项多达 40+，两套必然漂移；动作都基于 `EditorController`，天然可共享 |
| 插入表格/表格动作改为直调控制器 | 事件（`zeditor-insert-table`）只在编辑器实例闭包里有效，菜单在两处都要能用 |
| 分隔条视觉线画在 `::after` 上 | 4px 热区好抓，1px 线好看；`::before` 再外扩扩大抓取范围 |
| 内容宽度放开到 100% | 用户明确要求"自适应窗口"；舒适度交给 padding（`clamp`） |
| 分屏默认 60/40 | 内容放开后编辑区仍是主工作面，预览够用即可；用户仍可拖 |
| 首屏分批渲染而不是虚拟滚动 | 虚拟滚动要接管滚动容器与光标恢复，风险高；分批渲染对现有结构零侵入 |
| 手柄在 `pointerenter` 强制重测 | 观察器只能保证"视口附近的块有值"，hover 时再测一次能覆盖滚动后漏测的块 |
| `focus({ preventScroll: true })` | 隐式滚动在长文档里是纯开销，滚动交给 `revealElement` 更可控 |

## 六、验证方式

```bash
# 静态检查 + 单测 + 构建
npx tsc -b --force
npm run lint
npm test
npm run build

# 浏览器回归（30 项；起 dev server 后跑，注意地址与 playwright 路径）
npm run dev -- --host 127.0.0.1 --port 5199 --strictPort
$env:ZEDITOR_TEST_URL="http://127.0.0.1:5199/"
$env:PLAYWRIGHT_MODULE_PATH="<npx 缓存>/node_modules/playwright/index.mjs"
node scripts/verify-wysiwyg-browser.mjs

# 打包（务必先关掉运行中的 zeditor.exe，否则 os error 5）
npm run tauri -- build --bundles nsis --no-sign --ci
```

回归脚本支持 `WYSIWYG_TEST_FILTER` 按名称筛用例。探针要注意：`#boot-splash` 与模式选择模态会拦截点击，
需等它们消失；store 操作前确认 dev server 没有待应用的 HMR 更新（否则重启 server）。

## 七、这一轮踩过的坑

1. **"改了但没生效"的两次翻车**：样式被文件后部的规则覆盖（分隔条 5142/5291、沉浸预览 2081/5288、
   zen 卡片 4175）。教训：改全局样式先全量 grep 同名选择器，改完必须实测 computed style。
2. **HMR 让探针假失败**：改完源码后 dev server 热更新，`import('/src/stores/appStore.ts')` 命中新的模块
   实例，`setMode` 改的不是页面那一份 → 四种模式测到同一状态。重启 dev server 后立刻正常。
3. **`getBoundingClientRect` 在 layout effect 里逐块调用**：CDP profile 显示 `getBoundingClientRect`
   独占 399ms（打开 240 块）。改成视口门控 + rAF 合并后降到噪声级。
4. **`balanceDocumentPanes` 覆盖编辑区宽度**：看不到 preview 兄弟节点时仍按 `DEFAULT_EDITOR_RATIO`
   改写 flex，导致"AI 面板打开时编辑区缩到某个宽度就拖不动"。
5. **`react-hooks/set-state-in-effect`**：菜单高度回夹、子菜单位置修正原先在 `useLayoutEffect` 里
   `setState`；改为直接写内联样式（只影响视觉）。定位递增改用 `requestAnimationFrame` 包裹。
6. **`react-hooks/refs`**：宿主把 `controllerRef.current` 作为 prop 传 → 渲染期读 ref 报错；改成
   菜单内部从 store 取。
7. **打包被运行实例占用**：`cargo` 无法覆盖 `zeditor.exe`（os error 5）。打包前先 `Get-Process zeditor`。
8. **子菜单 hover 后点击会关闭**：`onToggle` 做 toggle 会把 hover 展开的结果翻回去；改为只打开。
9. **子菜单在 body 上**：宿主用 `pointerdown` 关闭菜单时，子菜单项按下即被卸载 → 容器要阻止冒泡。

## 八、当前已知限制

- 编辑模式（源码对照 / 所见即所得 / 沉浸阅读 / 沉浸写作）与面板宽度**不持久化**到设置，重启回到默认
  （split 60/40、侧栏 250、AI 面板按 1/3 自适应）。
- 内容宽度放开到 100% 后，超宽屏（≥2560）长行可读性由 padding 控制，没有独立的"最大行宽"设置项。
- 首屏分批渲染在极端快速滚动（一次跳到文档末尾）时可能短暂看到空白，随后一帧内补齐。
- 表格处理沿用第一份 handoff 的限制（宽表滚动、复杂结构只读 + 就地源码编辑）。
- 安装包未签名；安装流程、桌面端真实输入法与高 DPI 表现仍未做人工验收。

## 九、可能的后续方向

1. 把"内容最大宽 / 分屏比例 / 面板宽度"做成可持久化的编辑器设置（`settings.editor.*`）。
2. 块菜单再补"复制为 Markdown / 粘贴为纯文本"、拖动排序（目前只有上移/下移）。
3. 首屏分批渲染可升级为真正的虚拟滚动（需要先解决光标恢复与 `content-visibility` 的冲突）。
4. 右键盘菜单的键盘可达性（方向键导航、`Shift+F10` 打开）尚未实现。
5. 把这一轮 18 个改动按"菜单共享 / 布局与样式 / 性能"拆成 2~3 笔提交（脚本与文档已备好思路）。

## 十、恢复上下文的最短路径

```bash
git log --oneline -4                  # HEAD = 2fff5fb（两笔未推送提交）
git status --short                    # 18 改 + 2 新（含本文件）
ls test-output                        # 7 个阶段包，最新 width-divider
```

**改哪类东西看哪个文件**：

| 想改 | 看 |
| --- | --- |
| 右键菜单项 / 子菜单 | `src/components/Editor/EditorContextMenu.tsx` |
| 块悬停菜单（插入 / 转换） | `src/components/Wysiwyg/BlockActions.tsx` + `wysiwygSession.setBlockKind / insertBlockAfter` |
| 块前缀转换规则 | `src/utils/wysiwyg/blockOps.ts` 的 `retypeBlock` |
| 编辑区宽度 / 留白 | `src/styles/wysiwyg.css`（`.wysiwyg-surface > .wysiwyg-document`） |
| 预览 / 沉浸 / zen 宽度 | `src/styles/main.css`（`preview-document`、`immersive-preview`、`zen-editor-pane`）、`src/styles/workbench.css` |
| 分隔条 | `src/styles/main.css`：公共 `::after` 段 + 各 divider 的 `width`（4px）+ 活动栏 `border-right` |
| 分屏比例 / 面板拖拽 | `src/App.tsx`（`DEFAULT_EDITOR_RATIO`、`balanceDocumentPanes`、`scheduleDragFrame`） |
| 打开速度 | `src/components/Wysiwyg/WysiwygEditor.tsx`（`renderBudget`、`observeHandleMeasure`） |
| 表格快捷栏 | `src/components/Editor/TableToolbar.tsx`（`placeToolbar`）+ `WysiwygChrome.tsx` 的锚点 |
| 设置里的编辑模式 | `src/components/Settings/SettingsPanel.tsx`（`setMode`）+ `appStore.setMode` |
