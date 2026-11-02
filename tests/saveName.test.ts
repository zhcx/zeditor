import { register } from 'node:module';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

register('./helpers/resolveTypescript.mjs', import.meta.url);
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {} } });
const { resolveSaveBaseName } = await import('../src/utils/saveName.ts');
const { useAIStore } = await import('../src/stores/aiStore.ts');
const originalAI = useAIStore.getState();
afterEach(() => useAIStore.setState(originalAI));

test('resolves a name synchronously even when AI filename generation never finishes', () => {
  let calls = 0;
  useAIStore.setState({
    status: 'loading', statusMessage: '正在处理其他 AI 任务',
    suggestFilename: () => { calls += 1; return new Promise(() => {}); },
  });
  assert.equal(resolveSaveBaseName('未命名', '# 新文件标题\n\n正文'), '新文件标题');
  assert.equal(calls, 0);
  assert.equal(useAIStore.getState().statusMessage, '正在处理其他 AI 任务');
});

test('uses local headings or the first text line and retains an existing file title', () => {
  assert.equal(resolveSaveBaseName('已有文件.md', '# 另一个标题'), '已有文件');
  assert.equal(resolveSaveBaseName('未命名', '开场白\n\n## 正式标题 ##\n正文'), '正式标题');
  assert.equal(resolveSaveBaseName('未命名', '> 第一行正文\n下一行'), '第一行正文');
  assert.equal(resolveSaveBaseName('未命名', '\n \n'), '未命名');
});

test('ignores metadata and fenced code when choosing the document title', () => {
  const text = '---\ntitle: metadata\n---\n```md\n# 代码中的标题\n```\n# 真正的标题';
  assert.equal(resolveSaveBaseName('未命名', text), '真正的标题');
});

test('makes a safe local filename and bounds work on very large documents', () => {
  assert.equal(resolveSaveBaseName('未命名', '# [项目](https://example.com)：A/B? *进展*'), '项目：A B 进展');
  assert.equal(resolveSaveBaseName('未命名', '# CON'), '笔记-CON');
  const name = resolveSaveBaseName('未命名', '# ' + '😀'.repeat(100) + '\n' + '正文'.repeat(1024 * 1024));
  assert.equal(Array.from(name).length, 60);
  assert.ok(!/[\uD800-\uDBFF]$/.test(name));
});
