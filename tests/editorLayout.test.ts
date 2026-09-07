import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('wrapped editor does not reserve or display horizontal scrolling', async () => {
  let options: {
    scrollBeyondLastColumn?: number;
    scrollbar?: { horizontal?: string; vertical?: string; useShadows?: boolean; horizontalScrollbarSize?: number; verticalScrollbarSize?: number; verticalSliderSize?: number };
  } = {};

  try {
    ({ EDITOR_OVERFLOW_OPTIONS: options } = await import('../src/utils/editorLayout.ts'));
  } catch {
    // The assertion below provides the intended regression failure when the
    // shared editor layout policy has not been implemented yet.
  }

  assert.equal(options.scrollBeyondLastColumn, 0);
  assert.equal(options.scrollbar?.horizontal, 'hidden');
  assert.equal(options.scrollbar?.vertical, 'auto');
  assert.equal(options.scrollbar?.useShadows, false);
  assert.equal(options.scrollbar?.horizontalScrollbarSize, 0);
  assert.equal(options.scrollbar?.verticalScrollbarSize, 10);
  assert.equal(options.scrollbar?.verticalSliderSize, 10);
});

test('editor wraps against the viewport without shrinking from rendered font measurements', async () => {
  const source = await readFile(new URL('../src/components/Editor/Editor.tsx', import.meta.url), 'utf8');

  assert.match(source, /wordWrap:\s*'on'/);
  assert.doesNotMatch(source, /wordWrapColumn|fitRenderedText|scheduleTextFit/);
});

test('editor synchronizes the preview after the pointer selection gesture finishes', async () => {
  const source = await readFile(new URL('../src/components/Editor/Editor.tsx', import.meta.url), 'utf8');

  assert.match(source, /editor\.onMouseUp\(\(event\)\s*=>/);
  assert.doesNotMatch(source, /editor\.onMouseDown\(\(event\)\s*=>\s*\{\s*const lineNumber/);
});

test('editor does not cover scrolled content with Monaco sticky headings', async () => {
  const source = await readFile(new URL('../src/components/Editor/Editor.tsx', import.meta.url), 'utf8');

  assert.match(source, /stickyScroll:\s*\{\s*enabled:\s*false\s*\}/);
});

test('editor uses immediate scrolling so split-view synchronization stays responsive', async () => {
  const source = await readFile(new URL('../src/components/Editor/Editor.tsx', import.meta.url), 'utf8');

  assert.match(source, /smoothScrolling:\s*false/);
});

test('editor does not highlight matching text when the cursor moves', async () => {
  const source = await readFile(new URL('../src/components/Editor/Editor.tsx', import.meta.url), 'utf8');

  assert.match(source, /occurrencesHighlight:\s*'off'/);
});

test('suppresses ambiguous Unicode warnings for multilingual documents', async () => {
  const { EDITOR_UNICODE_HIGHLIGHT_OPTIONS } = await import('../src/utils/editorLayout.ts');

  assert.equal(EDITOR_UNICODE_HIGHLIGHT_OPTIONS?.nonBasicASCII, false);
  assert.equal(EDITOR_UNICODE_HIGHLIGHT_OPTIONS?.ambiguousCharacters, false);
  assert.equal(EDITOR_UNICODE_HIGHLIGHT_OPTIONS?.allowedLocales?.['zh-hans'], true);
  assert.equal(EDITOR_UNICODE_HIGHLIGHT_OPTIONS?.allowedLocales?.['zh-hant'], true);
  assert.equal(EDITOR_UNICODE_HIGHLIGHT_OPTIONS?.allowedLocales?._os, true);
  assert.equal(EDITOR_UNICODE_HIGHLIGHT_OPTIONS?.allowedLocales?._vscode, true);
});

test('continues highlighting suspicious invisible Unicode characters', async () => {
  const { EDITOR_UNICODE_HIGHLIGHT_OPTIONS } = await import('../src/utils/editorLayout.ts');

  assert.equal(EDITOR_UNICODE_HIGHLIGHT_OPTIONS?.invisibleCharacters, true);
});
test('contentFontStack returns a concrete font stack instead of a CSS variable reference', async () => {
  const { contentFontStack } = await import('../src/utils/appearanceSettings.ts');

  // Monaco 的折行测量缓存以 fontFamily 字符串为键。传 'var(--font-content)'
  // 这类 CSS 变量时字符串不随字体变化，更换字体后不会触发重新测量，导致
  // 渲染字体与测量宽度不一致、行文字溢出编辑框；这里必须返回真实字体名。
  assert.equal(contentFontStack('Maple Mono CN'), 'Maple Mono CN, "Microsoft YaHei", sans-serif');
  assert.equal(contentFontStack(''), 'Microsoft YaHei, "Microsoft YaHei", sans-serif');
  assert.equal(contentFontStack(undefined), 'Microsoft YaHei, "Microsoft YaHei", sans-serif');
});

test('editor feeds Monaco a concrete font stack so wrap measurement re-runs on font change', async () => {
  const source = await readFile(new URL('../src/components/Editor/Editor.tsx', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /fontFamily:\s*'var\(--font-content\)'/);
  assert.match(source, /fontFamily:\s*contentFontStack\(/);
});

test('editor defaults to native EditContext and keeps textarea as an explicit fallback', async () => {
  const editorSource = await readFile(new URL('../src/components/Editor/Editor.tsx', import.meta.url), 'utf8');
  const storeSource = await readFile(new URL('../src/stores/appStore.ts', import.meta.url), 'utf8');
  const settingsSource = await readFile(new URL('../src/components/Settings/SettingsPanel.tsx', import.meta.url), 'utf8');
  const layoutSource = await readFile(new URL('../src/utils/editorLayout.ts', import.meta.url), 'utf8');

  // 原生 EditContext 不依赖 Monaco textarea 对折行文本的可见范围计算；清除
  // 应用层透明覆盖后应作为默认路径，textarea 仅供旧环境显式回退。
  assert.match(
    editorSource,
    /editContext:\s*useAppStore\.getState\(\)\.settings\.editor\.input_engine\s*===\s*'editContext'/,
  );
  assert.match(storeSource, /input_engine:\s*'editContext'/);
  assert.match(settingsSource, /input_engine\s*\|\|\s*'editContext'/);
  assert.doesNotMatch(layoutSource, /editContext:\s*false/);
  assert.match(editorSource, /accessibilitySupport:\s*'off'/);
});

// 输入法可见性回归必须在打包后的 CSP 下检查真实行几何，不能用 CSS 字符串
// 匹配代替。运行方法见 HANDOFF-editor-top-blink.md 和 scripts/verify-editor-ime.mjs。
