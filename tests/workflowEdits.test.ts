import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyWorkflowPatches,
  describeWorkflowPatch,
  workflowPatchKey,
  type WorkflowPatch,
} from '../src/utils/workflowEdits.ts';

const SOURCE = [
  '# 部署流水线',
  'name: Deploy',
  'on:',
  '  push:',
  '    branches: [main]',
  '',
  'jobs:',
  '  # 构建产物',
  '  build:',
  '    name: 构建       # 显示名',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout@v4',
  '      - name: 打包',
  '        run: npm run build',
  '        working-directory: web',
  '      - name: 上传',
  '        uses: actions/upload-artifact@v4',
  '        with:',
  '          name: dist      # 产物名',
  '          path: dist',
  '',
].join('\n');

test('同目标补丁去重键与描述', () => {
  assert.equal(workflowPatchKey({ kind: 'job.set', jobId: 'build', field: 'name', value: 'x' }), 'job:build:name');
  assert.equal(workflowPatchKey({ kind: 'step.set', jobId: 'build', stepIndex: 2, field: 'run', value: 'x' }), 'step:build:2:run');
  assert.equal(workflowPatchKey({ kind: 'with.set', jobId: 'build', stepIndex: 2, key: 'path', value: 'x' }), 'with:build:2:path');
  assert.equal(workflowPatchKey({ kind: 'with.remove', jobId: 'build', stepIndex: 2, key: 'path' }), 'with:build:2:path');
  assert.equal(describeWorkflowPatch({ kind: 'job.set', jobId: 'build', field: 'runs-on', value: 'x' }), 'job build · runs-on');
  assert.equal(describeWorkflowPatch({ kind: 'with.remove', jobId: 'build', stepIndex: 1, key: 'path' }), 'job build · 步骤 2 · 删除 with.path');
});

test('job.set 保留注释、锚点与缩进', () => {
  const result = applyWorkflowPatches(SOURCE, [
    { kind: 'job.set', jobId: 'build', field: 'name', value: '构建（CI）' },
    { kind: 'job.set', jobId: 'build', field: 'if', value: "github.ref == 'refs/heads/main'" },
  ]);

  assert.deepEqual(result.issues, []);
  assert.equal(result.applied.length, 2);
  assert.ok(result.source.includes('# 部署流水线'));
  assert.ok(result.source.includes('# 构建产物'));
  assert.ok(result.source.includes('# 显示名'));
  assert.ok(result.source.includes('# 产物名'));
  assert.ok(result.source.includes('name: 构建（CI）'));
  assert.ok(result.source.includes("if: github.ref == 'refs/heads/main'"));
  assert.ok(result.source.includes('branches: [main]'));
  // 未触碰的内容保持不变。
  assert.ok(result.source.includes('runs-on: ubuntu-latest'));
  assert.ok(result.source.includes('working-directory: web'));
});

test('runs-on 支持数组写法并保持流式风格', () => {
  const result = applyWorkflowPatches(SOURCE, [
    { kind: 'job.set', jobId: 'build', field: 'runs-on', value: '[self-hosted, linux, x64]' },
  ]);
  assert.deepEqual(result.issues, []);
  assert.match(result.source, /runs-on: \[self-hosted, linux, x64\]/);
  assert.ok(!result.source.includes('- self-hosted'));
});

test('step.set 修改 run 与多行脚本', () => {
  const result = applyWorkflowPatches(SOURCE, [
    { kind: 'step.set', jobId: 'build', stepIndex: 1, field: 'run', value: 'npm ci\nnpm run build' },
  ]);
  assert.deepEqual(result.issues, []);
  assert.ok(result.source.includes('npm ci'));
  assert.ok(result.source.includes('npm run build'));
  // 多行脚本按块标量写出，其余字段与步骤不受影响。
  assert.ok(result.source.includes('working-directory: web'));
  assert.ok(result.source.includes('actions/upload-artifact@v4'));
  assert.ok(result.source.includes('actions/checkout@v4'));
});

test('with.set / with.remove 增删 action 输入', () => {
  const setResult = applyWorkflowPatches(SOURCE, [
    { kind: 'with.set', jobId: 'build', stepIndex: 2, key: 'retention-days', value: '7' },
    { kind: 'with.set', jobId: 'build', stepIndex: 2, key: 'name', value: 'dist-ci' },
  ]);
  assert.deepEqual(setResult.issues, []);
  assert.ok(setResult.source.includes('retention-days: 7'));
  assert.ok(setResult.source.includes('name: dist-ci'));
  assert.ok(setResult.source.includes('# 产物名'));

  const removeResult = applyWorkflowPatches(SOURCE, [
    { kind: 'with.remove', jobId: 'build', stepIndex: 2, key: 'path' },
  ]);
  assert.deepEqual(removeResult.issues, []);
  assert.ok(!removeResult.source.includes('path: dist'));
  assert.ok(removeResult.source.includes('name: dist'));

  // 删空后 with 块整体移除，不留空映射。
  const emptyResult = applyWorkflowPatches(SOURCE, [
    { kind: 'with.remove', jobId: 'build', stepIndex: 2, key: 'path' },
    { kind: 'with.remove', jobId: 'build', stepIndex: 2, key: 'name' },
  ]);
  assert.ok(!/\bwith:/.test(emptyResult.source));
});

test('找不到 job / step / with 键时跳过并给出原因', () => {
  const missingJob = applyWorkflowPatches(SOURCE, [
    { kind: 'job.set', jobId: 'ghost', field: 'name', value: 'x' },
  ]);
  assert.equal(missingJob.source, SOURCE);
  assert.deepEqual(missingJob.applied, []);
  assert.match(missingJob.issues[0].reason, /未找到 job "ghost"/);

  const missingStep = applyWorkflowPatches(SOURCE, [
    { kind: 'step.set', jobId: 'build', stepIndex: 9, field: 'name', value: 'x' },
  ]);
  assert.equal(missingStep.source, SOURCE);
  assert.match(missingStep.issues[0].reason, /第 10 个步骤已不存在/);

  const missingWithKey = applyWorkflowPatches(SOURCE, [
    { kind: 'with.remove', jobId: 'build', stepIndex: 0, key: 'token' },
  ]);
  assert.equal(missingWithKey.source, SOURCE);
  assert.match(missingWithKey.issues[0].reason, /未找到 with.token/);
});

test('值未变化的补丁不写回源码', () => {
  const result = applyWorkflowPatches(SOURCE, [
    { kind: 'job.set', jobId: 'build', field: 'name', value: '构建' },
    { kind: 'step.set', jobId: 'build', stepIndex: 1, field: 'run', value: 'npm run build' },
    { kind: 'with.set', jobId: 'build', stepIndex: 2, key: 'path', value: 'dist' },
  ]);
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.issues, []);
  assert.equal(result.source, SOURCE);
});

test('关闭保留格式时输出规范化 YAML（丢注释）', () => {
  const result = applyWorkflowPatches(
    SOURCE,
    [{ kind: 'job.set', jobId: 'build', field: 'name', value: '构建流水线' }],
    { preserveFormat: false },
  );
  assert.equal(result.applied.length, 1);
  assert.ok(!result.source.includes('# 部署流水线'));
  assert.ok(!result.source.includes('# 产物名'));
  assert.ok(result.source.includes('name: 构建流水线'));
  assert.ok(result.source.includes('upload-artifact@v4'));
});

test('没有补丁时不改动源码', () => {
  const result = applyWorkflowPatches(SOURCE, [] as WorkflowPatch[]);
  assert.equal(result.source, SOURCE);
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.issues, []);
});

test('文档不是映射时整体拒绝', () => {
  const result = applyWorkflowPatches('- a\n- b\n', [
    { kind: 'job.set', jobId: 'build', field: 'name', value: 'x' },
  ]);
  assert.match(result.issues[0].reason, /根节点不是映射/);
});
