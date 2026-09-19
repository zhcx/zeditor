// 在独立的 Vite 浏览器测试会话中通过 agent-browser eval -b 执行。
// 该脚本会替换当前测试标签页内容，不应在用户正在编辑的会话中运行。
(async () => {
  const { useAppStore } = await import('/src/stores/appStore.ts');
  const pause = () => new Promise(resolve => setTimeout(resolve, 50));
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const waitFor = async (predicate, message) => {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return;
      await pause();
    }
    throw new Error(message);
  };
  const editor = () => useAppStore.getState().editorView;
  const value = () => editor().getValue().replace(/\r\n/g, '\n');
  const reset = async (text) => {
    editor().replaceRange(0, editor().getValue().length, text);
    await pause();
  };
  const paste = async (html, text) => {
    const data = new DataTransfer();
    data.setData('text/html', html);
    data.setData('text/plain', text);
    editor().focus();
    document.querySelector('.monaco-host').dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: data, bubbles: true, cancelable: true,
    }));
    await pause();
  };
  const results = [];
  const settings = useAppStore.getState().settings;
  try {
    for (const input_engine of ['editContext', 'textarea']) {
      useAppStore.getState().setSettings({ ...settings, editor: { ...settings.editor, input_engine } });
      await pause();
      await reset('beforeAFTER');
      editor().setSelection(6);
      await paste('<h2>Title</h2><ul><li>item</li></ul>', 'Title item');
      assert(value() === 'before\n\n## Title\n\n- item\n\nAFTER', `${input_engine}: block paste`);
      editor().undo();
      await pause();
      assert(value() === 'beforeAFTER', `${input_engine}: undo paste`);
      editor().setSelection(6);
      await paste('<strong>bold</strong>', 'bold');
      assert(value() === 'before**bold**AFTER', `${input_engine}: inline paste`);
      await reset('');
      editor().setSelection(0);
      await paste('<p>&lt;div&gt;source&lt;/div&gt;</p>', '<div>source</div>');
      assert(value() === '<div>source</div>', `${input_engine}: HTML source passthrough`);
      results.push(`${input_engine}: rich paste and undo`);
    }

    await reset('- [ ] first\n* [X] second\n> + [ ] quote');
    await waitFor(() => document.querySelectorAll('article input.task-list-item-checkbox').length === 3, 'task rendering');
    for (let i = 0; i < 3; i++) {
      const checkbox = document.querySelectorAll('article input.task-list-item-checkbox')[i];
      assert(!checkbox.disabled, 'enabled preview checkbox');
      checkbox.click();
      await pause();
    }
    assert(value() === '- [x] first\n* [ ] second\n> + [x] quote', 'task source updates');
    editor().undo();
    await pause();
    assert(value() === '- [x] first\n* [ ] second\n> + [ ] quote', 'single task undo');
    results.push('task variants and undo');

    await reset('# First\n\n- [ ] task\n\n---\n## Second\n\n[Link](https://example.com)\n\n```mermaid\ngraph TD\nA-->B\n```');
    await waitFor(() => document.querySelector('article .mermaid-container svg text'), 'preview Mermaid labels');
    const labels = (selector) => Array.from(document.querySelectorAll(`${selector} svg text`)).map(node => node.textContent).join(' ');
    assert(labels('article .mermaid-container').includes('A') && labels('article .mermaid-container').includes('B'), 'preview node text');
    editor().focus();
    window.dispatchEvent(new Event('zeditor-presentation-request'));
    await waitFor(() => document.querySelector('.reveal.ready'), 'presentation initialization');
    assert(document.querySelectorAll('.reveal .slides > section').length === 2, 'slide count');
    assert(document.activeElement.closest('.presentation-overlay'), 'presentation focus');
    assert(document.querySelector('.presentation-overlay input').disabled, 'read-only presentation task');
    await waitFor(() => document.querySelector('.presentation-overlay .mermaid-container svg'), 'presentation Mermaid');
    assert(labels('.presentation-overlay .mermaid-container').includes('A') && labels('.presentation-overlay .mermaid-container').includes('B'), 'presentation node text');
    document.querySelector('.reveal .navigate-right').click();
    await waitFor(() => document.querySelector('.reveal section.present h2'), 'slide navigation');
    const originalOpen = window.open;
    let opened;
    try {
      window.open = (...args) => { opened = args; return null; };
      document.querySelector('.reveal section.present a').click();
      assert(opened?.[0] === 'https://example.com/', 'external link opens separately');
    } finally { window.open = originalOpen; }
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await waitFor(() => !document.querySelector('.presentation-overlay'), 'presentation exit');
    assert(!document.documentElement.classList.contains('reveal-full-page'), 'html cleanup');
    assert(!document.body.classList.contains('reveal-viewport'), 'body cleanup');
    window.dispatchEvent(new Event('zeditor-presentation-request'));
    await waitFor(() => document.querySelector('.reveal.ready'), 'presentation re-entry');
    document.querySelector('.presentation-exit-btn').click();
    await waitFor(() => !document.querySelector('.presentation-overlay'), 'exit button');
    results.push('presentation focus, Mermaid, navigation, links and cleanup');
    return results;
  } finally {
    useAppStore.getState().setSettings(settings);
  }
})()
