# 所见即所得编辑器：体验修复轮交接说明

日期：2026-10-17
支线：`feature/wysiwyg-editor`
上一份交接：[wysiwyg-handoff-2026-10-16.md](./wysiwyg-handoff-2026-10-16.md)（记录到 `a1971ea`）
本文覆盖：`a1971ea` 之后的全部工作——两笔本地提交（未推送）+ 当前工作区 8 个尚未提交的文件。

---

## 一、当前状态速览

| 位置 | 内容 | 状态 |
| --- | --- | --- |
| `faf1554` | 表格方向键、复杂结构编辑、行内标记扩展、视觉折行、块级公式、校对高亮、块渲染性能、回归基建 | 已提交，未推送（31 文件，+1233/−117） |
| `2fff5fb` | 段间距稳定（两态行高统一）、块手柄对齐、块源码就地编辑（删 `SourcePopup`）、表格对齐预览 | 已提交，未推送（11 文件，+262/−127） |
| 工作区 | 段间距压缩、表格快捷栏避让、块按钮 VS Code 外观、删除空行的光标语义 | **未提交**（8 文件，+120/−41） |

验证基线（全部在最终代码树上跑过）：

```powershell
npx tsc -b --force                      # 通过
npm run lint                            # 通过
npm test                                # 575 通过 / 0 失败
npm run build                           # 通过
node scripts/verify-wysiwyg-browser.mjs # 30/30 通过（需先起 dev server，见第六节）
npm run tauri -- build --bundles nsis --no-sign --ci   # 成功，产物已归档
```

打包产物（未签名测试包，均归档在 `test-output/`）：
`wysiwyg-complete-2026-10-16`、`wysiwyg-inline-ui-2026-10-16`、`wysiwyg-ui-polish-2026-10-17`（最新，SHA-256 `1D1F8F1B…9CDA`）。

---

## 二、两笔提交与未提交改动的内容

### `faf1554`：功能补齐 + 性能 + 回归基建

- 表格方向键在单元格文字/视觉行边界跨格，表格外边界连接相邻正文（`wysiwygSession.handleTableArrow` + `navigateTableCell`）。
- `Tab` / `Shift+Tab` 只调整当前列表项及其后代，支持引用中的列表与多位编号（`utils/wysiwyg/listEditing.ts`）。
- 开放嵌套引用、多段落列表、列表/引用混合结构的原地编辑（`blocks.ts` / `blockSerialize.ts` / `blockOps.ts` 的容器与前缀递归）。
- 行内标记扩展到 `_`、`__`、`***`、`___` 与不同格式嵌套（`inlineMarkers.ts`，渲染器复核边界）。
- 上下方向键按实际视觉折行判定跨块（`components/Wysiwyg/caretGeometry.ts`）。
- 块级公式点击打开既有公式弹窗；编辑表面用 CSS Highlight 显示校对波浪线（`ProofreadHighlights.tsx`，不改 DOM、不写源码，文档变化后清除过期标记）。
- 性能：块渲染缓存迁到 `utils/wysiwyg/blockHtml.ts`（600 项上限、按最近使用淘汰）；每块独立渲染版本 `blockRenderRevisions`（React 合并中间快照时脏块仍会规范化）；空段落行号改用已有行索引二分定位。
- 基建：`scripts/verify-wysiwyg-browser.mjs`（浏览器回归）、`scripts/benchmark-wysiwyg.mjs`（分块基准）；三份过程记录（`wysiwyg-review` / `wysiwyg-completion-plan` / `wysiwyg-completion-2026-10-16.md`）。

### `2fff5fb`：编辑表面体验（提交部分）

- **段间距稳定**：段落块（含回车产生的空段落）与渲染出的 `<p>` 统一行高，空段落 `min-height` 同步——消除「输入态 21px → 重渲染 25.76px」的每次回车跳变。
- **块手柄对齐**：手柄换成几何居中的 SVG 六点图标；块视图测量首行行盒（优先 `p/li/h1..h6/pre code`，表格取首格）写入壳属性 `--wysiwyg-first-line`，手柄按它垂直居中。实测偏差：段落 0.4px、标题 0.6px、列表/引用 0.4px、表格 1.6px、代码块 3.5px（等宽字形墨迹中心差）。
- **块源码就地编辑**：删除模态 `SourcePopup.tsx`，新增 `BlockSourceEditor.tsx`（面板占用块自身位置，工具栏含 `Ctrl+Enter` 保存 / `Esc` 取消 / 保存 / 取消；`Tab` 插入两空格）；HTML 块与解析不出结构的块**点击直接进入**编辑。
- **表格对齐阅读预览**：`display: inline-table`（内容宽度，不再拉满整行）、`border-collapse: collapse`、预览同款外框与 108px 单元格最小宽度；宽表仍由 `.table-resize-wrap` 出滚动条，列宽拖拽不受影响。
- 浏览器回归 +3 用例（段落回车高度稳定、块源码就地写回且无模态、表格按内容宽度渲染）→ 30 项。

### 工作区（未提交，8 文件）

- **段间距压缩**：段落行高 1.84 → **1.62**（段落块高 25.8 → 22.7px），列表项与引用内正文同步；块间距 0.45em → **0.32em**。相邻段落文字间隙 **13.0 → 8.1px**。
  ⚠️ 规则必须同时命中 section（输入态）与 `p`（渲染态）：`.preview-document p` 是显式 `line-height: 1.84`，只改壳（继承）不会生效——第一版就因为这点没生效，两态行高还会再次分叉。
- **表格快捷栏避让**：`TableToolbar` 改为以**整张表格**为锚点，渲染后按**实测尺寸**在绘制前定位（上方放不下自动移到下方、两侧紧张时夹回视口），并用 `ResizeObserver` 跟随换行；提示文字不再强制独占一行（工具栏回到单行 36px）。修复前：按单元格定位 + 固定 46px 预留，而实际高度 56px（两行）→ 盖住表头；且按 620px 假定宽度夹位置 → 窄窗口贴边。
- **块按钮外观（参考 VS Code）**：图标由描边圆改为 6 个**实心**圆点（`iconGeometry.grip` 用新的 `dot()` helper，逐点覆盖画布的 `fill:none/stroke`）；按钮 26×26、圆角 6px、常驻底色 `--surface-muted`、强调色点阵，悬停只提亮底色（不再改边框/图标色，避免指针进出时跳动）。
- **删除空行的光标语义**：空块按 Backspace 删除后，光标回到**上一块末尾**（"上升一行"），而不是留在删除点交给下一块开头（那会让下一行内容"跳上来"）。修复前中间空块与末尾空块行为不一致。
  ⚠️ 注意实测现象：`AA\n\n\n\nBB` 里退格一次，源码从 3 个空行归到 1 个空行（删除的是空段落块连同两侧分隔），这是块模型语义，不是缺陷；视觉位移是"空段落块"这一行。

---

## 三、架构更新（相对上一份交接）

新增文件：

```text
src/utils/wysiwyg/blockHtml.ts           块 HTML 渲染缓存（600 项 LRU）
src/utils/wysiwyg/listEditing.ts         列表层级调整
src/components/Wysiwyg/caretGeometry.ts  视觉行/行边缘判定
src/components/Wysiwyg/ProofreadHighlights.tsx  CSS Highlight 校对标记
src/components/Wysiwyg/BlockSourceEditor.tsx    块源码就地编辑面板
scripts/verify-wysiwyg-browser.mjs       浏览器回归（30 项，见第六节）
scripts/benchmark-wysiwyg.mjs            分块基准
docs/wysiwyg-{review,completion-plan,completion}-2026-10-16.md  过程记录
```

删除文件：`src/components/Wysiwyg/SourcePopup.tsx`（被 `BlockSourceEditor` 取代）。

补充两条数据流：

1. **手柄对齐**：`WysiwygBlockView` 的渲染 `useLayoutEffect` 末尾测量首个文本盒（表格取 `th/td`），把「到首行行盒中心的两倍距离」写到壳的 `--wysiwyg-first-line`；CSS 里 `.wysiwyg-block-actions { height: var(--wysiwyg-first-line, 1.62em); align-items: center }`。基准是**壳**而不是块（围栏块的代码工具栏在块之外、壳之内）。
2. **表格快捷栏定位**：`WysiwygChrome` / `Editor.tsx` 只提供表格的 `anchorLeft/anchorTop/anchorBottom`；`TableToolbar` 自己测量尺寸并计算 `above/below`（`placeToolbar`），首帧用估计尺寸、`useLayoutEffect` 在绘制前修正，`ResizeObserver` 跟随尺寸变化。

---

## 四、不能破坏的前提（在上一份基础上新增）

上一份交接第四节的前提继续有效（块级粒度、转义来源复用、`PREFIXED_TEXT_KINDS` 白名单、`collectBlock` 放行 table、拒绝要在 `checkpointBlock` 之前、围栏块不 `focus()`、块源码不含块尾换行、`applySelection` 只聚焦 `[contenteditable="true"]`）。本轮新增：

1. **段落两态行高一致**：`.wysiwyg-document .wysiwyg-block[data-block-kind="paragraph"]` 与它的 `p` 必须同一条行高规则命中（现在是 1.62）；只改壳会被 `.preview-document p` 的显式 1.84 盖掉，两态再次跳动。
2. **手柄对齐依赖测量**：删掉渲染 effect 里的 `--wysiwyg-first-line` 写入、或把手柄移出块壳，都会让手柄退回固定位置。
3. **空块删除的光标落点**：`handleBackspace` 空块分支必须用 `previous.offset + previous.length`（上一块末尾）；用 `removed.caret` 会把光标交给下一块开头。
4. **`TableToolbar` 有两个调用方**：`WysiwygChrome`（所见即所得）与 `Editor.tsx`（源码对照），改 props/定位必须两处同步（本轮先漏了后者，`tsc` 才发现）。
5. **回归脚本的用例归属**：新增用例只依赖已提交的代码；拆分提交时把测新功能的用例放进对应提交，否则前面的提交跑脚本会红（本轮第一笔因此把 3 个新用例临时移出）。

---

## 五、关键决策与理由

- **就地源码编辑替代模态弹窗**：弹窗把编辑动作从文档里摘出去，长内容要在居中窗口里看。就地面板保留前后文与滚动位置；显式保存/取消（不即时写回），因为编辑中的半成品源码会被解析成乱块、把 textarea 冲掉。
- **段间距压缩的取舍**：阅读预览的行高（1.84）对编辑偏松，编辑表面改用 1.62 + 更紧的块间距；只作用于 `.wysiwyg-document` 作用域，预览与导出排版不变。若将来要求"编辑与预览完全一致"，把 `wysiwyg.css` 里那段规则改回 1.84 即可（同时改 `min-height` 与手柄回退值）。
- **表格样式对齐预览但保留滚动兜底**：编辑器里没有 `.preview-container` 祖先，模板的 `display: block; width: 100%` 会把空表画成一整行空框，UA 默认 `border-collapse: separate` 又有双线；覆盖成预览的值。**不设 `max-width`**，让 `.table-resize-wrap` 继续决定是否出滚动条，避免破坏列宽拖拽。
- **手柄外观**：常驻底色 + 强调色实心点阵；悬停只改底色，不改边框/图标色——后者会让指针进出时按钮"跳"一下。
- **删除空行的语义**：与源码编辑器一致（行首 Backspace 合并到上一行），光标落点是"命中点"，不是"删除后下标指向的块"。

---

## 六、验证方式

四项静态/单元检查（在仓库根目录）：

```powershell
npx tsc -b --force
npm run lint
npm test
npm run build
```

浏览器回归（30 项，覆盖表格跨格、复杂结构编辑、行内标记、视觉折行、公式弹窗、校对高亮、撤销、组合输入、标签切换、源保真、本轮四项修复的防回归）：

```powershell
# 先起开发服务器（vite 默认只绑 localhost；脚本默认地址是 127.0.0.1，需用环境变量覆盖）
npm run dev -- --port 5199 --strictPort
# 冷启动首屏可能要 30~60 秒（依赖优化），先访问一次预热：
curl.exe -s -o NUL http://localhost:5199/
# Playwright 从 npx 缓存解析（路径中的 hash 目录可能变化，按需替换）：
$env:PLAYWRIGHT_MODULE_PATH="C:\Users\zhcx\AppData\Local\npm-cache\_npx\9833c18b2d85bc59\node_modules\playwright\index.mjs"
$env:ZEDITOR_TEST_URL="http://localhost:5199/"
node scripts/verify-wysiwyg-browser.mjs
# 支持 WYSIWYG_TEST_FILTER 按名称筛选单用例
```

打包（约 6 分钟；**执行前必须关闭正在运行的 `zeditor.exe`**，否则 cargo 覆盖可执行文件时报 `os error 5 拒绝访问`）：

```powershell
npm run tauri -- build --bundles nsis --no-sign --ci
# 产物：src-tauri/target/release/{zeditor.exe, bundle/nsis/Zeditor_0.6.3_x64-setup.exe}
```

---

## 七、这一轮踩过的坑

| 坑 | 事实 |
| --- | --- |
| vite 冷启动 | 首屏 HTML 可能 30~60 秒才返回（依赖优化）。回归脚本 `page.goto` 默认等 `load`、超时 30s，会直接失败——先 `curl` 预热，并用 `ZEDITOR_TEST_URL` 指到 `localhost`。 |
| Playwright 位置 | 不在项目依赖里，在 npx 缓存 `_npx/<hash>/node_modules/playwright/index.mjs`，hash 目录会变，跑脚本前先确认。 |
| `.preview-document p` 显式行高 | 继承值盖不过它——段间距压缩第一版只改了壳，没生效且两态重新分叉。改编辑表面段落行高必须同时命中 `p`。 |
| `TableToolbar` 双调用方 | `WysiwygChrome` 与 `Editor.tsx`；改 props 只改一处会 `tsc` 报错（比运行时才发现好）。 |
| 打包被占用 | 上一版 `zeditor.exe` 运行中 → `failed to remove file ... os error 5`。先关闭应用再打包。 |
| 拆分提交 | 两方改动混在同文件：备份最终版 → 逐处回退前半部分 → 提交 → 恢复备份（用 SHA-256 逐一核对）→ 提交后半部分。临时文件放 `%TEMP%`，**不要** `git add -A`（会把中间产物带进提交），用 `git add -u` + 显式新文件。 |
| 首帧定位闪动 | 浮动组件的首帧尺寸是估计值：用 `useLayoutEffect` 在绘制前按实测修正，再挂 `ResizeObserver` 跟随尺寸变化，避免"先画错再跳"。 |

---

## 八、当前已知限制

- 编辑表面行高（1.62）**有意不等于**阅读预览（1.84）：编辑更紧凑，最终排版以预览/导出为准。
- 图表、媒体、块级公式通过块源码的就地编辑修改；多光标仍使用源码模式。
- 表格快捷栏在极窄视口（约 <480px）仍会换行成两行——已按实测高度避让，不会再遮挡表格。
- 工作区 8 个文件（本轮四项修复）**尚未提交**；`faf1554`、`2fff5fb` 两笔提交**尚未推送**。
- 桌面端真实中文输入法与安装包安装流程仍未验收（沿用上一轮结论）。

---

## 九、可能的后续方向

- 若用户反馈"编辑与预览排版不一致"，优先把行高切回 1.84（一处 CSS + 手柄回退值），而不是给两套表面做桥接。
- 表格快捷栏按钮较多（11 项），窄视口下可考虑折叠次要操作（对齐/整理）到一个"更多"菜单。
- 提交并推送本轮工作；推送前建议重跑四项检查与浏览器回归（当前全绿）。

---

## 十、恢复上下文的最短路径

```powershell
cd D:\Documents\code\zeditor
git log --oneline -3        # 2fff5fb（体验修复）/ faf1554（功能与性能）/ a1971ea（上一轮基点）
git status --short          # 8 个未提交文件（段间距/工具栏/按钮/删除空行）
npx tsc -b --force; npm test   # 基线：575 通过
```

要改哪类东西，先看哪里：

- **段间距 / 行高 / 手柄外观**：`src/styles/wysiwyg.css` 的"编辑表面"区块 + `WysiwygEditor.tsx` 渲染 effect 里的首行测量。
- **表格快捷栏**：`src/components/Editor/TableToolbar.tsx`（`placeToolbar` + `ResizeObserver`），两个调用方 `WysiwygChrome.tsx` / `Editor.tsx` 只传锚点。
- **块级行为（回车/退格/方向键/删除）**：`wysiwygSession.ts` 的四兄弟（`handleEnter` / `handleBackspace` / `handleDelete` / `handleArrow`）与 `utils/wysiwyg/blockOps.ts`；新增操作照旧模式写：纯函数返回 `{source, caret} | null`，会话层拿到 `null` 就在 `checkpointBlock` 之前返回 `false`。
- **回归**：`scripts/verify-wysiwyg-browser.mjs`（新增用例追加在文件末尾、`assert.deepEqual(errors, …)` 之前）。
