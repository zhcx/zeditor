import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkflow } from '../src/utils/githubWorkflow.ts';
import {
  collectWorkflowDiagnostics,
  countWorkflowDiagnostics,
  findNeedsCycle,
  formatWorkflowDiagnostic,
} from '../src/utils/workflowDiagnostics.ts';

function diagnose(source: string) {
  const parsed = parseWorkflow(source);
  return collectWorkflowDiagnostics({
    model: parsed.model,
    errors: parsed.errors,
    warnings: parsed.warnings,
    source,
  });
}

const codesOf = (source: string) => diagnose(source).map(item => item.code);

test('解析错误转成 GHA-PARSE-* 诊断', () => {
  const diagnostics = diagnose('jobs: [未闭合\n');
  assert.ok(diagnostics.length > 0);
  assert.equal(diagnostics[0].code, 'GHA-PARSE-001');
  assert.ok(diagnostics[0].line && diagnostics[0].line >= 1);
});

test('重复 job id 报 GHA-JOB-001', () => {
  const diagnostics = diagnose([
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
  const duplicate = diagnostics.find(item => item.code === 'GHA-JOB-001');
  assert.ok(duplicate);
  assert.match(duplicate.message, /重复的 job id "build"/);
  assert.equal(duplicate.line, 6);
});

test('job 级结构问题：uses+steps、缺少 runs-on、空 job、matrix 结构', () => {
  const source = [
    'on: push',
    'jobs:',
    '  reusable:',
    '    uses: owner/repo/.github/workflows/build.yml@v1',
    '    steps:',
    '      - run: echo',
    '  no-runner:',
    '    steps:',
    '      - run: echo',
    '  empty:',
    '    runs-on: ubuntu-latest',
    '  matrix:',
    '    runs-on: ubuntu-latest',
    '    strategy:',
    '      matrix: ubuntu-latest',
    '    steps:',
    '      - run: echo',
    '',
  ].join('\n');
  const diagnostics = diagnose(source);
  assert.ok(diagnostics.some(item => item.code === 'GHA-JOB-002' && item.jobId === 'reusable'));
  assert.ok(diagnostics.some(item => item.code === 'GHA-JOB-003' && item.jobId === 'empty'));
  assert.ok(diagnostics.some(item => item.code === 'GHA-JOB-004' && item.jobId === 'no-runner'));
  assert.ok(diagnostics.some(item => item.code === 'GHA-MATRIX-001' && item.jobId === 'matrix'));
});

test('needs 引用问题：未知引用、循环依赖、自依赖', () => {
  assert.ok(codesOf([
    'jobs:',
    '  a:',
    '    needs: ghost',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: echo',
    '',
  ].join('\n')).includes('GHA-NEEDS-001'));

  assert.ok(codesOf([
    'jobs:',
    '  a:',
    '    needs: a',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: echo',
    '',
  ].join('\n')).includes('GHA-NEEDS-003'));

  const cycleSource = [
    'jobs:',
    '  a:',
    '    needs: b',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: echo',
    '  b:',
    '    needs: a',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: echo',
    '',
  ].join('\n');
  const parsed = parseWorkflow(cycleSource);
  assert.ok(parsed.model);
  assert.deepEqual(findNeedsCycle(parsed.model.jobs), ['a', 'b', 'a']);
  const cycleDiagnostic = diagnose(cycleSource).find(item => item.code === 'GHA-NEEDS-002');
  assert.ok(cycleDiagnostic);
  assert.match(cycleDiagnostic.message, /循环依赖：a → b → a/);
});

test('step 级问题与 action 版本固定提示', () => {
  const source = [
    'on: push',
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '        run: echo 冲突',
    '      - name: 空步骤',
    '      - uses: some/action',
    '      - uses: other/action@main',
    '',
  ].join('\n');
  const diagnostics = diagnose(source);
  assert.ok(diagnostics.some(item => item.code === 'GHA-STEP-001' && item.stepIndex === 0));
  assert.ok(diagnostics.some(item => item.code === 'GHA-STEP-002' && item.stepIndex === 1));
  assert.ok(diagnostics.some(item => item.code === 'GHA-STEP-003' && item.stepIndex === 2));
  assert.ok(diagnostics.some(item => item.code === 'GHA-STEP-004' && item.stepIndex === 3));
});

test('pull_request_target 检出 PR 头部代码时报安全警告', () => {
  const source = [
    'on:',
    '  pull_request_target:',
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '        with:',
    '          ref: ${{ github.event.pull_request.head.sha }}',
    '',
  ].join('\n');
  const diagnostics = diagnose(source);
  const warning = diagnostics.find(item => item.code === 'GHA-SEC-001');
  assert.ok(warning);
  assert.equal(warning.severity, 'warning');
  assert.equal(warning.jobId, 'build');
});

test('未知表达式上下文报 GHA-EXPR-001，合法上下文不误报', () => {
  const unknown = diagnose([
    'on: push',
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: echo ${{ foo.bar }}',
    '      - run: echo ${{ github.sha }} ${{ needs.build.result }} ${{ matrix.os }}',
    '',
  ].join('\n'));
  const expression = unknown.filter(item => item.code === 'GHA-EXPR-001');
  assert.equal(expression.length, 1);
  assert.match(expression[0].message, /"foo"/);
  assert.equal(expression[0].line, 6);

  const known = diagnose([
    'on: push',
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: echo ${{ hashFiles("**/package-lock.json") }} ${{ env.NODE_ENV }} ${{ secrets.TOKEN }}',
    '        if: ${{ success() && !cancelled() }}',
    '',
  ].join('\n'));
  assert.equal(known.filter(item => item.code === 'GHA-EXPR-001').length, 0);
});

test('缺少 on 触发器时给出提示，并按严重级别排序', () => {
  const diagnostics = diagnose([
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: echo ${{ wrong.ctx }}',
    '',
  ].join('\n'));
  assert.ok(diagnostics.some(item => item.code === 'GHA-PARSE-004'));
  const severities = diagnostics.map(item => item.severity);
  assert.deepEqual(severities, [...severities].sort((a, b) => (
    { error: 0, warning: 1, info: 2 }[a] - { error: 0, warning: 1, info: 2 }[b]
  )));

  const totals = countWorkflowDiagnostics(diagnostics);
  assert.equal(totals.errors + totals.warnings + totals.infos, diagnostics.length);
  assert.equal(totals.warnings >= 2, true);
  assert.match(formatWorkflowDiagnostic(diagnostics[0]), /^\[GHA-/);
});

test('普通 YAML 报「不是可识别工作流」', () => {
  const diagnostics = diagnose('title: 文档\n');
  assert.deepEqual(diagnostics.map(item => item.code), ['GHA-PARSE-003']);
});
