import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

test('校对开关接线：设置键、设置面板与状态栏行为', async () => {
  const store = await read('../src/stores/appStore.ts');
  const panel = await read('../src/components/Settings/SettingsPanel.tsx');
  const statusBar = await read('../src/components/StatusBar/StatusBar.tsx');
  const aiStore = await read('../src/stores/aiStore.ts');

  // 设置键存在且默认开启（保持既有用户行为不变）。
  assert.match(store, /proofread_with_ai:\s*boolean/);
  assert.match(store, /proofread_with_ai:\s*true/);

  // 设置面板新增「使用 AI 校对」开关。
  assert.match(panel, /label="使用 AI 校对"/);
  assert.match(panel, /proofread_with_ai:\s*checked/);

  // 状态栏「校对」不再自动启用 AI：校对模式完全由设置决定。
  const proofreadBody = statusBar.slice(
    statusBar.indexOf('const handleProofread'),
    statusBar.indexOf('const handleRewrite'),
  );
  assert.doesNotMatch(proofreadBody, /updateAISettings/);
  assert.doesNotMatch(proofreadBody, /enabled:\s*true/);
  assert.match(statusBar, /Markdown 检查/);

  // aiStore 依据设置选择 AI 或内置 lint；选区校对使用 partial 模式，
  // 且「从文档开头开始选」也会被识别为选区，避免上下文规则假阳性。
  assert.match(aiStore, /aiRequested && !aiReady/);
  assert.match(aiStore, /const isPartial = baseOffset > 0 \|\| trimmedContent !== wholeTrimmed/);
  assert.match(aiStore, /lintMarkdown\(trimmedContent,\s*\{ partial: isPartial \}\)/);
});

test('静态校对路径产出与 AI 校对同构的结果', async () => {
  const aiStore = await read('../src/stores/aiStore.ts');
  const app = await read('../src/App.tsx');

  // 结果结构：带偏移、type=markdown、规则编号写进 explanation。
  assert.match(aiStore, /explanation:\s*`\[\$\{issue\.ruleId\}\] \$\{issue\.message\}`/);
  assert.match(aiStore, /type:\s*'markdown'/);

  // 面板：report-only 项（suggestion === original）隐藏应用按钮，改为「问题:」展示。
  assert.match(app, /result\.suggestion !== result\.original/);
  assert.match(app, /问题:/);
});

test('静态校对引擎不依赖 AI 服务，完全本地运行', async () => {
  const lint = await read('../src/utils/markdownLint.ts');
  assert.doesNotMatch(lint, /\bfetch\s*\(/);
  assert.doesNotMatch(lint, /\binvoke\s*\(/);
  assert.doesNotMatch(lint, /XMLHttpRequest/);
  assert.match(lint, /export function lintMarkdown/);
  assert.match(lint, /partial\?:\s*boolean/);
  // 规则编号与 VMark lint 的编号体系对齐。
  for (const ruleId of ['E01', 'E02', 'E03', 'E04', 'E05', 'E06', 'E07', 'W01', 'W02', 'W03', 'W04', 'W05']) {
    assert.match(lint, new RegExp(`'${ruleId}'`), `缺少规则 ${ruleId}`);
  }
});
