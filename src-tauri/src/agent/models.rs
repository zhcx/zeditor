use super::{
    process,
    types::{AgentBackendId, AgentModelCatalog, AgentModelOption},
};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const MODEL_LIST_REQUEST_ID: u64 = 77;

pub async fn list_models(
    backend: AgentBackendId,
    executable: &Path,
    profile: Option<&str>,
    workspace_root: Option<&Path>,
) -> Result<AgentModelCatalog, String> {
    match backend {
        AgentBackendId::Codex => list_codex_models(executable, profile, workspace_root).await,
        AgentBackendId::ClaudeCode => list_claude_models(executable, workspace_root).await,
        AgentBackendId::Opencode => list_opencode_models(executable, workspace_root).await,
        AgentBackendId::Pi => list_pi_models(executable, workspace_root).await,
    }
}

/// pi 没有模型列表子命令，改用 RPC 的 `get_available_models` 查询。
async fn list_pi_models(
    executable: &Path,
    workspace_root: Option<&Path>,
) -> Result<AgentModelCatalog, String> {
    let mut command = process::tokio_executable_command(executable)?;
    command
        .args(["--mode", "rpc"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if let Some(root) = workspace_root.filter(|root| root.is_dir()) {
        command.current_dir(root);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("启动 Pi 失败：{error}"))?;
    let mut stdin = child.stdin.take().ok_or("无法写入 Pi")?;
    let stdout = child.stdout.take().ok_or("无法读取 Pi 输出")?;
    stdin
        .write_all(format!("{}\n", json!({"id": 1, "type": "get_available_models"})).as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    stdin.flush().await.map_err(|error| error.to_string())?;

    let result = tokio::time::timeout(Duration::from_secs(20), async {
        let mut lines = BufReader::new(stdout).lines();
        while let Some(line) = lines.next_line().await.map_err(|error| error.to_string())? {
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if value.get("id") != Some(&json!(1))
                || value.get("type").and_then(Value::as_str) != Some("response")
            {
                continue;
            }
            if value.get("success").and_then(Value::as_bool) == Some(false) {
                return Err(value
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("Pi 模型查询失败")
                    .to_string());
            }
            return parse_pi_catalog(value.pointer("/data/models").unwrap_or(&Value::Null));
        }
        Err("Pi 没有返回模型列表".into())
    })
    .await
    .map_err(|_| "读取 Pi 模型列表超时".to_string())?;
    let _ = child.kill().await;
    result
}

fn parse_pi_catalog(models: &Value) -> Result<AgentModelCatalog, String> {
    let entries = models.as_array().ok_or("Pi 返回了无法识别的模型列表")?;
    let models = entries
        .iter()
        .filter_map(|entry| {
            let id = entry.get("id").and_then(Value::as_str)?;
            let provider = entry
                .get("provider")
                .and_then(Value::as_str)
                .unwrap_or_default();
            Some(AgentModelOption {
                // pi 的 --model 接受 provider/id，这里沿用同一形式作为标识。
                id: if provider.is_empty() {
                    id.to_string()
                } else {
                    format!("{provider}/{id}")
                },
                display_name: entry
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(id)
                    .to_string(),
                description: entry
                    .get("api")
                    .and_then(Value::as_str)
                    .map(|api| format!("{provider} · {api}"))
                    .unwrap_or_else(|| provider.to_string()),
                is_default: false,
                default_reasoning_effort: None,
                supported_reasoning_efforts: if entry
                    .get("reasoning")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    // pi 的思考等级：off/minimal/low/medium/high/xhigh；
                    // 这里只暴露常用档位，与其它后端的选择器保持一致。
                    ["low", "medium", "high", "xhigh"]
                        .iter()
                        .map(|item| item.to_string())
                        .collect()
                } else {
                    Vec::new()
                },
            })
        })
        .collect::<Vec<_>>();
    Ok(AgentModelCatalog {
        backend: AgentBackendId::Pi,
        current_model: None,
        diagnostic: models
            .is_empty()
            .then(|| "Pi 没有返回可用模型，请先在 pi 中登录并配置 provider。".to_string()),
        models,
        source: "Pi RPC get_available_models".into(),
    })
}

async fn list_codex_models(
    executable: &Path,
    profile: Option<&str>,
    workspace_root: Option<&Path>,
) -> Result<AgentModelCatalog, String> {
    let mut command = process::tokio_executable_command(executable)?;
    if let Some(profile) = profile.filter(|value| !value.trim().is_empty()) {
        command.args(["--profile", profile]);
    }
    command
        .args(["app-server", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if let Some(root) = workspace_root.filter(|root| root.is_dir()) {
        command.current_dir(root);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("启动 Codex 模型服务失败：{error}"))?;
    let mut stdin = child.stdin.take().ok_or("无法写入 Codex 模型服务")?;
    let stdout = child.stdout.take().ok_or("无法读取 Codex 模型服务")?;
    stdin
        .write_all(
            format!(
                "{}\n",
                json!({
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "clientInfo": {"name": "zeditor", "title": "Zeditor", "version": env!("CARGO_PKG_VERSION")},
                        "capabilities": {"experimentalApi": true}
                    }
                })
            )
            .as_bytes(),
        )
        .await
        .map_err(|error| error.to_string())?;
    stdin.flush().await.map_err(|error| error.to_string())?;

    let result = tokio::time::timeout(Duration::from_secs(20), async {
        let mut lines = BufReader::new(stdout).lines();
        while let Some(line) = lines.next_line().await.map_err(|error| error.to_string())? {
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if value.get("id") == Some(&json!(1)) && value.get("result").is_some() {
                for message in [
                    json!({"method": "initialized", "params": {}}),
                    json!({"id": MODEL_LIST_REQUEST_ID, "method": "model/list", "params": {"limit": 100, "includeHidden": false}}),
                ] {
                    stdin
                        .write_all(format!("{message}\n").as_bytes())
                        .await
                        .map_err(|error| error.to_string())?;
                }
                stdin.flush().await.map_err(|error| error.to_string())?;
                continue;
            }
            if value.get("id") == Some(&json!(MODEL_LIST_REQUEST_ID)) {
                if let Some(error) = value.pointer("/error/message").and_then(Value::as_str) {
                    return Err(error.to_string());
                }
                return parse_codex_catalog(value.get("result").unwrap_or(&Value::Null));
            }
        }
        Err("Codex 模型服务已提前退出".into())
    })
    .await
    .map_err(|_| "读取 Codex 模型列表超时".to_string())?;
    let _ = child.kill().await;
    result
}

fn parse_codex_catalog(result: &Value) -> Result<AgentModelCatalog, String> {
    let entries = result
        .get("data")
        .and_then(Value::as_array)
        .ok_or("Codex 返回了无法识别的模型列表")?;
    let models = entries
        .iter()
        .filter(|entry| {
            !entry
                .get("hidden")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .filter_map(|entry| {
            let id = entry
                .get("model")
                .or_else(|| entry.get("id"))?
                .as_str()?
                .to_string();
            Some(AgentModelOption {
                id: id.clone(),
                display_name: entry
                    .get("displayName")
                    .and_then(Value::as_str)
                    .unwrap_or(&id)
                    .to_string(),
                description: entry
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                is_default: entry
                    .get("isDefault")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                default_reasoning_effort: entry
                    .get("defaultReasoningEffort")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                supported_reasoning_efforts: entry
                    .get("supportedReasoningEfforts")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|effort| {
                        effort
                            .get("reasoningEffort")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    })
                    .collect(),
            })
        })
        .collect::<Vec<_>>();
    let current_model = models
        .iter()
        .find(|model| model.is_default)
        .map(|model| model.id.clone());
    Ok(AgentModelCatalog {
        backend: AgentBackendId::Codex,
        current_model,
        models,
        source: "Codex app-server model/list".into(),
        diagnostic: None,
    })
}

async fn list_claude_models(
    executable: &Path,
    workspace_root: Option<&Path>,
) -> Result<AgentModelCatalog, String> {
    let output = run_output(executable, &["--help"], workspace_root).await?;
    let help = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let current_model = configured_model(AgentBackendId::ClaudeCode, workspace_root);
    let mut ids = Vec::new();
    if let Some(model) = current_model.as_deref() {
        ids.push(model.to_string());
    }
    for alias in ["sonnet", "opus", "fable"] {
        if help.contains(alias) && !ids.iter().any(|model| model == alias) {
            ids.push(alias.into());
        }
    }
    let models = ids
        .into_iter()
        .map(|id| AgentModelOption {
            display_name: title_case_model(&id),
            description: "Claude Code CLI 模型别名".into(),
            is_default: current_model.as_deref() == Some(&id),
            id,
            default_reasoning_effort: None,
            supported_reasoning_efforts: vec![
                "low".into(),
                "medium".into(),
                "high".into(),
                "xhigh".into(),
                "max".into(),
            ],
        })
        .collect();
    Ok(AgentModelCatalog {
        backend: AgentBackendId::ClaudeCode,
        current_model,
        models,
        source: "Claude Code CLI 配置与能力".into(),
        diagnostic: Some(
            "Claude Code CLI 未提供模型枚举接口，列表包含当前配置和 CLI 宣告的模型别名。".into(),
        ),
    })
}

async fn list_opencode_models(
    executable: &Path,
    workspace_root: Option<&Path>,
) -> Result<AgentModelCatalog, String> {
    let first = run_output(executable, &["models", "--format", "json"], workspace_root).await;
    let output = match first {
        Ok(output) if output.status.success() => output,
        _ => run_output(executable, &["models"], workspace_root).await?,
    };
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let stdout = strip_ansi(&String::from_utf8_lossy(&output.stdout));
    let mut ids = Vec::new();
    if let Ok(value) = serde_json::from_str::<Value>(&stdout) {
        collect_model_ids(&value, &mut ids);
    } else {
        ids.extend(stdout.lines().filter_map(|line| {
            let token = line.split_whitespace().next()?;
            (token.contains('/') && !token.starts_with("http")).then(|| token.to_string())
        }));
    }
    let current_model = configured_model(AgentBackendId::Opencode, workspace_root);
    if let Some(model) = current_model.as_deref() {
        ids.insert(0, model.to_string());
    }
    let mut seen = HashSet::new();
    ids.retain(|model| !model.is_empty() && seen.insert(model.clone()));
    let models = ids
        .into_iter()
        .map(|id| AgentModelOption {
            display_name: id.clone(),
            description: "OpenCode CLI 模型".into(),
            is_default: current_model.as_deref() == Some(&id),
            id,
            default_reasoning_effort: None,
            supported_reasoning_efforts: Vec::new(),
        })
        .collect::<Vec<_>>();
    Ok(AgentModelCatalog {
        backend: AgentBackendId::Opencode,
        current_model,
        diagnostic: models
            .is_empty()
            .then(|| "OpenCode CLI 没有返回可选模型，请在设置中手动填写 provider/model。".into()),
        models,
        source: "OpenCode CLI models".into(),
    })
}

async fn run_output(
    executable: &Path,
    args: &[&str],
    workspace_root: Option<&Path>,
) -> Result<std::process::Output, String> {
    let mut command = process::tokio_executable_command(executable)?;
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(root) = workspace_root.filter(|root| root.is_dir()) {
        command.current_dir(root);
    }
    tokio::time::timeout(Duration::from_secs(15), command.output())
        .await
        .map_err(|_| format!("{} 模型查询超时", executable.display()))?
        .map_err(|error| error.to_string())
}

fn configured_model(backend: AgentBackendId, workspace_root: Option<&Path>) -> Option<String> {
    let mut paths = Vec::new();
    // 跨平台家目录：Windows 用 USERPROFILE，Unix 用 HOME。
    // 此前仅读取 Windows 环境变量，macOS/Linux 上全局配置永远找不到。
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
    match backend {
        AgentBackendId::ClaudeCode => {
            if let Some(root) = workspace_root {
                paths.push(root.join(".claude").join("settings.local.json"));
                paths.push(root.join(".claude").join("settings.json"));
            }
            if let Some(profile) = home {
                paths.push(PathBuf::from(profile).join(".claude").join("settings.json"));
            }
        }
        AgentBackendId::Opencode => {
            if let Some(root) = workspace_root {
                paths.push(root.join("opencode.json"));
            }
            if let Some(profile) = home {
                paths.push(
                    PathBuf::from(profile)
                        .join(".config")
                        .join("opencode")
                        .join("opencode.json"),
                );
            }
            // XDG 配置目录（Linux 桌面常见）。
            if let Some(config) = std::env::var_os("XDG_CONFIG_HOME") {
                paths.push(PathBuf::from(config).join("opencode").join("opencode.json"));
            }
            if let Some(app_data) = std::env::var_os("APPDATA") {
                paths.push(
                    PathBuf::from(app_data)
                        .join("opencode")
                        .join("opencode.json"),
                );
            }
        }
        // Codex 从 app-server 读取，Pi 从 RPC 的 get_state 读取，都不依赖配置文件。
        AgentBackendId::Codex | AgentBackendId::Pi => return None,
    }
    paths.into_iter().find_map(|path| {
        let value = serde_json::from_slice::<Value>(&fs::read(path).ok()?).ok()?;
        value
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_string)
    })
}

fn collect_model_ids(value: &Value, output: &mut Vec<String>) {
    match value {
        Value::Array(items) => items
            .iter()
            .for_each(|item| collect_model_ids(item, output)),
        Value::Object(object) => {
            if let Some(id) = object
                .get("id")
                .or_else(|| object.get("model"))
                .or_else(|| object.get("modelID"))
                .and_then(Value::as_str)
            {
                output.push(id.to_string());
            } else {
                object
                    .values()
                    .for_each(|item| collect_model_ids(item, output));
            }
        }
        Value::String(id) if id.contains('/') => output.push(id.clone()),
        _ => {}
    }
}

/// 清除 ANSI 转义序列（CSI 与 OSC 序列）。
/// agent 模块共用此实现（mod.rs 的 visible_agent_stderr 同样使用），
/// 避免两份实现漂移。
pub(crate) fn strip_ansi(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars();
    while let Some(character) = chars.next() {
        if character != '\u{1b}' {
            output.push(character);
            continue;
        }
        if chars.next() == Some('[') {
            for next in chars.by_ref() {
                if ('@'..='~').contains(&next) {
                    break;
                }
            }
        }
    }
    output
}

fn title_case_model(model: &str) -> String {
    let mut characters = model.chars();
    match characters.next() {
        Some(first) => first.to_uppercase().collect::<String>() + characters.as_str(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_codex_model_metadata() {
        let catalog = parse_codex_catalog(&json!({"data": [{
            "id": "gpt-test",
            "model": "gpt-test",
            "displayName": "GPT Test",
            "description": "Test model",
            "hidden": false,
            "isDefault": true,
            "defaultReasoningEffort": "medium",
            "supportedReasoningEfforts": [{"reasoningEffort": "low"}, {"reasoningEffort": "medium"}]
        }]}))
        .unwrap();
        assert_eq!(catalog.current_model.as_deref(), Some("gpt-test"));
        assert_eq!(
            catalog.models[0].supported_reasoning_efforts,
            ["low", "medium"]
        );
    }

    #[test]
    fn parses_nested_opencode_model_output() {
        let mut models = Vec::new();
        collect_model_ids(
            &json!({"openai": [{"id": "openai/gpt-test"}], "anthropic": ["anthropic/test"]}),
            &mut models,
        );
        models.sort();
        assert_eq!(models, ["anthropic/test", "openai/gpt-test"]);
    }
}
