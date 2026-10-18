import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as wikiUtils from '../src/utils/wikiLinks.ts';

function serviceHarness() {
  const state = {
    tabs: [] as { path: string; id: string }[],
    currentFile: 'C:/vault/notes/current.md', activeTabId: 'current', content: '# Current',
    editorView: null as null | { focus: () => void },
    openFile: (async () => {}) as (path: string, encoding?: unknown, cancelled?: () => boolean) => Promise<void>,
  };
  let roots = ['C:/vault'];
  const calls: unknown[] = [];
  let invoke: (command: string, args: unknown) => Promise<string | null> = async () => null;
  const exports: Record<string, (...args: never[]) => unknown> = {};
  const compiled = ts.transpileModule(readFileSync(new URL('../src/services/wikiLinks.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(compiled, {
    exports, window: { __TAURI_INTERNALS__: {} }, setTimeout,
    require: (name: string) => {
      if (name === '@tauri-apps/api/core') return { invoke: (command: string, args: unknown) => { calls.push(args); return invoke(command, args); } };
      if (name === '../stores/appStore') return { useAppStore: { getState: () => state } };
      if (name === '../utils/storage') return { readStoredStringArray: () => roots };
      if (name === '../utils/wikiLinks') return wikiUtils;
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return {
    state, calls,
    service: exports as unknown as typeof import('../src/services/wikiLinks.ts'),
    setInvoke: (next: typeof invoke) => { invoke = next; },
    setRoots: (next: string[]) => { roots = next; },
  };
}

it('does not let an unrelated opened note override a contextual disk target', async () => {
  const h = serviceHarness();
  h.state.tabs = [{ id: 'other', path: 'C:/vault/elsewhere/Note.md' }];
  h.setInvoke(async () => 'C:/vault/notes/Note.md');
  assert.equal(await h.service.resolveWikiTarget('Note', h.state.currentFile), 'C:/vault/notes/Note.md');
  assert.equal(h.service.findOpenTabByWikiTarget('missing/Note'), null);
  h.state.tabs = [{ id: 'root', path: 'C:/vault/Note.md' }];
  assert.equal(await h.service.resolveWikiTarget('Note', h.state.currentFile), 'C:/vault/notes/Note.md');
});

it('coalesces in-flight target scans and invalidates resolutions when workspace roots change', async () => {
  const h = serviceHarness();
  let release!: (path: string | null) => void;
  h.setInvoke(() => new Promise(resolve => { release = resolve; }));
  const first = h.service.resolveWikiTarget('Note', h.state.currentFile);
  const second = h.service.resolveWikiTarget('Note', h.state.currentFile);
  assert.equal(h.calls.length, 1);
  release(null);
  await Promise.all([first, second]);
  h.setRoots(['C:/another-vault']);
  h.setInvoke(async () => 'C:/another-vault/Note.md');
  assert.equal(await h.service.resolveWikiTarget('Note', h.state.currentFile), 'C:/another-vault/Note.md');
});

it('does not navigate after the user switches tabs while a target is resolving', async () => {
  const h = serviceHarness();
  let release!: (path: string) => void;
  h.setInvoke(() => new Promise(resolve => { release = resolve; }));
  let opened = false;
  h.state.openFile = async () => { opened = true; };
  const pending = h.service.openWikiLink('[[Slow]]');
  h.state.activeTabId = 'different';
  h.state.currentFile = 'C:/vault/different.md';
  release('C:/vault/Slow.md');
  assert.equal(await pending, false);
  assert.equal(opened, false);
});

it('rechecks a missing target when a newly saved note appears among opened tabs', async () => {
  const h = serviceHarness();
  assert.equal(await h.service.resolveWikiTarget('New', h.state.currentFile), null);
  h.state.tabs.push({ id: 'new', path: 'C:/vault/notes/New.md' });
  h.setInvoke(async () => 'C:/vault/notes/New.md');
  assert.equal(await h.service.resolveWikiTarget('New', h.state.currentFile), 'C:/vault/notes/New.md');
});

it('does not focus the current editor when an asynchronous file open finishes in the background', async () => {
  const h = serviceHarness();
  h.setInvoke(async () => 'C:/vault/Slow.md');
  let focused = false;
  h.state.editorView = { focus: () => { focused = true; } };
  assert.equal(await h.service.openWikiLink('[[Slow]]'), false);
  assert.equal(focused, false);
});

it('bounds a batch of distinct wiki targets to four concurrent native scans', async () => {
  const h = serviceHarness();
  let inFlight = 0;
  let maximum = 0;
  h.setInvoke(async (_command, args) => {
    inFlight += 1;
    maximum = Math.max(maximum, inFlight);
    try {
      await new Promise(resolve => setTimeout(resolve, 1));
      return `C:/vault/${(args as { target: string }).target}.md`;
    } finally {
      inFlight -= 1;
    }
  });
  const targets = Array.from({ length: 12 }, (_, index) => `Note${index}`);
  const result = await h.service.resolveWikiLinkTargets(h.state.currentFile, [...targets, ' Note0 ']);
  assert.ok(maximum <= 4, `started ${maximum} native scans at once`);
  assert.equal(h.calls.length, targets.length);
  assert.equal(result.size, targets.length);
  for (const target of targets) assert.equal(result.get(target), `C:/vault/${target}.md`);
});

for (const kind of ['forward', 'backlink'] as const) {
  for (const cause of ['tab switch', 'newer navigation'] as const) {
  it(`cancels a pending ${kind} file read before it can activate after a ${cause}`, async () => {
    const h = serviceHarness();
    h.setInvoke(async () => 'C:/vault/Slow.md');
    let release!: () => void;
    let started!: () => void;
    const reading = new Promise<void>(resolve => { release = resolve; });
    const opening = new Promise<void>(resolve => { started = resolve; });
    let activated = false;
    h.state.openFile = async (path, _encoding, cancelled) => {
      started();
      await reading;
      if (cancelled?.()) return;
      activated = true;
      h.state.currentFile = path;
      h.state.activeTabId = 'slow';
    };
    const pending = kind === 'forward'
      ? h.service.openWikiLink('[[Slow]]')
      : h.service.openWikiBacklink('C:/vault/Slow.md', 1);
    await opening;
    if (cause === 'tab switch') {
      h.state.activeTabId = 'different';
      h.state.currentFile = 'C:/vault/different.md';
    } else {
      h.setInvoke(async () => null);
      await h.service.openWikiLink('[[Missing]]');
    }
    const expectedPath = h.state.currentFile;
    release();
    await pending;
    assert.equal(activated, false, 'the stale read must be cancelled before committing a new active tab');
    assert.equal(h.state.currentFile, expectedPath);
  });
  }
}
