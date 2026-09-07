<div align="center">

# ✨ Zeditor

**一款现代化的 Markdown 编辑器**

*让写作回归纯粹，让创作充满灵感*

[![Release](https://img.shields.io/github/v/release/zhcx/zeditor?style=flat-square)](https://github.com/zhcx/zeditor/releases)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](https://github.com/zhcx/zeditor/blob/main/LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=flat-square)](https://github.com/zhcx/zeditor/releases)

<img src="docs/banner.png" alt="Zeditor" width="900">

</div>

---

## 🌟 关于这个项目

> **这是我第一个使用 Claude Code 和 CodeX 通过「Vibe Coding」方式创建的项目。**
>
> 没有繁琐的需求文档，没有刻板的开发计划。我只是告诉 Claude：「我想做一个像 Typora 那样的 Markdown 编辑器」，然后我们开始了一场编码对话——我描述想法，Claude 实现代码，我调整方向，Claude 优化细节。
>
> 这不是传统的软件开发流程，更像是一场人与 AI 的即兴合奏。每一次「试试这样」的念头，都在几秒钟内变成了真实的代码。这种感觉，就像用吉他即兴演奏——你不需要提前写好谱子，旋律在指尖自然流淌。
>
> 这个项目诞生于一个下午的灵感碰撞，见证了 AI 辅助创作的无限可能。

---

## 📣 重要更新：软件更名与转换引擎升级

> **本项目已完成品牌与引擎的双重升级，请旧用户特别注意以下变更：**

### 1. 软件名称：MarkItDown → **Zeditor**

本项目最初以 *MarkItDown* 为名创建，但 **MarkItDown 是微软开源的 Python 文档解析库**，为避免与微软官方项目混淆、并确立独立品牌，自 **v0.3.7** 起正式更名为 **Zeditor**。

- 仓库地址同步迁移至 **[github.com/zhcx/zeditor](https://github.com/zhcx/zeditor)**（原 `zhcx/markitdown` 仓库仅保留历史与转换模块的发布资产）。
- 安装包名称由 `MarkitDown_*` 变更为 `Zeditor_*`，**旧版本可直接覆盖安装，用户文档与配置不受影响**。

### 2. 文档转换引擎：markitdown（Python）→ **AnyDoc（Rust）**

文档转换能力已从 **微软 markitdown（Python 依赖）** 全面替换为 **AnyDoc 原生 Rust 转换引擎**：

| 对比项 | 旧版（markitdown / Python） | 新版（AnyDoc / Rust） |
| --- | --- | --- |
| 运行时 | 依赖 Python 环境与第三方库 | 零依赖原生可执行文件 |
| 安装方式 | 内置打包（安装包体积庞大） | 首次转换时按需下载独立模块 |
| 安装包体积 | 约 80 MB（内嵌 72 MB 转换程序） | 约 8 MB（模块外置） |
| 转换性能 | 进程启动慢、跨语言调用开销 | 原生执行、启动与转换更快 |
| 数据安全 | 本机处理 | 本机处理（不变） |

> ⚠️ 由于转换引擎已更换，**旧的 markitdown 内置转换器不再可用**。升级到 v0.3.7 后，首次打开 DOC/DOCX/PPT/PDF 等文档时，Zeditor 会自动引导从 GitHub Release 下载对应平台的 AnyDoc 模块（亦可离线导入 `.zip` 包）。模块版本与软件版本独立演进，当前转换模块版本为 **v1.2.0**。

---

## ✨ 核心功能

### 📝 编辑体验
- **实时预览** - 左侧编辑，右侧即时渲染
- **沉浸阅读 / 沉浸写作** - 阅读与写作分别提供专注空间，可保留大纲和 AI Chatbox
- **多标签页** - 同时编辑多个文件
- **Monaco 编辑器** - 语法高亮、自动换行、当前行定位和专业编辑体验
- **可调节布局** - 自由拖动调整侧边栏和编辑区域宽度
- **同步滚动与大纲** - 编辑器和预览联动，按 Markdown 标题自动生成大纲

### 🎨 渲染能力
- **数学公式** - KaTeX 渲染，支持行内与块级公式
- **Mermaid 图表** - 流程图、时序图、甘特图等
- **代码高亮** - highlight.js 支持
- **任务列表** - 待办事项管理
- **GitHub 风格 Markdown** - 更贴近 GitHub 的排版与换行行为
- **图片与视频** - 粘贴图片自动保存或上传图床，支持 B 站、YouTube 与 Vimeo 视频
- **写作辅助** - Markdown 检查与格式化、完整语法指南、原生 Emoji 和常用表情

### 🎯 界面设计
- **多主题支持** - 内置「深色主题」与「浅色主题」两套简约配色，可从“功能 → 主题”菜单切换
- **编辑增强** - 编辑器行号、可拖动网格选择并插入 Markdown 表格
- **图片导出** - 支持 1:1、4:3、16:9、9:16、A4 比例预览并导出 PNG
- **现代化设计** - Notion 风格的简洁界面
- **右键菜单** - 快捷操作，从列表移除文件

### 📁 文件管理
- **拖拽打开** - 直接拖入文件到窗口打开
- **最近文档** - 快速访问历史文件
- **文件夹浏览** - 打开文件夹，树形展示

### 🖼️ 图片上传
- **多图床支持** - Cloudinary、PicGo、S3、本地存储

### 📄 文档转换

Zeditor 支持将 **DOC、DOCX、PPT、PPTX、XLS、XLSX、ODF、RTF、EPUB、CSV、PDF** 等文档一键转换为 Markdown 格式，以新标签页打开编辑。提供在线安装和离线导入两种方式：

- **在线安装** — 首次转换时自动弹出主题弹窗引导安装，从 GitHub Release 下载对应平台模块
- **导入离线包** — 在无网络环境中导入提前下载的 ZIP 包
- **AnyDoc 模块** — 首次转换时按需下载对应平台的原生 Rust 转换模块

文件转换**始终在本机处理**，不会上传到任何服务器。详情见下方[文档转换模块使用指南](#文档转换模块使用指南)。

### 🤖 AI 智能助手
- **AI 对话面板** — 侧边栏自由对话，支持流式输出与思维链展示
- **智能校对** - 自动检测错别字、语法错误、标点问题
- **伴写建议** - 根据上下文提供写作建议
- **文本重写** - 一键改写选中内容
- **智能翻译** - 支持多语言翻译
- **摘要生成** - 自动生成文档摘要
- **大纲生成** - 智能提取文档大纲
- **思维链展示** — DeepSeek/硅基流动模型思考过程实时流式显示
- **思考模式** — 关闭/快速/均衡/深度，灵活控制 AI 推理强度
- **关联文档** — 一键将当前编辑文档作为对话上下文
- **附件上传** — 图片和文本文件上传，与对话一起发送
- **本地 Agent（Beta）** — 在同一面板调用 Claude Code、Codex 或 OpenCode，支持流式任务、命令审批和会话恢复
- **隔离变更审阅** — Git 仓库任务在临时 worktree 中工作，完成后可按文件应用，不覆盖当前未提交修改

### 🤖 AI 服务商支持

| 服务商 | 状态 |
| --- | --- |
| OpenAI | 支持 |
| DeepSeek | 支持（含思维链） |
| 硅基流动 (SiliconFlow) | 支持（含思维链） |
| Anthropic | 支持 |
| 小米 MiMo | 支持 |
| 火山引擎 / 豆包 | 支持 |
| LongCat | 支持 |
| 智谱 AI | 支持 |
| MiniMax | 支持 |
| Kimi | 支持 |
| 自定义 OpenAI 兼容 | 支持 |

### 🧩 本地 Agent 支持（桌面端 Beta）

| Agent | 接入方式 |
| --- | --- |
| Claude Code | Stream JSON + PreToolUse 审批 Hook |
| Codex | App Server JSON-RPC v2 |
| OpenCode | 本地 Server API + SSE |

Agent 默认关闭，需要先在“设置 → AI 助手”中启用。Zeditor 复用各 CLI 的登录与默认模型，不保存其账号凭据。Git 根目录中的任务使用隔离 worktree；其他目录在进入 Agent 后授权为当前会话的读写范围，修改会直接写入。命令、网络和 MCP 默认逐次审批，也可仅对当前会话启用完全允许。详细说明见 [Agent 使用与安全说明](docs/agent-support.md)。

### 🔄 自动更新

- Zeditor 菜单 → 检查更新
- 自动检测 GitHub Release 最新版本
- 一键下载安装包，实时进度显示

### 💾 导出功能
- **HTML 导出** - 自定义模板
- **PDF 导出** - 专业排版输出

### ☁️ WebDAV / S3 备份（桌面版）
- 本地保存成功后自动上传到自建的 WebDAV 服务器或 S3 兼容对象存储（AWS S3、阿里云 OSS、腾讯云 COS、MinIO、Cloudflare R2 等），云端失败不影响本地保存
- WebDAV 与 S3 可同时启用，各自独立队列与状态
- 保留最新副本 + 最近 20 个不同内容版本（SHA-256 去重）
- 状态栏实时显示同步状态，支持点击重试与浏览历史
- 失败任务持久化，应用重启后自动恢复
- 历史版本按「另存为」下载，下载前校验哈希

---

## 🚀 快速开始

## v0.4.5 更新

### 更新日志

- **分栏拖拽优化**：分隔条拖拽改用 Pointer Events，跨分栏调整更顺滑，不再误触选中文本。
- **编辑 / 预览滚动体验**：增强编辑框与预览框的滚动浏览手感，长文档滚动更跟手、不跳变。
- **预览链接系统浏览器打开**：预览框内点击链接不再在软件内打开，自动调用系统默认浏览器访问。
- **编辑器输入修复**：修复生产包 CSP 拦截 Monaco 动态行样式导致的正文消失、折行高度归零和首行上方闪字。
- **输入法引擎**：原生 EditContext 默认启用，textarea 作为兼容回退；设置保存后立即切换并在重启后保留。
- **输入稳定性验证**：覆盖短行、折行、连续组合、取消、上屏、首列输入、撤销、退格、中英混输和换段。
- **数据安全修复**：每个标签独立撤销状态，AI 异步结果校验文档身份，保存/关闭/更新竞态受到保护。
- **自动保存**：按设置周期保存已有路径且已修改的标签。
- **依赖审计**：更新高危依赖并通过 GitHub Actions 发布质量门禁。
- **转换模块**：继续沿用 AnyDoc v1.2.0（本版本未变更转换引擎）。
- **资源管理器删除修复**：删除最后一个文件后列表立即刷新；删除已打开文档时给出提醒，确认后自动关闭编辑器并删除文件。
- **Agent / AI 上下文**：自动识别当前文档并显示为可移除上下文标签，文档切换和编辑后同步最新内容，支持未保存文档。
- **Agent / AI 插入体验**：生成内容插入编辑器前自动加入 Markdown 横线 `---`，AI 对话新增“插入编辑器”操作。
- **Agent 输入与权限**：提交任务后立即清空输入框；Claude 完全访问模式不再重复触发普通权限询问。
- **编辑器高亮修复**：关闭 Monaco 单击后的同词高亮，避免未选中文字出现灰色块；真实选区高亮保持不变。

### v0.4.5 平台安装包对照

> 以下链接指向 v0.4.5 Release 资产；安装包由 GitHub Actions 根据 v0.4.5 标签源码构建。

| 操作系统 | 架构 | 最低系统版本 | 推荐安装包 | 适用场景 |
| --- | --- | --- | --- | --- |
| Windows | x86_64 | Windows 10 1809+ | [NSIS `.exe`](https://github.com/zhcx/zeditor/releases/download/v0.4.5/Zeditor_0.4.5_x64-setup.exe) | 推荐大多数用户使用，按向导安装 |
| Windows | x86_64 | Windows 10 1809+ | [MSI](https://github.com/zhcx/zeditor/releases/download/v0.4.5/Zeditor_0.4.5_x64_en-US.msi) | 企业部署、系统管理或静默安装 |
| macOS Apple Silicon | arm64 | macOS 12+ | [DMG](https://github.com/zhcx/zeditor/releases/download/v0.4.5/Zeditor_0.4.5_aarch64.dmg) | M1、M2、M3、M4 等 Apple 芯片 |
| macOS Apple Silicon | arm64 | macOS 12+ | [APP 压缩包](https://github.com/zhcx/zeditor/releases/download/v0.4.5/Zeditor_aarch64.app.tar.gz) | 手动解压或更新 |
| macOS Intel | x86_64 | macOS 12+ | [DMG](https://github.com/zhcx/zeditor/releases/download/v0.4.5/Zeditor_0.4.5_x64.dmg) | Intel 芯片 Mac |
| macOS Intel | x86_64 | macOS 12+ | [APP 压缩包](https://github.com/zhcx/zeditor/releases/download/v0.4.5/Zeditor_x64.app.tar.gz) | 手动解压或更新 |
| Ubuntu / Debian | x86_64 | Ubuntu 20.04+ / Debian 11+ | [DEB](https://github.com/zhcx/zeditor/releases/download/v0.4.5/Zeditor_0.4.5_amd64.deb) | Ubuntu、Debian、Linux Mint 等 |
| Fedora / RHEL / openSUSE | x86_64 | Fedora 38+ / RHEL 9+ | [RPM](https://github.com/zhcx/zeditor/releases/download/v0.4.5/Zeditor-0.4.5-1.x86_64.rpm) | RPM 系发行版 |
| 通用 Linux | x86_64 | 需 webkit2gtk-4.1 | [AppImage](https://github.com/zhcx/zeditor/releases/download/v0.4.5/Zeditor_0.4.5_amd64.AppImage) | 无需安装，赋予执行权限后运行 |

完整更新说明、转换模块下载与安装提示见 [`docs/releases/v0.4.5.md`](docs/releases/v0.4.5.md)。

## Contributors

- CodeX
- Claude Code

### 下载安装

从 [Releases](https://github.com/zhcx/zeditor/releases) 页面下载适合您系统的安装包：

| 平台 | 架构 | 推荐下载 | 安装包格式 |
|------|------|----------|-----------|
| Windows | x86_64 | `.exe` (NSIS) | `.msi` / `.exe` |
| macOS Intel | x86_64 | `.dmg` | `.dmg` / `.app.tar.gz` |
| macOS Apple Silicon | arm64 | `.dmg` | `.dmg` / `.app.tar.gz` |
| Linux | x86_64 | `.AppImage` | `.deb` / `.rpm` / `.AppImage` |

### 本地构建

```bash
# 克隆仓库
git clone https://github.com/zhcx/zeditor.git
cd zeditor

# 安装依赖
npm install

# 开发模式
npm run tauri dev

# 构建发布
npm run tauri build
```

**环境要求：**
- Node.js >= 22.6
- Rust >= 1.85
- Python >= 3.10（仅从源码运行或开发文档转换功能时需要）

### 文档转换模块使用指南

Zeditor 使用 AnyDoc 将 **DOC、DOCX、PPT、PPTX、XLS、XLSX、ODF、RTF、EPUB、CSV、PDF** 转换为 Markdown，并在新标签页中打开编辑。转换模块为按需下载的独立组件，主安装包不包含转换依赖，仅在需要时下载。

#### 转换流程示意

```text
用户拖入/右键 PDF 文件
  → 检测模块状态（本机）
  → 已安装          → 直接转换，结果以标签页打开
  → 未安装 + 有网络 → 弹出主题弹窗 → 点击”在线安装”
                      → 检查清单 → 下载平台模块 → 校验 → 安装 → 转换
  → 未安装 + 无网络 → 弹出主题弹窗 → 点击”稍后安装”
                      → 在设置中导入离线 ZIP 包
```

#### 方式一：在线安装（推荐）

首次转换非 Markdown 文件时自动弹出安装引导，也可在设置中手动操作：

1. **触发安装**：
   - 右键 PDF/DOCX 文件 → “转换为 Markdown”
   - 或打开 **设置 → 文档转换** → 点击”在线安装”
2. 应用自动从 GitHub Release 拉取清单，下载对应平台的转换模块
3. 下载完成后执行 SHA-256 校验和健康检查，自动安装
4. 安装成功后自动执行转换，结果以新标签页打开

#### 方式二：导入离线包

在无网络或内网环境中使用：

1. 从可联网的机器下载对应平台的转换模块 ZIP 包（见下方对照表）
2. 将 ZIP 包复制到目标机器
3. 打开 **设置 → 文档转换** → 点击”导入离线包”
4. 选择下载好的 ZIP 包，导入后即可使用

**各平台转换模块包：**

| 平台 | 模块包 |
| --- | --- |
| Windows x86_64 | `zeditor-converter-v1.2.0-x86_64-pc-windows-msvc.zip` |
| macOS Apple Silicon | `zeditor-converter-v1.2.0-aarch64-apple-darwin.zip` |
| macOS Intel | `zeditor-converter-v1.2.0-x86_64-apple-darwin.zip` |
| Linux x86_64 | `zeditor-converter-v1.2.0-x86_64-unknown-linux-gnu.zip` |

模块可从 [converter-v1.2.0 Release](https://github.com/zhcx/zeditor/releases/tag/converter-v1.2.0) 页面下载。

#### 方式三：开发调试

开发时可直接构建 AnyDoc 转换器，并通过环境变量指定可执行文件：

```powershell
$env:ANYDOC_CONVERTER_PATH = "D:\path\to\document_converter.exe"
npm run tauri dev
```

#### 支持的格式

| 类别 | 格式 | 说明 |
| --- | --- | --- |
| Office / 文档 | DOC、DOCX、DOCM、PPT、PPTX、PPTM、XLS、XLSX、XLSM、XLSB | 保留标题、列表、表格和演讲者备注等结构 |
| OpenDocument | ODT、ODS、ODP | 转换文档、表格和演示文稿结构 |
| 其他文档 | RTF、EPUB、CSV、PDF | PDF 支持文本型文档；扫描型 PDF 需要后续 OCR 引擎 |
| 纯文本 | TXT/TEXT、Markdown、HTML、JSON、XML | 直接以文本编辑器打开 |

#### 安全说明

- AnyDoc 支持的文档转换在本机处理，不上传文件
- 扫描型 PDF、图片、音频、MSG 和 Notebook 不在当前 AnyDoc 模块的转换范围内
- 发布清单使用 Ed25519 签名验证（公钥编译期嵌入）
- 模块可执行文件经过 SHA-256 完整性校验
- 未配置公钥时自动跳过 Ed25519 验证
- Windows 模块未进行 Authenticode 代码签名，但仍强制验证模块哈希

#### 故障排除

| 问题 | 可能原因 | 解决方法 |
| --- | --- | --- |
| 提示”converter_module_missing” | 未安装 AnyDoc 模块 | 在设置中在线安装或导入对应平台 ZIP |
| 下载转换模块失败 | 网络问题 | 检查网络连接，或使用离线包导入 |
| 健康检查失败 | 模块文件损坏 | 重新安装或导入模块 |
| 转换结果为空 | 源文件为扫描件/图片 | 确认源文件包含可提取的文本内容 |
| SmartScreen 警告 | 安装包未代码签名 | 点击”更多信息 → 仍要运行” |

---

## 🛠️ 技术栈

| 层级 | 技术 |
|------|------|
| 前端框架 | React 18 + TypeScript |
| 编辑器引擎 | Monaco Editor |
| Markdown 渲染 | markdown-it + KaTeX + Mermaid |
| 状态管理 | Zustand |
| 后端框架 | Tauri 2.0 (Rust) |
| HTTP 客户端 | Reqwest |
| 样式方案 | 纯 CSS + CSS Variables |

---

## 📂 项目结构

```
zeditor/
├── src/                    # React 前端
│   ├── components/         # UI 组件
│   │   ├── Chatbot/        # AI 对话面板
│   │   ├── Editor/         # Monaco 编辑器
│   │   ├── Preview/        # Markdown 渲染预览
│   │   ├── Toolbar/        # 工具栏按钮
│   │   ├── Sidebar/        # 文件管理侧边栏
│   │   ├── MenuBar/        # 顶部菜单栏
│   │   ├── Export/         # 导出功能
│   │   └── Settings/       # 设置面板
│   ├── stores/             # Zustand 状态管理
│   └── styles/             # CSS 样式
├── src-tauri/              # Rust 后端
│   ├── src/
│   │   ├── main.rs         # Tauri 入口
│   │   ├── commands.rs     # IPC 命令
│   │   ├── ai/             # AI API 客户端
│   │   ├── image/          # 图床模块
│   │   └── pdf/            # PDF 导出
│   └── Cargo.toml
└── .github/workflows/      # CI/CD 配置
```

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

---

## 🔏 Code signing policy

Windows 代码签名的构建来源、审批角色、验证方法与当前接入状态见 [Code Signing Policy](CODE_SIGNING_POLICY.md)。隐私与可选第三方数据传输说明见 [Privacy Policy](PRIVACY.md)。

SignPath Foundation 申请目前处于准备/审核阶段；在正式启用前，发布页必须明确标识未签名的 Windows 安装包。启用后的署名为：**Free code signing provided by SignPath.io, certificate by SignPath Foundation**。

---

## 📄 许可证

[MIT License](https://github.com/zhcx/zeditor/blob/main/LICENSE)

---

## 📈 项目更新热力图

<div align="center">

[![GitHub 更新热力图](https://ghchart.rshah.org/2196f3/zhcx)](https://github.com/zhcx/zeditor/graphs/commit-activity)

</div>

---

## 🚀 版本更新日志

 - **v0.4.5**（2026-09-07）：修复资源管理器删除残留、Agent 输入与完全访问权限问题，Agent / AI 自动识别当前文档并支持可移除上下文，生成内容插入编辑器时自动添加 Markdown 横线，关闭编辑器单击后的同词高亮。详见 [v0.4.5 发布说明](docs/releases/v0.4.5.md)。
   - 平台安装包（由 `v0.4.5` 标签触发 GitHub Actions 构建）：Windows `Zeditor_0.4.5_x64-setup.exe` / `Zeditor_0.4.5_x64_en-US.msi`、macOS（Apple Silicon / Intel）`.dmg`、Linux `.deb` / `.rpm` / `.AppImage`。
 - **v0.4.4**（2026-09-06）：修复跨标签撤销、AI 异步回写、保存关闭竞态和自动保存，继续保留 WebView2 输入与行布局修复。详见 [v0.4.4 发布说明](docs/releases/v0.4.4.md)。
   - 平台安装包（由 `v0.4.4` 标签触发 GitHub Actions 构建）：Windows `Zeditor_0.4.4_x64-setup.exe` / `Zeditor_0.4.4_x64_en-US.msi`、macOS（Apple Silicon / Intel）`.dmg`、Linux `.deb` / `.rpm` / `.AppImage`。
- **v0.4.2**（2026-08-26）：编辑与预览体验打磨 —— 分栏拖拽改用 Pointer Events 更顺滑、编辑/预览滚动浏览更跟手，预览框链接改为系统默认浏览器打开。详见 [v0.4.2 发布说明](docs/releases/v0.4.2.md)。
  - 平台安装包（由 `v0.4.2` 标签触发 GitHub Actions 构建）：Windows `Zeditor_0.4.2_x64-setup.exe` / `Zeditor_0.4.2_x64_en-US.msi`、macOS（Apple Silicon / Intel）`.dmg`、Linux `.deb` / `.rpm` / `.AppImage`。
- **v0.4.1**（2026-08-26）：资源管理器体验修复 —— 目录层级逐级缩进、时间线标题单行显示、一级目录关闭按钮（悬停 `×` + 右键菜单，关闭后收起其下所有文件夹并防止子目录被自动重新添加）、刷新保留已展开目录内容。详见 [v0.4.1 发布说明](docs/releases/v0.4.1.md)。
  - 平台安装包（由 `v0.4.1` 标签触发 GitHub Actions 构建）：Windows `Zeditor_0.4.1_x64-setup.exe` / `Zeditor_0.4.1_x64_en-US.msi`、macOS（Apple Silicon / Intel）`.dmg`、Linux `.deb` / `.rpm` / `.AppImage`。
- **v0.4.0**（2026-08-22）：全新蓝色 `Z` 应用图标与 GitHub 首页横幅；延续云同步面板（WebDAV / S3）开关样式统一、未配置拦截、设置按钮层级修复与视觉打磨。详见 [v0.4.0 发布说明](docs/releases/v0.4.0.md)。
  - 平台安装包（由 `v0.4.0` 标签触发 GitHub Actions 构建）：Windows `Zeditor_0.4.0_x64-setup.exe` / `Zeditor_0.4.0_x64_en-US.msi`、macOS（Apple Silicon / Intel）`.dmg`、Linux `.deb` / `.rpm` / `.AppImage`。
- **v0.3.9**：云同步面板交互与视觉打磨（状态显示、开关样式统一、历史版本打开）。详见 [v0.3.9 发布说明](docs/releases/v0.3.9.md)。
- **v0.3.7**：品牌与转换引擎双重升级 —— 项目更名 **Zeditor**（原 MarkItDown），文档转换引擎由 markitdown(Python) 全面替换为原生 Rust 的 **AnyDoc**。

完整发布说明见 [`docs/releases/`](docs/releases/)。

---

<div align="center">

**用 ❤️ 和 Claude Code、CodeX 构建**

*If you like this project, give it a ⭐!*

</div>
