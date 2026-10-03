import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  isAIProviderConfigured,
  listConfiguredAIProviders,
  parseAIProviderProfiles,
  resolveConfiguredAIProvider,
} from '../src/utils/aiProviderProfiles.ts';
import type { AIProviderDefinition, AIProviderProfile } from '../src/stores/appStore.ts';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/** 复刻 src/stores/appStore.ts 中的关键定义，避免测试直接加载应用运行时。 */
const definitions: AIProviderDefinition[] = [
  { id: 'openai', label: 'OpenAI', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'deepseek', label: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1', model: 'deepseek-chat', supportsThinking: true },
  { id: 'siliconflow', label: '硅基流动 (SiliconFlow)', endpoint: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen3-35B-A3B', supportsThinking: true },
  { id: 'ollama', label: 'Ollama（本地模型）', endpoint: 'http://localhost:11434/v1', model: 'qwen3:8b', keyless: true },
  { id: 'custom', label: '自定义 OpenAI 兼容', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
];

const definition = (id: string) => {
  const found = definitions.find((item) => item.id === id);
  assert.ok(found, `缺少服务商定义：${id}`);
  return found;
};

const profile = (patch: Partial<AIProviderProfile> = {}): AIProviderProfile => ({
  api_key: '',
  api_endpoint: '',
  model: '',
  ...patch,
});

test('parseAIProviderProfiles 对非法输入返回空对象', () => {
  assert.deepEqual(parseAIProviderProfiles(undefined), {});
  assert.deepEqual(parseAIProviderProfiles('not-json'), {});
  assert.deepEqual(parseAIProviderProfiles('[]'), {});
});

test('填写了 API 密钥的服务商才算已配置', () => {
  assert.equal(isAIProviderConfigured(definition('siliconflow'), profile({ api_key: 'sk-test' })), true);
  // 默认的 openai 没有密钥时不应被算作已配置
  assert.equal(isAIProviderConfigured(definition('openai'), profile()), false);
  // 只有空白字符等同于未填写
  assert.equal(isAIProviderConfigured(definition('openai'), profile({ api_key: '   ' })), false);
});

test('配置了自定义接入点也算已配置', () => {
  const custom = definition('custom');
  assert.equal(isAIProviderConfigured(custom, profile({ api_endpoint: 'https://my-proxy/v1' })), true);
  // 与官方默认值相同则不额外算作已配置
  assert.equal(isAIProviderConfigured(custom, profile({ api_endpoint: custom.endpoint })), false);
});

test('免密钥的本地模型仅在用户主动选择后才算已配置', () => {
  const ollama = definition('ollama');
  assert.equal(isAIProviderConfigured(ollama, profile(), 'ollama'), true);
  assert.equal(isAIProviderConfigured(ollama, profile(), 'siliconflow'), false);
});

test('只配置硅基流动时候选列表仅含硅基流动，不会混入未配置的 OpenAI', () => {
  const configured = listConfiguredAIProviders(
    definitions,
    { siliconflow: profile({ api_key: 'sk-sf', model: 'Qwen/Qwen3-35B-A3B' }) },
    'siliconflow',
  );
  assert.deepEqual(configured.map((item) => item.id), ['siliconflow']);
});

test('设置页默认服务商无密钥时不会被强行加入候选列表', () => {
  // provider 仍是默认的 openai，但只给 siliconflow 配了密钥
  const configured = listConfiguredAIProviders(definitions, { siliconflow: profile({ api_key: 'sk-sf' }) }, 'openai');
  assert.deepEqual(configured.map((item) => item.id), ['siliconflow']);
});

test('配置多个服务商时按官方顺序全部进入候选列表', () => {
  const configured = listConfiguredAIProviders(
    definitions,
    { siliconflow: profile({ api_key: 'sk-sf' }), deepseek: profile({ api_key: 'sk-ds' }) },
    'siliconflow',
  );
  assert.deepEqual(configured.map((item) => item.id), ['deepseek', 'siliconflow']);
});

test('解析服务商时跳过未配置的候选值', () => {
  const configured = listConfiguredAIProviders(definitions, { siliconflow: profile({ api_key: 'sk-sf' }) }, 'siliconflow');
  // 工作区里记忆的是未配置的 openai，应回退到已配置的硅基流动
  assert.equal(resolveConfiguredAIProvider(configured, ['openai', 'siliconflow']), 'siliconflow');
  assert.equal(resolveConfiguredAIProvider(configured, [undefined, 'openai']), 'siliconflow');
  assert.equal(resolveConfiguredAIProvider(configured, ['openai']), 'siliconflow');
});

test('没有任何已配置服务商时返回 undefined，交由调用方兜底', () => {
  assert.equal(resolveConfiguredAIProvider([], ['openai', 'siliconflow']), undefined);
});

test('AI 对话面板只列出已配置的服务商，且仅在多个时提供下拉菜单', () => {
  const panel = read('src/components/Chatbot/AIChatbotPanel.tsx');
  // 候选列表来自「已配置」过滤器，而不是把设置页默认服务商无条件塞进来
  assert.match(panel, /listConfiguredAIProviders\(AI_PROVIDER_DEFINITIONS, providerProfiles, settings\.ai\.provider\)/);
  // 旧的错误逻辑不应复现
  assert.doesNotMatch(panel, /provider\.id === settings\.ai\.provider \|\|/);
  // 初始选择按「工作区记忆 → 设置默认 → 已配置首个」依次回退
  assert.match(panel, /resolveProvider\(\[workspaceConfig\.provider, settings\.ai\.provider\]\)/);
  // 仅在候选多于一个时渲染服务商下拉菜单，否则退化为只读文本
  assert.match(panel, /const providerSelectable = availableProviders\.length > 1;/);
  assert.match(panel, /providerSelectable \? \(/);
  assert.match(panel, /chatbot-provider-static/);
});

test('校对与伴写请求在发送前摊平服务商凭据', () => {
  const store = read('src/stores/aiStore.ts');
  // 校对：原样下发 settings.ai 会让后端拿默认服务商的端点去打另一个服务商的密钥
  assert.match(store, /action: 'proofread',[\s\S]*?settings: resolveAIRequestSettings\(settings\.ai\) \?\? settings\.ai,/);
  // 伴写同理
  assert.match(store, /action: 'companion',[\s\S]*?settings: resolveAIRequestSettings\(settings\.ai\) \?\? settings\.ai,/);
  // 桌面端聊天同样走统一摊平逻辑
  assert.match(store, /resolveAIRequestSettings\(appSettings\.ai, selection\)/);
  // 旧的「仅在聊天内联解析档案」实现不应残留
  assert.doesNotMatch(store, /const profiles = parseAIProviderProfiles\(appSettings\.ai\.provider_profiles\)/);
});

test('校对分块失败时区分瞬时与确定性失败，并保留真实原因', () => {
  const client = read('src-tauri/src/ai/client.rs');
  // 分块结果必须区分瞬时 / 确定性失败，否则顺序回退永不触发
  assert.match(client, /enum ChunkOutcome \{\s*Items\(Vec<serde_json::Value>\),\s*Transient\(String\),\s*Fatal\(String\),\s*\}/);
  // 聚合错误必须带上游原因，否则 is_transient_ai_error 认不出 429/超时，
  // 顺序回退兜底永远不触发，且用户只看到无信息量的中文总结
  assert.match(client, /所有并发校对分块均失败（共 \{\} 个）：\{detail\}/);
  assert.match(client, /所有并发校对分块均失败（共 \{\} 个，均为可重试故障）：\{detail\}/);
  assert.match(client, /所有校对分块均失败（共 \{\} 个）：\{detail\}/);
  assert.match(client, /所有校对分块均失败（共 \{\} 个，均为可重试故障）：\{detail\}/);
  // 并发与顺序两条路径都要分别记录两类错误
  assert.match(client, /first_transient\.get_or_insert\(e\);/);
  assert.match(client, /first_fatal\.get_or_insert\(e\);/);
});

test('校对全部失败时不得伪装成「未发现问题」', () => {
  const client = read('src-tauri/src/ai/client.rs');
  // 只有「一块都没成功」才算失败：部分成功仍返回已有结果，避免用户重跑整篇
  assert.match(client, /if succeeded == 0 \{/);
  // 顺序回退全灭时必须上报错误，而不是回落到空数组
  assert.match(client, /Err\(error2\) => return Err\(error2\)/);
  assert.doesNotMatch(client, /sequential fallback also failed[\s\S]{0,200}Vec::new\(\)/);
  // 旧的吞掉瞬时故障、返回空结果的实现不应残留
  assert.doesNotMatch(client, /return Ok\(Vec::new\(\)\);\s*\}\s*return Err\(e\);/);
});

test('残留失效代理时自动降级为直连，并把真实原因透出', () => {
  const client = read('src-tauri/src/ai/client.rs');
  // 系统代理不可用时自动改走直连，避免所有 AI 请求都死在传输层
  assert.match(client, /static PREFER_DIRECT: AtomicBool = AtomicBool::new\(false\);/);
  assert.match(client, /static HTTP_CLIENT_DIRECT: OnceLock<Client> = OnceLock::new\(\);/);
  assert.match(client, /async fn try_direct_fallback\(/);
  assert.match(client, /PREFER_DIRECT\.store\(true, Ordering::Relaxed\);/);
  // 直连兜底客户端必须显式关闭代理
  assert.match(client, /builder = builder\.no_proxy\(\);/);
  // reqwest 只给「error sending request for url」，必须展开 source 链取出真实原因
  assert.match(client, /fn describe_transport_error\(error: &reqwest::Error\) -> String/);
  assert.match(client, /std::error::Error::source\(error\)/);
  // 传输层失败必须归类为瞬时故障，否则顺序回退与直连兜底都会被跳过
  assert.match(client, /"error sending request",/);
  // 拉取模型列表同样要具备兜底能力（该文件为 CRLF 换行，断言不依赖行尾）
  assert.match(client, /pub async fn fetch_models\(api_key: &str, api_endpoint: &str\) -> Result<Vec<String>, String>/);
  assert.match(client, /let mut candidates: Vec<\(Client, bool\)> = vec!\[\(primary, false\)\];/);
  assert.match(client, /请求模型列表失败: \{last_error\}/);
});

test('校对提速手段：提高并发、按需收敛、失败后才等待', () => {
  const client = read('src-tauri/src/ai/client.rs');
  // 并发上限提升到 8（分块数更少时按实际数量收敛，避免空转任务）
  assert.match(client, /const PROOFREAD_CONCURRENCY: usize = 8;/);
  assert.match(client, /PROOFREAD_CONCURRENCY\.min\(chunks\.len\(\)\.max\(1\)\)/);
  // 顺序回退仅在失败后等待，成功路径不再为每个分块固定付延迟
  assert.match(client, /if failed \{\s*sleep\(Duration::from_millis\(PROOFREAD_SEQUENTIAL_GAP_MS\)\)\.await;\s*\}/);
  // 连接池放宽到可容纳并发请求，避免反复 TLS 握手
  assert.match(client, /\.pool_max_idle_per_host\(PROOFREAD_CONCURRENCY \+ 4\)/);
  // max_tokens 改为 CJK 感知估算，避免中文分块被截断后白跑生成
  assert.match(client, /fn estimate_proofread_max_tokens\(content: &str\) -> u32/);
  assert.doesNotMatch(client, /content\.chars\(\)\.count\(\) \/ 6/);
});
