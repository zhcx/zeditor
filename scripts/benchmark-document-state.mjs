import assert from 'node:assert/strict';
import { register } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { formatTextStatistics } from '../src/utils/textStatistics.ts';
register('../tests/helpers/resolveTypescript.mjs', import.meta.url);
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
let loadedText = '';
globalThis.window = { __TAURI_INTERNALS__: { invoke: async command => command === 'read_text_document'
  ? { content: loadedText, encoding: 'utf-8', fileVersion: { size: loadedText.length, sha256: 'fixture' } } : undefined } };
const { useAppStore } = await import('../src/stores/appStore.ts');
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const results = [];
for (const size of [100_000, 1_000_000, 5_000_000]) {
  loadedText = ('中文 English 👋 正文\n'.repeat(Math.ceil(size / 18))).slice(0, size);
  const samples = [];
  for (let iteration = 0; iteration < 7; iteration++) {
    useAppStore.setState({ tabs: [{ id: 'empty', title: '未命名', path: null, content: '', modified: false }], activeTabId: 'empty', content: '', currentFile: null, editorView: null });
    const start = performance.now();
    await useAppStore.getState().openFile(`C:/fixture-${size}.md`);
    if (iteration > 0) samples.push(performance.now() - start);
    assert.equal(useAppStore.getState().content, loadedText);
    assert.equal(useAppStore.getState().getActiveTab().content, loadedText);
  }
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(useAppStore.getState().wordCount, formatTextStatistics(loadedText));
  results.push({ utf16Length: loadedText.length, medianStateOpenMs: median(samples), exactTextAndStatistics: true });
}
const output = process.env.DOCUMENT_STATE_BENCH_OUTPUT || 'test-output/reliability/document-state.json';
await mkdir(output.slice(0, output.lastIndexOf('/')), { recursive: true });
await writeFile(output, JSON.stringify({ scope: 'real store processing; immediate in-memory IPC; excludes disk and visual rendering', results }, null, 2));
console.log(JSON.stringify(results));
