//! MCP 桥接协议：编辑器内桥接与 `zeditor_mcp_server` 二进制之间的
//! WebSocket 帧类型，以及暴露给 AI 助手的工具清单（JSON Schema）。
//!
//! 设计参考 VMark 的 MCP 集成（AI 助手 ←stdio→ MCP server ←WS→ 编辑器），
//! 工具面取其编辑器读写主轴：session / workspace / document / selection。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// 桥接信息文件（app_config_dir/mcp_bridge.json）：MCP server 二进制
/// 通过它发现桥接端口与认证令牌。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeInfo {
    pub port: u16,
    pub token: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BridgeFrame {
    /// MCP server → 桥接：握手认证。
    Hello { token: String },
    /// 桥接 → MCP server：认证成功。
    HelloOk { version: String },
    /// MCP server → 桥接：工具调用请求，转发到前端执行。
    Call {
        id: String,
        method: String,
        #[serde(default)]
        params: Value,
    },
    /// 桥接 → MCP server：调用结果（result 与 error 二选一）。
    Result {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<Value>,
    },
    /// 桥接 → MCP server：错误（如认证失败）。
    Error { message: String },
    /// 桥接 → MCP server / 前端：状态事件。
    Event {
        event: String,
        #[serde(default)]
        data: Value,
    },
}

/// 桥接内置方法（不经前端即可应答）：健康检查。
pub const BRIDGE_PING_METHOD: &str = "bridge.ping";

/// 工具定义：name / description / inputSchema / annotations。
/// （主程序侧仅供状态展示与测试引用；MCP server 二进制经 #[path] 复用。）
#[allow(dead_code)]
pub fn tool_definitions() -> Value {
    json!([
        {
            "name": "session_get_state",
            "description": "获取编辑器会话状态：窗口、打开的标签页（filePath/dirty/kind/active）以及服务器能力。",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "workspace_new",
            "description": "新建一个未命名 Markdown 标签页并激活。",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        },
        {
            "name": "workspace_open",
            "description": "打开磁盘上的文件（Markdown 或文本）。路径必须位于已打开的工作区根目录或已打开文档所在目录之内，否则返回 INVALID_PATH。",
            "inputSchema": {
                "type": "object",
                "properties": { "filePath": { "type": "string", "description": "要打开的绝对路径" } },
                "required": ["filePath"]
            }
        },
        {
            "name": "workspace_save",
            "description": "把当前标签页保存到其现有路径。",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "workspace_save_as",
            "description": "把当前标签页另存为新路径。路径必须在允许范围内（同 workspace_open）。",
            "inputSchema": {
                "type": "object",
                "properties": { "filePath": { "type": "string" } },
                "required": ["filePath"]
            }
        },
        {
            "name": "workspace_close",
            "description": "关闭当前标签页；有未保存修改且未传 force 时返回 {closed:false, reason:\"DIRTY\"}。",
            "inputSchema": {
                "type": "object",
                "properties": { "force": { "type": "boolean" } }
            }
        },
        {
            "name": "workspace_switch_tab",
            "description": "按标签页 id 激活对应标签页。",
            "inputSchema": {
                "type": "object",
                "properties": { "tabId": { "type": "string" } },
                "required": ["tabId"]
            }
        },
        {
            "name": "document_read",
            "description": "读取当前活动标签页的完整 Markdown 内容与 revision 令牌。写入前必须先读。",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "document_write",
            "description": "替换整篇文档内容。传入 expected_revision 时若文档已变化返回 STALE 错误信封。未启用自动批准时，变更以「AI 修改建议」形式呈现，由用户接受或拒绝。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "content": { "type": "string" },
                    "expected_revision": { "type": "string", "description": "最近一次 document_read 返回的 revision" }
                },
                "required": ["content"]
            }
        },
        {
            "name": "selection_get",
            "description": "读取当前编辑器选区（源码模式字符偏移）。选区折叠时 isEmpty 为 true。",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "selection_set",
            "description": "替换当前编辑器选区内容；content 为空则删除选区；选区折叠时在光标处插入。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "content": { "type": "string" },
                    "expected_revision": { "type": "string" }
                },
                "required": ["content"]
            }
        }
    ])
}

#[allow(dead_code)]
pub const TOOL_COUNT: usize = 11;

#[allow(dead_code)]
pub const SERVER_NAME: &str = "zeditor";
#[allow(dead_code)]
pub const MCP_PROTOCOL_VERSION: &str = "2025-03-26";
