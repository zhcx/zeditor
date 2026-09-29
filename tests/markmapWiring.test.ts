import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  MARKMAP_BRANCH_COLORS,
  MARKMAP_TEMPLATE,
  MARKMAP_TEMPLATE_SELECTION,
  branchColor,
  readMarkmapTheme,
} from '../src/utils/markmapSource.ts';

const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

test('插入模板本身就是一份可直接渲染的 markmap 围栏', () => {
  assert.ok(MARKMAP_TEMPLATE.startsWith('```markmap\n# 中心主题'), '必须以 markmap 围栏与中心主题开头');
  assert.ok(MARKMAP_TEMPLATE.endsWith('```'), '围栏必须闭合');

  // 组合成树的三级结构：根节点 1 个、分支 2 条、要点 3 个。
  assert.equal(MARKMAP_TEMPLATE.match(/^# /gm)?.length, 1);
  assert.equal(MARKMAP_TEMPLATE.match(/^## /gm)?.length, 2);
  assert.equal(MARKMAP_TEMPLATE.match(/^### /gm)?.length, 3);

  const selected = MARKMAP_TEMPLATE.slice(MARKMAP_TEMPLATE_SELECTION.start, MARKMAP_TEMPLATE_SELECTION.end);
  assert.equal(selected, '中心主题');
});

test('主题配色：同一分支共用一种颜色，明暗主题各一套', () => {
  // Node 环境下没有 document，回退到浅色主题。
  assert.equal(readMarkmapTheme(), 'light');

  const light = MARKMAP_BRANCH_COLORS.light;
  assert.equal(branchColor(light, '1'), light[0], '根节点用第一个颜色');
  assert.equal(branchColor(light, '1.2'), light[1], '第二条一级分支用第二个颜色');
  assert.equal(branchColor(light, '1.2.5'), light[1], '分支下的子节点跟随分支颜色');
  assert.notEqual(branchColor(light, '1.2'), branchColor(light, '1.3'));
  assert.equal(branchColor(light, undefined), light[0], '缺少路径时回退到第一个颜色');
  assert.equal(branchColor([], '1.2'), 'currentColor', '空色板不应抛错');

  assert.notDeepEqual(MARKMAP_BRANCH_COLORS.light, MARKMAP_BRANCH_COLORS.dark);
  MARKMAP_BRANCH_COLORS.dark.forEach((color) => assert.match(color, /^#[0-9a-f]{6}$/i));
});

test('预览接线：```markmap 围栏替换为 MarkmapViewer', async () => {
  const preview = await read('../src/components/Preview/Preview.tsx');

  // 特殊围栏先保留 language-markmap class，否则二次渲染找不到目标。
  assert.match(preview, /lang === 'markmap'/);
  assert.match(preview, /class="language-markmap"/);
  assert.match(preview, /MARKMAP_FENCE_SELECTOR/);

  // 懒加载 + 只在靠近视口时挂载，并在重渲染前卸载 React 根。
  assert.match(preview, /import\('\.\.\/MarkmapViewer\/MarkmapViewer'\)/);
  assert.match(preview, /querySelectorAll<HTMLElement>\(MARKMAP_FENCE_SELECTOR\)/);
  assert.match(preview, /mount\.className = 'markmap-embed-mount'/);
  assert.match(preview, /markmapObserver\?\.unobserve\(entry\.target\)/);
  assert.match(preview, /markmapObserver\?\.disconnect\(\)/);
  assert.match(preview, /markmapRoots\.forEach\(\(root\) => root\.unmount\(\)\)/);
});

test('查看器：懒加载 markmap 库、清洗节点内容、支持交互与导出', async () => {
  const viewer = await read('../src/components/MarkmapViewer/MarkmapViewer.tsx');

  // markmap-lib / markmap-view 只在真正遇到围栏时才下载。
  assert.match(viewer, /await import\('markmap-lib'\)/);
  assert.match(viewer, /import\('markmap-view'\)/);
  // 节点内容会被写进 foreignObject，必须按预览同一套规则清洗。
  assert.match(viewer, /sanitizeRenderedHtml\(String\(node\.content/);
  assert.match(viewer, /node\.children\?\.forEach\(sanitizeNodeContent\)/);

  // 交互：普通滚轮留给文档，Ctrl + 滚轮缩放，拖动平移。
  assert.match(viewer, /scrollForPan:\s*true/);
  assert.match(viewer, /pan:\s*false/);
  assert.match(viewer, /autoFit:\s*true/);
  assert.match(viewer, /MarkmapCtor\.create\(svg, options, root\)/);
  assert.match(viewer, /markmapRef\.current\?\.fit\(\)/);

  // 主题切换只更新配色，不重建实例（保留缩放与折叠状态）。
  assert.match(viewer, /instance\.setOptions\(\{ color: markmapColor\(theme\) \}\)/);

  // 导出 2 倍分辨率 PNG，并在卸载时销毁实例。
  assert.match(viewer, /const scale = 2/);
  assert.match(viewer, /canvas\.toBlob/);
  assert.match(viewer, /XMLSerializer/);
  assert.match(viewer, /markmapRef\.current\?\.destroy\(\)/);

  // 功能样式由组件自身引入（与 workflow-viewer.css 的组织方式一致）。
  assert.match(viewer, /import '\.\.\/\.\.\/styles\/markmap-viewer\.css'/);
});

test('插入入口：斜杠命令、工具栏、功能菜单与编辑器共用同一份模板', async () => {
  const slash = await read('../src/utils/slashCommands.ts');
  const toolbar = await read('../src/components/Toolbar/Toolbar.tsx');
  const menubar = await read('../src/components/MenuBar/MenuBar.tsx');
  const editor = await read('../src/components/Editor/Editor.tsx');
  const i18n = await read('../src/i18n/index.ts');

  assert.match(slash, /shortcut: '\/markmap'/);
  assert.match(slash, /MARKMAP_TEMPLATE_SELECTION\.start, MARKMAP_TEMPLATE_SELECTION\.end/);

  assert.match(toolbar, /Markmap 思维导图/);
  assert.match(toolbar, /MARKMAP_TEMPLATE_SELECTION\.start \+ 1/);

  assert.match(menubar, /requestInsert\('markmap'\)/);
  assert.match(menubar, /`zeditor-insert-\$\{kind\}`/);

  // 菜单事件由编辑器执行插入，并在卸载时移除监听。
  assert.match(editor, /'zeditor-insert-markmap'/);
  assert.match(editor, /removeEventListener\('zeditor-insert-markmap'/);
  assert.match(editor, /const insertMarkmapAtCursor = \(\) => \{/);

  assert.match(i18n, /'思维导图': 'Mind map'/);
});
