import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyDiagramFence, diagramCaption } from '../src/utils/exportDiagrams.ts';

const workflow = 'name: ci\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n';
const plainYaml = 'name: data\nvalues:\n  - 1\n';

test('导出识别 Mermaid、Markmap 与 SVG 围栏（忽略大小写与空白）', () => {
  assert.equal(classifyDiagramFence('mermaid', 'graph TD\n A-->B'), 'mermaid');
  assert.equal(classifyDiagramFence(' Mermaid ', 'graph TD'), 'mermaid');
  assert.equal(classifyDiagramFence('markmap', '# 中心'), 'markmap');
  assert.equal(classifyDiagramFence('svg', '<svg xmlns="http://www.w3.org/2000/svg"/>'), 'svg');
  assert.equal(classifyDiagramFence('javascript', 'console.log(1)'), null);
  assert.equal(classifyDiagramFence('', 'graph TD'), null);
});

test('只有形态符合工作流的 YAML 才作为工作流导出', () => {
  assert.equal(classifyDiagramFence('yaml', workflow), 'workflow');
  assert.equal(classifyDiagramFence('yml', workflow), 'workflow');
  assert.equal(classifyDiagramFence('github-actions-workflow', workflow), 'workflow');
  assert.equal(classifyDiagramFence('github-actions', workflow), 'workflow');
  assert.equal(classifyDiagramFence('yaml', plainYaml), null);
  assert.equal(classifyDiagramFence('github-actions', plainYaml), null);
});

test('导出图注与图类型一致', () => {
  assert.equal(diagramCaption('mermaid'), 'Mermaid 图表');
  assert.equal(diagramCaption('markmap'), 'Markmap 思维导图');
  assert.equal(diagramCaption('svg'), 'SVG 图形');
  assert.equal(diagramCaption('workflow'), 'GitHub Actions 工作流');
});
