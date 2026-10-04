import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// 使用独立的无头浏览器会话，不访问真实用户的文档或浏览器资料。
const url = process.argv[2] || 'http://127.0.0.1:1425';
const browserBin = process.env.AGENT_BROWSER_BIN || (process.platform === 'win32'
  ? join(process.env.APPDATA || '', 'npm/node_modules/agent-browser/bin/agent-browser-win32-x64.exe')
  : 'agent-browser');
const session = 'zeditor-performance';
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(browserBin, ['--session', session, ...args], { windowsHide: true });
    let output = '';
    let errors = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('浏览器命令超时')); }, 30_000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    // Windows 后台守护进程可能继承输出管道；按主命令退出结束，而不等待守护进程关闭管道。
    child.on('exit', code => {
      clearTimeout(timeout);
      child.stdout.destroy(); child.stderr.destroy();
      if (code !== 0) reject(new Error(errors || output || `浏览器命令失败：${code}`));
      else resolve(output.trim());
    });
  });
}
const edge = process.platform === 'win32'
  ? join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe')
  : '';
const launch = edge && existsSync(edge) ? ['--executable-path', edge] : [];
try {
  await run([...launch, 'open', url]);
  const script = `
    (async () => {
      const waitFor = async (check) => {
        for (let i = 0; i < 200; i++) {
          if (check()) return;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        throw new Error('等待界面状态超时：' + check.toString());
      };
      await waitFor(() => document.querySelector('.open-editor-row'));
      // Vite 热更新会给模块添加时间戳，必须复用页面实际加载的 store 实例。
      const appSource = await (await fetch('/src/App.tsx')).text();
      const storeUrl = appSource.match(/from ["']([^"']*\\/src\\/stores\\/appStore\\.ts[^"']*)["']/)?.[1];
      if (!storeUrl) throw new Error('未找到页面使用的应用状态模块');
      const { useAppStore } = await import(storeUrl);
      const store = useAppStore.getState();
      const dirty = store.addTab({title:'关闭保护测试', content:'未保存的文字', modified:true});
      await waitFor(() => document.querySelector('.open-editor-row.active')?.textContent.includes('关闭保护测试'));
      document.querySelector('.open-editor-row.active .explorer-close').click();
      await waitFor(() => !useAppStore.getState().tabs.some(tab => tab.id === dirty)
        || document.querySelector('[role="alertdialog"]'));
      const dirtyCloseProtected = useAppStore.getState().tabs.some(tab => tab.id === dirty)
        && Boolean(document.querySelector('[role="alertdialog"]'));
      document.querySelector('[aria-label="取消关闭标签页"]')?.click();
      await waitFor(() => !document.querySelector('[role="alertdialog"]'));
      useAppStore.getState().closeTab(dirty);
      const id = store.addTab({path:'web://performance/note.md',content:'# 性能测试'});
      await waitFor(() => useAppStore.getState().editorView?.getValue() === '# 性能测试');
      let historyWrites = 0;
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key === 'zeditor.explorer-history') historyWrites++;
        return original.call(this, key, value);
      };
      const durations = [];
      for (let i = 0; i < 20; i++) {
        const start = performance.now();
        useAppStore.getState().setContent('# 性能测试\\n' + '中文 English 👋\\n'.repeat(5000) + i);
        durations.push(performance.now() - start);
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      await waitFor(() => document.querySelector('.markdown-body')?.textContent.trimEnd().endsWith('19'));
      Storage.prototype.setItem = original;
      const result = {historyWrites, dirtyCloseProtected, edits:durations.length,
        averageStoreUpdateMs:durations.reduce((a,b)=>a+b,0)/durations.length,
        previewReady:document.querySelector('.markdown-body')?.textContent.includes('性能测试') || false,
        editorReady:Boolean(useAppStore.getState().editorView)};
      useAppStore.getState().closeTab(id);
      const editing = store.addTab({title:'编辑验证', content:'# 编辑验证'});
      await waitFor(() => useAppStore.getState().editorView?.getValue() === '# 编辑验证');
      useAppStore.getState().editorView.replaceRange(6, 6, '\\n- [ ] 测试任务');
      await waitFor(() => document.querySelector('.task-list-item-checkbox'));
      document.querySelector('.task-list-item-checkbox').click();
      await waitFor(() => useAppStore.getState().content.includes('[x]'));
      result.taskToggleWorks = true;
      const other = store.addTab({title:'另一个文档', content:'# 另一个文档'});
      await waitFor(() => useAppStore.getState().editorView?.getValue() === '# 另一个文档');
      useAppStore.getState().setActiveTab(editing);
      await waitFor(() => useAppStore.getState().editorView?.getValue().includes('[x]'));
      useAppStore.getState().editorView.undo();
      await waitFor(() => useAppStore.getState().content.includes('[ ]'));
      useAppStore.getState().editorView.redo();
      await waitFor(() => useAppStore.getState().content.includes('[x]'));
      result.undoSurvivesSwitch = true;
      useAppStore.getState().setMode('zen');
      await waitFor(() => document.querySelector('.zen-editor-pane') && useAppStore.getState().editorView);
      useAppStore.getState().setMode('immersive');
      await waitFor(() => document.querySelector('.immersive-preview') && !useAppStore.getState().editorView);
      useAppStore.getState().setMode('split');
      await waitFor(() => useAppStore.getState().editorView?.getValue().includes('[x]'));
      result.modeSwitchWorks = true;
      useAppStore.getState().closeTab(editing);
      useAppStore.getState().closeTab(other);
      return result;
    })()
  `;
  const result = JSON.parse(await run(['eval', '-b', Buffer.from(script).toString('base64')]));
  console.log(JSON.stringify(result, null, 2));
  assert.equal(result.historyWrites, 0, '输入时不应重新写入最近文件历史');
  assert.equal(result.previewReady, true, '大文档预览应最终同步');
  assert.equal(result.editorReady, true, '编辑器应在后台加载完成');
  assert.equal(result.dirtyCloseProtected, true, '资源管理器关闭未保存文档必须先确认');
  assert.equal(result.taskToggleWorks, true, '任务列表点击应同步写回源码');
  assert.equal(result.undoSurvivesSwitch, true, '切换文档后应保留撤销和重做历史');
  assert.equal(result.modeSwitchWorks, true, '分屏、写作和阅读模式之间应正常切换');
} finally {
  await run(['close']);
}
