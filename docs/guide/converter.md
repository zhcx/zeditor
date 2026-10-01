---
title: 文档转换
---

# 文档转换（AnyDoc）

Zeditor 内置 **AnyDoc 原生 Rust 转换引擎**，把 Office 文档、PDF、EPUB 等一键转换为 Markdown，在新标签页中打开编辑。转换**始终在本机完成**，文件不会上传到任何服务器。

## 支持的格式

| 类别 | 格式 |
| --- | --- |
| Microsoft Office | DOC、DOCX、DOCM、PPT、PPTX、PPTM、XLS、XLSX、XLSM、XLSB |
| OpenDocument | ODT、ODS、ODP |
| 其他文档 | RTF、EPUB、CSV、PDF（仅文本型） |

不支持：扫描型 PDF（需 OCR）、图片、音频、MSG、Notebook。

## 触发转换

三种方式，效果一致：

1. **资源管理器点击**：直接点击 PDF / DOCX 等文件（悬停提示「点击即可转换为 Markdown」）；
2. **文件对话框**：`Ctrl+O` 打开时直接选择可转换文件；
3. **菜单**：`文件 → 导入并转换文档…`。

转换完成后，结果以新标签页打开（标题为原文件名 + `.md`，带未保存标记），确认内容无误后 `Ctrl+S` 保存即可。

## 转换模块的安装

主安装包**不包含**转换依赖，首次转换时按需下载独立模块（约数 MB），主程序保持轻量。

```text
首次触发转换
  → 检测本机模块
  → 已安装          → 直接转换
  → 未安装 + 有网络 → 弹窗确认 → 从 GitHub 下载平台模块
                      → SHA-256 校验 + 健康检查 → 安装 → 转换
  → 未安装 + 无网络 → 在设置中导入离线 ZIP 包
```

### 在线安装（推荐）

首次转换时自动弹出安装引导，点击「立即安装」即可；进度条依次显示下载 → 校验 → 安装。

### 导入离线包

内网或无网络环境：从 [converter-v1.3.0 Release](https://github.com/zhcx/zeditor/releases/tag/converter-v1.3.0) 下载对应平台的 ZIP 包，复制到目标机器，然后在 `设置 → 文档转换 → 导入离线包` 中选择导入。

| 平台 | 模块包 |
| --- | --- |
| Windows x86_64 | `zeditor-converter-v1.3.0-x86_64-pc-windows-msvc.zip` |
| macOS Apple Silicon | `zeditor-converter-v1.3.0-aarch64-apple-darwin.zip` |
| macOS Intel | `zeditor-converter-v1.3.0-x86_64-apple-darwin.zip` |
| Linux x86_64 | `zeditor-converter-v1.3.0-x86_64-unknown-linux-gnu.zip` |

### 管理模块

`设置 → 文档转换` 页提供：模块状态（已安装版本 / 可更新 / 未安装 / 校验失败 / 不兼容）、平台与空间占用、支持格式列表，以及「在线安装 / 更新模块 / 重新安装 / 导入离线包 / 卸载模块」按钮。

## 安全说明

- 发布清单使用 **Ed25519 签名验证**（公钥编译期嵌入）；
- 模块可执行文件强制 **SHA-256 完整性校验**；
- 转换过程完全离线本机执行。

::: tip 开发调试
开发时可通过环境变量 `ANYDOC_CONVERTER_PATH` 指向本地构建的转换器可执行文件，再运行 `npm run tauri dev`。
:::

## 下一步

- [支持的格式](/guide/formats) —— 全部可打开与可转换格式
- [导出](/guide/export) —— 转换来的文档如何导出分发
