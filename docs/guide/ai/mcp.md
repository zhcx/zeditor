---
title: MCP 集成
---

# MCP 集成

Zeditor 内置 MCP（Model Context Protocol）服务器，让 **Claude Desktop、Claude Code、Codex CLI、Gemini CLI** 等外部 AI 助手通过 MCP 协议直接读写你正在编辑的文档——你可以对着 Claude 说「总结我当前打开的文档」「把选中段落改简洁后保存」。

## 三步启用

1. `设置 → 集成`，开启「**启用 MCP 服务器**」；
2. 在「AI 助手配置」区对你使用的客户端点「**安装**」，状态显示 **✓ 已安装**（自动写入该客户端的 MCP 配置文件）；
3. **完全退出并重启该 AI 助手**。

之后即可在 Claude Desktop / Claude Code 等助手中直接操作 Zeditor 里打开的文档。

::: tip 启动时自动运行
开启「启动时自动运行」后，Zeditor 每次打开即自动启动桥接，无需手动操作。
:::

## 提供的工具（11 个）

| 工具 | 作用 |
| --- | --- |
| `session_get_state` | 获取当前会话与文档状态 |
| `workspace_new` / `workspace_open` / `workspace_close` | 新建 / 打开 / 关闭文档 |
| `workspace_save` / `workspace_save_as` | 保存 / 另存 |
| `workspace_switch_tab` | 切换标签页 |
| `document_read` | 读取文档内容（返回修订号） |
| `document_write` | 写入文档（支持乐观并发，内容过期返回 STALE） |
| `selection_get` / `selection_set` | 读取 / 修改当前选区 |

## 安全边界

- 桥接**仅监听 `127.0.0.1`**，并使用**随机令牌认证**（每次启动重新生成）；
- 文件操作**限定在已打开的工作区根与文档目录内**，越界请求返回 `INVALID_PATH`；
- 默认不自动落盘：AI 的修改以「**AI 修改建议**」差异审阅呈现，由你接受 / 拒绝 / 撤销；
- 状态栏 MCP 指示灯：灰 = 未运行，绿 = 运行中等待连接，脉冲绿 = 有 AI 助手已连接；点击直达设置。

### 自动批准编辑

开启「自动批准编辑」后 AI 修改直接写入文件、不再弹出审阅——**仅在完全信任该助手时开启**。

## 一键配置的客户端

| 客户端 | 配置写入位置 |
| --- | --- |
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json`（macOS 为 `~/Library/Application Support/Claude/`） |
| Claude Code | `~/.claude.json` |
| Codex CLI | `~/.codex/config.toml` |
| Gemini CLI | `~/.gemini/settings.json` |

状态显示「⚠ 路径不匹配」时点「安装 / 修复」即可重新写入。

## 下一步

- [MCP 集成完整指南](/mcp-support) —— 手动配置 JSON / TOML、协作示例与故障排查
- [本地 Agent](/guide/ai/agent) —— Zeditor 内直接驱动 CLI Agent
