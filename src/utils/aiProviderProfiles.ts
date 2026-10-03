import type { AIProviderDefinition, AIProviderId, AIProviderProfile } from '../stores/appStore';

export function parseAIProviderProfiles(raw: string | null | undefined): Record<string, AIProviderProfile> {
  try {
    const parsed: unknown = JSON.parse(raw || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, AIProviderProfile>;
  } catch {
    return {};
  }
}

/**
 * 判断某个服务商是否算「已配置」。
 *
 * 判定依据（满足其一即可）：
 * 1. 在设置里填写了 API 密钥；
 * 2. 配置了与官方默认值不同的自定义接入点（例如「自定义 OpenAI 兼容」）；
 * 3. 免密钥的本地模型（Ollama）且用户在设置中主动选择了它——它没有密钥可探测，
 *    只有显式选择才算配置完成，避免它在列表里凭空出现。
 */
export function isAIProviderConfigured(
  provider: AIProviderDefinition,
  profile: AIProviderProfile | undefined,
  activeProvider?: AIProviderId,
): boolean {
  if (profile?.api_key?.trim()) return true;
  const endpoint = profile?.api_endpoint?.trim();
  if (endpoint && endpoint !== provider.endpoint) return true;
  return Boolean(provider.keyless) && provider.id === activeProvider;
}

/** 返回所有已配置的服务商，保持传入的官方定义顺序。 */
export function listConfiguredAIProviders(
  definitions: AIProviderDefinition[],
  profiles: Record<string, AIProviderProfile>,
  activeProvider?: AIProviderId,
): AIProviderDefinition[] {
  return definitions.filter((provider) =>
    isAIProviderConfigured(provider, profiles[provider.id], activeProvider),
  );
}

/**
 * 从候选值中挑出第一个「已配置」的服务商；都不可用时回退到列表首项，
 * 由调用方决定最终的兜底展示。
 */
export function resolveConfiguredAIProvider(
  configured: AIProviderDefinition[],
  candidates: Array<AIProviderId | undefined>,
): AIProviderId | undefined {
  const available = new Set(configured.map((provider) => provider.id));
  for (const candidate of candidates) {
    if (candidate && available.has(candidate)) return candidate;
  }
  return configured[0]?.id;
}
