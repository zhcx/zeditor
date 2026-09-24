import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isWorkflowFilePath,
  isWorkflowSourceFile,
  jobSubtitle,
  looksLikeWorkflowYaml,
  nodeToText,
  parseActionRef,
  parseWorkflow,
} from '../src/utils/githubWorkflow.ts';

const WORKFLOW = [
  '# 持续集成',
  'name: CI',
  'on:',
  '  push:',
  '    branches: [main, "release/*"]',
  '  pull_request:',
  '  schedule:',
  "    - cron: '0 3 * * 1'",
  '  workflow_dispatch:',
  '    inputs:',
  '      target:',
  '        description: 目标环境',
  '        default: staging',
  '',
  'jobs:',
  '  build:',
  '    name: 构建',
  '    runs-on: ubuntu-latest',
  '    strategy:',
  '      matrix:',
  '        node: [20, 22]',
  '    steps:',
  '      - uses: actions/checkout@v4',
  '      - name: 安装依赖',
  '        run: npm ci',
  '        working-directory: web',
  '        with:',
  '          node-version: 20',
  '',
  '  test:',
  '    needs: build',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - run: npm test',
  '',
  '  deploy:',
  '    needs: [build, test]',
  '    uses: owner/repo/.github/workflows/deploy.yml@main',
  '',
].join('\n');

test('识别工作流文件路径与可识别内容', () => {
  assert.equal(isWorkflowFilePath('D:\\repo\\.github\\workflows\\ci.yml'), true);
  assert.equal(isWorkflowFilePath('/home/me/repo/.github/workflows/release.yaml'), true);
  assert.equal(isWorkflowFilePath('/home/me/repo/.github/workflows/nested/ci.yml'), false);
  assert.equal(isWorkflowFilePath('/home/me/repo/ci.yml'), false);
  assert.equal(isWorkflowFilePath(null), false);

  assert.equal(looksLikeWorkflowYaml(WORKFLOW), true);
  // 普通 YAML：有 jobs 但 job 内没有 runs-on / uses。
  assert.equal(looksLikeWorkflowYaml('jobs:\n  build:\n    name: 构建\n'), false);
  assert.equal(looksLikeWorkflowYaml('services:\n  db:\n    image: mysql\n'), false);
  // 可复用工作流用 uses 描述 job，同样算工作流。
  assert.equal(looksLikeWorkflowYaml('jobs:\n  call:\n    uses: o/r/.github/workflows/x.yml@v1\n'), true);

  assert.equal(isWorkflowSourceFile('D:\\repo\\.github\\workflows\\ci.yml', WORKFLOW), true);
  assert.equal(isWorkflowSourceFile('/tmp/notes.yaml', WORKFLOW), true);
  assert.equal(isWorkflowSourceFile('/tmp/notes.md', WORKFLOW), false);
  assert.equal(isWorkflowSourceFile('D:\\repo\\.github\\workflows\\broken.yml', 'jobs: ['), true);
});

test('解析 job、step 与源码行号', () => {
  const { model, errors } = parseWorkflow(WORKFLOW);
  assert.deepEqual(errors, []);
  assert.ok(model);
  assert.equal(model.name, 'CI');
  assert.deepEqual(model.jobs.map(job => job.id), ['build', 'test', 'deploy']);

  const [build, testJob, deploy] = model.jobs;
  assert.equal(build.name, '构建');
  assert.equal(build.runsOn, 'ubuntu-latest');
  assert.deepEqual(build.matrixKeys, ['node']);
  assert.equal(build.matrixIssue, null);
  assert.equal(build.line, 16);
  assert.equal(build.steps.length, 2);

  const [checkout, install] = build.steps;
  assert.equal(checkout.uses, 'actions/checkout@v4');
  assert.equal(checkout.run, null);
  assert.equal(install.name, '安装依赖');
  assert.equal(install.run, 'npm ci');
  assert.equal(install.workingDirectory, 'web');
  assert.deepEqual(install.withEntries, [{ key: 'node-version', value: '20' }]);
  assert.equal(install.line, 24);

  assert.deepEqual(testJob.needs, ['build']);
  assert.deepEqual(deploy.needs, ['build', 'test']);
  assert.equal(deploy.uses, 'owner/repo/.github/workflows/deploy.yml@main');
  assert.equal(jobSubtitle(deploy), 'owner/repo/.github/workflows/deploy.yml@main');
  assert.equal(jobSubtitle(testJob), 'ubuntu-latest');
});

test('汇总触发器信息', () => {
  const { model } = parseWorkflow(WORKFLOW);
  assert.ok(model);
  const { triggers } = model;
  assert.deepEqual(triggers.events, ['push', 'pull_request', 'schedule', 'workflow_dispatch']);
  assert.deepEqual(triggers.branches, ['main', 'release/*']);
  assert.deepEqual(triggers.cron, ['0 3 * * 1']);
  assert.deepEqual(triggers.dispatchInputs, ['target']);
  assert.deepEqual(triggers.tags, []);
});

test('触发器支持字符串、序列与映射三种写法', () => {
  const single = parseWorkflow('on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n');
  assert.deepEqual(single.model?.triggers.events, ['push']);

  const list = parseWorkflow('on: [push, pull_request]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n');
  assert.deepEqual(list.model?.triggers.events, ['push', 'pull_request']);

  const empty = parseWorkflow('jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n');
  assert.deepEqual(empty.model?.triggers.events, []);
});

test('语法错误时给出诊断但仍尽可能解析出模型', () => {
  const broken = parseWorkflow([
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: echo',
    '  broken: [未闭合的流式序列',
    '',
  ].join('\n'));
  assert.ok(broken.errors.length > 0);
  assert.ok((broken.errors[0].line ?? 0) >= 6);
  assert.equal(broken.model?.jobs[0].id, 'build');
  assert.equal(broken.model?.jobs[0].runsOn, 'ubuntu-latest');

  // 普通 YAML 不返回模型，让调用方回退到代码块渲染。
  const plain = parseWorkflow('title: 文档\nitems:\n  - a\n');
  assert.equal(plain.model, null);
  assert.deepEqual(plain.errors, []);
});

test('重复 job id 会被记录为重复键错误', () => {
  const duplicated = parseWorkflow([
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: echo',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: echo',
    '',
  ].join('\n'));
  const duplicate = duplicated.errors.find(error => error.code === 'DUPLICATE_KEY');
  assert.ok(duplicate);
  assert.equal(duplicate.line, 6);
  assert.equal(duplicate.column, 3);
});

test('解析 action 引用与表达式文本', () => {
  assert.deepEqual(parseActionRef('actions/checkout@v4'), { slug: 'actions/checkout', ref: 'v4', isLocal: false });
  assert.deepEqual(parseActionRef('actions/checkout'), { slug: 'actions/checkout', ref: null, isLocal: false });
  assert.deepEqual(parseActionRef('./.github/actions/build'), { slug: './.github/actions/build', ref: null, isLocal: true });
  assert.deepEqual(parseActionRef('docker://alpine:3.20'), { slug: 'docker://alpine:3.20', ref: null, isLocal: true });
  assert.equal(nodeToText(undefined), '');
  assert.equal(nodeToText(null), '');
});
