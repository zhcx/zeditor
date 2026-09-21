# 文本清理与智能配对实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Zeditor 增加“格式 → 文本清理”和可配置的 Markdown 智能配对、Tab 跳出、空配对 Backspace 删除能力。

**Architecture:** 将文本清理和智能配对规则分别实现为无 UI 依赖的纯函数模块；`Editor.tsx` 负责把智能配对决策应用到 Monaco，`MenuBar.tsx` 负责调用文本清理，设置由现有 Zustand 持久化链路承载。代码围栏与已有内容的行内代码只影响键盘智能行为，文本清理按用户指定的两项规则处理全文或选区。

**Tech Stack:** React 18, TypeScript, Monaco Editor 0.55, Zustand, Node test runner (`node --test`), ESLint, Vite/TypeScript build。

---

## 文件边界

- Create: `src/utils/textCleanup.ts` — 行尾空白和连续空白行清理，以及光标/选区偏移映射。
- Create: `src/utils/smartPairs.ts` — 配对表、Markdown 上下文识别和键盘决策。
- Create: `tests/textCleanup.test.ts` — 文本清理与偏移映射测试。
- Create: `tests/smartPairs.test.ts` — 智能配对决策测试。
- Create: `tests/editorFeatureWiring.test.ts` — 菜单、设置、编辑器接线的静态契约测试。
- Modify: `src/stores/appStore.ts` — 增加 `Settings.editor.smart_pairs`，默认开启并兼容旧配置。
- Modify: `src/components/Settings/SettingsPanel.tsx` — 添加编辑器设置开关。
- Modify: `src/components/Editor/Editor.tsx` — 接入 Monaco `onKeyDown` 和文本清理控制器。
- Modify: `src/components/MenuBar/MenuBar.tsx` — 增加“格式 → 文本清理”。

## Task 1: 文本清理纯函数（TDD）

**Files:**
- Create: `tests/textCleanup.test.ts`
- Create: `src/utils/textCleanup.ts`

- [ ] **Step 1: 写失败测试，固定清理结果和偏移 API**

创建 `tests/textCleanup.test.ts`，测试接口为：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanText } from '../src/utils/textCleanup.ts';

test('removes trailing whitespace and collapses repeated blank lines', () => {
  const result = cleanText('title  \n\t\n\nbody');
  assert.equal(result.content, 'title\n\nbody');
  assert.equal(result.changed, true);
});

test('keeps one blank line and does not rewrite existing line endings', () => {
  const source = 'a\r\n\r\n\r\n b\r\n';
  assert.equal(cleanText(source).content, 'a\r\n\r\n b\r\n');
});

test('removes unicode whitespace at the end of a line', () => {
  assert.equal(cleanText('a\u00a0\n\u2003\nb').content, 'a\n\nb');
});

test('reports unchanged input without creating a different string', () => {
  const source = 'a\n\nb';
  const result = cleanText(source);
  assert.equal(result.content, source);
  assert.equal(result.changed, false);
});

test('maps an original caret past removed trailing spaces and blank lines', () => {
  const source = 'a  \n\n\nbody';
  const result = cleanText(source);
  assert.equal(result.content, 'a\n\nbody');
  assert.equal(result.mapOffset(source.indexOf('body')), result.content.indexOf('body'));
});
```

- [ ] **Step 2: 运行测试确认按预期失败**

运行：`node --test tests/textCleanup.test.ts`

预期：FAIL，原因是 `src/utils/textCleanup.ts` 尚不存在或尚未导出 `cleanText`；不得因为测试语法错误失败。

- [ ] **Step 3: 实现最小清理算法**

在 `src/utils/textCleanup.ts` 导出：

```ts
export interface TextCleanupResult {
  content: string;
  changed: boolean;
  mapOffset: (offset: number) => number;
}

export function cleanText(source: string): TextCleanupResult;
```

实现要求：先用 `[^\S\r\n]+(?=\r?$)` 的等价正则逻辑删除每行末尾的非换行空白；再按 `\r\n|\n|\r` 保留分隔符的方式扫描行片段，把连续空白行保留为最多一行。不要用 `split('\n').join('\n')` 之类的写法重写 CRLF 或混合换行。扫描时记录每个源偏移对应的输出偏移：被删除的尾随空白映射到删除点前，被折叠的空白行映射到保留下来的空白行末端；`mapOffset` 对越界输入进行 `0..source.length` 和 `0..content.length` 截断。

- [ ] **Step 4: 运行测试确认通过**

运行：`node --test tests/textCleanup.test.ts`

预期：所有文本清理测试 PASS。

- [ ] **Step 5: 提交文本清理模块**

```text
git add src/utils/textCleanup.ts tests/textCleanup.test.ts
git commit -m "feat: add text cleanup utility"
```

## Task 2: 智能配对决策（TDD）

**Files:**
- Create: `tests/smartPairs.test.ts`
- Create: `src/utils/smartPairs.ts`

- [ ] **Step 1: 写失败测试，固定决策类型和全部交互规则**

测试使用以下 API：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSmartPair, type SmartPairDecision } from '../src/utils/smartPairs.ts';

const decide = (value: string, offset: number, key: string, enabled = true): SmartPairDecision =>
  resolveSmartPair({ value, offset, key, enabled });

test('inserts ordinary, CJK, curly quote and backtick pairs', () => {
  for (const [key, text] of [
    ['(', '()'], ['[', '[]()'], ['{', '{}'], ['"', '""'], ["'", "''"], ['`', '``'],
    ['「', '「」'], ['『', '『』'], ['（', '（）'], ['【', '【】'], ['《', '《》'], ['〈', '〈〉'],
    ['“', '“”'], ['‘', '‘’'],
  ] as const) {
    const action = decide('', 0, key);
    assert.deepEqual(action, { kind: 'insert', from: 0, to: 0, text, cursor: 1 });
  }
});

test('creates Markdown emphasis pairs and upgrades them to double markers', () => {
  assert.deepEqual(decide('', 0, '*'), { kind: 'insert', from: 0, to: 0, text: '**', cursor: 1 });
  assert.deepEqual(decide('**', 1, '*'), { kind: 'replace', from: 0, to: 2, text: '****', cursor: 2 });
  assert.deepEqual(decide('', 0, '_'), { kind: 'insert', from: 0, to: 0, text: '__', cursor: 1 });
  assert.deepEqual(decide('__', 1, '_'), { kind: 'replace', from: 0, to: 2, text: '____', cursor: 2 });
  assert.deepEqual(decide('', 0, '~'), { kind: 'insert', from: 0, to: 0, text: '~~', cursor: 1 });
  assert.deepEqual(decide('~~', 1, '~'), { kind: 'replace', from: 0, to: 2, text: '~~~~', cursor: 2 });
});

test('inserts a link template and tabs through its two destinations', () => {
  assert.deepEqual(decide('', 0, '['), { kind: 'insert', from: 0, to: 0, text: '[]()', cursor: 1 });
  assert.deepEqual(decide('[text]()', 5, 'Tab'), { kind: 'move', cursor: 7 });
  assert.deepEqual(decide('[text](url)', 10, 'Tab'), { kind: 'move', cursor: 11 });
});

test('deletes empty pairs with Backspace', () => {
  assert.deepEqual(decide('()', 1, 'Backspace'), { kind: 'delete', from: 0, to: 2, cursor: 0 });
  assert.deepEqual(decide('[]()', 1, 'Backspace'), { kind: 'delete', from: 0, to: 4, cursor: 0 });
  assert.deepEqual(decide('**', 1, 'Backspace'), { kind: 'delete', from: 0, to: 2, cursor: 0 });
});

test('does not intercept code blocks, non-empty inline code or disabled settings', () => {
  assert.deepEqual(decide('```\n(', 5, '('), { kind: 'default' });
  assert.deepEqual(decide('`code`', 5, '('), { kind: 'default' });
  assert.deepEqual(decide('', 0, '(', false), { kind: 'default' });
  assert.deepEqual(decide('(', 1, 'Tab', false), { kind: 'default' });
});

test('allows Tab and Backspace to finish an empty auto-created backtick pair', () => {
  assert.deepEqual(decide('``', 1, 'Tab'), { kind: 'move', cursor: 2 });
  assert.deepEqual(decide('``', 1, 'Backspace'), { kind: 'delete', from: 0, to: 2, cursor: 0 });
});
```

- [ ] **Step 2: 运行测试确认按预期失败**

运行：`node --test tests/smartPairs.test.ts`

预期：FAIL，原因是 `smartPairs.ts` 尚不存在；如出现断言结构错误，先修正测试再继续。

- [ ] **Step 3: 实现最小决策模块**

在 `src/utils/smartPairs.ts` 定义：

```ts
export type SmartPairDecision =
  | { kind: 'default' }
  | { kind: 'insert'; from: number; to: number; text: string; cursor: number }
  | { kind: 'replace'; from: number; to: number; text: string; cursor: number }
  | { kind: 'move'; cursor: number }
  | { kind: 'delete'; from: number; to: number; cursor: number };

export interface SmartPairInput {
  value: string;
  offset: number;
  key: string;
  enabled: boolean;
}

export function resolveSmartPair(input: SmartPairInput): SmartPairDecision;
```

实现顺序固定为：关闭开关返回 `default`；先处理 Tab/Backspace；再处理代码上下文；最后处理插入和 `*`/`_`/`~` 升级。围栏扫描支持三连及以上反引号/波浪号，只有相同字符且长度不少于开启长度的围栏关闭代码块。行内代码只在当前行的成对反引号范围内生效；相邻空反引号对作为自动生成的空结构，允许 Tab/Backspace 处理。普通配对表、中文括号、弯引号和链接模板均作为常量集中定义，避免在决策分支中重复散落。

- [ ] **Step 4: 运行测试确认通过**

运行：`node --test tests/smartPairs.test.ts`

预期：所有智能配对测试 PASS。

- [ ] **Step 5: 提交智能配对模块**

```text
git add src/utils/smartPairs.ts tests/smartPairs.test.ts
git commit -m "feat: add smart pair decisions"
```

## Task 3: 设置持久化与设置页接线

**Files:**
- Modify: `src/stores/appStore.ts`
- Modify: `src/components/Settings/SettingsPanel.tsx`
- Test: `tests/editorFeatureWiring.test.ts`

- [ ] **Step 1: 在接线契约测试中固定设置字段**

在 `tests/editorFeatureWiring.test.ts` 增加：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('declares and exposes the smart pair editor setting', async () => {
  const store = await read('src/stores/appStore.ts');
  const settings = await read('src/components/Settings/SettingsPanel.tsx');
  assert.match(store, /smart_pairs\?: boolean/);
  assert.match(store, /smart_pairs:\s*true/);
  assert.match(store, /defaultSettings\.editor/);
  assert.match(settings, /smart_pairs/);
  assert.match(settings, /启用自动配对与 Tab 跳出/);
});
```

- [ ] **Step 2: 运行契约测试确认按预期失败**

运行：`node --test tests/editorFeatureWiring.test.ts`

预期：新增测试 FAIL，因为设置字段尚未存在。

- [ ] **Step 3: 增加向后兼容的设置字段**

在 `Settings.editor` 增加 `smart_pairs?: boolean`；在 `defaultSettings.editor` 设置 `smart_pairs: true`；保持 `normalizeSettings` 当前的浅合并结构，使旧配置自动继承默认值，不改变其他编辑器设置。

- [ ] **Step 4: 在编辑器设置页增加开关**

在 `activeTab === 'editor'` 区块的自动补全设置附近增加：

```tsx
<SettingToggle
  label="启用自动配对与 Tab 跳出"
  description="输入括号、引号和 Markdown 格式标记时自动补全；在代码区域中自动停用"
  checked={Boolean(localSettings.editor.smart_pairs)}
  onChange={(checked) => setLocalSettings({
    ...localSettings,
    editor: { ...localSettings.editor, smart_pairs: checked },
  })}
/>
```

复用现有 `handleSave`，不新增独立保存逻辑。

- [ ] **Step 5: 运行契约测试确认通过**

运行：`node --test tests/editorFeatureWiring.test.ts`

预期：设置相关断言 PASS。

- [ ] **Step 6: 提交设置改动**

```text
git add src/stores/appStore.ts src/components/Settings/SettingsPanel.tsx tests/editorFeatureWiring.test.ts
git commit -m "feat: add smart pair editor setting"
```

## Task 4: Monaco 编辑器接线（TDD）

**Files:**
- Modify: `src/components/Editor/Editor.tsx`
- Modify: `tests/editorFeatureWiring.test.ts`

- [ ] **Step 1: 先扩展接线契约测试**

增加以下断言：

```ts
test('connects smart pair decisions to Monaco key handling', async () => {
  const editor = await read('src/components/Editor/Editor.tsx');
  assert.match(editor, /from ['"]\.\.\/\.\.\/utils\/smartPairs/);
  assert.match(editor, /resolveSmartPair\(/);
  assert.match(editor, /settings\.editor\.smart_pairs/);
  assert.match(editor, /key === ['"]Tab['"]/);
  assert.match(editor, /key === ['"]Backspace['"]/);
});
```

- [ ] **Step 2: 运行测试确认接线断言失败**

运行：`node --test tests/editorFeatureWiring.test.ts`

预期：新增 Editor 接线断言 FAIL。

- [ ] **Step 3: 把现有斜杠菜单键处理重构成分层处理**

在现有 `editor.onKeyDown` 中保留 Escape、上下箭头、Enter/Tab 选择斜杠命令的逻辑，并让它在命令已处理时立即返回。没有被斜杠菜单消费时，读取 `controller.getSelection()`；只对空选区调用 `resolveSmartPair({ value: model.getValue(), offset: selection.to, key: event.browserEvent.key, enabled: Boolean(useAppStore.getState().settings.editor.smart_pairs) })`。

- [ ] **Step 4: 应用 insert/replace/move/delete 决策**

对非 `default` 决策执行 `event.preventDefault()` 和 `event.stopPropagation()`：

- `insert`/`replace`：调用 `controller.replaceRange(decision.from, decision.to, decision.text, { from: decision.from + decision.cursor, to: decision.from + decision.cursor })`。
- `move`：调用 `controller.setSelection(decision.cursor)`。
- `delete`：调用 `controller.replaceRange(decision.from, decision.to, '', { from: decision.cursor, to: decision.cursor })`。

所有决策应用后调用 `controller.focus()`；不要直接调用 `model.setValue()`，以便现有内容同步、时间线和撤销栈继续工作。由于 `replaceRange` 已封装 `pushUndoStop()`，不要在同一个决策上再制造额外的撤销边界。

- [ ] **Step 5: 运行接线测试确认通过**

运行：`node --test tests/editorFeatureWiring.test.ts`

预期：Editor 接线断言 PASS。

- [ ] **Step 6: 提交 Monaco 接线**

```text
git add src/components/Editor/Editor.tsx tests/editorFeatureWiring.test.ts
git commit -m "feat: connect smart pairs to editor"
```

## Task 5: 文本清理菜单与编辑器控制器接线（TDD）

**Files:**
- Modify: `src/components/MenuBar/MenuBar.tsx`
- Modify: `tests/editorFeatureWiring.test.ts`

- [ ] **Step 1: 先增加菜单契约测试**

增加以下断言：

```ts
test('adds the Format > Text Cleanup menu action', async () => {
  const menu = await read('src/components/MenuBar/MenuBar.tsx');
  assert.match(menu, /label: ['"]格式['"]/);
  assert.match(menu, /label: ['"]文本清理['"]/);
  assert.match(menu, /cleanText\(/);
  assert.match(menu, /editorView/);
});
```

- [ ] **Step 2: 运行测试确认菜单断言失败**

运行：`node --test tests/editorFeatureWiring.test.ts`

预期：菜单断言 FAIL。

- [ ] **Step 3: 实现当前文档/选区清理动作**

在 `MenuBar` 读取 `editorView`，新增 `handleTextCleanup`：

1. 没有 `editorView` 时关闭菜单并返回。
2. 从 `editorView.getSelection()` 读取选区；空选区使用 `0..editorView.getValue().length`，否则使用选区范围。
3. 对范围文本调用 `cleanText`。
4. `changed` 为 false 时只关闭菜单，不写入编辑器。
5. changed 时调用 `editorView.replaceRange`；有选区时使用 `{ from, to: from + result.content.length }` 选择清理后的文本，无选区时使用 `{ from: result.mapOffset(originalSelection.from), to: result.mapOffset(originalSelection.from) }` 恢复光标，其中 `originalSelection` 是步骤 2 读取的原始选区。
6. 调用 `editorView.focus()` 并关闭菜单。

将格式菜单作为新的 `MenuGroup` 插入现有菜单数组，菜单项为 `{ label: '文本清理', action: handleTextCleanup }`。不要复用工具栏中更宽泛的 `formatMarkdown`，避免清理动作额外改变标题、列表或分隔线。

- [ ] **Step 4: 运行菜单契约测试确认通过**

运行：`node --test tests/editorFeatureWiring.test.ts`

预期：菜单、清理调用和编辑器控制器断言 PASS。

- [ ] **Step 5: 提交文本清理菜单**

```text
git add src/components/MenuBar/MenuBar.tsx tests/editorFeatureWiring.test.ts
git commit -m "feat: add text cleanup menu"
```

## Task 6: 全量验证与差异检查

**Files:**
- Verify: all modified files and tests

- [ ] **Step 1: 运行新增测试**

运行：`node --test tests/textCleanup.test.ts tests/smartPairs.test.ts tests/editorFeatureWiring.test.ts`

预期：新增测试全部 PASS，退出码为 0。

- [ ] **Step 2: 运行完整测试套件**

运行：`npm test`

预期：所有现有和新增测试 PASS，无未处理异常或警告。

- [ ] **Step 3: 运行 ESLint**

运行：`npm run lint`

预期：退出码为 0，无 ESLint error。

- [ ] **Step 4: 运行生产构建**

运行：`npm run build`

预期：TypeScript 检查和 Vite 构建均成功，退出码为 0。

- [ ] **Step 5: 检查最终差异与工作区状态**

运行：`git diff --check; git status --short; git log --oneline -6`

预期：没有空白错误；工作区只包含本任务预期的提交或未提交变更；提交历史包含各个 TDD 任务的清晰提交。

- [ ] **Step 6: 完成前按需求逐项核对**

逐项确认：

- “格式 → 文本清理”存在，选区/全文范围正确。
- 行尾空白被删除，连续空白行最多保留一行。
- 普通括号、引号、反引号、中文括号和弯引号自动配对。
- `*`、`_`、`~` 支持单标记和双标记升级；`[` 支持 `[]()` 链接模板。
- Tab 跳出、空配对 Backspace 和代码块/行内代码禁用规则均由测试覆盖。
- 设置开关默认开启、可关闭，并兼容旧配置。
