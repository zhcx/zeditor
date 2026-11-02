import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('stopping or leaving a chat cancels the backend stream', () => {
  const store = read('src/stores/aiStore.ts');

  assert.match(store, /invoke\('cancel_ai_chat', \{ requestId \}\)/);
  assert.match(store, /stopChatMessage: \(\) => \{\s*cancelActiveChatRequest\(\)/);
  assert.match(store, /newChatConversation: \(\) => \{\s*cancelActiveChatRequest\(\)/);
  assert.match(store, /selectChatConversation: \(conversationId\) => \{[\s\S]*?cancelActiveChatRequest\(\)/);
});

test('the streaming loop observes cancellation and the command is registered', () => {
  const client = read('src-tauri/src/ai/client.rs');
  const module = read('src-tauri/src/ai/mod.rs');
  const main = read('src-tauri/src/main.rs');

  assert.match(client, /tokio::select!\s*\{[\s\S]*?cancel\.changed\(\)/);
  assert.match(client, /if cancelled \{/);
  assert.match(module, /pub fn cancel_ai_chat\(request_id: String\) -> bool/);
  assert.match(main, /ai::cancel_ai_chat/);
});

test('an SSE [DONE] marker ends the loop instead of waiting for connection close', () => {
  const client = read('src-tauri/src/ai/client.rs');
  assert.match(client, /if data == "\[DONE\]"[\s\S]*?stream_finished = true;[\s\S]*?break;/);
  assert.match(client, /if stream_finished \{\s*break;/);
});
