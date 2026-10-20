# 文档可靠性与性能改进：接力说明

日期：2026-10-20。适用于当前分支 `codex/recycle-cloud-docx-safety`。本轮代码、回归测试、性能探针和报告均与本说明一起提交；未合并主支线、未推送远端，也未生成新发行包。

## 接力起点

- 当前分支的原始提交：`8336306`（`feat: add document recovery, attachment backups, and DOCX export`）。它当时同时是 `origin/codex/recycle-cloud-docx-safety` 的头部。后续本地提交会领先远端；需要上传时先审核本地提交，再单独推送。
- 主支线当时为 `main` / `origin/main`，提交 `02988f9`。当前工作针对 feature branch；不要在接力时误切 `main`。
- 新提交包含本轮实现与文档，提交后用 `git log -1 --oneline` 查看准确提交号。
- 包版本仍是 `0.6.5`。原有安装包不包含本轮改动。原生验证二进制使用独立标识 `com.zeditor.validation20261020`，用于隔离用户应用配置。

## 本轮工作

### 文件保存、外部冲突与恢复

- 同一规范化文档路径的“比较版本 + 原子替换”现在由异步互斥锁串行执行，避免两个同时到达的保存都通过同一个旧指纹。不同文件不互相阻塞。
- 删除保存路径上重复的全文件读取/哈希；临时文件写入并同步后、替换目标前的版本比较仍是最终写入门槛。保存基准版本与写盘字节由端到端文件系统回归核对。
- 焦点检查合并同一标签的重叠请求；异步读盘返回后核对当前标签、路径、指纹和编辑器缓冲。冲突重载重新读取最新磁盘版本；读盘期间又产生本地编辑则保留本地输入，要求再次确认。
- 恢复订阅只写发生实质变化的草稿；失败保留待重试 ID；清空草稿可清理旧快照。没有有效指纹的旧格式命名快照恢复成无路径草稿，需另存，避免覆盖未知的磁盘版本。

### 回收站、云附件与 DOCX

- 回收站修复成功任务清理、旧版共享附件清理、UTF 编码异常误判、原生回收步骤中断和坏记录阻断等故障路径；Windows 同名冲突拒绝覆盖。
- WebDAV/S3 将资源清单与文件版本关联，校验内容后恢复。持久队列按原任务完成，不删除并发期间新产生的任务。S3 自定义端口进入 Host 签名。
- DOCX 表格行判定改为线性扫描；图片按最多 4 个并发读取、每次导出内去重，仍按文档原有顺序写出。修复仅设置高度的图片比例。
- HTML/PDF/DOCX 导出先同步编辑器缓冲，再捕获不可变内容快照；路径选择后才做重型 HTML 渲染。HTML 图片实体/URL 只解码一次；原生媒体路径与 DOM 图片 URL 使用分开的解析与缓存语义。
- PDF 关闭事件调用本机浏览器 WebSocket 的 `Browser.close`，不依赖 tab 是否创建，并阻止退出期间另起浏览器。
- 补入 Tauri IPC 所需的 CSP 来源，解决实际 WebView 控制台发现的原生调用被拦截。

### 性能测量结论

| 操作 | 前后结果 | 解读 |
| --- | --- | --- |
| 保存 5 MiB UTF-8 | 1105 → 731ms | Debug 暖缓存、文件系统命令耗时，不含 UI、IPC |
| 500 KiB 混合表格对照模式完整渲染 | 7501 → 5142ms | 实际前端，内存文档，渲染就绪代理，不含启动/读盘 |
| DOCX 5000 行表格 | 1507 → 455ms | Node 导出和打包中位数 |
| 8 张不同图片，每张注入 40ms 延迟 | 385 → 107ms | 受控读取延迟夹具，不代表公网图床耗时 |
| 6 标签中编辑 1 个的恢复快照订阅 | 6 次、252653 字节 → 1 次、42128 字节 | React 订阅和内存 IPC 计数，不代表实际磁盘时延 |

极大所见即所得表格样稿（9370 块）最终完整渲染仍需约 27 秒，并有长帧；仍应是性能下一步重点。GB18030 大文稿保存仍慢。没有 Release 安装版的同机冷启动/打开/保存/导出全链路比较，也没有同场对比竞品。

## 验证状态

- `npm test`：725 通过、0 失败；`npm run lint`、`npm run build` 通过。
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 通过。
- 严格 Clippy（所有 target、`-D warnings`）通过。
- `cargo test --locked`：236 通过、0 失败、6 默认忽略。单独以原生浏览器进程执行 tabless shutdown 生命周期探针，1 项通过。
- Windows 独立标识的 Tauri/WebView2 原生套件最新执行 8 项全通过、页面异常 0 项：强杀恢复、第二进程文件冲突、特殊附件文件名、WebDAV 上传/离线图片还原、菜单 HTML/PDF/DOCX、明确放弃清理和 PDF 正常/进行中退出。
- 最新原生套件**跳过**系统回收确认窗口场景，以免无人值守地代替用户操作 Windows 确认框。此前完整套件 7 项通过并包含真实 Windows 回收、同名文件保护与按 ID 还原；结果在 `test-output/reliability/desktop-run.log`。需要再次复现时，应让操作者处理只涉及临时夹具的系统确认框。
- 最新 PDF 还通过 PyMuPDF 核对中文标题、最后一次输入、嵌入图片解码像素与原图相等。
- 真实云账户/跨设备、Office/WPS 视觉分页、macOS/Linux 原生安装与回收均未验收。Word 的公式/图表降级说明继续有效；“支持原生 docx”不等于 Office 页面与预览像素完全一致。

详细证据与性能口径：[深入验证与性能改进报告](reviews/2026-10-20-reliability-performance.md)。产品/用户路线：[产品与用户评估](reviews/2026-10-19-product-user-assessment.md) §10–11。

## 重跑命令

前端：

```powershell
npm test
npm run lint
npm run build
```

Rust/Windows 桌面构建：本机 Rust 1.95 stable、rustfmt 和 C++ Build Tools 在此环境已修复/安装。当前 PowerShell 先载入：

```powershell
$vcEnvironment = cmd /d /s /c '""D:\Software\ZeditorBuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul && set"'
foreach ($line in $vcEnvironment) {
  if ($line -match '^([^=]+)=(.*)$') { Set-Item -Path "Env:$($matches[1])" -Value $matches[2] }
}
$env:CARGO_HTTP_PROXY = ''
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --config 'source.crates-io.replace-with="zeditor-rsproxy"' --config 'source.zeditor-rsproxy.registry="sparse+https://rsproxy.cn/index/"' --manifest-path src-tauri/Cargo.toml --locked --offline --all-targets -- -D warnings
cargo --config 'source.crates-io.replace-with="zeditor-rsproxy"' --config 'source.zeditor-rsproxy.registry="sparse+https://rsproxy.cn/index/"' test --manifest-path src-tauri/Cargo.toml --locked --offline
```

构建隔离的原生验证程序（不会打发行包）：

```powershell
npm run tauri -- build --debug --no-bundle --no-sign --ci --config scripts/fixtures/tauri-validation.conf.json -- --locked --offline --config 'source.crates-io.replace-with="zeditor-rsproxy"' --config 'source.zeditor-rsproxy.registry="sparse+https://rsproxy.cn/index/"'
$env:PLAYWRIGHT_MODULE_PATH = 'C:/Users/zhcx/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs'
node scripts/verify-desktop-reliability.mjs
```

完整复跑如遇 Windows 系统确认，需在系统窗口明确处理临时测试文件。只运行除系统回收外的原生流程，可设置 `$env:ZEDITOR_DESKTOP_SKIP_RECYCLE='1'`；浏览器退出专项可设置 `$env:ZEDITOR_DESKTOP_PDF_EXIT_ONLY='1'`。基准脚本在 `scripts/benchmark-*.mjs`；浏览器测量需要相应 Vite 页面，样本和排除范围写在脚本的 JSON 结果内。

Cargo 镜像参数只用于上述单条进程命令，未修改用户全局 Cargo 配置或 Cargo.lock。`test-output/` 日志、fixtures、临时桌面配置、修复记录和 PDF 像素 JSON 在本机忽略目录，未纳入 Git；CSV 基准、可复现脚本和隔离 Tauri 配置已提交。

## 建议的下一步

1. 对独立临时云账户做跨电脑新目录恢复和离线阅读验收，并加断网、附件变更与旧版本案例。
2. 用实际目标 Office/WPS 版本检查复杂稿件分页、目录、脚注、图表和降级提示。
3. 对 9370 块密集表格与 GB18030 大文件做 CPU/布局剖析，重复同一脚本测量。
4. 固定机器、样稿和阅读器，测 Release 包冷启动、文稿打开、保存、DOCX/PDF 导出，再决定稳定的性能预算。
5. 再安排发行包、签名/安装验收和该分支是否推送/提 PR；目前没有新的安装包或远端提交。
