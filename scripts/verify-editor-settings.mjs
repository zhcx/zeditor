import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const browserBin = process.env.AGENT_BROWSER_BIN || (process.platform === 'win32'
  ? join(process.env.APPDATA || '', 'npm/node_modules/agent-browser/bin/agent-browser-win32-x64.exe') : 'agent-browser');
const session = 'zeditor-settings-verification';
const edge = process.platform === 'win32' ? join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe') : '';
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(browserBin, ['--session', session, ...args], { windowsHide: true });
    let output = ''; let errors = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('浏览器命令超时')); }, 30_000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => {
      clearTimeout(timer); child.stdout.destroy(); child.stderr.destroy();
      if (code !== 0) reject(new Error(errors || output)); else resolve(output.trim());
    });
  });
}
const evaluate = async script => JSON.parse(await run(['eval', '-b', Buffer.from(script).toString('base64')]));
const waitFor = expression => evaluate(`(async()=>{for(let i=0;i<240;i++){if(${expression})return true;await new Promise(r=>setTimeout(r,25));}throw new Error(${JSON.stringify(expression)});})()`);
const loadStore = () => evaluate(`(async()=>{const source=await(await fetch('/src/App.tsx')).text();window.__settingsStore=(await import(source.match(/from ["']([^"']*appStore[.]ts[^"']*)["']/)[1])).useAppStore;return true;})()`);
const typography = () => evaluate(`(()=>{const css=getComputedStyle(document.documentElement);return {size:css.getPropertyValue('--ui-font-base-size').trim(),gap:css.getPropertyValue('--text-letter-spacing').trim(),preview:getComputedStyle(document.querySelector('.preview-document')).letterSpacing,editor:getComputedStyle(document.querySelector('.monaco-editor .view-lines')).letterSpacing,contentSize:window.__settingsStore.getState().settings.appearance.font_size};})()`);
const slider = async (label, count) => {
  await run(['click', `[aria-label="${label}"]`]);
  await run(['press', 'Home']);
  for (let i=0;i<count;i++) await run(['press', 'ArrowRight']);
};

// 使用隔离的浏览器和内存示例文档，不接触用户文档或桌面设置。
try {
  await mkdir('test-output', { recursive: true });
  await run([...(edge && existsSync(edge) ? ['--executable-path', edge] : []), 'open', process.argv[2] || 'http://127.0.0.1:1425']);
  await run(['set', 'viewport', '1440', '900']);
  await waitFor("document.querySelector('.open-editor-row')");
  await loadStore();
  const exampleDoc = '# 排版设置\n\n文字间距将同步到编辑器与预览。';
  await evaluate(`(()=>{const s=window.__settingsStore.getState();s.setSettings({...s.settings,appearance:{...s.settings.appearance,theme:'vscode-dark',language:'zh-CN',ui_font_size:13,letter_spacing:0.6},editor:{...s.settings.editor,pin_toolbar:true}});s.addTab({title:'排版设置测试.md',path:'web://demo/排版设置测试.md',content:${JSON.stringify(exampleDoc)}});s.setSettingsOpen(true);return true;})()`);
  await waitFor("document.querySelector('[aria-label=界面字号]') && document.querySelector('.monaco-editor .view-lines')");
  assert.equal((await typography()).gap, '0.6px');
  await run(['screenshot', 'test-output/typography-settings.png']);
  await slider('界面字号', 9); // 20 px
  await run(['click', '[aria-label="字间距"]']);
  await run(['press', 'End']);
  await waitFor("getComputedStyle(document.querySelector('.monaco-editor .view-lines')).letterSpacing==='5px'");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.preview-document h1')).letterSpacing"), '5px');
  assert.deepEqual(await typography(), {size:'20px',gap:'5px',preview:'5px',editor:'5px',contentSize:14});
  await run(['click', '.settings-footer button:first-child']);
  await waitFor("!document.querySelector('.settings-panel')");
  assert.deepEqual(await typography(), {size:'13px',gap:'0.6px',preview:'0.6px',editor:'0.6px',contentSize:14});

  await run(['click', '[aria-label="设置"]']);
  await waitFor("document.querySelector('.settings-panel')");
  await slider('界面字号', 7); // 18 px
  await slider('字间距', 12); // 1.2 px
  await run(['click', '.settings-footer button:last-child']);
  await waitFor("!document.querySelector('.settings-panel') && window.__settingsStore.getState().settings.appearance.ui_font_size===18");
  assert.deepEqual(await typography(), {size:'18px',gap:'1.2px',preview:'1.2px',editor:'1.2px',contentSize:14});
  const widths = [];
  for (const width of [1440,1100,960,900]) {
    await run(['set', 'viewport', String(width), '900']);
    await waitFor("document.querySelector('.editor-pane-toolbar .toolbar-scroll-area').scrollWidth<=document.querySelector('.editor-pane-toolbar .toolbar-scroll-area').clientWidth+1");
    const geometry = await evaluate("({width:innerWidth,page:document.documentElement.scrollWidth,status:document.querySelector('.statusbar').scrollWidth})");
    assert.ok(geometry.page<=width+1 && geometry.status<=width+1, JSON.stringify(geometry));
    widths.push(geometry);
  }
  await run(['screenshot', 'test-output/typography-large-narrow.png']);
  await evaluate("(()=>{const s=window.__settingsStore.getState();s.setSettings({...s.settings,appearance:{...s.settings.appearance,ui_font_size:20,letter_spacing:5}});return true;})()");
  await waitFor("getComputedStyle(document.documentElement).getPropertyValue('--ui-font-base-size').trim()==='20px'");
  const extreme = await evaluate("({width:innerWidth,page:document.documentElement.scrollWidth,status:document.querySelector('.statusbar').scrollWidth})");
  assert.ok(extreme.page<=extreme.width+1 && extreme.status<=extreme.width+1, JSON.stringify(extreme));
  await run(['screenshot', 'test-output/typography-extreme.png']);
  await evaluate("(()=>{const s=window.__settingsStore.getState();s.setSettings({...s.settings,appearance:{...s.settings.appearance,ui_font_size:18,letter_spacing:1.2}});return true;})()");
  await run(['reload']);
  await waitFor("document.querySelector('.open-editor-row')");
  await loadStore();
  assert.equal(await evaluate("window.__settingsStore.getState().settings.appearance.ui_font_size"),18);
  assert.equal(await evaluate("window.__settingsStore.getState().settings.appearance.letter_spacing"),1.2);

  // 真实字节转换由 Rust 测试验证；此处验证选择、焦点与防止覆盖修改的交互。
  await run(['set','viewport','1440','900']);
  await evaluate(`(()=>{const s=window.__settingsStore.getState();s.setSettings({...s.settings,appearance:{...s.settings.appearance,ui_font_size:13,letter_spacing:0.6}});window.__encodedTab=s.addTab({title:'编码测试.md',path:'web://demo/编码测试.md',content:'中文原文'});s.setEncodingDialog({mode:'save',tabId:window.__encodedTab});return true;})()`);
  await waitFor("document.activeElement?.matches('.encoding-options [aria-selected=true]')");
  assert.equal(await evaluate("document.querySelectorAll('.encoding-options [role=option]').length"),11);
  await run(['press','End']);
  assert.equal(await evaluate("document.activeElement.textContent.includes('Windows-1252')"),true);
  await run(['press','Home']);
  await run(['press','ArrowDown']);
  assert.equal(await evaluate("document.activeElement.textContent.includes('UTF-8 with BOM')"),true);
  await evaluate("Array.from(document.querySelectorAll('.encoding-options button')).find(b=>b.textContent.includes('GB18030')).click();true");
  await run(['screenshot','test-output/encoding-dialog.png']);
  await run(['click','.encoding-confirm']);
  await waitFor("!document.querySelector('.encoding-dialog')");
  await evaluate("(()=>{const s=window.__settingsStore.getState();s.setSettings({...s.settings,appearance:{...s.settings.appearance,language:'en'}});s.setEncodingDialog({mode:'save',tabId:window.__encodedTab});return true;})()");
  await waitFor("document.querySelector('#encoding-title')?.textContent==='Text encoding'");
  assert.equal(await evaluate("document.querySelector('.encoding-confirm').textContent"), 'Use this encoding');
  await run(['press','Escape']);
  await waitFor("!document.querySelector('.encoding-dialog')");
  assert.deepEqual(await evaluate("(()=>{const t=window.__settingsStore.getState().getActiveTab();return {content:t.content,encoding:t.encoding,modified:t.modified};})()"),{content:'中文原文',encoding:'gb18030',modified:true});
  await evaluate("window.__settingsStore.getState().setEncodingDialog({mode:'save',tabId:window.__encodedTab});true");
  await waitFor("document.querySelector('.encoding-dialog')");
  assert.equal(await evaluate("document.querySelector('.encoding-modes button:last-child').disabled"),true);
  await run(['press','Escape']);
  await waitFor("!document.querySelector('.encoding-dialog')");
  console.log(JSON.stringify({livePreview:true,cancelRestores:true,saveAndReload:true,contentFontIndependent:true,encodingKeyboardAndSave:true,encodingLocalization:true,dirtyReopenProtected:true,widths,extreme},null,2));
} catch(error) {
  await run(['screenshot','test-output/settings-failure.png']).catch(()=>{});
  throw error;
} finally {
  await run(['close']);
}
