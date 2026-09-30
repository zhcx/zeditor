use super::{
    process,
    types::{AgentApprovalMode, AgentBackendId},
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::process::Command;

pub struct AdapterLaunch {
    pub command: Command,
    pub protocol: AdapterProtocol,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdapterProtocol {
    ClaudeJson,
    CodexAppServer,
    OpenCodeJson,
    PiRpc,
}

pub struct AdapterLaunchConfig<'a> {
    pub backend: AgentBackendId,
    pub executable: &'a Path,
    pub cwd: &'a Path,
    pub prompt: &'a str,
    pub model: Option<&'a str>,
    pub profile: Option<&'a str>,
    pub reasoning_effort: Option<&'a str>,
    pub context_paths: &'a [PathBuf],
    pub approval_mode: AgentApprovalMode,
    pub read_only: bool,
    pub backend_session_id: Option<&'a str>,
    pub permission_bridge: Option<(&'a Path, &'a Path)>,
}

pub fn build_launch(config: AdapterLaunchConfig<'_>) -> Result<AdapterLaunch, String> {
    let AdapterLaunchConfig {
        backend,
        executable,
        cwd,
        prompt,
        model,
        profile,
        reasoning_effort,
        context_paths,
        approval_mode,
        read_only,
        backend_session_id,
        permission_bridge,
    } = config;
    let mut command = process::tokio_executable_command(executable)?;
    command
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let protocol = match backend {
        AgentBackendId::ClaudeCode => {
            command.args([
                "-p",
                "--output-format",
                "stream-json",
                "--input-format",
                "text",
                "--verbose",
            ]);
            command.args([
                "--permission-mode",
                if read_only {
                    "plan"
                } else if approval_mode == AgentApprovalMode::AllowAllSession {
                    "bypassPermissions"
                } else {
                    "manual"
                },
            ]);
            if let Some(value) = model.filter(|value| !value.is_empty()) {
                command.args(["--model", value]);
            }
            if let Some(value) = profile.filter(|value| !value.is_empty()) {
                command.args(["--agent", value]);
            }
            if let Some(value) = reasoning_effort.filter(|value| !value.is_empty()) {
                command.args(["--effort", value]);
            }
            if let Some(value) = backend_session_id.filter(|value| !value.is_empty()) {
                command.args(["--resume", value]);
            }
            if let Some((exe, request_dir)) = permission_bridge {
                let hook_command = format!(
                    "\"{}\" --agent-permission-hook \"{}\"",
                    exe.display(),
                    request_dir.display()
                );
                let settings = json!({
                    "hooks": {
                        "PreToolUse": [{
                            "matcher": "Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|WebSearch|mcp__.*",
                            "hooks": [{"type": "command", "command": hook_command, "timeout": 86400}]
                        }]
                    }
                });
                let settings_path = request_dir.join("claude-settings.json");
                std::fs::create_dir_all(request_dir)
                    .map_err(|error| format!("无法创建 Claude Code 审批配置目录：{error}"))?;
                std::fs::write(
                    &settings_path,
                    serde_json::to_vec(&settings).map_err(|error| error.to_string())?,
                )
                .map_err(|error| format!("无法写入 Claude Code 审批配置：{error}"))?;
                command.arg("--settings").arg(settings_path);
            }
            command.arg(prompt_with_context(prompt, cwd, context_paths));
            AdapterProtocol::ClaudeJson
        }
        AgentBackendId::Codex => {
            if let Some(value) = profile.filter(|value| !value.is_empty()) {
                command.args(["--profile", value]);
            }
            command.args(["app-server", "--stdio"]);
            AdapterProtocol::CodexAppServer
        }
        AgentBackendId::Opencode => {
            command.args(["run", "--format", "json"]);
            if let Some(value) = model.filter(|value| !value.is_empty()) {
                command.args(["--model", value]);
            }
            command.arg(prompt_with_context(prompt, cwd, context_paths));
            command.env(
                "OPENCODE_CONFIG_CONTENT",
                opencode_permissions(approval_mode, read_only).to_string(),
            );
            AdapterProtocol::OpenCodeJson
        }
        AgentBackendId::Pi => {
            // RPC 模式：提示词与模型/推理等级都通过 stdin JSONL 命令下发，
            // CLI 只负责把进程拉起来（见 mod.rs 的 pi 命令序列）。
            command.args(["--mode", "rpc"]);
            if let Some(value) = model.filter(|value| !value.is_empty()) {
                command.args(["--model", value]);
            }
            // 非交互模式下 pi 用「项目信任」决定是否加载项目上下文文件、
            // 扩展与技能。只读会话保持干净基线，其余加载项目资源。
            command.arg(if read_only {
                "--no-approve"
            } else {
                "--approve"
            });
            AdapterProtocol::PiRpc
        }
    };
    command.kill_on_drop(true);
    Ok(AdapterLaunch { command, protocol })
}

pub fn prompt_with_context(prompt: &str, cwd: &Path, context_paths: &[PathBuf]) -> String {
    if context_paths.is_empty() {
        return prompt.to_string();
    }
    let files = context_paths
        .iter()
        .map(|path| path.strip_prefix(cwd).unwrap_or(path).to_string_lossy())
        .map(|path| format!("- {path}"))
        .collect::<Vec<_>>()
        .join("\n");
    format!("{prompt}\n\nRelevant files selected by the user:\n{files}")
}

pub fn opencode_permissions(mode: AgentApprovalMode, read_only: bool) -> Value {
    let ask = if mode == AgentApprovalMode::AllowAllSession {
        "allow"
    } else {
        "ask"
    };
    json!({
        "permission": {
            "read": "allow",
            "edit": if read_only { "deny" } else { "allow" },
            "bash": if read_only { json!("deny") } else { json!({
                "*": ask,
                "git push*": "deny"
            }) },
            "webfetch": ask,
            "websearch": ask,
            "external_directory": "deny"
        }
    })
}

pub fn codex_initialize() -> Value {
    json!({"id": 1, "method": "initialize", "params": {
        "clientInfo": {"name": "zeditor", "title": "Zeditor", "version": env!("CARGO_PKG_VERSION")},
        "capabilities": {"experimentalApi": true}
    }})
}

pub fn codex_initialized() -> Value {
    json!({"method": "initialized", "params": {}})
}

pub fn codex_thread_start(cwd: &Path, model: Option<&str>) -> Value {
    let mut params = json!({"cwd": cwd, "ephemeral": false});
    if let Some(value) = model.filter(|value| !value.is_empty()) {
        params["model"] = json!(value);
    }
    json!({"id": 2, "method": "thread/start", "params": params})
}

pub fn codex_thread_resume(thread_id: &str) -> Value {
    json!({"id": 2, "method": "thread/resume", "params": {"threadId": thread_id}})
}

pub struct CodexTurnConfig<'a> {
    pub thread_id: &'a str,
    pub prompt: &'a str,
    pub cwd: &'a Path,
    pub model: Option<&'a str>,
    pub reasoning_effort: Option<&'a str>,
    pub context_paths: &'a [PathBuf],
    pub mode: AgentApprovalMode,
    pub read_only: bool,
}

pub fn codex_turn_start(config: CodexTurnConfig<'_>) -> Value {
    let CodexTurnConfig {
        thread_id,
        prompt,
        cwd,
        model,
        reasoning_effort,
        context_paths,
        mode,
        read_only,
    } = config;
    let mut input = vec![json!({"type": "text", "text": prompt})];
    input.extend(context_paths.iter().map(|path| {
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp") {
            json!({"type": "localImage", "path": path})
        } else {
            json!({
                "type": "mention",
                "name": path.file_name().and_then(|value| value.to_str()).unwrap_or("file"),
                "path": path,
            })
        }
    }));
    let mut params = json!({
        "threadId": thread_id,
        "input": input,
        "cwd": cwd,
        "runtimeWorkspaceRoots": [cwd],
        "approvalPolicy": if mode == AgentApprovalMode::AllowAllSession { "never" } else { "on-request" },
        "sandboxPolicy": if read_only {
            json!({"type": "readOnly", "networkAccess": mode == AgentApprovalMode::AllowAllSession})
        } else {
            json!({"type": "workspaceWrite", "writableRoots": [cwd], "networkAccess": mode == AgentApprovalMode::AllowAllSession})
        }
    });
    if let Some(value) = model.filter(|value| !value.is_empty()) {
        params["model"] = json!(value);
    }
    if let Some(value) = reasoning_effort.filter(|value| !value.is_empty()) {
        params["effort"] = json!(value);
    }
    json!({"id": 3, "method": "turn/start", "params": params})
}

pub fn codex_interrupt(thread_id: &str, turn_id: &str) -> Value {
    json!({"id": 90, "method": "turn/interrupt", "params": {"threadId": thread_id, "turnId": turn_id}})
}

pub fn codex_approval_response(request_id: &Value, decision: &str) -> Value {
    let mapped = match decision {
        "allow_once" => "accept",
        "allow_session_kind" | "allow_all_session" => "acceptForSession",
        _ => "decline",
    };
    json!({"id": request_id, "result": {"decision": mapped}})
}

// ── Pi（pi --mode rpc）─────────────────────────────────────────────
// 严格 JSONL：stdin 下发命令（可带 id），stdout 返回 response 与事件。

/// 发起一次提问。pi 在流式输出中要求显式 `streamingBehavior`，而 Zeditor
/// 每回合只发一条提示，因此无需携带该字段。
pub fn pi_prompt(message: &str) -> Value {
    json!({"type": "prompt", "message": message})
}

/// 查询会话状态：响应中的 `data.sessionFile` 用于后续回合恢复会话。
pub fn pi_get_state() -> Value {
    json!({"type": "get_state"})
}

pub fn pi_switch_session(session_path: &str) -> Value {
    json!({"type": "switch_session", "sessionPath": session_path})
}

pub fn pi_set_thinking_level(level: &str) -> Value {
    json!({"type": "set_thinking_level", "level": level})
}

pub fn pi_abort() -> Value {
    json!({"type": "abort"})
}

/// 扩展 UI 请求的响应。`select` 用 `value`/`cancelled`，`confirm` 用
/// `confirmed`，两者字段不同（见 Pi RPC 文档）。
pub fn pi_ui_response(id: &str, method: &str, allowed: bool, allow_value: Option<&str>) -> Value {
    match (method, allowed) {
        ("confirm", allowed) => {
            json!({"type": "extension_ui_response", "id": id, "confirmed": allowed})
        }
        ("select", true) => match allow_value {
            Some(value) => json!({"type": "extension_ui_response", "id": id, "value": value}),
            None => json!({"type": "extension_ui_response", "id": id, "cancelled": true}),
        },
        _ => json!({"type": "extension_ui_response", "id": id, "cancelled": true}),
    }
}

pub fn extract_codex_thread_id(value: &Value) -> Option<String> {
    value
        .get("result")?
        .get("thread")?
        .get("id")?
        .as_str()
        .map(str::to_string)
}

pub fn line_events(protocol: AdapterProtocol, value: &Value) -> Vec<RawAgentEvent> {
    match protocol {
        AdapterProtocol::ClaudeJson => claude_events(value),
        AdapterProtocol::CodexAppServer => codex_events(value),
        AdapterProtocol::OpenCodeJson => opencode_events(value),
        AdapterProtocol::PiRpc => pi_events(value),
    }
}

#[derive(Debug, Clone)]
pub struct RawAgentEvent {
    pub kind: &'static str,
    pub content: Option<String>,
    pub tool_name: Option<String>,
    pub approval: Option<RawApproval>,
    pub payload: Option<Value>,
    pub turn_id: Option<String>,
    pub backend_session_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RawApproval {
    pub backend_request_id: Value,
    pub kind: String,
    pub title: String,
    pub detail: String,
    pub command: Option<String>,
    pub cwd: Option<String>,
    /// Pi 扩展 UI 对话框方法（`select` / `confirm`），其它后端为 None。
    pub method: Option<String>,
    /// Pi `select` 的可选项，用于把「允许」映射回具体选项。
    pub options: Vec<String>,
}

fn event(kind: &'static str, content: impl Into<String>) -> RawAgentEvent {
    RawAgentEvent {
        kind,
        content: Some(content.into()),
        tool_name: None,
        approval: None,
        payload: None,
        turn_id: None,
        backend_session_id: None,
    }
}

fn claude_events(value: &Value) -> Vec<RawAgentEvent> {
    let event_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match event_type {
        "assistant" => value
            .pointer("/message/content")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|part| match part.get("type").and_then(Value::as_str) {
                Some("text") => Some(event("message_delta", part.get("text")?.as_str()?)),
                Some("tool_use") => Some(RawAgentEvent {
                    kind: "tool_started",
                    content: part.get("input").map(Value::to_string),
                    tool_name: part.get("name").and_then(Value::as_str).map(str::to_string),
                    approval: None,
                    payload: Some(part.clone()),
                    turn_id: None,
                    backend_session_id: None,
                }),
                _ => None,
            })
            .collect(),
        "stream_event" => {
            let delta = value
                .pointer("/event/delta/text")
                .and_then(Value::as_str)
                .or_else(|| {
                    value
                        .pointer("/event/delta/thinking")
                        .and_then(Value::as_str)
                });
            delta
                .map(|text| vec![event("message_delta", text)])
                .unwrap_or_default()
        }
        "result" => vec![RawAgentEvent {
            kind: if value
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                "error"
            } else {
                "done"
            },
            content: value
                .get("result")
                .and_then(Value::as_str)
                .map(str::to_string),
            tool_name: None,
            approval: None,
            payload: Some(value.clone()),
            turn_id: None,
            backend_session_id: value
                .get("session_id")
                .and_then(Value::as_str)
                .map(str::to_string),
        }],
        _ => Vec::new(),
    }
}

fn codex_events(value: &Value) -> Vec<RawAgentEvent> {
    let method = value
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let params = value.get("params").cloned().unwrap_or(Value::Null);
    let turn_id = params
        .get("turnId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            params
                .pointer("/turn/id")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    match method {
        "item/agentMessage/delta" => vec![RawAgentEvent {
            kind: "message_delta",
            content: params
                .get("delta")
                .and_then(Value::as_str)
                .map(str::to_string),
            tool_name: None,
            approval: None,
            payload: None,
            turn_id,
            backend_session_id: None,
        }],
        "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => vec![RawAgentEvent {
            kind: "reasoning_delta",
            content: params
                .get("delta")
                .and_then(Value::as_str)
                .map(str::to_string),
            tool_name: None,
            approval: None,
            payload: None,
            turn_id,
            backend_session_id: None,
        }],
        "turn/started" => vec![RawAgentEvent {
            kind: "status",
            content: Some("Codex 已开始处理".into()),
            tool_name: None,
            approval: None,
            payload: None,
            turn_id,
            backend_session_id: None,
        }],
        "item/started" | "item/completed" => {
            let item = params.get("item").unwrap_or(&Value::Null);
            let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
            if matches!(
                item_type,
                "userMessage" | "agentMessage" | "reasoning" | "error"
            ) {
                return Vec::new();
            }
            let content = item
                .get("command")
                .or_else(|| item.get("query"))
                .or_else(|| item.get("path"))
                .map(|value| {
                    value
                        .as_str()
                        .map(str::to_string)
                        .unwrap_or_else(|| value.to_string())
                });
            vec![RawAgentEvent {
                kind: if method == "item/started" {
                    "tool_started"
                } else {
                    "tool_completed"
                },
                content,
                tool_name: (!item_type.is_empty()).then(|| item_type.to_string()),
                approval: None,
                payload: Some(params),
                turn_id,
                backend_session_id: None,
            }]
        }
        "item/commandExecution/outputDelta" => vec![RawAgentEvent {
            kind: "command_output",
            content: params
                .get("delta")
                .and_then(Value::as_str)
                .map(str::to_string),
            tool_name: Some("command".into()),
            approval: None,
            payload: None,
            turn_id,
            backend_session_id: None,
        }],
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
            let command = params.get("command").map(|item| {
                if item.is_string() {
                    item.as_str().unwrap_or_default().into()
                } else {
                    item.to_string()
                }
            });
            vec![RawAgentEvent {
                kind: "approval_requested",
                content: None,
                tool_name: None,
                approval: Some(RawApproval {
                    backend_request_id: value.get("id").cloned().unwrap_or(Value::Null),
                    kind: if method.contains("commandExecution") {
                        "command".into()
                    } else {
                        "file_change".into()
                    },
                    title: if method.contains("commandExecution") {
                        "执行命令".into()
                    } else {
                        "应用文件修改".into()
                    },
                    detail: params
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or("Agent 请求授权")
                        .into(),
                    command,
                    cwd: params
                        .get("cwd")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    method: None,
                    options: Vec::new(),
                }),
                payload: Some(params),
                turn_id,
                backend_session_id: None,
            }]
        }
        "turn/completed" => {
            let status = params
                .pointer("/turn/status")
                .and_then(Value::as_str)
                .unwrap_or("completed");
            let error = params
                .pointer("/turn/error/message")
                .and_then(Value::as_str)
                .or_else(|| {
                    params
                        .pointer("/turn/error/additionalDetails")
                        .and_then(Value::as_str)
                });
            let kind = match status {
                "failed" => "error",
                "interrupted" => "interrupted",
                _ => "done",
            };
            vec![RawAgentEvent {
                kind,
                content: error.map(str::to_string),
                tool_name: None,
                approval: None,
                payload: Some(params),
                turn_id,
                backend_session_id: None,
            }]
        }
        "error" => {
            let message = params
                .get("message")
                .and_then(Value::as_str)
                .or_else(|| params.pointer("/error/message").and_then(Value::as_str))
                .or_else(|| {
                    params
                        .pointer("/error/additionalDetails")
                        .and_then(Value::as_str)
                })
                .unwrap_or("Codex 运行失败");
            if params
                .get("willRetry")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                vec![event("status", localize_codex_retry(message))]
            } else {
                vec![event("error", message)]
            }
        }
        _ => Vec::new(),
    }
}

fn localize_codex_retry(message: &str) -> String {
    let attempt = message.split_whitespace().find(|part| {
        part.contains('/') && part.chars().any(|character| character.is_ascii_digit())
    });
    match attempt {
        Some(attempt) => format!("连接暂时中断，正在重试（{attempt}）"),
        None => "连接暂时中断，正在重试".into(),
    }
}

fn opencode_events(value: &Value) -> Vec<RawAgentEvent> {
    let event_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let properties = value.get("properties").unwrap_or(value);
    let part = value.get("part").or_else(|| properties.get("part"));
    match event_type {
        "text" => vec![event(
            "message_delta",
            value
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )],
        "tool_use" | "tool" => vec![RawAgentEvent {
            kind: "tool_started",
            content: value.get("input").map(Value::to_string),
            tool_name: value
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string),
            approval: None,
            payload: Some(value.clone()),
            turn_id: None,
            backend_session_id: None,
        }],
        "message.part.updated" => properties
            .get("delta")
            .and_then(Value::as_str)
            .or_else(|| {
                part.and_then(|item| item.get("text"))
                    .and_then(Value::as_str)
            })
            .map(|text| vec![event("message_delta", text)])
            .unwrap_or_default(),
        "permission.asked" => vec![RawAgentEvent {
            kind: "approval_requested",
            content: None,
            tool_name: None,
            approval: Some(RawApproval {
                backend_request_id: properties.get("id").cloned().unwrap_or(Value::Null),
                kind: properties
                    .get("permission")
                    .and_then(Value::as_str)
                    .unwrap_or("other")
                    .into(),
                title: "OpenCode 权限请求".into(),
                detail: properties
                    .get("metadata")
                    .map(Value::to_string)
                    .unwrap_or_else(|| properties.to_string()),
                command: properties
                    .pointer("/metadata/command")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                cwd: None,
                method: None,
                options: Vec::new(),
            }),
            payload: Some(value.clone()),
            turn_id: None,
            backend_session_id: properties
                .get("sessionID")
                .and_then(Value::as_str)
                .map(str::to_string),
        }],
        "session.idle" | "result" => vec![RawAgentEvent {
            kind: "done",
            content: properties
                .get("text")
                .and_then(Value::as_str)
                .map(str::to_string),
            tool_name: None,
            approval: None,
            payload: Some(value.clone()),
            turn_id: None,
            backend_session_id: properties
                .get("sessionID")
                .and_then(Value::as_str)
                .map(str::to_string),
        }],
        "error" | "session.error" => vec![event("error", value.to_string())],
        _ => Vec::new(),
    }
}

/// Pi（`pi --mode rpc`）的 stdout JSONL：response 与事件（事件不带 id）。
fn pi_events(value: &Value) -> Vec<RawAgentEvent> {
    let event_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match event_type {
        "response" => pi_state_event(value).into_iter().collect(),
        "message_update" => {
            let assistant = value.get("assistantMessageEvent").unwrap_or(&Value::Null);
            let delta = assistant
                .get("delta")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty());
            match assistant
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
            {
                "text_delta" => delta
                    .map(|text| vec![event("message_delta", text)])
                    .unwrap_or_default(),
                "thinking_delta" => delta
                    .map(|text| vec![event("reasoning_delta", text)])
                    .unwrap_or_default(),
                _ => Vec::new(),
            }
        }
        // message_end 携带完整消息，但文本已由 text_delta 流式给出，
        // 再发一次会在时间线里重复。
        "tool_execution_start" | "tool_execution_end" => {
            let started = event_type == "tool_execution_start";
            vec![RawAgentEvent {
                kind: if started {
                    "tool_started"
                } else {
                    "tool_completed"
                },
                content: value
                    .get(if started { "args" } else { "result" })
                    .map(Value::to_string),
                tool_name: value
                    .get("toolName")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                approval: None,
                payload: Some(value.clone()),
                turn_id: None,
                backend_session_id: None,
            }]
        }
        "agent_start" => vec![event("status", "Pi 已开始处理")],
        "agent_end" => vec![RawAgentEvent {
            kind: "done",
            content: None,
            tool_name: None,
            approval: None,
            payload: Some(value.clone()),
            turn_id: None,
            backend_session_id: None,
        }],
        "compaction_start" => vec![event("status", "正在压缩上下文…")],
        "auto_retry_start" => vec![event("status", localize_pi_retry(value))],
        "extension_error" => vec![event(
            "error",
            value
                .get("message")
                .or_else(|| value.get("error"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| value.to_string()),
        )],
        "extension_ui_request" => pi_ui_approval(value).into_iter().collect(),
        _ => Vec::new(),
    }
}

/// `get_state` 响应只用于提取会话文件（后续回合据此 `switch_session` 恢复），
/// kind 置空后由 process_raw_event 跳过，不产生时间线条目。
fn pi_state_event(value: &Value) -> Option<RawAgentEvent> {
    if value.get("command").and_then(Value::as_str) != Some("get_state") {
        return None;
    }
    let session_file = value
        .pointer("/data/sessionFile")
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty())?;
    Some(RawAgentEvent {
        kind: "",
        content: None,
        tool_name: None,
        approval: None,
        payload: None,
        turn_id: None,
        backend_session_id: Some(session_file.to_string()),
    })
}

/// 扩展 UI 请求 → 审批卡片。仅接入阻塞式 `select` / `confirm`；其余方法
/// （notify/setStatus/setWidget/setTitle 等）为即发即忘，无需响应。
fn pi_ui_approval(value: &Value) -> Option<RawAgentEvent> {
    let method = value
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !matches!(method, "select" | "confirm") {
        return None;
    }
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())?;
    let options = value
        .get("options")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let detail = value
        .get("message")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| options.join(" / "));
    Some(RawAgentEvent {
        kind: "approval_requested",
        content: None,
        tool_name: None,
        approval: Some(RawApproval {
            backend_request_id: json!(id),
            kind: "other".into(),
            title: value
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("Pi 扩展请求")
                .to_string(),
            detail,
            command: None,
            cwd: None,
            method: Some(method.to_string()),
            options,
        }),
        payload: Some(value.clone()),
        turn_id: None,
        backend_session_id: None,
    })
}

fn localize_pi_retry(value: &Value) -> String {
    let attempt = value.get("attempt").and_then(Value::as_u64);
    let max = value.get("maxAttempts").and_then(Value::as_u64);
    match (attempt, max) {
        (Some(attempt), Some(max)) => format!("连接暂时中断，正在重试（{attempt}/{max}）"),
        _ => "连接暂时中断，正在重试".into(),
    }
}

/// `select` 的「允许」需要回填具体选项文本：优先匹配语义上的许可选项，
/// 无法识别时回退到第一项。
pub fn pi_allow_option(options: &[String]) -> Option<String> {
    const ALLOW_HINTS: [&str; 6] = ["allow", "approve", "yes", "ok", "允许", "批准"];
    options
        .iter()
        .find(|option| {
            let lowered = option.to_ascii_lowercase();
            ALLOW_HINTS.iter().any(|hint| lowered.contains(hint))
        })
        .or_else(|| options.first())
        .cloned()
}

pub fn backend_overrides(
    input: Option<HashMap<AgentBackendId, String>>,
) -> HashMap<AgentBackendId, PathBuf> {
    input
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(key, value)| (!value.trim().is_empty()).then(|| (key, PathBuf::from(value))))
        .collect()
}
