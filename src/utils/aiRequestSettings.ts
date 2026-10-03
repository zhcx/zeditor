import { AI_PROVIDER_DEFINITIONS, type AIProviderId } from '../stores/appStore';
import {
  isAIProviderConfigured,
  listConfiguredAIProviders,
  parseAIProviderProfiles,
  resolveConfiguredAIProvider,
} from './aiProviderProfiles';

/**
 * 后端只读取 AISettings 的顶层字段（provider / api_key / api_endpoint / model），
 * 并不解析 provider_profiles。因此前端必须把选定服务商的档案「摊平」到顶层，
 * 否则就会出现「用 A 的密钥去打 A 的默认端点」这类全部分块失败的请求。
 */
export interface AISettingsLike {
  provider: AIProviderId;
  api_key: string;
  api_endpoint: string;
  model: string;
  provider_api_keys: string;
  provider_profiles: string;
}

export interface AIProviderSelection {
  provider: AIProviderId;
  model?: string;
}

function readLegacyProviderKeys(ai: AISettingsLike): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(ai.provider_api_keys || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch { /* 旧数据损坏时按无密钥处理。 */ }
  return {};
}

/**
 * 解析真正应当使用的服务商：跳过没有配置凭据的默认服务商
 * （例如设置里 provider 仍是 openai、但只有 siliconflow 填了密钥）。
 */
export function pickConfiguredAIProvider(ai: AISettingsLike): AIProviderId | undefined {
  const profiles = parseAIProviderProfiles(ai.provider_profiles);
  return resolveConfiguredAIProvider(
    listConfiguredAIProviders(AI_PROVIDER_DEFINITIONS, profiles, ai.provider),
    [ai.provider],
  );
}

/**
 * 生成自洽的请求 settings：provider / api_key / api_endpoint / model 必须来自同一份档案。
 *
 * - 传入 `selection`（如聊天面板切换的服务商）时，若该服务商未配置则返回 undefined，
 *   由调用方提示「请先在设置中配置该 AI 服务商」；
 * - 不传 `selection`（校对、伴写等）时，自动落到已配置的服务商；
 *   若一个都没配置，原样返回，交给后端给出「未配置」的明确提示。
 */
export function resolveAIRequestSettings<T extends AISettingsLike>(
  ai: T,
  selection?: AIProviderSelection,
): T | undefined {
  const provider = selection?.provider ?? pickConfiguredAIProvider(ai);
  if (!provider) return selection ? undefined : ai;

  const definition = AI_PROVIDER_DEFINITIONS.find((item) => item.id === provider);
  if (!definition) return selection ? undefined : ai;

  const saved = parseAIProviderProfiles(ai.provider_profiles)[provider];
  const legacyKey = readLegacyProviderKeys(ai)[provider] || '';
  // 顶层字段描述的是 settings.ai.provider 所指的服务商，其他服务商只能取档案值。
  const topLevelApplies = provider === ai.provider;
  const profile = {
    api_key: (saved?.api_key || legacyKey || (topLevelApplies ? ai.api_key : '')).trim(),
    api_endpoint: saved?.api_endpoint || (topLevelApplies ? ai.api_endpoint : '') || definition.endpoint,
    model: saved?.model || (topLevelApplies ? ai.model : '') || definition.model,
    models: saved?.models,
  };

  const configured = isAIProviderConfigured(definition, profile, provider);
  if (!configured) return selection ? undefined : ai;

  return {
    ...ai,
    provider,
    api_key: profile.api_key,
    api_endpoint: profile.api_endpoint,
    model: selection?.model || profile.model,
  };
}
