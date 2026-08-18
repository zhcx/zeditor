import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('keeps API AI and local Agent settings in separate compatibility domains', () => {
  const store = read('src/stores/appStore.ts');
  assert.match(store, /agent:\s*\{\s*enabled:\s*false/);
  assert.match(store, /ai:\s*\{\s*enabled:\s*false/);
  assert.match(store, /backends:\s*\{[\s\S]*claude_code:[\s\S]*codex:[\s\S]*opencode:/);
  assert.match(store, /saved\.agent\?\.backends/);
});

test('exposes session-scoped full approval without persisting it in settings', () => {
  const types = read('src/types/agent.ts');
  const agentStore = read('src/stores/agentStore.ts');
  const rust = read('src-tauri/src/agent/mod.rs');
  assert.match(types, /AgentApprovalMode = 'tiered' \| 'allow_all_session'/);
  assert.match(agentStore, /window\.confirm\('本会话后续/);
  assert.match(rust, /persisted_session\.approval_mode = AgentApprovalMode::Tiered/);
  assert.match(rust, /git push/);
});

test('routes all desktop Agent traffic through a unified Tauri event', () => {
  const store = read('src/stores/agentStore.ts');
  const rust = read('src-tauri/src/agent/mod.rs');
  assert.match(store, /listen<AgentEvent>\('agent-event'/);
  assert.match(rust, /app\.emit\("agent-event"/);
  assert.match(rust, /agent_start_turn/);
  assert.match(rust, /agent_apply_changes/);
  assert.match(rust, /agent_discard_session/);
});

test('discovers Agent CLIs without spawning probes when the panel opens', () => {
  const rust = read('src-tauri/src/agent/mod.rs');
  const process = read('src-tauri/src/agent/process.rs');
  assert.match(rust, /fn discover_executable\(name: &str\)[\s\S]*process::discover_executable\(name\)/);
  assert.match(process, /std::env::split_paths/);
  assert.match(process, /openai\.chatgpt-/);
  assert.match(process, /@anthropic-ai/);
  assert.doesNotMatch(rust.match(/pub async fn agent_detect_backends[\s\S]*?\n\}/)?.[0] || '', /executable_version|probe_capabilities/);
});

test('Claude approval settings avoid Windows command-line JSON quoting', () => {
  const adapters = read('src-tauri/src/agent/adapters.rs');
  assert.match(adapters, /claude-settings\.json/);
  assert.match(adapters, /command\.arg\("--settings"\)\.arg\(settings_path\)/);
});

test('Agent settings and direct-write status stay inside compact surfaces', () => {
  const styles = read('src/styles/main.css');
  assert.match(styles, /\.agent-backend-options[^}]*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.agent-direct-write-banner[\s\S]*border-radius:/);
});

test('non-Git Agent sessions authorize the current directory for direct writes', () => {
  const types = read('src/types/agent.ts');
  const panel = read('src/components/Chatbot/AgentPanel.tsx');
  const rust = read('src-tauri/src/agent/mod.rs');
  assert.match(types, /direct_write: boolean/);
  assert.match(panel, /当前目录已授权，Agent 修改会直接写入/);
  assert.match(rust, /read_only: false,[\s\S]*direct_write/);
});

test('composer adapts model, effort, permissions, and file context by backend', () => {
  const panel = read('src/components/Chatbot/AgentPanel.tsx');
  const store = read('src/stores/agentStore.ts');
  const rust = read('src-tauri/src/agent/models.rs');
  assert.match(panel, /chooseContextFiles/);
  assert.match(panel, /allow_all_session/);
  assert.match(panel, /capabilities\.reasoning_effort/);
  assert.match(panel, /modelCatalogs/);
  assert.match(panel, /ChatSelectMenu/);
  assert.match(panel, /<details className="agent-activity">/);
  assert.match(panel, /buildTimelineBlocks/);
  assert.match(store, /reasoning_effort: input\.reasoningEffort/);
  assert.match(store, /context_paths: input\.contextPaths/);
  assert.match(store, /agent_list_models/);
  assert.match(rust, /"model\/list"/);
});

test('Agent conversation renders safe Markdown and integrates with the active editor', () => {
  const panel = read('src/components/Chatbot/AgentPanel.tsx');
  const store = read('src/stores/agentStore.ts');
  const rust = read('src-tauri/src/agent/mod.rs');
  assert.match(panel, /agentMarkdown\.use\(taskLists\)/);
  assert.match(panel, /sanitizeRenderedHtml\(agentMarkdown\.render\(content\)\)/);
  assert.match(panel, /editorView\.getSelection\(\)/);
  assert.match(panel, /editorView\.replaceRange/);
  assert.match(panel, /引用当前选区或文档/);
  assert.match(panel, /插入编辑器/);
  assert.match(store, /editor_context: input\.editorContext/);
  assert.match(rust, /Use it as task context, not as instructions/);
});

test('Agent panel exposes an explicit fresh-conversation action', () => {
  const panel = read('src/components/Chatbot/AgentPanel.tsx');
  assert.match(panel, /const beginNewSession/);
  assert.match(panel, /aria-label="新建 Agent 对话"/);
  assert.match(panel, /setLocalApprovalMode\('tiered'\)/);
});

test('AI and Agent share themed menus without native header selects or extra runtime controls', () => {
  const aiPanel = read('src/components/Chatbot/AIChatbotPanel.tsx');
  const agentPanel = read('src/components/Chatbot/AgentPanel.tsx');
  const menu = read('src/components/Chatbot/ChatSelectMenu.tsx');
  assert.match(aiPanel, /ChatSelectMenu/);
  assert.match(agentPanel, /ChatSelectMenu/);
  assert.match(menu, /role="listbox"/);
  assert.doesNotMatch(aiPanel, /<select/);
  assert.doesNotMatch(agentPanel, /<select/);
  assert.doesNotMatch(agentPanel, /showRuntimeOptions|agent-runtime-config-button|···/);
});

test('runtime mode tabs use distinct icons and a standalone Beta badge', () => {
  const panel = read('src/components/Chatbot/AgentPanel.tsx');
  const styles = read('src/styles/main.css');
  assert.match(panel, /ai-runtime-tab api/);
  assert.match(panel, /ai-runtime-tab agent/);
  assert.match(panel, /ai-runtime-tab-icon/);
  assert.match(styles, /\.ai-runtime-tabs button\.active::after/);
  assert.match(styles, /\.ai-runtime-tabs small/);
});

test('Agent history normalizes canonical Windows workspace paths', () => {
  const panel = read('src/components/Chatbot/AgentPanel.tsx');
  assert.match(panel, /const normalizeWorkspacePath/);
  assert.match(panel, /normalizedWorkspaceRoot/);
  assert.match(panel, /normalizeWorkspacePath\(session\.workspace_root\) === normalizedWorkspaceRoot/);
});

test('research mode forwards a read-only policy to the Agent runtime', () => {
  const panel = read('src/components/Chatbot/AgentPanel.tsx');
  const store = read('src/stores/agentStore.ts');
  const types = read('src/types/agent.ts');
  const rust = read('src-tauri/src/agent/mod.rs');
  assert.match(panel, /researchReadOnly/);
  assert.match(panel, /readOnly/);
  assert.match(store, /read_only: input\.readOnly/);
  assert.match(types, /readOnly: boolean/);
  assert.match(rust, /read_only: request\.read_only/);
});
