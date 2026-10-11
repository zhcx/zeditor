import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path: string) => readFileSync(path, 'utf8');

test('启动页等待编辑区首帧绘制与字体就绪后再淡出', () => {
  const app = read('src/App.tsx');

  // 三个条件缺一不可：已定案、字体就绪、编辑区就绪
  assert.match(app, /if \(settled \|\| !fontsReady \|\| !editorReady\) return;/);
  // 编辑区就绪通过 store 订阅获得，而不是只在挂载时读一次快照
  assert.match(app, /useAppStore\.subscribe\(\(state\) => \{\s*editorReady = state\.editorBootReady;/);
  // 字体替换会引起二次重排，必须等字体稳定
  assert.match(app, /Promise\.resolve\(document\.fonts\?\.ready\)/);
  // 双 rAF 保证编辑区那一帧已提交并真正绘制
  assert.match(app, /frame = requestAnimationFrame\(\(\) => requestAnimationFrame\(scheduleRemoval\)\);/);
  // 超时兜底，避免极端情况下启动页滞留
  assert.match(app, /\}, 3000\);/);
  // 旧的「首帧即淡出」实现不应复活
  assert.doesNotMatch(app, /const fallbackTimer = window\.setTimeout\(hideBootSplash, 1500\);/);
});

test('编辑区在 Monaco 首次绘制前渲染占位骨架并置位就绪标志', () => {
  const editor = read('src/components/Editor/Editor.tsx');
  const store = read('src/stores/appStore.ts');
  const css = read('src/styles/main.css');

  assert.match(store, /editorBootReady: boolean;/);
  assert.match(store, /markEditorBootReady: \(\) => void;/);
  assert.match(store, /editorBootReady: false,/);

  // 必须等 Monaco 真正画完（下一帧）才宣告就绪，而不是创建完实例就算数
  assert.match(editor, /bootReadyFrameRef\.current = requestAnimationFrame\(\(\) => \{/);
  assert.match(editor, /useAppStore\.getState\(\)\.markEditorBootReady\(\);/);
  // 卸载时要取消未执行的帧回调，避免对已卸载组件 setState
  assert.match(editor, /cancelAnimationFrame\(bootReadyFrameRef\.current\)/);

  // 占位骨架有渲染点，且父级建立了定位上下文
  assert.match(editor, /\{!editorReady && \(/);
  assert.match(editor, /className="editor-loading-placeholder" role="status"/);
  assert.match(css, /\.editor-loading-placeholder \{/);
  assert.match(css, /\.monaco-editor-container \.monaco-document-card \{\s*position: relative;/);
});
