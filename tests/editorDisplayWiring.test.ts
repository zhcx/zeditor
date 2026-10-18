import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

test('显示设置：源码模式注册 Markdown 折叠 provider 并启用缩进参考线', async () => {
  const editor = await read('../src/components/Editor/Editor.tsx');
  const layout = await read('../src/utils/editorLayout.ts');

  // 折叠范围来自自定义 provider（标题分节 + 缩进块），开关在 provider 内读取最新设置。
  assert.match(editor, /registerFoldingRangeProvider\('markdown'/);
  assert.match(editor, /markdownFoldingRanges\(model\.getLinesContent\(\)/);
  assert.match(editor, /foldingRangesChanged\.fire\(markdownFoldingProvider\)/);
  // 缩进参考线与折叠开关随设置即时同步到现有实例。
  assert.match(editor, /guides: \{ indentation: display\.indentGuides, bracketPairs: false \}/);
  assert.match(editor, /showFoldingControls: folding \? 'mouseover' : 'never'/);
  // 折行仍按视口宽度（限制行宽靠 CSS 收窄文档卡片，不改折行列）。
  assert.match(editor, /wordWrap: 'on'/);
  assert.doesNotMatch(editor, /wordWrapColumn/);
  assert.match(layout, /wrappingStrategy: 'advanced'/);
});

test('显示设置：所见即所得按标题分节折叠与列表缩进折叠', async () => {
  const wysiwyg = await read('../src/components/Wysiwyg/WysiwygEditor.tsx');

  assert.match(wysiwyg, /findHeadingFoldSections\(blockDocument\.blocks\)/);
  assert.match(wysiwyg, /if \(hiddenBlocks\.has\(index\)\) return null/);
  assert.match(wysiwyg, /foldKey=\{section\?\.key \?\? null\}/);
  assert.match(wysiwyg, /className="wysiwyg-fold-toggle"/);
  assert.match(wysiwyg, /item\.classList\.toggle\('is-folded'\)/);
});

test('显示设置：App 写入 CSS 变量与 data-* 标记', async () => {
  const app = await read('../src/App.tsx');
  const css = await read('../src/styles/reading-view.css');

  assert.match(app, /root\.style\.setProperty\('--content-width'/);
  assert.match(app, /root\.dataset\.readableLineWidth = display\.readableLineLength \? 'on' : 'off'/);
  assert.match(app, /root\.dataset\.indentGuides = display\.indentGuides \? 'on' : 'off'/);
  assert.match(app, /root\.dataset\.foldIndentation = display\.foldIndentation \? 'on' : 'off'/);

  // 限制行宽同时作用于源码卡片、预览与所见即所得文档。
  assert.match(css, /\[data-readable-line-width="on"\] \.monaco-editor-container \.monaco-document-card/);
  assert.match(css, /\[data-readable-line-width="on"\] \.preview-pane \.preview-document/);
  assert.match(css, /\[data-readable-line-width="on"\] \.wysiwyg-surface > \.wysiwyg-document/);
  assert.match(css, /width: var\(--content-width\)/);
  assert.match(css, /flex: 0 1 var\(--content-width\)/);
  assert.match(css, /\[data-indent-guides="on"\] \.wysiwyg-document :is\(ul, ol\) :is\(ul, ol\)/);
  assert.match(css, /\[data-fold-indentation="on"\] \.wysiwyg-block\[data-block-kind="list"\] ul > li/);
});

test('显示设置：状态栏视图状态按钮与设置项开关', async () => {
  const statusBar = await read('../src/components/StatusBar/StatusBar.tsx');
  const panel = await read('../src/components/Settings/SettingsPanel.tsx');
  const store = await read('../src/stores/appStore.ts');
  const slider = await read('../src/components/Settings/LineWidthSetting.tsx');

  assert.match(statusBar, /className="status-item status-button status-view-state"/);
  assert.match(statusBar, /showViewStateButton \? \(/);
  // 按钮只在两种编辑方式之间切换：沉浸态会隐藏状态栏，切进去就没有切回来的入口。
  assert.match(statusBar, /const toggleViewMode: WorkspaceMode = mode === 'split'/);
  assert.doesNotMatch(statusBar, /next: 'immersive'/);

  // Esc 关闭设置面板（等价「取消」）：下拉 / 字体选择会先 preventDefault，同步历史对话框仍打开时不动。
  assert.match(panel, /if \(event\.key !== 'Escape' \|\| event\.isComposing \|\| event\.defaultPrevented\) return;/);
  assert.match(panel, /cancelRef\.current\(\)/);
  // 拖动行宽只写一次设置：先预览，松手才落盘。
  assert.match(slider, /onPointerUp=/);
  assert.match(slider, /onBlur=/);

  assert.match(panel, /label="限制行宽"/);
  assert.match(panel, /label="折叠标题"/);
  assert.match(panel, /label="折叠缩进"/);
  assert.match(panel, /label="缩进参考线"/);
  assert.match(panel, /label="视图状态按钮"/);
  // 显示类设置即时生效，不必等「保存」。
  assert.match(panel, /applyEditorDisplay\(\{ fold_headings: checked \}\)/);

  assert.match(store, /readable_line_length\?: boolean/);
  assert.match(store, /line_width\?: number/);
  assert.match(store, /fold_headings\?: boolean/);
  assert.match(store, /fold_indentation\?: boolean/);
  assert.match(store, /indent_guides\?: boolean/);
  assert.match(store, /show_view_state_button\?: boolean/);
  assert.match(store, /readable_line_length: true/);
});

test('macOS 适配：⌘+滚轮调行宽、⌘+点击开链接、原生菜单加速键让位', async () => {
  const platform = await read('../src/utils/platform.ts');
  const wheel = await read('../src/components/Editor/LineWidthWheel.tsx');
  const editor = await read('../src/components/Editor/Editor.tsx');
  const menu = await read('../src/components/MenuBar/MenuBar.tsx');
  const wysiwyg = await read('../src/components/Wysiwyg/WysiwygEditor.tsx');
  const macosCss = await read('../src/styles/macos.css');

  // 主修饰键与原生菜单标记：macOS 用 ⌘，Ctrl 留给系统右键。
  assert.match(platform, /export function isPrimaryModifier/);
  assert.match(platform, /export function isNativeMenuActive/);
  // ⌘+滚轮；触控板捏合在 WKWebView 里也带 ctrlKey，必须排除。
  assert.match(wheel, /event\.metaKey && !event\.ctrlKey/);
  assert.match(wheel, /event\.key === \(macos \? 'Meta' : 'Control'\)/);
  assert.match(editor, /isPrimaryModifier\(event\.event\)/);
  assert.match(wysiwyg, /target\.kind === 'link' && isPrimaryModifier\(event\)/);
  // 原生菜单已注册 ⌘N/⌘O/⌘S/⇧⌘S：窗口级监听让位，避免保存两次。
  assert.match(menu, /if \(isNativeMenuActive\(\)\) return;/);
  // 折叠快捷键：⌘⌥[ / ⌘⌥] 在两种编辑模式下都可用。
  assert.match(editor, /monaco\.KeyCode\.BracketLeft, 'editor\.fold'/);
  assert.match(wysiwyg, /event\.key === '\[' \|\| event\.key === '\]'/);
  // 系统「降低透明度」开启时去掉毛玻璃。
  assert.match(macosCss, /@media \(prefers-reduced-transparency: reduce\)/);
});

test('显示设置：Rust 侧带 serde 默认值，旧配置文件不掉字段', async () => {
  const commands = await read('../src-tauri/src/commands.rs');

  assert.match(commands, /pub readable_line_length: bool/);
  assert.match(commands, /pub line_width: u32/);
  assert.match(commands, /pub fold_headings: bool/);
  assert.match(commands, /pub fold_indentation: bool/);
  assert.match(commands, /pub indent_guides: bool/);
  assert.match(commands, /pub show_view_state_button: bool/);
  assert.match(commands, /fn default_line_width\(\) -> u32 \{\s*80\s*\}/);
});
