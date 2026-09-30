import type { AgentBackendId } from '../types/agent';

const SUPPORTED_AGENT_BACKENDS = new Set<AgentBackendId>(['claude_code', 'codex', 'opencode', 'pi']);

export function normalizeAgentBackend(value: unknown): AgentBackendId {
  return typeof value === 'string' && SUPPORTED_AGENT_BACKENDS.has(value as AgentBackendId)
    ? value as AgentBackendId
    : 'claude_code';
}
