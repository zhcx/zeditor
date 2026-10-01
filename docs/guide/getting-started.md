---
title: 快速上手
---

# 快速上手

Zeditor 是一款本地优先的 Markdown 编辑器：安装即用、无需登录，文档始终保存在你自己的磁盘上。本章带你在五分钟内完成安装并写出第一篇文档。

## 下载与安装

从 [GitHub Releases](https://github.com/zhcx/zeditor/releases/latest) 下载对应平台的安装包：

| 操作系统 | 推荐安装包 | 适用场景 |
| --- | --- | --- |
| Windows x86_64（Win10 1809+） | NSIS `.exe` | 大多数用户，按向导安装 |
| Windows x86_64 | MSI | 企业部署、静默安装 |
| macOS Apple Silicon（macOS 12+） | DMG | M1 / M2 / M3 / M4 芯片 |
| macOS Intel（macOS 12+） | DMG | Intel 芯片 Mac |
| Ubuntu / Debian | DEB | Ubuntu 20.04+、Debian 11+ 等 |
| Fedora / RHEL / openSUSE | RPM | RPM 系发行版 |
| 通用 Linux | AppImage | 免安装，`chmod +x` 后直接运行 |

::: tip SmartScreen 提示
Windows 安装包尚未进行 Authenticode 代码签名，首次运行可能触发 SmartScreen 警告，点击「更多信息 → 仍要运行」即可。
:::

## 首次启动

启动后你会看到左右分屏的编辑界面：左侧写 Markdown，右侧实时预览。几件事值得先知道：

- **界面语言**默认跟随系统，可在 `设置 → 外观` 中切换简体中文 / 繁體中文 / English。
- **主题**默认为深色，可在主题菜单中选择（含 12 套主题，见 [界面总览](/guide/interface#主题)）。
- 应用菜单中的「**快捷键说明**」和「**Markdown 语法**」是两份内置速查，随时可查。
- 文档默认**自动保存**（每 30 秒，已保存过的文件），也可 `Ctrl+S` 手动保存。

## 五分钟工作流

1. **新建文档**：`Ctrl+N`，或双击标签栏空白处。
2. **写作**：直接输入 Markdown；行首输入 `/` 可呼出命令菜单快速插入标题、表格、图表等（见[斜杠命令](/guide/slash-commands)）。
3. **插图**：把图片文件拖进窗口，会自动复制到文档同级的 `.assets` 目录并插入（见[图片](/guide/images)）。
4. **保存**：`Ctrl+S`；首次保存会弹出另存为对话框。
5. **导出**：`文件 → 导出` 可导出 HTML、PDF、Word、长图或公众号排版（见[导出](/guide/export)）。

## 保持更新

应用菜单 →「**检查更新**」可自动检测 GitHub 最新版本并一键下载安装；也可以直接前往 [Releases 页面](https://github.com/zhcx/zeditor/releases)手动下载，新版本可直接覆盖安装，文档与配置不受影响。

## 下一步

- [界面总览](/guide/interface) —— 认识菜单、侧边栏与编辑区
- [文件与工作区](/guide/files) —— 多根工作区、搜索替换与本地版本历史
- [AI 助手](/guide/ai/) —— 接入 13 家 AI 服务商辅助写作
