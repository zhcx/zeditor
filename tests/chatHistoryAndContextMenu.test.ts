import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseAIProviderProfiles } from '../src/utils/aiProviderProfiles.ts';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('AI chat can create, persist, and reopen conversations from the history button', () => {
  const store = read('src/stores/aiStore.ts');
  const panel = read('src/components/Chatbot/AIChatbotPanel.tsx');
  assert.match(store, /zeditor\.ai-chat-history/);
  assert.match(store, /newChatConversation:/);
  assert.match(store, /selectChatConversation:/);
  assert.match(store, /chatbotConversations:/);
  assert.match(panel, /aria-label="新建 AI 对话"/);
  assert.match(panel, /aria-label="打开 AI 对话历史"/);
  assert.match(panel, /chatbot-history-popover/);
});

test('AI provider profile storage treats JSON null as an empty profile map', () => {
  const panel = read('src/components/Chatbot/AIChatbotPanel.tsx');
  assert.match(panel, /parseAIProviderProfiles\(settings\.ai\.provider_profiles\)/);
  assert.deepEqual(parseAIProviderProfiles('null'), {});
  assert.deepEqual(parseAIProviderProfiles('[]'), {});
  assert.deepEqual(parseAIProviderProfiles('{"openai":{"model":"gpt-test"}}'), { openai: { model: 'gpt-test' } });
  assert.deepEqual(parseAIProviderProfiles('{malformed'), {});
});

test('AI chat automatically tracks a removable current-document context', () => {
  const panel = read('src/components/Chatbot/AIChatbotPanel.tsx');
  const contextPanel = read('src/components/Chatbot/WorkspaceContextPanel.tsx');

  assert.match(panel, /buildAutomaticEditorContext/);
  assert.match(panel, /dismissedDocumentKeyRef/);
  assert.match(panel, /setLinkedDocument/);
  assert.match(panel, /activeTabId/);
  assert.match(contextPanel, /linkedDocument\.path/);
  assert.match(contextPanel, /startsWith\('current-'\)/);
});

test('AI assistant output uses the same separated editor insertion as Agent', () => {
  const panel = read('src/components/Chatbot/AIChatbotPanel.tsx');
  assert.match(panel, /const insertIntoEditor/);
  assert.match(panel, /formatAssistantInsertion/);
  assert.match(panel, /插入编辑器/);
});

test('AI actions never log settings, document content, or model responses', () => {
  const store = read('src/stores/aiStore.ts');
  assert.doesNotMatch(store, /console\.log\(/);
});

test('editor context menu exposes grouped editing, export, image, and file actions', () => {
  const editor = read('src/components/Editor/Editor.tsx');
  const menu = read('src/components/MenuBar/MenuBar.tsx');
  const commands = read('src-tauri/src/commands.rs');
  const styles = read('src/styles/workbench.css');
  assert.match(editor, /AI 润色/);
  assert.match(editor, /复制为/);
  assert.match(editor, /runContextMenuAction\('copyHtml'\)/);
  assert.match(editor, /const translateContextSelection = useCallback/);
  assert.match(editor, /await translateText\(selectedText\)/);
  assert.match(editor, /setTranslationVisible\(true, coords \? \{ x: coords\.left, y: coords\.bottom \} : undefined, original, translated\)/);
  assert.match(editor, /onClick=\{\(\) => void translateContextSelection\(\)\}[\s\S]*AI 翻译/);
  assert.match(editor, /const menuHeight = 660/);
  assert.match(styles, /\.editor-context-menu \{[\s\S]*max-height: calc\(100vh - 16px\);[\s\S]*overflow-y: auto/);
  assert.match(editor, /sanitizeRenderedHtml\(contextMenuMarkdown\.render\(selectedText\)\)/);
  assert.match(editor, /submenuDirection: x \+ menuWidth \+ submenuWidth \+ 4 <= window\.innerWidth \? 'right' : 'left'/);
  assert.match(editor, /粘贴为纯文本/);
  assert.match(editor, /导出 PDF/);
  assert.match(editor, /导出 Word/);
  assert.match(editor, /导出 HTML/);
  assert.match(editor, /插入图片/);
  assert.match(editor, /在文件夹中显示/);
  assert.match(menu, /zeditor-export-request/);
  assert.match(commands, /pub fn reveal_in_file_manager/);
  // 二级菜单挂到 body：内联会被主菜单的 overflow 裁剪并挤出横向滚动条
  assert.match(styles, /\.editor-context-submenu \{[\s\S]*position: fixed/);
  assert.match(editor, /createPortal\([\s\S]{0,400}?className="editor-context-submenu"/);
  assert.match(editor, /const left = direction === 'left'[\s\S]*rect\.left - width \+ 2/);
});

test('editor context menu groups actions by scenario and reuses toolbar formatting', () => {
  const editor = read('src/components/Editor/Editor.tsx');
  const styles = read('src/styles/workbench.css');

  // 二级菜单容器与通用组件
  assert.match(editor, /function ContextSubmenu\(\{ label, icon, direction, open, disabled, onToggle, onHover, children \}: ContextSubmenuProps\)/);
  assert.match(editor, /data-submenu-direction=\{direction\}/);
  assert.match(styles, /\.editor-context-menu-group,[\s\S]*\.editor-context-copy-as \{ position: relative; \}/);
  assert.match(styles, /\.editor-context-menu-group > button,/);

  // 剪贴板场景补上剪切与全选
  assert.match(editor, /runContextMenuAction\('cut'\)/);
  assert.match(editor, /runContextMenuAction\('selectAll'\)/);

  // 格式 / 标题子菜单：与浮动工具栏同源，直接作用于选区
  assert.match(editor, /label="格式" icon="format"/);
  assert.match(editor, /runContextWrap\('\*\*', '\*\*'\)/);
  assert.match(editor, /clearContextInlineFormatting/);
  assert.match(editor, /stripInlineFormatting\(selected\)/);
  assert.match(editor, /label="标题" icon="heading"/);
  assert.match(editor, /applyContextHeading\(level\)/);

  // 插入与表格子菜单：表格操作仅在光标位于表格内时启用
  assert.match(editor, /label="插入" icon="insert"/);
  // 每一行都有独立图标，不再出现共用一个「横线」图标的情况
  assert.match(editor, /name === 'cut'\)/);
  assert.match(editor, /name === 'format'\)/);
  assert.match(editor, /name === 'heading'\)/);
  assert.match(editor, /name === 'insert'\)/);
  assert.match(editor, /name === 'selectAll'\)/);
  assert.match(editor, /requestContextTable/);
  assert.match(editor, /window\.dispatchEvent\(new CustomEvent\('zeditor-insert-table'\)\)/);
  assert.match(editor, /label="表格" icon="table"/);
  assert.match(editor, /disabled=\{!contextMenu\.inTable\}/);
  assert.match(editor, /inTable: parseTableAt\(model\.getValue\(\), selection\.to\) !== null/);
  for (const action of ['row-above', 'row-below', 'row-delete', 'column-left', 'column-right', 'column-delete', 'align-left', 'align-center', 'align-right', 'format', 'table-delete']) {
    assert.match(editor, new RegExp(`runContextTableAction\\('${action}'\\)`), action);
  }

  // 菜单过高时按实际高度回夹，避免超出窗口底部
  assert.match(editor, /const maxTop = window\.innerHeight - element\.offsetHeight - 8/);

  // 右键位置不在选区内时先把光标移过去，表格菜单与格式化动作才对得上目标
  assert.match(editor, /editor\.getTargetAtClientPoint\(event\.clientX, event\.clientY\)/);
  assert.match(editor, /if \(clickedOffset !== null && \(current\.empty \|\| clickedOffset < current\.from \|\| clickedOffset > current\.to\)\) \{/);
  assert.match(editor, /controller\.setSelection\(clickedOffset\)/);

  // 打开菜单与点击菜单项都不让焦点离开编辑器，选中的文字不会掉高亮
  assert.match(editor, /event\.preventDefault\(\);\s*event\.stopPropagation\(\);/);
  assert.match(editor, /阻止默认行为让编辑器保持焦点，动作执行时选区仍然有效/);

  // 弹层挂在 body 上，指针跨越间隙时延迟收起，避免子菜单刚展开就消失
  assert.match(editor, /closeTimerRef\.current = window\.setTimeout\(\(\) => onHover\(false\), 160\)/);
  assert.match(editor, /onMouseEnter=\{cancelClose\}/);
  assert.match(editor, /onMouseLeave=\{scheduleClose\}/);
});

test('floating editor toolbar stays compact and Monaco uses the shared scrollbar width', () => {
  const editor = read('src/components/Editor/Editor.tsx');
  const layout = read('src/utils/editorLayout.ts');
  const styles = read('src/styles/workbench.css');
  assert.match(editor, /const width = Math\.min\(720,/);
  assert.match(editor, /overviewRulerLanes: 0/);
  assert.match(editor, /hideCursorInOverviewRuler: true/);
  assert.match(layout, /verticalScrollbarSize: 10/);
  assert.match(layout, /verticalSliderSize: 10/);
  assert.match(styles, /--ui-scrollbar-size: 10px/);
  assert.match(styles, /\.explorer-tree::-webkit-scrollbar-thumb/);
  assert.match(styles, /\.monaco-editor \.monaco-scrollable-element > \.scrollbar > \.slider[\s\S]*width: 6px !important/);
  assert.match(styles, /\.monaco-editor \.monaco-scrollable-element > \.scrollbar > \.slider[\s\S]*border-radius: 999px !important/);
  assert.match(styles, /\.monaco-editor \.decorationsOverviewRuler[\s\S]*display: none !important/);
});
