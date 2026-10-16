# 所见即所得编辑器：修复与增强交接说明

日期：2026-10-16
支线：`feature/wysiwyg-editor`
本轮工作范围：`eaa0252`..`f084f90`（共 10 个提交，已推送到 `origin`；本文自身提交在其上）
起始基点：`eaa0252 docs: record the wysiwyg repair and its remaining limits`

本文面向继续这条支线的下一位维护者或 Agent，记录这一轮改了什么、为什么这样做、哪些前提不能被破坏、怎么验证，以及还剩什么问题。

---

## 一、结论速览

这一轮在 `eaa0252` 之上新增 10 个提交，全部只落在 `feature/wysiwyg-editor`，`main`（`f7fb967e9ec6`）未改动。

先说结果：

| 类别 | 内容 |
| --- | --- |
| 数据损坏修复 | 表格 / 代码块 / 分隔线被回车拆碎；`Ctrl+1..6` 把整张表变成「标题 + 段落」 |
| 编辑行为修复 | 引用块内回车像没反应；`Delete` 是只拦截默认行为的死键；失焦抢光标；大纲把分隔线读成标题 |
| 修复后新增能力 | 空块退块（回车离开空列表项 / 空引用行） |
| 新增功能 | 方向键跨块移动光标；行内标记「输入即渲染」 |
| 界面修复 | 隐藏的块手柄吃掉左侧留白点击；纵向节奏读不出层级；分隔线贴住段落 |

验证状态：在最终代码树上跑完 `tsc` · `lint` · `test`（552 通过 / 0 失败）· `build`，四项全绿后才提交并推送。推送后用 `git ls-remote` 与本地 `rev-parse HEAD` 双向核对一致。

---

## 二、提交清单

按时间顺序，`eaa0252` 之后共 10 个：

| 提交 | 类型 | 内容 |
| --- | --- | --- |
| `50a05d0` | chore | `.gitignore` 忽略 `.pi/`（工具运行时目录），与已忽略的 `.superpowers/` / `.worktrees/` / `.workbuddy/` / `.codebuddy/` 并列 |
| `f4fb92b` | fix | `docs/.vitepress/config.mts` 读取版本号加 try/catch，解析失败回退 `unknown`，文档站不再因无关的 `package.json` 问题整体构建失败 |
| `234136e` | fix | 大纲不再把 `---` 分隔线当成 Setext 标题（`src/utils/markdownOutline.ts` 新增 `isSetextHeadingText`） |
| `0b996db` | fix | 块级拆行加白名单；块源码不再含块尾换行；引用内回车改用空引用行；新增 `exitEmptyItem` 与 `mergeForward` |
| `893e20d` | fix | 块尾 `Delete` 恢复（向后合并）；失焦不再抢回焦点；引用块补空的尾部段落；无效回车不留空撤销步骤 |
| `66d81c9` | fix | 块手柄隐藏时同步关掉命中 + 左留白透明桥接层；按块类型补分级上边距；分隔线恢复上下留白 |
| `f52c67a` | docs | CHANGELOG 与 `docs/guide/editing.md` 记录这一轮修复与已知限制 |
| `0ea13f3` | fix | `Ctrl+1..6` 设标题级别下沉到纯函数层并拒绝自带交互面的块；`SPLITTABLE_KINDS` 更名 `PREFIXED_TEXT_KINDS` |
| `67e48a7` | feat | 方向键跨块移动光标 |
| `f084f90` | feat | 行内标记「输入即渲染」 |

文件层面：这 10 个提交共改动 17 个文件，1111 行新增 / 30 行删除。整条支线相对 `main` 是 32 个提交、68 个文件、6512 行新增 / 763 行删除。

---

## 三、架构地图

### 分层

```text
src/components/Wysiwyg/          交互层（React + DOM）
  WysiwygEditor.tsx      561 L   块渲染宿主、键盘入口、粘贴、块视图
  wysiwygSession.ts      981 L   编辑会话：写回、结构操作、选区与偏移映射
  WysiwygChrome.tsx      225 L   浮层：选区工具栏、表格工具栏、斜杠菜单、AI / 图片弹窗
  WysiwygController.ts   124 L   适配既有 EditorController（工具栏、AI、状态栏、大纲复用）
  WysiwygCodeBlock.tsx    70 L   围栏代码块的就地编辑（textarea + 语言下拉）
  BlockActions.tsx        45 L   块左侧悬停手柄与菜单
  SourcePopup.tsx         53 L   块源码窗口
  domCaret.ts             69 L   DOM Range 语义归一化
  inlineEditing.ts        42 L   内联目标 → Markdown

src/utils/wysiwyg/               纯函数层（无 DOM，node:test 可穷举）
  blockOps.ts            207 L   块源码 + 光标 → 新块源码 + 新光标
  blockSerialize.ts      232 L   块 DOM 树 → Markdown（含容器偏移表）
  blocks.ts              213 L   块模型：splitMarkdownDocument / 可编辑判定
  inlineMarkers.ts       114 L   行内标记「输入即渲染」的匹配（本轮新增）
  inlineSerialize.ts     196 L   行内 DOM 树 → Markdown（含转义来源 steps）
  inlineNodes.ts         123 L   DOM 无关的行内树
  offsetMap.ts            84 L   光标点 ↔ 块内偏移
  codeFence.ts            88 L   围栏解析与格式化
  textLines.ts / undoStack.ts    行索引、内容级撤销栈

src/styles/wysiwyg.css           编辑表面唯一的样式表
```

### 两条写回路径（理解一切的入口）

1. **用户直接输入**：DOM 就地改动 → `handleInput(index)` → 250 ms 防抖 `scheduleWriteBack` → `writeBackBlock` → `commit(block, markdown)`。`commit` 按「块类型是否改变 / 块数量是否改变」决定是保留 DOM（`skipRenderIndex`）还是整块重渲染（`pendingCaret`）。
2. **结构性或外部改动**：`applySource(source, caret)` 重新整篇 `splitMarkdownDocument`，或 `applyBlockSource(block, source, caret)` 只替换单块源码。

两条路最终都收敛到 `persist()` + `emit()`，`emit()` 只在 `skipRenderIndex === null` 时递增 `renderRevision` 并置 `awaitingRender`。

---

## 四、不能破坏的前提

这些是这一轮排查中反复确认的约束，后续改动请勿违反。

1. **块级粒度**：任何编辑只重排 / 替换被编辑块的源码区间，绝不做整篇规范化。整篇重建会把光标、撤销栈和未保存输入一起冲掉。
2. **转义来源必须复用**：块内偏移映射必须复用序列化时产出的 `MarkdownPiece.steps` 与容器 `escapeLineStart`（`offsetMap.ts` 里有注释说明），自行重新推导转义长度会让整块光标偏移。
3. **`PREFIXED_TEXT_KINDS` 是共用白名单**：`paragraph / heading / list / blockquote` 之外（table / fence / hr / html）都自带交互面，`splitBlock` 与 `setHeadingLevel` 必须返回 `null` 交回浏览器。两个入口依赖同一条前提（源码是「可选前缀 + 内容」），**不要只为其中一个加守卫**——`0ea13f3` 之前的 bug 就是这个形状。
4. **`collectBlock` 故意把 table 放行**（表格单元格需要经 `collectBlockForOffset` 写回），因此**每个调用方都要自己判断** `collected.block.editable`。
5. **拒绝要在 `checkpointBlock` 之前**：`handleEnter` / `handleHeadingLevel` 等先算结果、拿到 `null` 立即返回，否则会在撤销栈里留下空步骤。
6. **围栏块不能用 `focus()` 落光标**：`applySelection` 在无法生成 Range 时对 fence 派发 `zeditor-code-selection` 事件；而 `focus()` 的兜底会把不可编辑目标改送到「第一个可编辑块」。
7. **块源码不含块尾换行**：`blocks.ts` 里剥掉尾部换行（`0b996db`），块之间的空行交给 `pairEnds` 合成空段落，否则列表 / 表格后面的光标落点根本不存在。
8. **`applySelection` 只聚焦最近的 `[contenteditable="true"]`**，不改变源码；改源码一律走两条写回路径。

---

## 五、这一轮的关键决策与理由

### 引用块内的回车：改用空引用行，末尾则退出引用

单换行在 CommonMark 里是同一段落的**软换行**，所以 `> a\n> b` 渲染出来只有一个 `<p>`，回车看起来像没反应。改用 `\n>\n` 作分隔（真正的两个引用段落）。但 markdown-it **不为末尾的空引用行生成段落**，末尾多一个空引用行渲染后也只有一个 `<p>`，光标落不下去——所以引用末尾的回车改为**退出引用**（Markdown 无法表达尾部空引用段落）。

实现上分两处：`blockOps.splitBlock` 负责分隔符；`WysiwygEditor` 的渲染 effect 在 `hasTrailingEmptyQuoteLine(source)` 时补一个空 `<p>`（带 `alreadyEmpty` 幂等判断，因为该 effect 每次 renderRevision 都会重跑）。

### 行尾换行被列表 token 吃掉

markdown-it 的列表 token 会把块尾空行算进自己的 `token.map`，于是「在下方插入段落」和空块退块都找不到落点。修法是在 `splitMarkdownDocument` 里先算出 `rawLength`，剥掉尾部换行得到 `blockSource`，再让 `source` 与 `editable` 都基于剥好的文本。

### 手柄为什么要点「两下」

块手柄原本只靠 `opacity` 隐藏，命中区仍在，于是正文左侧留白（正常的「定位光标」动作）会命中一个看不见的按钮并弹出块菜单。修法是隐藏态 `pointer-events: none`，同时给壳加一层透明 `::before` 桥接层覆盖那 34px 竖条——指针移进留白时手柄先显现，再点才打开菜单。这样既恢复「悬停留白可见手柄」的发现性，又不再静默劫持点击。键盘可达性单独验证过（程序化聚焦后 Enter 仍能打开菜单）。

### 纵向节奏

编辑表面把块内边距清成 0，所有纵向间隔统一由壳的 `.45em` 提供，于是标题和段落只差一个字号，层级读不出来。按块类型补 `:has()` 分级上边距：标题 0.9em，表格 / 代码 / 引用 0.7em，其余维持 0.45em；分隔线单独恢复 `margin-block: 1.5em`。

### 方向键跨块

每个块是各自独立的 `contenteditable`，浏览器原生不会把光标交给兄弟块，所以块尾按 `↓` 是原地不动，与源码模式不一致。

判定逻辑放在纯函数 `arrowLeavesBlock`（只看偏移边界，不看几何），会话层 `handleArrow` 负责挑相邻块并落光标。`Shift` / `Alt` / `Ctrl` 组合键不接管。光标移动**不改源码**：只调 `setSelectionOffsets`（此时 `awaitingRender` 为假，立即生效），由 `applySelection` 自行聚焦或派发围栏事件。

### 行内标记「输入即渲染」

这是文档里列的第一条已知限制。不做的话，`**粗体**` 会以字面字符写回源码（`*` 是必须转义的字符，源码成了 `\*\*粗体\*\*`），此后无论怎么重渲染都变不成粗体。

新增纯模块 `src/utils/wysiwyg/inlineMarkers.ts`：识别光标前刚闭合的 `**` `*` `~~` `` ` ``，然后把候选**交给真正的渲染器复核一遍**（`rendersAsMarker` 用 `renderMarkdownSource` 验证）——这条保险是为了避免「敲完变粗体、但源码渲染回来不是粗体」的分叉（例如 `**a**b**` 这种表面配对、实际按字面渲染的写法）。

`wysiwygSession.handleInput` 在排写回之前调用 `renderInlineMarker`，只改 DOM；源码仍由正常写回生成，因此两条路径结果必然一致。

不接管的边界（每一条都有测试）：

- 空内容、首尾空白（`* 斜 *` 不是强调）
- 未真正闭合，或光标停在成对 `*` 中间（打 `**粗体**` 的第 5 个字符时文本停在 `**粗体*`，若按单 `*` 收尾就会先把「粗体」变成斜体，整段再也拼不出粗体）
- 非折叠选区、输入法组合期间
- 已经处于 `code` / `pre` 内
- 同种标记套自己（`<strong><strong>a</strong></strong>` 回写成 `****a****` 会失去粗体）
- 下划线 `_` / `__`：CommonMark 只在标点或空白边界才认它，中文正文里 `文件_名称` 很常见，纯文本判断覆盖不全，宁可交回字面文本

---

## 六、验证方式

### 标准四项

在仓库根目录：

```powershell
npx tsc -b --force
npm run lint
npm test
npm run build
```

本轮最终状态：`tsc` 通过、`lint` 通过、`npm test` **552 tests / 552 pass / 0 fail**、`vite build` 成功。

### 测试布局

仓库里**没有 jsdom**，所以：

- 纯逻辑放 `src/utils/wysiwyg/*`，用 node:test 穷举；
- 需要 DOM 的会话行为用**替身夹具**：`tests/wysiwygBlockDelete.test.ts`（光标固定在块尾）、`tests/wysiwygBlockNavigate.test.ts`（光标位置可设）。夹具通过 `session.setAccessors({ getSurface, getBlockElement })` 注入，宿主对象只需实现 `dataset.blockIndex` / `closest` / `contains` / `focus`。

仅跑所见即所得相关用例：

```powershell
node --test tests/wysiwyg*.test.ts
```

当前 11 个文件 / 101 个用例（另有 `tests/markdownOutline.test.ts` 的 8 个）。

新增用例分布：`wysiwygBlockOps` 16、`wysiwygBlockDelete` 8、`wysiwygBlockNavigate` 8、`wysiwygInlineMarker` 7、`markdownOutline` 8（全部为新增或改写）。

### 真浏览器复核（这套方法成本高，值得复用）

四条结构性缺陷（手柄命中、引用内回车、表格被 `Ctrl+1` 破坏、方向键不动）都是先在真浏览器里复现、修完再复核的。配方：

```js
// 从 npx 缓存直接 import，仓库未装 playwright
import { chromium } from 'file:///C:/Users/zhcx/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
```

要点：

1. 先起 dev server（本轮用 5199 端口），`page.goto('http://localhost:5199/')`。
2. **必须**先点掉首次运行的模式选择框（`.mode-chooser-card` 中含「所见即所得」的那张），否则它拦截所有点击。
3. 灌入测试文档要用**合成粘贴事件**，不要用 `keyboard.type('\n')`——后者会触发结构化的回车处理，把夹具揉坏：

   ```js
   await page.evaluate((t) => {
     const dt = new DataTransfer();
     dt.setData('text/plain', t);
     document.activeElement.dispatchEvent(
       new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
     );
   }, '第一段\n\n第二段\n');
   ```

4. 每个探针步骤用 try/catch 包住，否则一个 `locator.click` 超时会丢掉此前所有输出。
5. 读状态优先用 `page.evaluate`，不要去点 `display: none` 的元素（`is-code-editing` 的围栏块就是这种）。
6. `page.goto` / reload 可能被未保存修改守卫拦住，改用应用自己的「新建标签页」/「新建文件」。

---

## 七、这一轮踩过的坑（避免重复付费）

| 坑 | 事实 |
| --- | --- |
| pi-lens 的整仓扫描 | `mode=all` 会返回既有的风格洪泛（数十条 blocking + 上千条 warning，跨数百文件），与本轮无关，不要追。判断改动是否干净请用 `source=lsp` + `scope=paths` 针对改过的文件。 |
| 根 `tsconfig.json` 是引用壳 | 它只有 `{ files: [], references: [app, node] }`，LSP 可能据此推断出一个缺 `moduleResolution: bundler` / `types: ['node']` 的项目，从而对 `vite.config.ts` 报假错。用 `npx tsc -p tsconfig.node.json --noEmit` 复核，别信重放的缓存。 |
| `bg_run` 的执行环境是 cmd.exe | 路径要写成 `cd /d D:\Documents\Code\zeditor && ...`（`/d` 后必须有空格、用 Windows 路径）。POSIX 写法 `cd /d/Documents/...` 会报 GBK「命令语法不正确」。 |
| 大 pack 拉取会中断 | 抓 GitHub 时大包或 `--unshallow` 会 `RPC failed / early EOF / invalid index-pack output`；小 `--depth=1` 单支线可成功。本仓库是浅克隆，不要尝试 unshallow。 |
| GitHub 访问 | 本机需要走系统代理。仓库本地 `.git/config` 里已写 `http.proxy` / `https.proxy = http://192.168.1.22:20173`（按需确认当前系统代理是否仍为此地址）。 |
| 临时脚本 | 浏览器探针写成仓库根的 `.pi-*.mjs`，用完即删；`.pi/` 已在 `.gitignore` 里。 |

---

## 八、当前已知限制（文档化的行为，不是缺陷）

来自 `docs/guide/editing.md` 与 `CHANGELOG.md`：

1. 行内标记「输入即渲染」只覆盖 `**`、`*`、`~~`、`` ` `` 四种；下划线写法与嵌套复杂组合仍按字面文本保留。转换后光标停在标记之后，继续输入会落进该格式内部——这与工具栏加粗的行为一致，需要时用方向键或 `End` 移出。
2. 所见即所得不提供源码编辑器的多光标操作。
3. 图表与块级公式仍通过块源码窗口编辑。
4. 编辑表面内不显示校对高亮（校对面板与「应用」修复仍可用）。
5. 引用块末尾的空引用段落无法用 Markdown 表达，重新渲染时会被规范化掉；因此引用末尾回车是退出引用。
6. 方向键不进入表格 / 代码块 / 分隔线（它们自带交互面，用点击进入），跨块时会越过它们。

---

## 九、可能的后续方向

下面按「已确认存在 / 需要评估」两类分开。

### 已确认存在

- `main` 尚未合并这条支线。是否需要开 PR 或合回 `main`，看发布节奏。合并前建议先跑一遍标准四项。
- 表格单元格里的方向键目前不走 `navigateTableCell`（该函数已支持 `ArrowUp/Down/Left/Right` 并会在越界时返回 `null`，是现成的逃生口），而 `WysiwygChrome` 的捕获阶段只接管了 `Tab` / `Enter`。若要让方向键在表格内跨格，接线成本不高。

### 需要评估（先复现再动手）

- 方向键跨块是**只看偏移边界**的判定，不看几何。对软换行和块内多行，块内移动仍交给浏览器；若要处理「视觉行」与「源码行」不一致的极端排版，需要改成比较光标矩形与内容矩形。
- 行内标记目前只在闭合瞬间判定一次。若将来要覆盖下划线写法，需要把 CommonMark 的边界规则完整搬进来，或改用「渲染器复核 + 候选集合」的策略。

---

## 十、恢复上下文的最短路径

```powershell
cd D:\Documents\Code\zeditor
git rev-parse --abbrev-ref HEAD      # feature/wysiwyg-editor
git status --short                   # 应为空
git log --oneline -1                 # 顶端包含本文档
git log --oneline -1 f084f90         # 本轮代码的最后一个提交
npx tsc -b --force; npm test         # 基线：552 通过
```

要动块级行为，先读 `src/utils/wysiwyg/blockOps.ts`（纯函数、白名单、每个导出的语义都在注释里）和 `src/components/Wysiwyg/wysiwygSession.ts` 的 `handleEnter` / `handleBackspace` / `handleDelete` / `handleArrow` 四兄弟——它们是同一族操作，新操作照这个形状写：**纯函数返回 `{source, caret} | null`，会话层拿到 `null` 就在 `checkpointBlock` 之前返回 `false` 交回浏览器**。
