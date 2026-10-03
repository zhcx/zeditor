//! AI 助手未配置时的桥接层：用本机 Agent CLI 完成一次性文本任务。
//!
//! 与完整 Agent 会话（`spawn_turn`）不同，桥接调用不建会话、不建隔离工作区、
//! 不走审批与持久化——只启动一次 CLI，收集完整回答后立即退出，把固定开销
//! 压到 CLI 冷启动本身。所有任务以只读方式运行：Claude 用 plan 权限、
//! OpenCode 用只读配置、Codex 传 read_only；任何后端尝试执行工具都立即中止，
//! 桥接只做文本变换，不允许碰文件。

use super::{
    adapters,
    process,
    types::{AgentApprovalMode, AgentBackendId},
};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::time::timeout;

/// 一次性任务整体超时：覆盖 CLI 冷启动与模型推理，长文档校对也留足余量。
const QUICK_TURN_TIMEOUT: Duration = Duration::from_secs(150);
/// 提示词放在命令行参数里的后端受 Windows CreateProcess 32K 字符限制；
/// 超过阈值时跳过该候选，改试 stdin 型后端（Pi / Codex 走管道无此限制）。
const ARG_PROMPT_LIMIT_CHARS: usize = 20_000;

/// 桥接专用工作目录：刻意与用户主目录隔离，避免 CLI 加载用户项目配置
/// （模型覆盖、CLAUDE.md 等）改变回答行为，也避免触发目录信任询问。
fn bridge_cwd() -> PathBuf {
    let dir = std::env::temp_dir().join("zeditor-agent-bridge");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// 会话内后端记忆：记下最近一次成功的后端优先复用，跳过已知失败的后端，
/// 免得每次桥接都重走「候选依次失败」的链路拉长等待。
static LAST_GOOD_BACKEND: OnceLock<Mutex<Option<AgentBackendId>>> = OnceLock::new();
static BAD_BACKENDS: OnceLock<Mutex<Vec<AgentBackendId>>> = OnceLock::new();

fn backend_memory() -> (
    &'static Mutex<Option<AgentBackendId>>,
    &'static Mutex<Vec<AgentBackendId>>,
) {
    (
        LAST_GOOD_BACKEND.get_or_init(|| Mutex::new(None)),
        BAD_BACKENDS.get_or_init(|| Mutex::new(Vec::new())),
    )
}

/// 持久化设置文件路径（应用启动时注入）：用于读取每个后端的启用/停用状态。
static SETTINGS_PATH: OnceLock<PathBuf> = OnceLock::new();
static DISABLED_CACHE: OnceLock<Mutex<Option<(std::time::Instant, Vec<AgentBackendId>)>>> = OnceLock::new();

pub fn init_settings_path(path: PathBuf) {
    let _ = SETTINGS_PATH.set(path);
}

/// 读取持久化设置中被停用的后端（5 秒缓存；文件缺失或解析失败视为全部启用）。
fn disabled_backends() -> Vec<AgentBackendId> {
    let Some(path) = SETTINGS_PATH.get() else {
        return Vec::new();
    };
    {
        let cache = DISABLED_CACHE.get_or_init(|| Mutex::new(None));
        if let Ok(guard) = cache.lock() {
            if let Some((stamp, list)) = guard.as_ref() {
                if stamp.elapsed() < Duration::from_secs(5) {
                    return list.clone();
                }
            }
        }
    }
    let ids = [
        ("claude_code", AgentBackendId::ClaudeCode),
        ("codex", AgentBackendId::Codex),
        ("opencode", AgentBackendId::Opencode),
        ("pi", AgentBackendId::Pi),
    ];
    let list = std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| {
            let backends = value.pointer("/agent/backends")?;
            Some(
                ids.iter()
                    .filter(|(id, _)| {
                        backends.get(*id).and_then(|config| config.get("enabled")).and_then(Value::as_bool) == Some(false)
                    })
                    .map(|(_, backend)| *backend)
                    .collect::<Vec<_>>(),
            )
        })
        .unwrap_or_default();
    if let Ok(mut guard) = DISABLED_CACHE.get_or_init(|| Mutex::new(None)).lock() {
        *guard = Some((std::time::Instant::now(), list.clone()));
    }
    list
}

/// 按固定优先级列出本机已安装且未停用的 Agent CLI。`discover_executable`
/// 自带 30 秒 TTL 缓存，重复调用不产生进程开销。
fn discover_quick_backends() -> Vec<(AgentBackendId, PathBuf)> {
    // Pi 是 Zeditor 的主推后端，放候选首位。
    let disabled = disabled_backends();
    [
        AgentBackendId::Pi,
        AgentBackendId::ClaudeCode,
        AgentBackendId::Codex,
        AgentBackendId::Opencode,
    ]
    .into_iter()
    .filter(|backend| !disabled.contains(backend))
    .filter_map(|backend| {
        let path = process::discover_executable(backend.executable_name())?;
        Some((backend, path))
    })
    .collect()
}

/// 预热探测（供 `agent_probe_backend` 命令调用）：把首次使用的 CLI 版本与
/// 能力探测（两次子进程冷启动）挪到应用启动阶段后台执行，结果按 mtime 缓存，
/// 首次桥接调用即零探测等待。返回实际探测成功的后端标识。
pub async fn probe_any(
    backend: Option<AgentBackendId>,
    executable_path: Option<String>,
) -> Result<String, String> {
    let mut candidates: Vec<(AgentBackendId, PathBuf)> = match backend {
        Some(id) => {
            let path = match executable_path.filter(|value| !value.trim().is_empty()) {
                Some(value) => PathBuf::from(value),
                None => process::discover_executable(id.executable_name())
                    .ok_or_else(|| format!("未找到 {}", id.label()))?,
            };
            vec![(id, path)]
        }
        None => discover_quick_backends(),
    };
    if candidates.is_empty() {
        return Err("未找到可用的本地 Agent CLI（Claude Code / Codex / OpenCode / Pi）".into());
    }

    let mut last_error = String::new();
    for (id, path) in candidates.drain(..) {
        let path = match process::resolve_executable(path) {
            Ok(value) => value,
            Err(error) => {
                last_error = error;
                continue;
            }
        };
        let probe_path = path.clone();
        let result = tokio::task::spawn_blocking(move || super::ensure_backend_probed(&probe_path, id))
            .await
            .map_err(|error| error.to_string());
        match result {
            Ok(Ok(())) => return Ok(id.label().to_string()),
            Ok(Err(error)) => last_error = error,
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}

struct QuickCollector {
    text: String,
    final_text: Option<String>,
    finished: bool,
    error: Option<String>,
    tool_blocked: bool,
}

impl QuickCollector {
    fn new() -> Self {
        Self {
            text: String::new(),
            final_text: None,
            finished: false,
            error: None,
            tool_blocked: false,
        }
    }

    fn feed(&mut self, protocol: adapters::AdapterProtocol, value: &Value) {
        for raw in adapters::line_events(protocol, value) {
            match raw.kind {
                "message_delta" => {
                    self.text.push_str(raw.content.as_deref().unwrap_or_default());
                }
                "done" => {
                    self.finished = true;
                    if let Some(content) = raw.content.filter(|text| !text.trim().is_empty()) {
                        self.final_text = Some(content);
                    }
                }
                "error" => {
                    self.error
                        .get_or_insert_with(|| raw.content.unwrap_or_else(|| "Agent 执行失败".into()));
                }
                // 桥接任务只做文本变换：模型尝试调用工具说明任务失控，
                // 立即中止，避免在只读范围之外产生副作用。
                "tool_started" => {
                    self.tool_blocked = true;
                    self.finished = true;
                }
                _ => {}
            }
        }
    }

    fn result(self, backend: AgentBackendId) -> Result<String, String> {
        if self.tool_blocked {
            return Err(format!(
                "{} 在桥接任务中尝试执行工具，已中止；如需该能力请使用 Agent 面板",
                backend.label()
            ));
        }
        if let Some(error) = self.error {
            return Err(error);
        }
        let text = self.final_text.unwrap_or(self.text);
        if text.trim().is_empty() {
            return Err(format!("{} 未返回任何回答", backend.label()));
        }
        Ok(text)
    }
}

enum PromptChannel {
    /// 提示词作为命令行参数一次性传入（Claude / OpenCode）。
    Argument,
    /// 提示词经 stdin 下发（Pi 的 JSONL RPC）。
    StdinJson,
    /// Codex app-server：先 initialize + thread/start，收到 threadId 后
    /// 再补发 turn/start。
    Codex,
}

struct QuickTurn {
    backend: AgentBackendId,
    protocol: adapters::AdapterProtocol,
    command: Command,
    channel: PromptChannel,
}

/// 构建一次性调用命令。后端不适用（如提示词超长）时返回 `None`，由调用方
/// 换下一个候选。
fn build_quick_turn(backend: AgentBackendId, path: &Path, prompt: &str) -> Result<Option<QuickTurn>, String> {
    let cwd = bridge_cwd();
    let mut command = process::tokio_executable_command(path)?;
    command
        .current_dir(&cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let (protocol, channel, needs_stdin) = match backend {
        // Claude：与完整会话一致，提示词作为参数传入；plan 权限保证只读。
        // 不能加 `--input-format text`：那会让 CLI 把 stdin 当输入流等待
        // EOF，而桥接进程没有后续输入，只会无限挂起。
        AgentBackendId::ClaudeCode => {
            if prompt.chars().count() > ARG_PROMPT_LIMIT_CHARS {
                return Ok(None);
            }
            command.args([
                "-p",
                "--output-format",
                "stream-json",
                "--verbose",
                "--permission-mode",
                "plan",
            ]);
            command.arg(prompt);
            (adapters::AdapterProtocol::ClaudeJson, PromptChannel::Argument, false)
        }
        // Codex：app-server 常驻 stdin 协议。
        AgentBackendId::Codex => {
            command.args(["app-server", "--stdio"]);
            (adapters::AdapterProtocol::CodexAppServer, PromptChannel::Codex, true)
        }
        // OpenCode：`run --format json` 一次性执行，只读配置。
        AgentBackendId::Opencode => {
            if prompt.chars().count() > ARG_PROMPT_LIMIT_CHARS {
                return Ok(None);
            }
            command.args(["run", "--format", "json"]);
            command.arg(prompt);
            command.env(
                "OPENCODE_CONFIG_CONTENT",
                adapters::opencode_permissions(AgentApprovalMode::Tiered, true).to_string(),
            );
            (adapters::AdapterProtocol::OpenCodeJson, PromptChannel::Argument, false)
        }
        // Pi：RPC 模式，提示词经 stdin JSONL 下发，无长度限制。
        AgentBackendId::Pi => {
            command.args(["--mode", "rpc", "--no-approve"]);
            (adapters::AdapterProtocol::PiRpc, PromptChannel::StdinJson, true)
        }
    };
    command.stdin(if needs_stdin { Stdio::piped() } else { Stdio::null() });
    Ok(Some(QuickTurn { backend, protocol, command, channel }))
}

/// 用本机 Agent CLI 完成一次文本任务：按优先级找到可用后端 → 只读一次性
/// 调用 → 返回完整回答文本。AI 助手未配置时，`call_api_with_messages` 以此兜底。
pub async fn complete(prompt: &str) -> Result<String, String> {
    let mut candidates = discover_quick_backends();
    if candidates.is_empty() {
        return Err(
            "未检测到本地 Agent CLI。请在「设置 → AI 助手」启用 AI，或安装 Claude Code / Codex / OpenCode / Pi 任意一个命令行工具"
                .into(),
        );
    }

    // 后端记忆：上次成功的排最前，已知失败的直接剔除。
    let (last_good, bad_list) = backend_memory();
    if let Ok(guard) = last_good.lock() {
        if let Some(preferred) = *guard {
            candidates.sort_by_key(|(backend, _)| *backend != preferred);
        }
    }
    if let Ok(guard) = bad_list.lock() {
        candidates.retain(|(backend, _)| !guard.contains(backend));
    }
    if candidates.is_empty() {
        return Err("本机的 Agent CLI 均不可用（此前调用失败）。请检查各 CLI 的登录与模型配置，或改用 AI 助手".into());
    }

    let mut last_error = "没有可用的本地 Agent 后端".to_string();
    for (backend, path) in candidates {
        let path = match process::resolve_executable(path) {
            Ok(value) => value,
            Err(error) => {
                last_error = error;
                continue;
            }
        };
        // 首次使用某后端时做版本/能力探测（结果按 mtime 缓存；应用启动时的
        // 预热会让这里命中缓存零开销）。
        let probe_path = path.clone();
        let probed = tokio::task::spawn_blocking(move || super::ensure_backend_probed(&probe_path, backend))
            .await
            .map_err(|error| error.to_string())
            .and_then(|result| result);
        if let Err(error) = probed {
            last_error = error;
            mark_bad_backend(backend);
            continue;
        }

        let mut turn = match build_quick_turn(backend, &path, prompt) {
            Ok(Some(turn)) => turn,
            Ok(None) => {
                last_error = format!("提示词超出 {} 命令行长度限制", backend.label());
                mark_bad_backend(backend);
                continue;
            }
            Err(error) => {
                last_error = error;
                mark_bad_backend(backend);
                continue;
            }
        };
        match timeout(QUICK_TURN_TIMEOUT, run_quick_turn(&mut turn, prompt)).await {
            Ok(Ok(text)) => {
                if let Ok(mut guard) = last_good.lock() {
                    *guard = Some(backend);
                }
                return Ok(text);
            }
            Ok(Err(error)) => last_error = error,
            Err(_) => {
                last_error = format!(
                    "{} 桥接任务超时（{} 秒）",
                    backend.label(),
                    QUICK_TURN_TIMEOUT.as_secs()
                );
            }
        }
        mark_bad_backend(backend);
    }
    Err(last_error)
}

fn mark_bad_backend(backend: AgentBackendId) {
    if let Ok(mut guard) = backend_memory().1.lock() {
        if !guard.contains(&backend) {
            guard.push(backend);
        }
    }
}

async fn run_quick_turn(turn: &mut QuickTurn, prompt: &str) -> Result<String, String> {
    let mut child = turn
        .command
        .spawn()
        .map_err(|error| format!("启动 {} 失败：{error}", turn.backend.label()))?;
    let stdout = child.stdout.take().ok_or("无法读取 Agent 输出")?;
    // Argument 通道的后端（Claude / OpenCode）stdin 为 null，这里拿到 None。
    let mut stdin: Option<ChildStdin> = child.stdin.take();

    if let PromptChannel::Codex = turn.channel {
        let stdin = stdin.as_mut().ok_or("无法写入 Agent 输入")?;
        write_stdin(stdin, &adapters::codex_initialize()).await?;
        write_stdin(stdin, &adapters::codex_initialized()).await?;
        write_stdin(stdin, &adapters::codex_thread_start(bridge_cwd().as_path(), None)).await?;
    }
    if let PromptChannel::StdinJson = turn.channel {
        let stdin = stdin.as_mut().ok_or("无法写入 Agent 输入")?;
        write_stdin(stdin, &adapters::pi_prompt(prompt)).await?;
    }

    let collector = std::cell::RefCell::new(QuickCollector::new());
    let backend = turn.backend;
    let protocol = turn.protocol;
    let codex_prompt = prompt.to_string();
    let mut lines = BufReader::new(stdout).lines();

    loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(error) => return Err(format!("读取 {} 输出失败：{error}", backend.label())),
        };
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };

        // Codex：thread/start 的响应携带 threadId，捕获后补发 turn/start。
        if let PromptChannel::Codex = turn.channel {
            if let Some(thread_id) = adapters::extract_codex_thread_id(&value) {
                let request = adapters::codex_turn_start(adapters::CodexTurnConfig {
                    thread_id: &thread_id,
                    prompt: &codex_prompt,
                    cwd: bridge_cwd().as_path(),
                    model: None,
                    reasoning_effort: None,
                    context_paths: &[],
                    mode: AgentApprovalMode::Tiered,
                    read_only: true,
                });
                let stdin = stdin.as_mut().ok_or("无法写入 Agent 输入")?;
                write_stdin(stdin, &request).await?;
                continue;
            }
        }

        collector.borrow_mut().feed(protocol, &value);
        if collector.borrow().finished {
            break;
        }
    }

    let _ = child.kill().await;
    collector.into_inner().result(backend)
}

async fn write_stdin(stdin: &mut ChildStdin, value: &Value) -> Result<(), String> {
    stdin
        .write_all(value.to_string().as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    stdin
        .write_all(b"\n")
        .await
        .map_err(|error| error.to_string())?;
    stdin.flush().await.map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collector_prefers_done_content_over_deltas() {
        let mut collector = QuickCollector::new();
        collector.feed(
            adapters::AdapterProtocol::ClaudeJson,
            &serde_json::json!({
                "type": "stream_event",
                "event": { "delta": { "text": "你好" } }
            }),
        );
        collector.feed(
            adapters::AdapterProtocol::ClaudeJson,
            &serde_json::json!({ "type": "result", "is_error": false, "result": "完整回答" }),
        );
        assert_eq!(collector.result(AgentBackendId::ClaudeCode).unwrap(), "完整回答");
    }

    #[test]
    fn collector_accumulates_deltas_when_done_has_no_content() {
        let mut collector = QuickCollector::new();
        collector.feed(
            adapters::AdapterProtocol::PiRpc,
            &serde_json::json!({
                "type": "message_update",
                "assistantMessageEvent": { "type": "text_delta", "delta": "片段一" }
            }),
        );
        collector.feed(
            adapters::AdapterProtocol::PiRpc,
            &serde_json::json!({
                "type": "message_update",
                "assistantMessageEvent": { "type": "text_delta", "delta": "片段二" }
            }),
        );
        collector.feed(adapters::AdapterProtocol::PiRpc, &serde_json::json!({ "type": "agent_end" }));
        let text = collector.result(AgentBackendId::Pi).unwrap();
        assert_eq!(text, "片段一片段二");
    }

    #[test]
    fn collector_blocks_tool_use() {
        let mut collector = QuickCollector::new();
        collector.feed(
            adapters::AdapterProtocol::PiRpc,
            &serde_json::json!({ "type": "tool_execution_start", "toolName": "write", "args": {} }),
        );
        let error = collector.result(AgentBackendId::Pi).unwrap_err();
        assert!(error.contains("已中止"), "unexpected error: {error}");
    }

    #[test]
    fn collector_surfaces_error_event() {
        let mut collector = QuickCollector::new();
        collector.feed(
            adapters::AdapterProtocol::CodexAppServer,
            &serde_json::json!({ "method": "turn/completed", "params": { "turn": { "status": "failed", "error": { "message": "模型不可用" } } } }),
        );
        assert_eq!(collector.result(AgentBackendId::Codex).unwrap_err(), "模型不可用");
    }

    #[test]
    fn collector_rejects_empty_answer() {
        let collector = QuickCollector::new();
        assert!(collector.result(AgentBackendId::Opencode).is_err());
    }

    /// 真实调用本机 Agent CLI（消耗少量模型额度），验证桥接端到端可用。
    /// 运行：cargo test bridge -- --include-ignored
    #[tokio::test]
    #[ignore]
    async fn bridge_completes_via_local_cli() {
        let text = complete("请原样返回四个字：桥接成功。不要输出其他任何内容。").await.unwrap();
        assert!(text.contains("桥接成功"), "unexpected response: {text}");
    }
}
