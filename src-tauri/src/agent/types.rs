use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum AgentBackendId {
    ClaudeCode,
    Codex,
    Opencode,
}

impl AgentBackendId {
    pub fn executable_name(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude",
            Self::Codex => "codex",
            Self::Opencode => "opencode",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::ClaudeCode => "Claude Code",
            Self::Codex => "Codex",
            Self::Opencode => "OpenCode",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentApprovalMode {
    #[default]
    Tiered,
    AllowAllSession,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentSessionStatus {
    Idle,
    Running,
    WaitingApproval,
    Completed,
    Interrupted,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCapabilities {
    pub streaming: bool,
    pub approvals: bool,
    pub session_resume: bool,
    pub model_override: bool,
    pub profile_override: bool,
    pub reasoning_effort: bool,
    pub file_context: bool,
}

impl AgentCapabilities {
    pub fn for_backend(backend: AgentBackendId) -> Self {
        Self {
            streaming: true,
            approvals: true,
            session_resume: true,
            model_override: true,
            profile_override: true,
            reasoning_effort: !matches!(backend, AgentBackendId::Opencode),
            file_context: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentBackendStatus {
    pub id: AgentBackendId,
    pub label: String,
    pub installed: bool,
    pub executable_path: Option<String>,
    pub version: Option<String>,
    pub compatible: bool,
    pub diagnostic: Option<String>,
    pub capabilities: AgentCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentModelOption {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub is_default: bool,
    pub default_reasoning_effort: Option<String>,
    #[serde(default)]
    pub supported_reasoning_efforts: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentModelCatalog {
    pub backend: AgentBackendId,
    pub current_model: Option<String>,
    pub models: Vec<AgentModelOption>,
    pub source: String,
    pub diagnostic: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSession {
    pub id: String,
    pub backend: AgentBackendId,
    pub workspace_root: String,
    pub worktree_path: Option<String>,
    pub backend_session_id: Option<String>,
    pub status: AgentSessionStatus,
    #[serde(default)]
    pub approval_mode: AgentApprovalMode,
    pub created_at: String,
    pub updated_at: String,
    pub last_error: Option<String>,
    pub has_changes: bool,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub direct_write: bool,
    pub base_commit: String,
    #[serde(default)]
    pub baseline_hashes: HashMap<String, Option<String>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StartAgentTurnRequest {
    pub backend: AgentBackendId,
    pub workspace_root: String,
    pub prompt: String,
    pub executable_path: Option<String>,
    pub model: Option<String>,
    pub profile: Option<String>,
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    pub context_paths: Vec<String>,
    pub editor_context: Option<AgentEditorContext>,
    #[serde(default)]
    pub approval_mode: AgentApprovalMode,
    #[serde(default)]
    pub read_only: bool,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentEditorContext {
    pub label: String,
    pub path: Option<String>,
    pub content: String,
    #[serde(default)]
    pub selection: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentApprovalRequest {
    pub id: String,
    pub session_id: String,
    pub turn_id: String,
    pub kind: String,
    pub title: String,
    pub detail: String,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub risk: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentFileChange {
    pub path: String,
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
    pub binary: bool,
    pub diff: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentChangeSet {
    pub session_id: String,
    pub files: Vec<AgentFileChange>,
    pub base_commit: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentEvent {
    pub session_id: String,
    pub turn_id: String,
    pub sequence: u64,
    pub kind: String,
    pub message: Option<String>,
    pub content: Option<String>,
    pub tool_name: Option<String>,
    pub approval: Option<AgentApprovalRequest>,
    pub payload: Option<Value>,
}

impl AgentEvent {
    pub fn simple(
        session_id: &str,
        turn_id: &str,
        sequence: u64,
        kind: &str,
        content: impl Into<String>,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            turn_id: turn_id.into(),
            sequence,
            kind: kind.into(),
            message: None,
            content: Some(content.into()),
            tool_name: None,
            approval: None,
            payload: None,
        }
    }
}
