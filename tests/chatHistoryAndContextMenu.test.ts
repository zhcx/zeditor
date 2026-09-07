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
  assert.match(styles, /\.editor-context-submenu[\s\S]*left: calc\(100% - 2px\)/);
  assert.match(styles, /data-submenu-direction="left"[\s\S]*right: calc\(100% - 2px\)/);
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
