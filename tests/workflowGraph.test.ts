import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkflowGraph, workflowEdgePath, workflowToMermaid } from '../src/utils/workflowGraph.ts';
import { parseWorkflow } from '../src/utils/githubWorkflow.ts';

function graphOf(source: string) {
  const { model } = parseWorkflow(source);
  assert.ok(model, '工作流应能被解析');
  return buildWorkflowGraph(model);
}

test('按 needs 计算分层并保持声明顺序', () => {
  const graph = graphOf([
    'name: CI',
    'on: push',
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: npm ci',
    '  lint:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: npm run lint',
    '  test:',
    '    needs: build',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: npm test',
    '  deploy:',
    '    needs: [lint, test]',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: ./deploy.sh',
    '',
  ].join('\n'));

  assert.equal(graph.layerCount, 3);
  const byJob = new Map(graph.nodes.map(node => [node.jobId, node]));
  assert.equal(byJob.get('build')?.layer, 0);
  assert.equal(byJob.get('lint')?.layer, 0);
  assert.equal(byJob.get('test')?.layer, 1);
  assert.equal(byJob.get('deploy')?.layer, 2);
  // 同一层内按声明顺序排布，且不会重叠。
  assert.equal(byJob.get('build')?.row, 0);
  assert.equal(byJob.get('lint')?.row, 1);
  assert.ok((byJob.get('lint')?.y ?? 0) > (byJob.get('build')?.y ?? 0));

  assert.deepEqual(graph.edges.map(edge => edge.id), ['build->test', 'lint->deploy', 'test->deploy']);
  assert.equal(graph.cyclicJobIds.length, 0);
  assert.equal(graph.unknownNeeds.length, 0);
  assert.ok(graph.width > 0 && graph.height > 0);
  assert.equal(byJob.get('build')?.stepCount, 1);
});

test('未知 needs 与自依赖不会破坏布局', () => {
  const graph = graphOf([
    'jobs:',
    '  solo:',
    '    needs: [solo, missing]',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: echo',
    '',
  ].join('\n'));

  assert.deepEqual(graph.unknownNeeds, [{ jobId: 'solo', jobIdRaw: 'missing' }]);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].backEdge, true);
  assert.deepEqual(graph.cyclicJobIds, ['solo']);
  assert.equal(graph.nodes[0].layer, 0);
});

test('循环依赖只标注回边，其余边照常分层', () => {
  const graph = graphOf([
    'jobs:',
    '  a:',
    '    needs: c',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: echo a',
    '  b:',
    '    needs: a',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: echo b',
    '  c:',
    '    needs: b',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: echo c',
    '',
  ].join('\n'));

  assert.deepEqual([...graph.cyclicJobIds].sort(), ['a', 'c']);
  assert.equal(graph.edges.filter(edge => edge.backEdge).length, 1);
  assert.equal(graph.edges.filter(edge => !edge.backEdge).length, 2);
  // 断开的只是回边，剩余链路仍能给出 3 层。
  assert.equal(graph.layerCount, 3);
});

test('边路径按方向生成贝塞尔曲线，回边绕行', () => {
  const graph = graphOf([
    'jobs:',
    '  a:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: echo',
    '  b:',
    '    needs: a',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: echo',
    '',
  ].join('\n'));
  const [a, b] = graph.nodes;
  const path = workflowEdgePath(a, b);
  assert.match(path, /^M \d+(\.\d+)? \d+(\.\d+)? C /);
  // 起点固定在源节点右边缘，终点在目标节点左边缘。
  assert.ok(path.includes(`${a.x + a.width} ${a.y + a.height / 2}`));

  const back = workflowEdgePath(b, a);
  assert.match(back, /^M /);
  assert.notEqual(back, path);
});

test('导出 Mermaid flowchart 文本', () => {
  const { model } = parseWorkflow([
    'name: 发布流水线',
    'on:',
    '  push:',
    '    branches: [main]',
    'jobs:',
    '  build:',
    '    name: 构建',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: npm ci',
    '      - run: npm run build',
    '  deploy:',
    '    needs: build',
    '    uses: owner/repo/.github/workflows/deploy.yml@main',
    '',
  ].join('\n'));
  assert.ok(model);

  const mermaid = workflowToMermaid(model);
  const lines = mermaid.split('\n');
  assert.equal(lines[0], 'flowchart LR');
  assert.ok(lines.some(line => line.includes('%% on: push')));
  assert.ok(lines.some(line => line.includes('%% workflow: 发布流水线')));
  assert.ok(lines.some(line => line.includes('J0["构建<br/>ubuntu-latest · 2 步"]')));
  assert.ok(lines.some(line => line.includes('J1["deploy<br/>可复用工作流"]')));
  assert.ok(lines.some(line => line.trim() === 'J0 --> J1'));

  // 引号与换行必须被转义，否则 Mermaid 解析会失败。
  const quoted = workflowToMermaid({
    name: null,
    line: 1,
    triggers: { events: [], branches: [], tags: [], paths: [], types: [], cron: [], dispatchInputs: [] },
    jobs: [{
      id: 'weird',
      name: '含"引号"的 job',
      runsOn: 'ubuntu-latest',
      if: null,
      uses: null,
      needs: [],
      steps: [],
      matrixKeys: [],
      matrixIssue: null,
      line: 1,
    }],
  });
  assert.ok(quoted.includes("含'引号'的 job"));
});
