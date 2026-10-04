---
title: 简介
---

# 简介

**Zeditor** 是一款现代化、本地优先的 Markdown 编辑器，基于 Tauri 2.0（Rust）+ React + Monaco Editor 构建，支持 Windows、macOS 与 Linux。让写作回归纯粹，让创作充满灵感。

## 它适合谁

- 需要**实时预览**的 Markdown 写作者——左侧编辑、右侧即见，双向同步滚动；
- 要处理**多种文档格式**的人——DOCX、PPT、XLS、PDF、EPUB 一键转成 Markdown 来编辑；
- 希望 **AI 辅助但不失控**的创作者——AI 对话、指令面板、伴写建议都经你的确认才落盘；
- 关心**数据安全**的用户——文档只存在你自己的磁盘上，转换与 AI 修改全程可审阅。

## 核心能力一览

| 能力 | 说明 | 了解更多 |
| --- | --- | --- |
| 沉浸编辑 | Monaco 编辑器、智能 Tab 导航、斜杠命令、表格工具栏、内联弹窗 | [编辑与格式](/guide/editing) |
| 强大渲染 | KaTeX 公式、Mermaid 图表、Markmap 思维导图、工作流查看器 | [Mermaid 图表](/guide/mermaid) |
| AI 辅助 | 13 家服务商对话、指令面板、校对、联网搜索 | [AI 助手](/guide/ai/) |
| 本地 Agent | 驱动 Claude Code / Codex / OpenCode / Pi，worktree 隔离审阅 | [本地 Agent](/guide/ai/agent) |
| MCP 集成 | 让 Claude Desktop 等外部 AI 助手直接读写你的文档 | [MCP 集成](/guide/ai/mcp) |
| 文档转换 | AnyDoc 原生引擎，本机处理、按需下载 | [文档转换](/guide/converter) |
| 多格式导出 | HTML / PDF / Word / 长图 / 公众号排版，9 套模板 | [导出](/guide/export) |
| 自动云备份 | WebDAV 与 S3，保留最近 20 个内容版本 | [云备份](/guide/cloud-backup) |
| 旧编码文档 | UTF-8、UTF-16、GBK、Big5、Shift-JIS 等 11 种文本编码，打开时可选择编码 | [文件与工作区](/guide/files#选择文件编码) |
| 可调阅读体验 | 独立调整界面字号和字间距 | [设置参考](/reference/settings#外观) |

## 设计原则

- **本地优先**：文件保存在你自己的磁盘；自动保存、本地版本历史（时间线）兜底，不必依赖任何账号或云端；
- **隐私安全**：文档转换在本机完成；AI 请求直连你选择的服务商；MCP 桥接仅监听本机并带令牌认证；
- **修改可审阅**：AI 与 Agent 的改动默认以差异审阅呈现，接受才会写入，绝不静默覆盖你的内容；
- **简约现代**：12 套明暗主题统一联动界面、编辑器与图表配色。

## 下一步

- [快速上手](/guide/getting-started) —— 五分钟完成安装并写出第一篇文档
- [界面总览](/guide/interface) —— 认识菜单、侧边栏与编辑区
- [键盘快捷键](/reference/shortcuts) —— 全部快捷键速查
