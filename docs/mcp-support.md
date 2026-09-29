# MCP 集成使用指南

Zeditor 内置 MCP（Model Context Protocol）服务器，让 **Claude Desktop、Claude Code、Codex CLI、Gemini CLI** 等 AI 助手直接读写你正在编辑的文档——读取内容、改写选中段落、新建 / 保存 / 切换标签页，全部在你的编辑器里可见可控。

架构（参考 VMark MCP 设计）：

```
AI 助手 ←─stdio(JSON-RPC)─→ zeditor_mcp_server ←─WebSocket(127.0.0.1 + 随机令牌)─→ Zeditor 编辑器桥接 → 前端执行
```

> MCP 集成仅在 **Zeditor 桌面版**可用（依赖本地进程与文件系统权限），纯 Web 版不可用。

## 前置条件

- 使用 Zeditor 桌面版（Windows / macOS / Linux 安装包）。
- 已安装至少一个 MCP 兼容客户端：Claude Desktop、Claude Code、Codex CLI 或 Gemini CLI。

## 快速开始（3 步）

1. **在 Zeditor 中启用**：设置 → 集成 → 打开「启用 MCP 服务器」。
2. **一键配置助手**：设置 → 集成 → AI 助手配置 → 对目标客户端点击「安装」。
3. **完全重启该 AI 助手**，然后让助手读取 Zeditor 中的文档。

## 一、在 Zeditor 中启用 MCP

打开 **设置 → 集成**：

| 选项 | 说明 |
| --- | --- |
| **启用 MCP 服务器** | 总开关。关闭时立即断开所有 AI 接入 |
| **启动时自动运行** | Zeditor 打开时自动启动桥接（仅监听本机，带随机令牌认证） |
| **自动批准编辑** | AI 修改直接落盘，**不再**弹出「AI 修改建议」审阅。仅在你完全信任该助手时开启 |

- 点击 **启动桥接 / 停止桥接** 可手动控制桥接进程。
- 桥接只监听 **127.0.0.1**，端口与随机令牌写入应用配置目录的 `mcp_bridge.json`，由 MCP server 二进制自动发现。
- 状态栏 MCP 指示器：**灰** = 未运行，**绿** = 运行中，**脉冲绿** = 有 AI 助手连接；点击可直达设置。

## 二、配置 AI 助手

在 **设置 → 集成 → AI 助手配置** 中，对你要用的客户端点击一键安装。Zeditor 会把 `zeditor_mcp_server` 的**当前安装路径**写入对应配置文件（幂等，可重复点击）。

| 客户端 | 写入位置 | 状态显示 |
| --- | --- | --- |
| Claude Desktop | Windows：`%APPDATA%\Claude\claude_desktop_config.json`；macOS：`~/Library/Application Support/Claude/claude_desktop_config.json` | ✓ 已安装 |
| Claude Code | `~/.claude.json` | ✓ 已安装 |
| Codex CLI | `~/.codex/config.toml` | ✓ 已安装 |
| Gemini CLI | `~/.gemini/settings.json` | ✓ 已安装 |

- 若显示 **⚠ 路径不匹配**（例如 Zeditor 升级后安装目录变化），重新点击安装即可刷新。
- **配置写入后，必须完全退出并重启对应的 AI 助手**，新的 MCP 服务器才会被加载。

### 手动配置参考

一键配置失败或需要自定义时，可手写配置。将路径替换为你的 `zeditor_mcp_server`（Windows 为 `zeditor_mcp_server.exe`）实际路径。

**Claude Desktop / Claude Code / Gemini CLI（JSON）**

```json
{
  "mcpServers": {
    "zeditor": {
      "command": "C:\\Program Files\\Zeditor\\zeditor_mcp_server.exe"
    }
  }
}
```

**Codex CLI（TOML）**

```toml
[mcp_servers.zeditor]
command = "C:\\Program Files\\Zeditor\\zeditor_mcp_server.exe"
```

## 三、与 AI 助手协作

重启助手后，它会自动发现 Zeditor 的工具。示例指令：

- 「读取我当前在 Zeditor 里打开的文档，总结要点」
- 「把我在 Zeditor 中选中的段落改得更简洁，然后保存」
- 「在文档末尾追加一段结论」
- 「列出我打开的标签页」/「切换到 *项目计划* 文档」
- 「新建一个文档，标题为《周报》」

默认（未开启自动批准）时，AI 的写入会以 **「AI 修改建议」内联差异**弹出，你可逐条**接受 / 拒绝 / 撤销**。若文档在你确认前又被自己修改，写入会被拒绝并提示重读，避免覆盖。

## 四、可用工具（11 个）

| 工具 | 作用 | 备注 |
| --- | --- | --- |
| `session_get_state` | 读取当前会话状态 | 打开的标签页、活动文档等 |
| `workspace_new` | 新建文档 | |
| `workspace_open` | 打开工作区内的文件 | 受工作区范围限制 |
| `workspace_save` | 保存当前文档 | |
| `workspace_save_as` | 另存为 | 目标须在允许目录内 |
| `workspace_close` | 关闭标签页 | |
| `workspace_switch_tab` | 切换活动标签页 | |
| `document_read` | 读取文档内容 | 返回内容与修订号 |
| `document_write` | 写入文档内容 | 支持 `expected_revision` 乐观并发 |
| `selection_get` | 获取当前选区 | |
| `selection_set` | 设置当前选区 | |

`document_write` 的乐观并发：调用时带上读取到的修订号，若文档已被修改则返回 `STALE` 错误信封，助手需重新读取后再写入。

## 五、安全边界

- **仅本机**：桥接仅监听 `127.0.0.1`，连接需持有 `mcp_bridge.json` 中的**随机令牌**，外部网络无法直接连接。
- **路径受限**：所有文件操作限制在**已打开的工作区根目录与文档所在目录**内，越界返回 `INVALID_PATH`。
- **人工审阅**：默认不自动落盘，AI 修改以差异呈现，由你决定是否应用。
- **随时断开**：关闭「启用 MCP 服务器」或点击「停止桥接」立即生效。

## 六、故障排查

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| 助手看不到 Zeditor 工具 | 配置后未重启助手 | 完全退出并重启对应 AI 助手 |
| 状态显示「⚠ 路径不匹配」 | Zeditor 更新后二进制路径变化 | 设置 → 集成 重新点击一键安装 |
| 状态栏 MCP 指示为灰色 | 桥接未运行 | 点击「启动桥接」或开启「启动时自动运行」 |
| 助手报连接失败 | Zeditor 未运行 / 桥接未启动 | 打开 Zeditor 并确保桥接状态为「运行中」 |
| 写入被拒绝（`STALE`） | 文档在读取后被你修改 | 让助手重新读取文档后再写入 |
| 写入被拒绝（`INVALID_PATH`） | 目标文件不在已打开的工作区 / 文档目录内 | 先在 Zeditor 中打开对应文件夹 |
| 想恢复审阅弹窗 | 此前开启了「自动批准编辑」 | 关闭「自动批准编辑」开关 |
