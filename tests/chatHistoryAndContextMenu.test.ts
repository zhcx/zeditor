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
  const contextMenu = read('src/components/Editor/EditorContextMenu.tsx');
  const menu = read('src/components/MenuBar/MenuBar.tsx');
  const commands = read('src-tauri/src/commands.rs');
  const styles = read('src/styles/workbench.css');
  assert.match(contextMenu, /AI 润色/);
  assert.match(contextMenu, /复制为/);
  assert.match(contextMenu, /runContextMenuAction\('copyHtml'\)/);
  assert.match(contextMenu, /const translateContextSelection = useCallback/);
  assert.match(contextMenu, /await translateText\(selectedText\)/);
  assert.match(contextMenu, /setTranslationVisible\(true, coords \? \{ x: coords\.left, y: coords\.bottom \} : undefined, original, translated\)/);
  assert.match(contextMenu, /onClick=\{\(\) => void translateContextSelection\(\)\}[\s\S]*AI 翻译/);
  // 纵向位置由菜单按实测高度夹紧；宿主不再用固定 660px 估算（小屏会把菜单顶到窗口上方）。
  assert.match(contextMenu, /window\.innerHeight - element\.offsetHeight - 8/);
  assert.doesNotMatch(editor, /const menuHeight = 660/);
  assert.match(styles, /\.editor-context-menu \{[\s\S]*max-height: calc\(100vh - 16px\);[\s\S]*overflow-y: auto/);
  assert.match(contextMenu, /sanitizeRenderedHtml\(contextMenuMarkdown\.render\(selectedText\)\)/);
  assert.match(editor, /submenuDirection: x \+ menuWidth \+ submenuWidth \+ 4 <= window\.innerWidth \? 'right' : 'left'/);
  assert.match(contextMenu, /粘贴为纯文本/);
  assert.match(contextMenu, /导出 PDF/);
  assert.match(contextMenu, /导出 Word/);
  assert.match(contextMenu, /导出 HTML/);
  assert.match(contextMenu, /插入图片/);
  assert.match(contextMenu, /在文件夹中显示/);
  assert.match(menu, /zeditor-export-request/);
  assert.match(commands, /pub fn reveal_in_file_manager/);
  // 二级菜单挂到 body：内联会被主菜单的 overflow 裁剪并挤出横向滚动条
  assert.match(styles, /\.editor-context-submenu \{[\s\S]*position: fixed/);
  assert.match(contextMenu, /createPortal\([\s\S]{0,400}?className="editor-context-submenu"/);
  assert.match(contextMenu, /const left = direction === 'left'[\s\S]*rect\.left - width \+ 2/);
});

test('editor context menu groups actions by scenario and reuses toolbar formatting', () => {
  // 菜单本身与两种编辑器共用（源码对照 / 所见即所得），宿主只负责算出打开位置；
  // 因此菜单断言读 EditorContextMenu，编辑器特有的定位断言仍读 Editor.tsx。
  const editor = read('src/components/Editor/Editor.tsx');
  const menu = read('src/components/Editor/EditorContextMenu.tsx');
  const styles = read('src/styles/workbench.css');

  // 二级菜单容器与通用组件
  assert.match(menu, /function ContextSubmenu\(\{ label, icon, direction, open, disabled, onToggle, onHover, children \}: ContextSubmenuProps\)/);
  assert.match(menu, /data-submenu-direction=\{direction\}/);
  assert.match(styles, /\.editor-context-menu-group,[\s\S]*\.editor-context-copy-as \{ position: relative; \}/);
  assert.match(styles, /\.editor-context-menu-group > button,/);

  // 剪贴板场景补上剪切与全选
  assert.match(menu, /runContextMenuAction\('cut'\)/);
  assert.match(menu, /runContextMenuAction\('selectAll'\)/);

  // 格式 / 标题子菜单：与浮动工具栏同源，直接作用于选区
  assert.match(menu, /label="格式" icon="format"/);
  assert.match(menu, /runContextWrap\('\*\*', '\*\*'\)/);
  assert.match(menu, /clearContextInlineFormatting/);
  assert.match(menu, /stripInlineFormatting\(selected\)/);
  assert.match(menu, /label="标题" icon="heading"/);
  assert.match(menu, /applyContextHeading\(level\)/);

  // 插入与表格子菜单：表格操作仅在光标位于表格内时启用
  assert.match(menu, /label="插入" icon="insert"/);
  // 每一行都有独立图标，不再出现共用一个「横线」图标的情况
  assert.match(menu, /name=\{ContextMenuIconNames\[name\]\}/);
  const iconMap = JSON.parse(menu.match(/const ContextMenuIconNames = (\{[^\n]+\}) as const/)![1]);
  assert.deepEqual(['cut', 'format', 'heading', 'insert', 'selectAll'].map(key => iconMap[key]), ['cut', 'sliders', 'heading', 'plus', 'selectAll']);
  assert.match(menu, /requestContextTable/);
  // 插入表格直接经控制器改文档（两种模式共用），不再依赖编辑器专有事件
  assert.match(menu, /const insertion = insertTable\(3, 3\)/);
  assert.match(menu, /label="表格" icon="table"/);
  assert.match(menu, /disabled=\{!state\.inTable\}/);
  // 表格子菜单本身始终可用：插入与结构操作分开，插入不受光标位置限制
  assert.doesNotMatch(menu, /label="表格" icon="table"[\s\S]{0,140}?disabled=\{/);
  assert.match(menu, /<span>插入 3 × 3 表格<\/span>/);
  assert.match(menu, /把光标放进表格即可使用行列与对齐操作/);
  assert.match(editor, /inTable: parseTableAt\(model\.getValue\(\), selection\.to\) !== null/);
  for (const action of ['row-above', 'row-below', 'row-delete', 'column-left', 'column-right', 'column-delete', 'align-left', 'align-center', 'align-right', 'format', 'table-delete']) {
    assert.match(menu, new RegExp(`runContextTableAction\\('${action}'\\)`), action);
  }

  // 菜单过高时按实际高度回夹，避免超出窗口底部
  assert.match(menu, /const maxTop = window\.innerHeight - element\.offsetHeight - 8/);

  // 右键位置不在选区内时先把光标移过去，表格菜单与格式化动作才对得上目标
  assert.match(editor, /editor\.getTargetAtClientPoint\(event\.clientX, event\.clientY\)/);
  assert.match(editor, /if \(clickedOffset !== null && \(current\.empty \|\| clickedOffset < current\.from \|\| clickedOffset > current\.to\)\) \{/);
  assert.match(editor, /controller\.setSelection\(clickedOffset\)/);

  // 打开菜单与点击菜单项都不让焦点离开编辑器，选中的文字不会掉高亮
  assert.match(menu, /event\.preventDefault\(\);\s*event\.stopPropagation\(\);/);
  assert.match(menu, /阻止默认行为让编辑器保持焦点，动作执行时选区仍然有效/);

  // 弹层挂在 body 上，指针跨越间隙时延迟收起，避免子菜单刚展开就消失
  assert.match(menu, /closeTimerRef\.current = window\.setTimeout\(\(\) => onHover\(false\), 160\)/);
  assert.match(menu, /onMouseEnter=\{cancelClose\}/);
  assert.match(menu, /onMouseLeave=\{scheduleClose\}/);
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
