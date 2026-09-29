//! zeditor_mcp_server：MCP server 二进制（stdio）。
//!
//! 架构（参考 VMark）：AI 助手 ←stdio(JSON-RPC)→ 本二进制
//! ←WebSocket(127.0.0.1 + 令牌)→ 运行中的 Zeditor 编辑器桥接。
//!
//! - 端口与令牌从 Zeditor 应用配置目录的 mcp_bridge.json 自动发现
//!   （--port / --token 可覆盖，用于诊断）。
//! - `--version` 打印版本；`--health-check` 连接桥接自测后退出。
//! - MCP 协议修订版 2025-03-26：initialize / ping / tools/list / tools/call。

#[path = "../mcp/protocol.rs"]
mod protocol;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_tungstenite::tungstenite::Message;

const CALL_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Serialize, Deserialize, Default)]
struct JsonRpcMessage {
    #[serde(default)]
    jsonrpc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    method: Option<String>,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<Value>,
}

struct BridgeClient {
    write_tx: mpsc::UnboundedSender<Message>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<protocol::BridgeFrame>>>>,
}

impl BridgeClient {
    async fn connect(port: u16, token: &str) -> Result<Self, String> {
        let url = format!("ws://127.0.0.1:{port}");
        let (ws, _) = tokio_tungstenite::connect_async(&url).await.map_err(|e| {
            format!(
                "无法连接 Zeditor 桥接（{url}）：{e}（请确认 Zeditor 已启动且 MCP 服务器已启用）"
            )
        })?;
        let (mut writer, mut reader) = ws.split();
        let (write_tx, mut write_rx) = mpsc::unbounded_channel::<Message>();
        let pending: Arc<Mutex<HashMap<String, oneshot::Sender<protocol::BridgeFrame>>>> =
            Arc::new(Mutex::new(HashMap::new()));

        // 握手：Hello 认证（单帧应答，失败即退出）。
        let hello = serde_json::to_string(&protocol::BridgeFrame::Hello {
            token: token.to_string(),
        })
        .map_err(|e| e.to_string())?;
        write_tx
            .send(Message::Text(hello))
            .map_err(|_| "桥接写入通道已关闭")?;
        match reader.next().await {
            Some(Ok(Message::Text(text))) => {
                match serde_json::from_str::<protocol::BridgeFrame>(&text) {
                    Ok(protocol::BridgeFrame::HelloOk { version }) => {
                        eprintln!("zeditor_mcp_server: connected to Zeditor {version}");
                    }
                    Ok(protocol::BridgeFrame::Error { message }) => {
                        return Err(format!("桥接认证失败：{message}"));
                    }
                    _ => return Err("桥接握手响应异常".to_string()),
                }
            }
            _ => return Err("桥接连接在握手期间断开".to_string()),
        }

        // 写出任务。
        tokio::spawn(async move {
            while let Some(message) = write_rx.recv().await {
                if writer.send(message).await.is_err() {
                    break;
                }
            }
            let _ = writer.close().await;
        });

        // 读入任务：按 id 分发 Result 帧。
        let pending_reader = pending.clone();
        tokio::spawn(async move {
            while let Some(Ok(Message::Text(text))) = reader.next().await {
                let Ok(frame) = serde_json::from_str::<protocol::BridgeFrame>(&text) else {
                    continue;
                };
                if let protocol::BridgeFrame::Result { id, .. } = &frame {
                    if let Some(sender) = pending_reader.lock().await.remove(id) {
                        let _ = sender.send(frame);
                    }
                }
            }
        });

        Ok(Self { write_tx, pending })
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, Value> {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel::<protocol::BridgeFrame>();
        self.pending.lock().await.insert(id.clone(), tx);
        let frame = protocol::BridgeFrame::Call {
            id: id.clone(),
            method: method.to_string(),
            params,
        };
        let text = serde_json::to_string(&frame)
            .map_err(|e| json!({ "error": "INTERNAL", "message": e.to_string() }))?;
        if self.write_tx.send(Message::Text(text)).is_err() {
            self.pending.lock().await.remove(&id);
            return Err(json!({ "error": "BRIDGE_LOST", "message": "桥接连接已断开" }));
        }
        match tokio::time::timeout(CALL_TIMEOUT, rx).await {
            Ok(Ok(protocol::BridgeFrame::Result {
                result: Some(value),
                ..
            })) => Ok(value),
            Ok(Ok(protocol::BridgeFrame::Result {
                error: Some(error), ..
            })) => Err(error),
            Ok(_) => Err(json!({ "error": "INTERNAL", "message": "桥接返回异常帧" })),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(json!({ "error": "TIMEOUT", "message": "编辑器未在 120 秒内应答" }))
            }
        }
    }
}

fn tool_error_text(error: &Value) -> String {
    error
        .get("message")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| error.to_string())
}

async fn handle_message(client: &BridgeClient, request: &JsonRpcMessage) -> Option<JsonRpcMessage> {
    let method = request.method.as_deref().unwrap_or("");
    match method {
        "initialize" => Some(JsonRpcMessage {
            jsonrpc: Some("2.0".into()),
            id: request.id.clone(),
            result: Some(json!({
                "protocolVersion": protocol::MCP_PROTOCOL_VERSION,
                "capabilities": { "tools": {} },
                "serverInfo": {
                    "name": protocol::SERVER_NAME,
                    "version": env!("CARGO_PKG_VERSION"),
                },
            })),
            ..Default::default()
        }),
        "notifications/initialized" | "notifications/cancelled" => None,
        "ping" => Some(JsonRpcMessage {
            jsonrpc: Some("2.0".into()),
            id: request.id.clone(),
            result: Some(json!({})),
            ..Default::default()
        }),
        "tools/list" => Some(JsonRpcMessage {
            jsonrpc: Some("2.0".into()),
            id: request.id.clone(),
            result: Some(json!({ "tools": protocol::tool_definitions() })),
            ..Default::default()
        }),
        "tools/call" => {
            let params = request.params.clone().unwrap_or(Value::Null);
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let response = match client.call(name, arguments).await {
                Ok(value) => json!({
                    "content": [{ "type": "text", "text": serde_json::to_string_pretty(&value).unwrap_or_default() }],
                }),
                Err(error) => json!({
                    "content": [{ "type": "text", "text": tool_error_text(&error) }],
                    "isError": true,
                }),
            };
            Some(JsonRpcMessage {
                jsonrpc: Some("2.0".into()),
                id: request.id.clone(),
                result: Some(response),
                ..Default::default()
            })
        }
        _ => Some(JsonRpcMessage {
            jsonrpc: Some("2.0".into()),
            id: request.id.clone(),
            error: Some(json!({
                "code": -32601,
                "message": format!("方法不支持：{method}"),
            })),
            ..Default::default()
        }),
    }
}

fn load_bridge_info(
    port_override: Option<u16>,
    token_override: Option<String>,
) -> Result<(u16, String), String> {
    let config_dir = mcp_server_config_dir()?;
    let info_path = protocol_discover_path(&config_dir);
    let info: protocol::BridgeInfo = std::fs::read_to_string(&info_path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .ok_or_else(|| {
            format!(
                "未找到桥接信息文件 {}：请确认 Zeditor 正在运行且已在「设置 → 集成」中启用 MCP 服务器",
                info_path.display()
            )
        })?;
    Ok((
        port_override.unwrap_or(info.port),
        token_override.unwrap_or(info.token),
    ))
}

fn protocol_discover_path(config_dir: &std::path::Path) -> PathBuf {
    config_dir.join("mcp_bridge.json")
}

fn mcp_server_config_dir() -> Result<PathBuf, String> {
    // 与主程序的 app_config_dir 保持一致的跨平台解析（二进制侧不链接 tauri）。
    if cfg!(windows) {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .map(|dir| dir.join("zeditor"))
            .ok_or_else(|| "无法定位 %APPDATA%".to_string())
    } else if cfg!(target_os = "macos") {
        home_dir()
            .map(|home| home.join("Library/Application Support/zeditor"))
            .ok_or_else(|| "无法定位用户主目录".to_string())
    } else {
        Ok(std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or(home_dir().map(|home| home.join(".config")))
            .ok_or("无法定位配置目录")?
            .join("zeditor"))
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--version" || arg == "-v") {
        println!("zeditor_mcp_server {}", env!("CARGO_PKG_VERSION"));
        return;
    }

    let mut port_override: Option<u16> = None;
    let mut token_override: Option<String> = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--port" => {
                port_override = args.get(index + 1).and_then(|value| value.parse().ok());
                index += 1;
            }
            "--token" => {
                token_override = args.get(index + 1).cloned();
                index += 1;
            }
            _ => {}
        }
        index += 1;
    }

    let health_check = args.iter().any(|arg| arg == "--health-check");

    let (port, token) = match load_bridge_info(port_override, token_override) {
        Ok(found) => found,
        Err(error) => {
            eprintln!("zeditor_mcp_server: {error}");
            std::process::exit(2);
        }
    };

    let client = match BridgeClient::connect(port, &token).await {
        Ok(client) => client,
        Err(error) => {
            eprintln!("zeditor_mcp_server: {error}");
            std::process::exit(2);
        }
    };

    if health_check {
        match client.call(protocol::BRIDGE_PING_METHOD, json!({})).await {
            Ok(value) => {
                println!("health check ok: {value}");
                return;
            }
            Err(error) => {
                eprintln!("health check failed: {error}");
                std::process::exit(1);
            }
        }
    }

    eprintln!(
        "zeditor_mcp_server {} ready (stdio)",
        env!("CARGO_PKG_VERSION")
    );

    // 换行分隔的 JSON-RPC stdio 主循环。
    let stdin = tokio::io::stdin();
    let mut lines = BufReader::new(stdin).lines();
    let mut stdout = tokio::io::stdout();

    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(request) = serde_json::from_str::<JsonRpcMessage>(line) else {
            continue;
        };
        if let Some(response) = handle_message(&client, &request).await {
            if let Ok(text) = serde_json::to_string(&response) {
                let _ = stdout.write_all(text.as_bytes()).await;
                let _ = stdout.write_all(b"\n").await;
                let _ = stdout.flush().await;
            }
        }
    }
}
