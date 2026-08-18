export type AIRuntime = 'api' | 'agent';

export type AgentBackendId = 'claude_code' | 'codex' | 'opencode';
export type AgentApprovalMode = 'tiered' | 'allow_all_session';
export type AgentSessionStatus = 'idle' | 'running' | 'waiting_approval' | 'completed' | 'interrupted' | 'error';

export interface AgentBackendConfig {
  executable_path: string;
  model: string;
  profile: string;
  reasoning_effort: string;
}

export interface AgentSettings {
  enabled: boolean;
  backend: AgentBackendId;
  backends: Record<AgentBackendId, AgentBackendConfig>;
}

export interface AgentResearchOptions {
  readOnly: boolean;
}

export interface AgentCapabilities {
  streaming: boolean;
  approvals: boolean;
  session_resume: boolean;
  model_override: boolean;
  profile_override: boolean;
  reasoning_effort: boolean;
  file_context: boolean;
}

export interface AgentBackendStatus {
  id: AgentBackendId;
  label: string;
  installed: boolean;
  executable_path?: string;
  version?: string;
  compatible: boolean;
  diagnostic?: string;
  capabilities: AgentCapabilities;
}

export interface AgentModelOption {
  id: string;
  display_name: string;
  description: string;
  is_default: boolean;
  default_reasoning_effort?: string;
  supported_reasoning_efforts: string[];
}

export interface AgentModelCatalog {
  backend: AgentBackendId;
  current_model?: string;
  models: AgentModelOption[];
  source: string;
  diagnostic?: string;
}

export interface AgentEditorContext {
  label: string;
  path?: string;
  content: string;
  selection: boolean;
}

export interface AgentSession {
  id: string;
  backend: AgentBackendId;
  workspace_root: string;
  worktree_path?: string;
  backend_session_id?: string;
  status: AgentSessionStatus;
  approval_mode: AgentApprovalMode;
  created_at: string;
  updated_at: string;
  last_error?: string;
  has_changes: boolean;
  read_only: boolean;
  direct_write: boolean;
}

export type AgentApprovalDecision = 'allow_once' | 'allow_session_kind' | 'allow_all_session' | 'deny';

export interface AgentApprovalRequest {
  id: string;
  session_id: string;
  turn_id: string;
  kind: 'command' | 'network' | 'mcp' | 'external_directory' | 'file_change' | 'other';
  title: string;
  detail: string;
  command?: string;
  cwd?: string;
  risk?: string;
}

export interface AgentFileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'binary';
  additions: number;
  deletions: number;
  binary: boolean;
  diff?: string;
}

export interface AgentChangeSet {
  session_id: string;
  files: AgentFileChange[];
  base_commit: string;
}

export type AgentEventKind =
  | 'message_delta'
  | 'reasoning_delta'
  | 'status'
  | 'tool_started'
  | 'tool_completed'
  | 'command_output'
  | 'approval_requested'
  | 'approval_resolved'
  | 'file_changed'
  | 'usage'
  | 'done'
  | 'error';

export interface AgentEvent {
  session_id: string;
  turn_id: string;
  sequence: number;
  kind: AgentEventKind;
  message?: string;
  content?: string;
  tool_name?: string;
  approval?: AgentApprovalRequest;
  payload?: Record<string, unknown>;
}

export interface AgentTimelineItem {
  id: string;
  kind: AgentEventKind | 'user';
  content: string;
  tool_name?: string;
  sequence: number;
}
