import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const browserBin = process.env.AGENT_BROWSER_BIN || (process.platform === 'win32'
  ? join(process.env.APPDATA || '', 'npm/node_modules/agent-browser/bin/agent-browser-win32-x64.exe')
  : 'agent-browser');
const session = 'zeditor-ui-verification';
const url = process.argv[2] || 'http://127.0.0.1:1425';
const edge = process.platform === 'win32' ? join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe') : '';

// 使用独立会话和内存中的示例文档验证，不读取真实文件或用户资料。
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
      if (code !== 0) reject(new Error(errors || output));
      else resolve(output.trim());
    });
  });
}
const evaluate = async script => JSON.parse(await run(['eval', '-b', Buffer.from(script).toString('base64')]));
const waitFor = async expression => evaluate(`(async () => {
  for (let i=0;i<200;i++) { if (${expression}) return true; await new Promise(resolve=>setTimeout(resolve,25)); }
  throw new Error('界面状态未按预期更新：' + ${JSON.stringify(expression)});
})()`);
const sampleDoc = [
  '# 把想法写成文章', '', '清晰的写作空间，让注意力回到内容本身。', '',
  '## 今天的安排', '', '- [x] 收集灵感与参考资料', '- [ ] 整理文章大纲', '- [ ] 写下第一段内容', '',
  '## 让文字更好读', '', '好的排版，让阅读自然地发生。用简洁的句子表达想法，在段落之间保留适当的呼吸感。', '',
  '> 从一个小想法开始，把它慢慢写完整。', '', '### 一个简单的计划', '',
  '| 时间 | 内容 | 状态 |', '| --- | --- | --- |', '| 上午 | 整理思路 | 已完成 |', '| 下午 | 专注写作 | 进行中 |', '',
  '```javascript', 'const ideas = ["观察", "思考", "表达"];', 'ideas.forEach(idea => console.log(idea));', '```', '',
].join('\n');

try {
  await mkdir('test-output', { recursive: true });
  await run([...(edge && existsSync(edge) ? ['--executable-path', edge] : []), 'open', url]);
  await run(['set', 'viewport', '1440', '900']);
  await waitFor("document.querySelector('.open-editor-row')");
  await evaluate(`(async () => {
    const source=await(await fetch('/src/App.tsx')).text();
    const {useAppStore}=await import(source.match(/from ["']([^"']*appStore[.]ts[^"']*)["']/)[1]);
    window.__uiStore=useAppStore;
    const state=useAppStore.getState();
    state.setSettings({...state.settings,appearance:{...state.settings.appearance,theme:'vscode-dark',language:'zh-CN'},editor:{...state.settings.editor,pin_toolbar:true}});
    window.__plan=state.addTab({title:'写作计划.md',path:'web://demo/写作计划.md',content:${JSON.stringify(sampleDoc)}});
    window.__ideas=state.addTab({title:'灵感记录.md',content:'# 灵感记录'});
    state.setActiveTab(window.__plan);
    return true;
  })()`);
  await waitFor("window.__uiStore.getState().editorView?.getValue().includes('把想法写成文章')");
  await run(['screenshot', 'test-output/ui-after-dark.png']);

  await run(['press', 'Control+p']);
  await waitFor("document.activeElement?.matches('.document-switcher input')");
  assert.equal(await evaluate("(async()=>{const input=document.querySelector('.document-switcher input');const selected=input.getAttribute('aria-activedescendant');input.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',isComposing:true,bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}));await new Promise(resolve=>requestAnimationFrame(resolve));return !!document.querySelector('.document-switcher')&&input.getAttribute('aria-activedescendant')===selected;})()"), true, '输入法确认键不能提前切换文档');
  await run(['screenshot', 'test-output/ui-document-switcher.png']);
  await run(['press', 'Tab']);
  assert.equal(await evaluate("Boolean(document.activeElement?.closest('.document-switcher'))"), true);
  await run(['fill', '.document-switcher input', '灵感']);
  await waitFor("document.querySelectorAll('.document-switcher [role=option]').length===1");
  await run(['press', 'Enter']);
  await waitFor("window.__uiStore.getState().activeTabId===window.__ideas && !document.querySelector('.document-switcher')");

  await evaluate("document.querySelector('.editor-workspace-pane [role=tab][aria-selected=true]').focus();true");
  await run(['press', 'ArrowLeft']);
  assert.equal(await evaluate('window.__uiStore.getState().activeTabId===window.__plan'), true);
  await run(['press', 'End']);
  assert.equal(await evaluate('window.__uiStore.getState().activeTabId===window.__ideas'), true);
  await run(['press', 'Home']);
  assert.equal(await evaluate('window.__uiStore.getState().activeTabId===window.__uiStore.getState().tabs[0].id'), true);

  await evaluate("window.__uiStore.getState().setActiveTab(window.__plan);true");
  await waitFor("window.__uiStore.getState().editorView?.getValue().includes('把想法写成文章')");
  await run(['click', '[aria-label="隐藏格式工具栏"]']);
  await waitFor("!document.querySelector('.editor-pane-toolbar')");
  await evaluate("window.__uiStore.getState().editorView.setSelection(2,6);window.__uiStore.getState().editorView.focus();true");
  await waitFor("document.querySelector('.toolbar-floating .toolbar-left .toolbar-item')");
  assert.equal(await evaluate("(() => {const toolbar=document.querySelector('.toolbar-floating .toolbar-scroll-area');return toolbar.scrollWidth<=toolbar.clientWidth+1;})()"), true);
  await evaluate("window.__uiStore.getState().editorView.setSelection(6,6);true");
  await run(['click', '[aria-label="显示格式工具栏"]']);
  await waitFor("document.querySelector('.editor-pane-toolbar')");
  await evaluate("window.__uiStore.getState().setActiveTab(window.__plan);true");

  const widths = [];
  for (const width of [1440, 1100, 960, 900]) {
    await run(['set', 'viewport', String(width), '900']);
    await waitFor("document.querySelector('.editor-pane-toolbar .toolbar-scroll-area').scrollWidth <= document.querySelector('.editor-pane-toolbar .toolbar-scroll-area').clientWidth+1");
    const result = await evaluate(`(() => {
      const toolbar=document.querySelector('.editor-pane-toolbar .toolbar-scroll-area');
      return {viewport:innerWidth,toolbarWidth:toolbar.clientWidth,toolbarScrollWidth:toolbar.scrollWidth,
        pageWidth:document.documentElement.scrollWidth,statusWidth:document.querySelector('.statusbar').scrollWidth};
    })()`);
    assert.ok(result.pageWidth <= width + 1, `窗口 ${width}px 出现横向溢出`);
    assert.ok(result.statusWidth <= width + 1, `窗口 ${width}px 状态栏溢出`);
    widths.push(result);
  }
  await run(['screenshot', 'test-output/ui-narrow.png']);
  await run(['click', '.editor-pane-toolbar .toolbar-more-btn']);
  await waitFor("document.querySelector('.toolbar-overflow-menu')");
  await run(['press', 'Escape']);
  await waitFor("!document.querySelector('.toolbar-overflow-menu')");

  await run(['set', 'viewport', '1440', '900']);
  const themes = await evaluate(`(async () => {
    const {THEMES}=await import('/src/themes/index.ts');
    const results=[];
    for (const theme of THEMES) {
      const state=window.__uiStore.getState();
      state.setSettings({...state.settings,appearance:{...state.settings.appearance,theme:theme.id}});
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      results.push({id:theme.id,applied:document.documentElement.dataset.theme===theme.id,
        overflow:document.documentElement.scrollWidth>innerWidth+1});
    }
    return results;
  })()`);
  assert.equal(themes.length, 12);
  assert.ok(themes.every(theme => theme.applied && !theme.overflow));
  await evaluate("(() => {const state=window.__uiStore.getState();state.setSettings({...state.settings,appearance:{...state.settings.appearance,theme:'vscode-light'}});return true;})()");
  await waitFor("document.documentElement.dataset.theme==='vscode-light'");
  await run(['screenshot', 'test-output/ui-after-light.png']);
  await run(['click', '[aria-label="设置"]']);
  await waitFor("document.querySelector('.settings-panel')");
  await run(['screenshot', 'test-output/ui-settings.png']);
  await run(['click', '[aria-label="关闭设置"]']);

  await evaluate("window.__uiStore.getState().setMode('zen');true");
  await waitFor("document.querySelector('.zen-editor-pane')");
  await run(['press', 'Control+p']);
  await waitFor("document.querySelector('.document-switcher')");
  await run(['fill', '.document-switcher input', '没有这个文档']);
  await waitFor("document.querySelector('.document-switcher-empty')");
  await run(['press', 'Escape']);
  assert.equal(await evaluate("window.__uiStore.getState().mode"), 'zen');
  await evaluate("window.__uiStore.getState().setMode('split');window.__blank=window.__uiStore.getState().addTab();true");
  await waitFor("document.querySelector('.editor-empty-guide') && window.__uiStore.getState().editorView?.getValue()===''");
  await evaluate("window.__uiStore.getState().editorView.replaceRange(0,0,'第一笔文字');true");
  await waitFor("!document.querySelector('.editor-empty-guide') && document.querySelector('.status-save-state')?.dataset.state==='modified'");
  await evaluate("document.querySelector('.editor-workspace-pane [role=tab][aria-selected=true] .tab-close').focus();true");
  await run(['press', 'Enter']);
  await waitFor("document.querySelector('[role=alertdialog]')");
  await run(['press', 'Escape']);
  await waitFor("!document.querySelector('[role=alertdialog]') && window.__uiStore.getState().tabs.some(tab=>tab.id===window.__blank)");
  console.log(JSON.stringify({documentSwitcher:true,compositionSafe:true,tabKeyboardNavigation:true,toolbarToggle:true,floatingToolbar:true,escapeAndFocus:true,
    emptyGuideAndSaveState:true,keyboardCloseProtection:true,themes:themes.length,widths}, null, 2));
} catch (error) {
  await run(['screenshot', 'test-output/ui-failure.png']).catch(() => {});
  throw error;
} finally {
  await run(['close']);
}
