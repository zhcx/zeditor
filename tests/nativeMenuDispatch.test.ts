import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { createMenuDispatcher, type AppMenuItem } from '../src/utils/menuModel.ts';

test('native export dispatch reads document actions from the latest render', () => {
  const exported: string[] = [];
  const renderMenu = (content: string): AppMenuItem[][] => [[{
    id: 'file.export', label: 'Export', children: [{
      id: 'file.export.html', label: 'HTML', action: () => exported.push(content),
    }],
  }]];
  let currentMenu = renderMenu('original document');
  const dispatch = createMenuDispatcher(() => currentMenu);
  currentMenu = renderMenu('edited document');
  dispatch('file.export.html');
  assert.deepEqual(exported, ['edited document']);
  currentMenu = renderMenu('another document');
  dispatch('file.export.html');
  assert.deepEqual(exported, ['edited document', 'another document']);
  dispatch('removed.menu.item');
  assert.equal(exported.length, 2);
});

// Exercise the actual App keyboard callbacks in isolation without mounting unrelated
// editor components or requiring a real macOS menu bar in the test environment.
function appShortcut(action: string, globals: Record<string, unknown>): (event: object) => void {
  const source = ts.createSourceFile('App.tsx', readFileSync('src/App.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback = '';
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'onKeyDown' && node.initializer) {
      const text = node.initializer.getText(source);
      if (text.includes(action)) callback = text;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(callback, `App shortcut callback for ${action} was not found`);
  const script = ts.transpile(`(${callback})`, { target: ts.ScriptTarget.ES2022 });
  return runInNewContext(script, globals);
}

test('native link-check accelerator triggers one check while browser fallback still works', () => {
  let checks = 0;
  let nativeMenu = true;
  const onKeyDown = appShortcut('runCheck()', {
    isNativeMenuActive: () => nativeMenu,
    runCheck: () => { checks += 1; },
  });
  const event = { key: 'v', ctrlKey: false, metaKey: true, altKey: true, shiftKey: false, preventDefault() {} };
  checks += 1; // Native menu dispatch.
  onKeyDown(event);
  assert.equal(checks, 1);
  nativeMenu = false;
  onKeyDown(event);
  assert.equal(checks, 2);
});

test('native AI palette accelerator does not immediately toggle the opened panel closed', () => {
  let visible = false;
  let nativeMenu = true;
  const onKeyDown = appShortcut('setAiPaletteVisible', {
    isNativeMenuActive: () => nativeMenu,
    setAiPaletteVisible: (update: (previous: boolean) => boolean) => { visible = update(visible); },
  });
  const event = { key: 'j', ctrlKey: false, metaKey: true, altKey: false, shiftKey: false, preventDefault() {} };
  visible = true; // Native menu dispatch opens the panel.
  onKeyDown(event);
  assert.equal(visible, true);
  nativeMenu = false;
  onKeyDown(event);
  assert.equal(visible, false);
});

test('native menu ownership does not disable F2 link-result navigation', () => {
  let direction = 0;
  let prevented = false;
  const onKeyDown = appShortcut('runCheck()', {
    isNativeMenuActive: () => true,
    navigateResult: (value: number) => { direction = value; return true; },
  });
  onKeyDown({ key: 'F2', shiftKey: true, isComposing: false, preventDefault() { prevented = true; } });
  assert.equal(direction, -1);
  assert.equal(prevented, true);
});

interface TestMenu { setAsAppMenu(): Promise<void> }

function nativeMenuEffect(buildMenu: () => Promise<TestMenu>, document: { documentElement: { dataset: Record<string, string> } }): () => void {
  const source = ts.createSourceFile('MenuBar.tsx', readFileSync('src/components/MenuBar/MenuBar.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback = '';
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect') {
      const text = node.arguments[0]?.getText(source);
      if (text?.includes('void buildMacAppMenu({')) callback = text;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(callback, 'native menu installation effect was not found');
  const effect = runInNewContext(ts.transpile(`(${callback})`, { target: ts.ScriptTarget.ES2022 }), {
    macDesktop: true,
    menusRef: { current: [] },
    language: 'en',
    t: (text: string) => text,
    toAppMenuItems: () => [],
    createMenuDispatcher,
    buildMacAppMenu: buildMenu,
    APP_NAME: 'Zeditor',
    setSettingsOpen() {},
    document,
    console: { warn() {} },
  });
  return effect();
}

test('a cancelled native menu build cannot replace a newer installed menu', async () => {
  const installed: string[] = [];
  const document = { documentElement: { dataset: {} as Record<string, string> } };
  let finishOld!: (menu: TestMenu) => void;
  const oldBuild = new Promise<TestMenu>(resolve => { finishOld = resolve; });
  const cleanup = nativeMenuEffect(() => oldBuild, document);
  cleanup();
  nativeMenuEffect(() => Promise.resolve({ async setAsAppMenu() { installed.push('new'); } }), document);
  await new Promise(resolve => setImmediate(resolve));
  finishOld({ async setAsAppMenu() { installed.push('old'); } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(installed, ['new']);
  assert.equal(document.documentElement.dataset.nativeMenu, 'active');
});

test('a cancelled menu build failure cannot clear the current native menu marker', async () => {
  const document = { documentElement: { dataset: {} as Record<string, string> } };
  let failOld!: (error: Error) => void;
  const oldBuild = new Promise<TestMenu>((_, reject) => { failOld = reject; });
  const cleanup = nativeMenuEffect(() => oldBuild, document);
  cleanup();
  nativeMenuEffect(() => Promise.resolve({ async setAsAppMenu() {} }), document);
  await new Promise(resolve => setImmediate(resolve));
  failOld(new Error('old build failed'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(document.documentElement.dataset.nativeMenu, 'active');
});
