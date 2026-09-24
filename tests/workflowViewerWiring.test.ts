import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

test('工作流查看器接线：预览集成独立文件与代码围栏两条路径', async () => {
  const preview = await read('../src/components/Preview/Preview.tsx');
  const shape = await read('../src/utils/workflowShape.ts');

  // 独立工作流文件：右侧预览区直接渲染可编辑查看器，并写回 Monaco。
  assert.match(preview, /isWorkflowLikeFile\(currentFile, content\)/);
  assert.match(preview, /<WorkflowViewer\s/);
  assert.match(preview, /editable\b/);
  assert.match(preview, /onApply=\{\(nextSource\) =>/);
  assert.match(preview, /editor\.replaceRange\(0, editor\.getValue\(\)\.length, nextSource\)/);

  // Markdown 代码围栏：先正则预判，再动态加载解析器，避免给普通 YAML 加料。
  assert.match(shape, /export function hasWorkflowShape/);
  assert.match(preview, /hasWorkflowShape\(block\.textContent/);
  assert.match(preview, /await import\(['"]\.\.\/\.\.\/utils\/githubWorkflow['"]\)/);
  assert.match(preview, /looksLikeWorkflowYaml\(source\)/);
  // 预览里挂载的 React 根必须在重渲染前卸载，否则会泄漏。
  assert.match(preview, /workflowRoots\.forEach\(\(root\) => root\.unmount\(\)\)/);
});

test('查看器不发起网络请求、不执行工作流（与参考实现的安全边界一致）', async () => {
  const files = [
    '../src/components/WorkflowViewer/WorkflowViewer.tsx',
    '../src/components/WorkflowViewer/WorkflowCanvas.tsx',
    '../src/components/WorkflowViewer/WorkflowInspector.tsx',
    '../src/utils/githubWorkflow.ts',
    '../src/utils/workflowGraph.ts',
    '../src/utils/workflowDiagnostics.ts',
    '../src/utils/workflowEdits.ts',
  ];
  for (const path of files) {
    const source = await read(path);
    assert.doesNotMatch(source, /\bfetch\s*\(/, `${path} 不应直接发起网络请求`);
    assert.doesNotMatch(source, /\binvoke\s*\(/, `${path} 不应直接调用 Tauri 命令`);
    assert.doesNotMatch(source, /XMLHttpRequest/, `${path} 不应使用 XHR`);
  }
});

test('诊断覆盖文档约定的 GHA-* 前缀', async () => {
  const diagnostics = await read('../src/utils/workflowDiagnostics.ts');
  for (const code of [
    'GHA-PARSE-001', 'GHA-PARSE-004', 'GHA-JOB-001', 'GHA-JOB-002', 'GHA-JOB-003',
    'GHA-JOB-004', 'GHA-MATRIX-001', 'GHA-NEEDS-001', 'GHA-NEEDS-002', 'GHA-NEEDS-003',
    'GHA-STEP-001', 'GHA-STEP-002', 'GHA-STEP-003', 'GHA-STEP-004', 'GHA-EXPR-001',
    'GHA-SEC-001',
  ]) {
    assert.match(diagnostics, new RegExp(code), `缺少诊断码 ${code}`);
  }
});

test('结构化编辑补丁保留格式与规范化两条路径都可单测', async () => {
  const edits = await read('../src/utils/workflowEdits.ts');
  assert.match(edits, /preserveFormat/);
  assert.match(edits, /document\.toString\(\{[\s\S]*?flowCollectionPadding:\s*false/);
  assert.match(edits, /stringify\(document\.toJS\(\)/);
});

test('设置项与设置面板接入工作流查看器', async () => {
  const store = await read('../src/stores/appStore.ts');
  const panel = await read('../src/components/Settings/SettingsPanel.tsx');

  assert.match(store, /export interface WorkflowSettings/);
  assert.match(store, /render_in_preview:\s*boolean/);
  assert.match(store, /preserve_format:\s*boolean/);
  assert.match(store, /render_in_preview:\s*true,\s*preserve_format:\s*true/);
  assert.match(store, /workflow:\s*\{\s*\.\.\.defaultSettings\.workflow,\s*\.\.\.saved\.workflow\s*\}/);
  assert.match(store, /'workflow'/);

  assert.match(panel, /\{ id: 'workflow', label: '工作流'/);
  assert.match(panel, /在预览中渲染工作流图/);
  assert.match(panel, /保存时保留 YAML 格式/);
});
