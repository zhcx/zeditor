use crate::image::{self, CloudinaryConfig, ImageService, LocalImageConfig, PicGoConfig, S3Config};
use base64::{engine::general_purpose, Engine as _};
use font_kit::source::SystemSource;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[tauri::command]
pub fn reveal_in_file_manager(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err(format!("文件不存在：{}", target.display()));
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .arg(format!("/select,{}", target.display()))
            .spawn()
            .map_err(|error| format!("无法在文件夹中显示文件：{error}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|error| format!("无法在 Finder 中显示文件：{error}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let parent = target.parent().unwrap_or(&target);
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|error| format!("无法打开文件夹：{error}"))?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateInfo {
    pub has_update: bool,
    pub current_version: String,
    pub latest_version: String,
    pub download_url: String,
    pub asset_download_url: String,
    pub asset_name: String,
    pub asset_size: u64,
    pub auto_install_supported: bool,
    pub release_notes: String,
    pub published_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentFile {
    pub path: String,
    pub title: String,
    pub last_opened: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub children: Option<Vec<FileNode>>,
}

fn default_history_retention_days() -> u32 {
    30
}

fn default_explorer_auto_refresh() -> bool {
    true
}

fn default_refresh_interval_seconds() -> u32 {
    5
}

/// 资源管理器设置。前端 `Settings.explorer` 的持久化载体：此前 Rust 端
/// 没有对应字段，保存时被静默丢弃，导致桌面端重启后自动刷新等设置回退默认。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExplorerSettings {
    #[serde(default = "default_history_retention_days")]
    pub history_retention_days: u32,
    #[serde(default = "default_explorer_auto_refresh")]
    pub auto_refresh: bool,
    #[serde(default = "default_refresh_interval_seconds")]
    pub refresh_interval_seconds: u32,
}

impl Default for ExplorerSettings {
    fn default() -> Self {
        Self {
            history_retention_days: default_history_retention_days(),
            auto_refresh: default_explorer_auto_refresh(),
            refresh_interval_seconds: default_refresh_interval_seconds(),
        }
    }
}

/// MCP 集成设置（设置 → 集成）：桥接总开关、随应用启动、自动批准 AI 修改。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct McpSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub auto_start: bool,
    #[serde(default)]
    pub auto_approve: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowSettings {
    #[serde(default = "default_true")]
    pub render_in_preview: bool,
    #[serde(default = "default_true")]
    pub preserve_format: bool,
}

impl Default for WorkflowSettings {
    fn default() -> Self {
        Self {
            render_in_preview: true,
            preserve_format: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub appearance: AppearanceSettings,
    pub editor: EditorSettings,
    pub image_hosting: ImageHostingSettings,
    pub export: ExportSettings,
    pub ai: AISettings,
    #[serde(default)]
    pub agent: AgentSettings,
    #[serde(default)]
    pub web_search: WebSearchSettings,
    #[serde(default)]
    pub webdav: WebDavSettings,
    #[serde(default)]
    pub s3: S3Settings,
    #[serde(default)]
    pub explorer: ExplorerSettings,
    #[serde(default)]
    pub mcp: McpSettings,
    #[serde(default)]
    pub workflow: WorkflowSettings,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentBackendConfig {
    #[serde(default)]
    pub executable_path: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub profile: String,
    #[serde(default)]
    pub reasoning_effort: String,
    /// 启用/停用该后端：缺省视为启用；停用后不参与 Agent 面板选择与本地桥接。
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSettings {
    pub enabled: bool,
    pub backend: String,
    pub backends: std::collections::HashMap<String, AgentBackendConfig>,
}

impl Default for AgentSettings {
    fn default() -> Self {
        let backends = ["claude_code", "codex", "opencode"]
            .into_iter()
            .map(|id| (id.to_string(), AgentBackendConfig::default()))
            .collect();
        Self {
            enabled: false,
            backend: "claude_code".into(),
            backends,
        }
    }
}

fn default_ui_font_family() -> String {
    "Microsoft YaHei".into()
}

/// Returns the font families registered with the operating system.
/// Desktop WebViews do not consistently expose `window.queryLocalFonts()`.
#[tauri::command]
pub fn get_local_font_families() -> Result<Vec<String>, String> {
    let source = SystemSource::new();
    let mut families = source
        .all_families()
        .map_err(|error| format!("Unable to read system fonts: {error}"))?;

    families.retain(|family| !family.trim().is_empty());
    families.sort_by_cached_key(|family| family.to_lowercase());
    families.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
    Ok(families)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppearanceSettings {
    pub theme: String,
    /// None means the frontend should choose from the operating-system locale.
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default = "default_ui_font_family")]
    pub ui_font_family: String,
    #[serde(default = "default_ui_font_size")]
    pub ui_font_size: u32,
    #[serde(default = "default_letter_spacing")]
    pub letter_spacing: f32,
    pub font_family: String,
    pub font_size: u32,
    pub line_height: f32,
}

fn default_ui_font_size() -> u32 {
    13
}
fn default_letter_spacing() -> f32 {
    0.6
}

fn default_favorite_emojis() -> Vec<String> {
    ["😀", "👍", "❤️", "🎉", "✅", "⚠️", "💡", "🚀"]
        .iter()
        .map(|value| (*value).into())
        .collect()
}

fn default_smart_pairs() -> bool {
    true
}

fn default_check_local_links() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditorSettings {
    pub auto_save_interval: u32,
    pub spell_check: bool,
    pub auto_complete: bool,
    #[serde(default = "default_smart_pairs")]
    pub smart_pairs: bool,
    #[serde(default = "default_favorite_emojis")]
    pub favorite_emojis: Vec<String>,
    #[serde(default)]
    pub input_engine: EditorInputEngine,
    #[serde(default)]
    pub pin_toolbar: bool,
    /// 链接检查开关：Markdown 检查时验证本地链接与图片是否存在（默认开启）。
    #[serde(default = "default_check_local_links")]
    pub check_local_links: bool,
    #[serde(default = "default_true")]
    pub inline_popups: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EditorInputEngine {
    #[default]
    EditContext,
    Textarea,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageHostingSettings {
    pub active_service: String,
    pub cloudinary: CloudinaryConfig,
    pub picgo: PicGoConfig,
    pub s3: S3Config,
    pub local: LocalImageConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportSettings {
    pub pdf_margin: f32,
    pub html_template: String,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AISettings {
    pub enabled: bool,
    pub provider: String,
    pub api_key: String,
    pub api_endpoint: String,
    pub model: String,
    pub temperature: f32,
    pub auto_suggest: bool,
    pub suggest_delay: u32,
    pub writing_style: String,
    pub custom_style_prompt: String,
    pub provider_api_keys: String,
    #[serde(default)]
    pub provider_profiles: String,
    #[serde(default = "default_true")]
    pub proofread_with_ai: bool,
    /// 校对引擎：true 时强制走本机 AI Agent（单次调用整篇），不走 AI 助手 API。
    #[serde(default)]
    pub proofread_use_agent: bool,
    /// 伴写引擎：true 时强制走本机 AI Agent，不走 AI 助手 API。
    #[serde(default)]
    pub companion_use_agent: bool,
    /// 本地 Agent 后备总开关：AI 助手未配置时是否自动改用本机 AI Agent；
    /// 关闭后 AI 未配置直接报错，不再调用本机 CLI。
    #[serde(default = "default_true")]
    pub agent_fallback_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSearchSettings {
    pub enabled: bool,
    pub provider: String,
    pub tavily_api_key: String,
    pub tavily_search_depth: String,
    pub tavily_include_answer: bool,
    pub tavily_max_results: u32,
    pub searxng_url: String,
    pub searxng_api_key: String,
    pub searxng_language: String,
    pub searxng_categories: String,
    pub searxng_safesearch: u8,
    pub searxng_time_range: String,
    pub searxng_max_results: u32,
}

impl Default for WebSearchSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: "tavily".into(),
            tavily_api_key: String::new(),
            tavily_search_depth: "basic".into(),
            tavily_include_answer: true,
            tavily_max_results: 5,
            searxng_url: "http://localhost:8080".into(),
            searxng_api_key: String::new(),
            searxng_language: "auto".into(),
            searxng_categories: "general".into(),
            searxng_safesearch: 1,
            searxng_time_range: String::new(),
            searxng_max_results: 5,
        }
    }
}

pub use crate::webdav::{S3Settings, WebDavSettings};

impl Default for Settings {
    fn default() -> Self {
        Settings {
            appearance: AppearanceSettings {
                theme: "vscode-dark".into(),
                language: None,
                ui_font_family: default_ui_font_family(),
                ui_font_size: default_ui_font_size(),
                letter_spacing: default_letter_spacing(),
                font_family: "Microsoft YaHei".into(),
                font_size: 14,
                line_height: 1.6,
            },
            editor: EditorSettings {
                auto_save_interval: 30000,
                spell_check: false,
                auto_complete: true,
                smart_pairs: true,
                favorite_emojis: default_favorite_emojis(),
                input_engine: EditorInputEngine::default(),
                pin_toolbar: false,
                check_local_links: default_check_local_links(),
                inline_popups: true,
            },
            image_hosting: ImageHostingSettings {
                active_service: "local".into(),
                cloudinary: CloudinaryConfig {
                    cloud_name: String::new(),
                    api_key: String::new(),
                    api_secret: String::new(),
                    upload_folder: Some(String::new()),
                },
                picgo: PicGoConfig {
                    server_url: "http://127.0.0.1:36677".into(),
                    use_cli: false,
                    cli_path: None,
                },
                s3: S3Config {
                    provider: "aliyun-oss".into(),
                    endpoint: String::new(),
                    bucket: String::new(),
                    region: String::new(),
                    access_key: String::new(),
                    secret_key: String::new(),
                    custom_path: None,
                    use_ssl: true,
                },
                local: LocalImageConfig {
                    save_directory: "./assets/images".into(),
                    naming_rule: "timestamp".into(),
                },
            },
            export: ExportSettings {
                pdf_margin: 20.0,
                html_template: "default".into(),
            },
            ai: AISettings {
                enabled: false,
                provider: "openai".into(),
                api_key: String::new(),
                api_endpoint: "https://api.openai.com/v1".into(),
                model: "gpt-4o-mini".into(),
                temperature: 0.7,
                auto_suggest: false,
                suggest_delay: 2000,
                writing_style: "formal".into(),
                custom_style_prompt: String::new(),
                provider_api_keys: "{}".into(),
                provider_profiles: "{}".into(),
                proofread_with_ai: true,
                proofread_use_agent: false,
                companion_use_agent: false,
                agent_fallback_enabled: true,
            },
            agent: AgentSettings::default(),
            web_search: WebSearchSettings {
                enabled: false,
                provider: "tavily".into(),
                tavily_api_key: String::new(),
                tavily_search_depth: "basic".into(),
                tavily_include_answer: true,
                tavily_max_results: 5,
                searxng_url: "http://localhost:8080".into(),
                searxng_api_key: String::new(),
                searxng_language: "auto".into(),
                searxng_categories: "general".into(),
                searxng_safesearch: 1,
                searxng_time_range: String::new(),
                searxng_max_results: 5,
            },
            webdav: WebDavSettings::default(),
            s3: S3Settings::default(),
            explorer: ExplorerSettings::default(),
            mcp: McpSettings::default(),
            workflow: WorkflowSettings::default(),
        }
    }
}

fn app_config_file(app: &AppHandle, file_name: &str) -> Result<PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("无法定位应用配置目录：{error}"))?;
    std::fs::create_dir_all(&config_dir)
        .map_err(|error| format!("无法创建应用配置目录：{error}"))?;
    Ok(config_dir.join(file_name))
}

/// 写一行日志到系统临时目录下的 zeditor_crash.log，用于诊断崩溃
pub fn log_to_file(msg: &str) {
    let log_path = std::env::temp_dir().join("zeditor_crash.log");
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        let _ = writeln!(
            f,
            "[{}] {}",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
            msg
        );
    }
}

#[tauri::command]
pub async fn get_settings(app: AppHandle) -> Result<Settings, String> {
    let path = app_config_file(&app, "settings.json")?;
    if path.exists() {
        Ok(
            serde_json::from_str(&std::fs::read_to_string(path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?,
        )
    } else {
        let s = Settings::default();
        save_settings_inner(&app, &s)?;
        Ok(s)
    }
}

/// 启动时读取设置（无副作用：不创建默认设置文件）。
pub fn load_settings_for_startup(app: &AppHandle) -> Settings {
    let Ok(path) = app_config_file(app, "settings.json") else {
        return Settings::default();
    };
    if !path.exists() {
        return Settings::default();
    }
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn save_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    save_settings_inner(&app, &settings)
}

fn save_settings_inner(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = app_config_file(app, "settings.json")?;
    std::fs::write(
        path,
        serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn upload_image(
    file_path: String,
    service: String,
    settings: Settings,
) -> Result<String, String> {
    let image_service = match service.as_str() {
        "cloudinary" => ImageService::Cloudinary(settings.image_hosting.cloudinary),
        "picgo" => ImageService::PicGo(settings.image_hosting.picgo),
        "s3" => ImageService::S3(settings.image_hosting.s3),
        "local" => ImageService::Local(settings.image_hosting.local),
        _ => return Err(format!("Unknown image service: {}", service)),
    };
    image::upload(&file_path, image_service)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn upload_image_bytes(
    data_base64: String,
    extension: String,
    service: String,
    settings: Settings,
) -> Result<String, String> {
    const MAX_CLIPBOARD_IMAGE_BYTES: usize = 20 * 1024 * 1024;
    let safe_extension = match extension.to_ascii_lowercase().as_str() {
        "png" => "png",
        "jpg" | "jpeg" => "jpg",
        "gif" => "gif",
        "webp" => "webp",
        "bmp" => "bmp",
        // SVG 走矢量格式；预览对内联 SVG 做净化，<img> 上下文不执行脚本。
        "svg" => "svg",
        _ => return Err("Unsupported clipboard image format".into()),
    };
    if data_base64.len() > (MAX_CLIPBOARD_IMAGE_BYTES * 4 / 3) + 4 {
        return Err("Clipboard image is larger than the 20 MB limit".into());
    }
    let bytes = general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|error| format!("Invalid clipboard image data: {error}"))?;
    if bytes.len() > MAX_CLIPBOARD_IMAGE_BYTES {
        return Err("Clipboard image is larger than the 20 MB limit".into());
    }
    let temp_path = std::env::temp_dir().join(format!(
        "zeditor-paste-{}.{}",
        uuid::Uuid::new_v4(),
        safe_extension
    ));
    tokio::fs::write(&temp_path, bytes)
        .await
        .map_err(|error| format!("Failed to prepare clipboard image: {error}"))?;

    let result = upload_image(temp_path.to_string_lossy().into_owned(), service, settings).await;
    let _ = tokio::fs::remove_file(&temp_path).await;
    result
}

// ── Image embedding ────────────────────────────────────
// 实现已抽取到 crate::imaging，与 PDF 导出共享（此前两份实现漂移，
// 且本文件版本会在 <img> 无 src 时错误匹配到后续标签的属性）。
use crate::imaging::{embed_images, file_url_from_path, guess_mime};

// ── HTML page wrapper ──────────────────────────────────

fn wrap_html_page(body: &str, margin_mm: f32) -> String {
    format!(
        r##"<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Zeditor Export</title>
<style>
@page {{ margin: {margin}mm; }}
* {{ box-sizing: border-box; }}
body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Microsoft YaHei", sans-serif; font-size: 16px; line-height: 1.6; color: #333; max-width: 900px; margin: 0 auto; padding: 20px; }}
h1, h2, h3, h4, h5, h6 {{ margin-top: 24px; margin-bottom: 16px; font-weight: 600; line-height: 1.25; }}
h1 {{ font-size: 2em; border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; }}
h2 {{ font-size: 1.5em; border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; }}
h3 {{ font-size: 1.25em; }}
p {{ margin-top: 0; margin-bottom: 16px; }}
code {{ background-color: rgba(27,31,35,0.05); border-radius: 3px; font-family: "SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace; font-size: 85%; padding: 0.2em 0.4em; }}
pre {{ background-color: #f6f8fa; border-radius: 6px; font-size: 85%; line-height: 1.45; overflow: auto; padding: 16px; white-space: pre-wrap; word-wrap: break-word; }}
pre code {{ background-color: transparent; border: 0; padding: 0; }}
blockquote {{ border-left: 0.25em solid #dfe2e5; color: #6a737d; margin: 0 0 16px 0; padding: 0 1em; }}
table {{ border-collapse: collapse; width: 100%; margin-bottom: 16px; }}
table th, table td {{ border: 1px solid #dfe2e5; padding: 6px 13px; }}
table tr:nth-child(2n) {{ background-color: #f6f8fa; }}
img {{ max-width: 100%; height: auto; }}
ul, ol {{ padding-left: 2em; margin-bottom: 16px; }}
a {{ color: #0366d6; text-decoration: none; word-wrap: break-word; overflow-wrap: break-word; word-break: break-all; }}
a:hover {{ text-decoration: underline; }}
@media print {{
    body {{ padding: 0; }}
    pre {{ white-space: pre-wrap; word-wrap: break-word; }}
    a {{ word-wrap: break-word; overflow-wrap: break-word; word-break: break-all; }}
}}
</style>
</head>
<body>
{body}
<script>window.onload = function() {{ setTimeout(function() {{ window.print(); }}, 500); }};</script>
</body>
</html>"##,
        margin = margin_mm,
        body = body
    )
}

fn wrap_word_page(body: &str, margin_mm: f32) -> String {
    format!(
        r##"<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="UTF-8">
<meta name="ProgId" content="Word.Document">
<meta name="Generator" content="Zeditor">
<meta name="Originator" content="Zeditor">
<title>Zeditor Export</title>
<!--[if gte mso 9]>
<xml>
  <w:WordDocument>
    <w:View>Print</w:View>
    <w:Zoom>100</w:Zoom>
    <w:DoNotOptimizeForBrowser/>
  </w:WordDocument>
</xml>
<![endif]-->
<style>
@page Section1 {{ margin: {margin}mm; }}
div.Section1 {{ page: Section1; }}
body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Microsoft YaHei", sans-serif; font-size: 12pt; line-height: 1.6; color: #333; }}
h1, h2, h3, h4, h5, h6 {{ margin-top: 18pt; margin-bottom: 10pt; font-weight: 600; line-height: 1.25; }}
h1 {{ font-size: 22pt; border-bottom: 1px solid #eaecef; padding-bottom: 4pt; }}
h2 {{ font-size: 18pt; border-bottom: 1px solid #eaecef; padding-bottom: 4pt; }}
h3 {{ font-size: 15pt; }}
p {{ margin-top: 0; margin-bottom: 10pt; }}
code {{ background-color: #f6f8fa; font-family: Consolas, "Courier New", monospace; font-size: 10pt; }}
pre {{ background-color: #f6f8fa; border: 1px solid #dfe2e5; padding: 10pt; white-space: pre-wrap; word-wrap: break-word; font-family: Consolas, "Courier New", monospace; font-size: 10pt; }}
blockquote {{ border-left: 3pt solid #dfe2e5; color: #6a737d; margin: 0 0 10pt 0; padding: 0 0 0 10pt; }}
table {{ border-collapse: collapse; width: 100%; margin-bottom: 10pt; }}
table th, table td {{ border: 1px solid #dfe2e5; padding: 5pt 8pt; }}
table tr:nth-child(2n) {{ background-color: #f6f8fa; }}
img {{ max-width: 100%; height: auto; }}
ul, ol {{ margin-bottom: 10pt; }}
a {{ color: #0366d6; text-decoration: none; }}
</style>
</head>
<body>
<div class="Section1">
{body}
</div>
</body>
</html>"##,
        margin = margin_mm,
        body = body
    )
}

// ── Commands ───────────────────────────────────────────

#[tauri::command]
pub async fn export_html(
    html_body: String,
    settings: ExportSettings,
    file_path: Option<String>,
) -> Result<String, String> {
    // 图片内嵌是同步磁盘 IO，放到阻塞线程池执行。
    let with_images =
        tokio::task::spawn_blocking(move || embed_images(&html_body, file_path.as_deref()))
            .await
            .map_err(|e| e.to_string())?;
    Ok(wrap_html_page(&with_images, settings.pdf_margin))
}

#[tauri::command]
pub async fn export_word(
    html_body: String,
    settings: ExportSettings,
    file_path: Option<String>,
) -> Result<String, String> {
    let with_images =
        tokio::task::spawn_blocking(move || embed_images(&html_body, file_path.as_deref()))
            .await
            .map_err(|e| e.to_string())?;
    Ok(wrap_word_page(&with_images, settings.pdf_margin))
}

#[tauri::command]
pub async fn export_pdf(
    html_body: String,
    settings: ExportSettings,
    file_path: Option<String>,
) -> Result<String, String> {
    let with_images =
        tokio::task::spawn_blocking(move || embed_images(&html_body, file_path.as_deref()))
            .await
            .map_err(|e| e.to_string())?;
    let full = wrap_html_page(&with_images, settings.pdf_margin);
    let temp_dir = std::env::temp_dir();
    let temp_html = temp_dir.join(format!("zeditor_export_{}.html", uuid::Uuid::new_v4()));
    std::fs::write(&temp_html, full).map_err(|e| format!("{}", e))?;
    // Return as file:// URL so the shell plugin can open it.
    // 路径必须百分号编码：含空格/#/中文的路径直接拼接会产生无效 URL。
    Ok(file_url_from_path(&temp_html))
}

async fn read_utf8_text_file(path: &str, max_bytes: Option<u64>) -> Result<String, String> {
    if let Some(limit) = max_bytes {
        let size = tokio::fs::metadata(path)
            .await
            .map_err(|e| e.to_string())?
            .len();
        if size > limit {
            return Err(format!(
                "文件过大（{} MB），当前操作最多支持 {} MB。",
                size / 1_048_576,
                limit / 1_048_576
            ));
        }
    }
    let bytes = tokio::fs::read(path).await.map_err(|e| e.to_string())?;
    if max_bytes.is_some_and(|limit| bytes.len() as u64 > limit) {
        return Err("读取过程中检测到文件大小超出限制。".into());
    }
    let content = String::from_utf8(bytes)
        .map_err(|_| "文件不是 UTF-8 编码，请先转换为 UTF-8 后再打开。".to_string())?;
    Ok(content
        .strip_prefix('\u{feff}')
        .unwrap_or(&content)
        .to_string())
}

async fn write_utf8_text_file(path: &str, content: &str) -> Result<(), String> {
    write_file_bytes_atomic(path, content.as_bytes()).await
}

async fn write_file_bytes_atomic(path: &str, content: &[u8]) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let mut target = PathBuf::from(path);
    // 保留已有符号链接的语义，替换实际文档而不是链接本身。
    let metadata = match tokio::fs::symlink_metadata(&target).await {
        Ok(meta) => {
            if meta.file_type().is_symlink() {
                target = tokio::fs::canonicalize(&target)
                    .await
                    .map_err(|e| e.to_string())?;
                Some(
                    tokio::fs::metadata(&target)
                        .await
                        .map_err(|e| e.to_string())?,
                )
            } else {
                Some(meta)
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.to_string()),
    };
    if let Some(meta) = &metadata {
        if !meta.is_file() || meta.permissions().readonly() {
            return Err("目标不是可写文件，原文档未修改。".into());
        }
    }
    // 同目录的临时文件确保最终重命名位于同一文件系统；写入失败保留原文档。
    let temporary = target.with_file_name(format!(".zeditor-save-{}.tmp", uuid::Uuid::new_v4()));
    let result = async {
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .await?;
        file.write_all(content).await?;
        file.sync_all().await?;
        drop(file);
        if let Some(meta) = metadata {
            tokio::fs::set_permissions(&temporary, meta.permissions()).await?;
        }
        tokio::fs::rename(&temporary, &target).await
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    result.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_file_content(path: String) -> Result<String, String> {
    read_utf8_text_file(&path, None).await
}

#[tauri::command]
pub async fn read_text_document(
    path: String,
    encoding: Option<String>,
) -> Result<crate::text_encoding::TextDocument, String> {
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|error| error.to_string())?;
    crate::text_encoding::decode_text(&bytes, encoding.as_deref())
}

#[tauri::command]
pub async fn decode_text_document(
    data_base64: String,
    encoding: Option<String>,
) -> Result<crate::text_encoding::TextDocument, String> {
    let bytes = general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|_| "文件数据不是有效的 Base64".to_string())?;
    crate::text_encoding::decode_text(&bytes, encoding.as_deref())
}

#[tauri::command]
pub async fn save_file_bytes(path: String, data_base64: String) -> Result<(), String> {
    let bytes = general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|_| "文件数据不是有效的 Base64".to_string())?;
    write_file_bytes_atomic(&path, &bytes).await
}

#[tauri::command]
pub async fn get_text_attachment_content(path: String) -> Result<String, String> {
    const MAX_TEXT_ATTACHMENT_BYTES: u64 = 2 * 1024 * 1024;
    read_utf8_text_file(&path, Some(MAX_TEXT_ATTACHMENT_BYTES)).await
}

#[tauri::command]
pub async fn read_file_base64(path: String) -> Result<String, String> {
    const MAX_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024;
    let size = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("读取文件失败: {}", e))?
        .len();
    if size > MAX_ATTACHMENT_BYTES {
        return Err("附件过大，图片附件最多支持 20 MB。".into());
    }
    let data = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("读取文件失败: {}", e))?;
    if data.len() as u64 > MAX_ATTACHMENT_BYTES {
        return Err("读取过程中检测到附件大小超出 20 MB。".into());
    }
    let mime = guess_mime(Path::new(&path));
    let b64 = general_purpose::STANDARD.encode(&data);
    Ok(format!("data:{};base64,{}", mime, b64))
}
#[tauri::command]
pub async fn save_file_content(
    path: String,
    content: String,
    encoding: Option<String>,
) -> Result<(), String> {
    if encoding.as_deref().unwrap_or("utf-8") == "utf-8" {
        return write_utf8_text_file(&path, &content).await;
    }
    // 编码完成后才进入原子保存，不能表示的字符不会污染原文件。
    let bytes =
        crate::text_encoding::encode_text(&content, encoding.as_deref().unwrap_or("utf-8"))?;
    write_file_bytes_atomic(&path, &bytes).await
}

fn get_recent_files_path(app: &AppHandle) -> Result<PathBuf, String> {
    app_config_file(app, "recent_files.json")
}
static RECENT_FILES_LOCK: Mutex<()> = Mutex::new(());

#[tauri::command]
pub async fn get_recent_files(app: AppHandle) -> Result<Vec<RecentFile>, String> {
    let _guard = RECENT_FILES_LOCK
        .lock()
        .map_err(|_| "最近文件记录锁已损坏".to_string())?;
    let p = get_recent_files_path(&app)?;
    Ok(if p.exists() {
        serde_json::from_str(&std::fs::read_to_string(p).map_err(|e| e.to_string())?)
            .unwrap_or_default()
    } else {
        Vec::new()
    })
}
#[tauri::command]
pub async fn update_recent_file(
    app: AppHandle,
    path: String,
    title: String,
) -> Result<Vec<RecentFile>, String> {
    let _guard = RECENT_FILES_LOCK
        .lock()
        .map_err(|_| "最近文件记录锁已损坏".to_string())?;
    let rp = get_recent_files_path(&app)?;
    let mut recent: Vec<RecentFile> = if rp.exists() {
        serde_json::from_str(&std::fs::read_to_string(&rp).map_err(|e| e.to_string())?)
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    recent.retain(|f| f.path != path);
    recent.insert(
        0,
        RecentFile {
            path,
            title,
            last_opened: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        },
    );
    recent.truncate(20);
    std::fs::write(
        &rp,
        serde_json::to_string_pretty(&recent).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(recent)
}
#[tauri::command]
pub async fn remove_recent_file(app: AppHandle, path: String) -> Result<Vec<RecentFile>, String> {
    let _guard = RECENT_FILES_LOCK
        .lock()
        .map_err(|_| "最近文件记录锁已损坏".to_string())?;
    let rp = get_recent_files_path(&app)?;
    let mut recent: Vec<RecentFile> = if rp.exists() {
        serde_json::from_str(&std::fs::read_to_string(&rp).map_err(|e| e.to_string())?)
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    recent.retain(|f| f.path != path);
    std::fs::write(
        &rp,
        serde_json::to_string_pretty(&recent).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(recent)
}

fn is_workspace_file(name: &str) -> bool {
    let normalized = name.to_ascii_lowercase();
    if matches!(
        normalized.as_str(),
        "dockerfile" | "makefile" | "readme" | "license" | ".gitignore" | ".gitattributes"
    ) || normalized.starts_with(".env")
    {
        return true;
    }
    let extension = normalized.rsplit('.').next().unwrap_or("");
    if matches!(
        extension,
        "mdx"
            | "log"
            | "diff"
            | "patch"
            | "c"
            | "cc"
            | "cpp"
            | "cxx"
            | "h"
            | "hpp"
            | "cs"
            | "dart"
            | "ex"
            | "exs"
            | "fs"
            | "fsx"
            | "go"
            | "groovy"
            | "java"
            | "js"
            | "cjs"
            | "mjs"
            | "jsx"
            | "jl"
            | "kt"
            | "kts"
            | "lua"
            | "php"
            | "py"
            | "rb"
            | "rs"
            | "scala"
            | "swift"
            | "ts"
            | "cts"
            | "mts"
            | "tsx"
            | "vb"
            | "vue"
            | "svelte"
            | "css"
            | "scss"
            | "sass"
            | "less"
            | "sh"
            | "bash"
            | "zsh"
            | "fish"
            | "bat"
            | "cmd"
            | "ps1"
            | "sql"
            | "ini"
            | "cfg"
            | "conf"
            | "properties"
            | "toml"
            | "yaml"
            | "yml"
            | "tsv"
            | "text"
            | "jsonl"
            | "xhtml"
    ) {
        return true;
    }
    matches!(
        name.rsplit('.')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "md" | "markdown"
            | "txt"
            | "text"
            | "pdf"
            | "docx"
            | "pptx"
            | "xls"
            | "xlsx"
            | "html"
            | "htm"
            | "xhtml"
            | "csv"
            | "json"
            | "jsonl"
            | "xml"
            | "epub"
            | "zip"
            | "png"
            | "jpg"
            | "jpeg"
            | "wav"
            | "mp3"
            | "m4a"
            | "mp4"
            | "msg"
            | "rss"
            | "atom"
            | "ipynb"
    )
}

#[tauri::command]
pub async fn read_folder(path: String) -> Result<Vec<FileNode>, String> {
    // 打开的文件夹注册为授权根：后续删除/重命名/复制等破坏性命令
    // 仅允许作用于授权根内部（见 ensure_fs_authorized）。
    register_authorized_root(&path);
    tokio::task::spawn_blocking(move || {
        let mut nodes = Vec::new();
        for entry in std::fs::read_dir(&path).map_err(|e| e.to_string())? {
            let e = entry.map_err(|e| e.to_string())?;
            let m = e.metadata().map_err(|e| e.to_string())?;
            let name = e.file_name().to_string_lossy().to_string();
            if name == ".git" || name == "node_modules" || name == "target" {
                continue;
            }
            let is_dir = m.is_dir();
            if !is_dir && !is_workspace_file(&name) {
                continue;
            }
            nodes.push(FileNode {
                name,
                path: e.path().to_string_lossy().to_string(),
                is_directory: is_dir,
                children: if is_dir { Some(Vec::new()) } else { None },
            });
        }
        nodes.sort_by(|a, b| match (a.is_directory, b.is_directory) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });
        Ok(nodes)
    })
    .await
    .map_err(|error| format!("读取文件夹任务异常：{error}"))?
}

/// 已授权的文件操作根目录（进程内有效）。
/// 目的：即使 webview 发生脚本注入，invoke 破坏性文件命令也只能触达
/// 用户明确打开过的工作区文件夹，无法任意删除/改写系统文件。
static AUTHORIZED_FS_ROOTS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

fn lock_authorized_roots() -> std::sync::MutexGuard<'static, Vec<PathBuf>> {
    AUTHORIZED_FS_ROOTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn register_authorized_root(path: &str) {
    if let Ok(canonical) = std::fs::canonicalize(path) {
        let mut roots = lock_authorized_roots();
        if !roots.contains(&canonical) {
            roots.push(canonical);
            // 防御性上限，防止长期运行累积。
            if roots.len() > 16 {
                roots.remove(0);
            }
        }
    }
}

/// 目标路径不存在时（如重命名/新建的目标），规范化其父目录再拼接文件名。
fn canonicalize_or_parent(path: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(path);
    if let Ok(canonical) = std::fs::canonicalize(candidate) {
        return Ok(canonical);
    }
    let parent = candidate.parent().ok_or_else(|| "无效路径".to_string())?;
    let file_name = candidate
        .file_name()
        .ok_or_else(|| "无效路径".to_string())?;
    let parent = std::fs::canonicalize(parent).map_err(|e| format!("无法访问路径：{e}"))?;
    Ok(parent.join(file_name))
}

fn ensure_fs_authorized(path: &str, operation: &str) -> Result<(), String> {
    let canonical = canonicalize_or_parent(path)?;
    let roots = lock_authorized_roots();
    if roots.iter().any(|root| canonical.starts_with(root)) {
        Ok(())
    } else {
        Err(format!(
            "出于安全考虑，{operation} 仅允许作用于已通过资源管理器打开的文件夹内部"
        ))
    }
}

#[tauri::command]
pub async fn create_file(path: String, content: Option<String>) -> Result<(), String> {
    ensure_fs_authorized(&path, "新建文件")?;
    let parent = Path::new(&path)
        .parent()
        .ok_or_else(|| "无法获取父目录路径".to_string())?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|e| format!("创建父目录失败：{e}"))?;
    if let Some(text) = content {
        tokio::fs::write(&path, text.as_bytes())
            .await
            .map_err(|e| format!("创建文件失败：{e}"))?;
    } else {
        tokio::fs::write(&path, [])
            .await
            .map_err(|e| format!("创建文件失败：{e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn create_directory(path: String) -> Result<(), String> {
    ensure_fs_authorized(&path, "新建文件夹")?;
    tokio::fs::create_dir_all(&path)
        .await
        .map_err(|e| format!("创建文件夹失败：{e}"))
}

#[tauri::command]
pub async fn delete_fs_item(path: String) -> Result<(), String> {
    ensure_fs_authorized(&path, "删除")?;
    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("无法获取文件信息：{e}"))?;
    if meta.is_dir() {
        tokio::fs::remove_dir_all(&path)
            .await
            .map_err(|e| format!("删除文件夹失败：{e}"))
    } else {
        tokio::fs::remove_file(&path)
            .await
            .map_err(|e| format!("删除文件失败：{e}"))
    }
}

#[tauri::command]
pub async fn rename_fs_item(old_path: String, new_path: String) -> Result<(), String> {
    ensure_fs_authorized(&old_path, "重命名")?;
    ensure_fs_authorized(&new_path, "重命名")?;
    tokio::fs::rename(&old_path, &new_path)
        .await
        .map_err(|e| format!("重命名失败：{e}"))
}

/// 允许写入 `.assets` 的媒体扩展名，与前端 `MEDIA_FILE_EXTENSIONS` 保持一致。
const MEDIA_EXTENSIONS: [&str; 18] = [
    "mp4", "m4v", "webm", "ogv", "mov", "mkv", "avi", "wmv", "flv", "mp3", "m4a", "aac", "wav",
    "oga", "ogg", "opus", "flac", "weba",
];

/// 单个媒体文件的大小上限：再大的素材应通过外链引用。
const MAX_MEDIA_BYTES: u64 = 512 * 1024 * 1024;

/// 允许写入 `.assets` 的图片扩展名，与前端 `IMAGE_FILE_EXTENSIONS` 保持一致。
const IMAGE_EXTENSIONS: [&str; 12] = [
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico", "tif", "tiff", "heic",
];

/// 单张图片的大小上限：再大的素材应通过外链引用。
const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;

/// 媒体导入结果：绝对路径用于播放，相对路径写入 Markdown。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaAssetImport {
    pub file_name: String,
    pub absolute_path: String,
    pub relative_path: String,
    pub size: u64,
}

fn is_media_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| MEDIA_EXTENSIONS.contains(&value.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn is_image_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| IMAGE_EXTENSIONS.contains(&value.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn is_remote_media_source(source: &str) -> bool {
    source.starts_with("http://")
        || source.starts_with("https://")
        || source.starts_with("data:")
        || source.starts_with("blob:")
        || source.starts_with("asset:")
        || source.starts_with("//")
}

// Windows 的 canonicalize 会带 `\\?\` 前缀，前端 convertFileSrc 无法直接使用。
fn path_without_verbatim_prefix(path: &Path) -> String {
    let text = path.to_string_lossy().to_string();
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
}

fn sanitize_media_file_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => character,
        })
        .collect();
    let trimmed = cleaned.trim().to_string();
    if trimmed.is_empty() {
        "media".to_string()
    } else {
        trimmed
    }
}

fn document_dir_of(document_path: &str) -> Option<PathBuf> {
    let document = PathBuf::from(document_path);
    document
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(|parent| parent.to_path_buf())
}

/// 解析 `.assets` 目标目录：只允许文档同级下的单个目录名，避免 `..` 或绝对路径越权写入。
fn assets_target_dir(
    document_path: &str,
    assets_dir: Option<String>,
    label: &str,
) -> Result<(PathBuf, String), String> {
    let document_dir = document_dir_of(document_path)
        .ok_or_else(|| format!("请先保存文档，{label}文件将复制到文档同级的 .assets 目录"))?;
    let folder = assets_dir.unwrap_or_else(|| ".assets".to_string());
    let folder = folder.trim().to_string();
    let folder = if folder.is_empty() {
        ".assets".to_string()
    } else {
        folder
    };
    if folder.contains("..") || Path::new(&folder).is_absolute() {
        return Err(format!("{label}资源目录名称不合法"));
    }
    Ok((document_dir.join(&folder), folder))
}

/// 在目标目录里挑一个不冲突的文件名；同名同大小视为同一素材直接复用，避免重复导入产生副本。
async fn reserve_asset_name(
    target_dir: &Path,
    safe_name: &str,
    source_len: u64,
    label: &str,
) -> Result<String, String> {
    let (stem, extension) = match safe_name.rfind('.') {
        Some(index) if index > 0 => (
            safe_name[..index].to_string(),
            safe_name[index..].to_string(),
        ),
        _ => (safe_name.to_string(), String::new()),
    };

    let mut candidate = safe_name.to_string();
    let mut counter = 1u32;
    loop {
        let target = target_dir.join(&candidate);
        match tokio::fs::metadata(&target).await {
            Ok(existing) if existing.is_file() && existing.len() == source_len => break,
            Ok(_) => {
                candidate = format!("{stem}-{counter}{extension}");
                counter += 1;
                if counter > 999 {
                    return Err(format!("同名{label}文件过多，请重命名后再导入"));
                }
            }
            Err(_) => break,
        }
    }
    Ok(candidate)
}

/// 把外部媒体文件复制到文档同级的 `.assets` 目录，返回可直接引用的相对路径。
#[tauri::command]
pub async fn import_media_asset(
    source_path: String,
    document_path: String,
    assets_dir: Option<String>,
) -> Result<MediaAssetImport, String> {
    let source = PathBuf::from(&source_path);
    if !is_media_extension(&source) {
        return Err("仅支持导入视频或音频文件".to_string());
    }
    let source_meta = tokio::fs::metadata(&source)
        .await
        .map_err(|e| format!("无法读取媒体文件：{e}"))?;
    if !source_meta.is_file() {
        return Err("媒体源不是一个文件".to_string());
    }
    if source_meta.len() > MAX_MEDIA_BYTES {
        return Err("媒体文件超过 512MB，请改用外链引用".to_string());
    }

    let (target_dir, folder) = assets_target_dir(&document_path, assets_dir, "媒体")?;

    let original_name = source
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    let safe_name = sanitize_media_file_name(&original_name);
    let candidate = reserve_asset_name(&target_dir, &safe_name, source_meta.len(), "媒体").await?;

    tokio::fs::create_dir_all(&target_dir)
        .await
        .map_err(|e| format!("创建媒体资源目录失败：{e}"))?;
    let target_path = target_dir.join(&candidate);
    let same_file = tokio::fs::canonicalize(&source)
        .await
        .ok()
        .zip(tokio::fs::canonicalize(&target_path).await.ok())
        .map(|(left, right)| left == right)
        .unwrap_or(false);
    if !same_file {
        tokio::fs::copy(&source, &target_path)
            .await
            .map_err(|e| format!("复制媒体文件失败：{e}"))?;
    }

    Ok(MediaAssetImport {
        file_name: candidate.clone(),
        absolute_path: path_without_verbatim_prefix(&target_path),
        relative_path: format!("{folder}/{candidate}"),
        size: source_meta.len(),
    })
}

/// 把 Markdown 中的媒体引用解析为可播放的本地绝对路径；无法解析的位置返回 null。
#[tauri::command]
pub async fn resolve_media_sources(
    document_path: String,
    sources: Vec<String>,
) -> Result<Vec<Option<String>>, String> {
    let document_dir = document_dir_of(&document_path);
    let mut resolved = Vec::with_capacity(sources.len());

    for source in sources {
        let trimmed = source.trim();
        if trimmed.is_empty() || is_remote_media_source(trimmed) {
            resolved.push(None);
            continue;
        }
        let candidate = if Path::new(trimmed).is_absolute() {
            PathBuf::from(trimmed)
        } else {
            match &document_dir {
                Some(dir) => dir.join(trimmed.replace('\\', "/")),
                None => {
                    resolved.push(None);
                    continue;
                }
            }
        };
        match tokio::fs::metadata(&candidate).await {
            Ok(meta) if meta.is_file() => {
                resolved.push(Some(path_without_verbatim_prefix(&candidate)))
            }
            _ => resolved.push(None),
        }
    }

    Ok(resolved)
}

fn is_unc_path(value: &str) -> bool {
    value.starts_with("\\\\") || value.starts_with("//")
}

/// 驱动器相对路径（`C:file.md`）：相对应用工作目录而非文档位置，语义不明。
fn is_drive_relative_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && !matches!(bytes.get(2), Some(b'\\') | Some(b'/'))
}

/// Windows 根相对路径（`/docs/x.md`）：位于文档所在盘符的根目录。
fn is_windows_root_relative(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && matches!(bytes[0], b'/' | b'\\')
        && !matches!(bytes.get(1), Some(b'/') | Some(b'\\'))
}

/// 文档所在盘符前缀（`D:`）；文档位于 UNC 路径上时返回 None。
fn document_drive_prefix(document_path: &str) -> Option<String> {
    match Path::new(document_path).components().next() {
        Some(std::path::Component::Prefix(prefix)) => {
            let text = prefix.as_os_str().to_string_lossy().to_string();
            if text.starts_with("\\\\") {
                None
            } else {
                Some(text)
            }
        }
        _ => None,
    }
}

/// 链接检查：批量验证文档中的本地链接 / 图片目标是否存在。
///
/// 返回与 targets 等长的状态列表：`"file"` | `"dir"` | `"missing"` | `"error"`。
/// `"error"` 表示运行时无法判断（权限被拒、非法路径等），前端按「沉默优于错误」
/// 跳过；相对路径基于文档所在目录解析，UNC 网络路径永不查找。
#[tauri::command]
pub async fn check_link_targets(
    document_path: String,
    targets: Vec<String>,
) -> Result<Vec<String>, String> {
    let document_dir = document_dir_of(&document_path);
    let mut results = Vec::with_capacity(targets.len());

    for target in targets {
        let trimmed = target.trim();
        // UNC 网络路径会联系远端主机并可能泄露登录凭据；驱动器相对路径
        // （`C:file.md`）相对应用工作目录，两者都不做文件查找。
        if trimmed.is_empty() || is_unc_path(trimmed) || is_drive_relative_path(trimmed) {
            results.push("error".to_string());
            continue;
        }
        let candidate = if Path::new(trimmed).is_absolute() {
            PathBuf::from(trimmed)
        } else if is_windows_root_relative(trimmed) {
            // `/docs/x.md`：位于文档自身所在的驱动器（与 VMark 行为一致）。
            match document_drive_prefix(&document_path) {
                Some(prefix) => PathBuf::from(format!("{prefix}{trimmed}")),
                None => {
                    results.push("error".to_string());
                    continue;
                }
            }
        } else {
            match &document_dir {
                Some(dir) => dir.join(trimmed.replace('\\', "/")),
                None => {
                    results.push("error".to_string());
                    continue;
                }
            }
        };
        match tokio::fs::metadata(&candidate).await {
            Ok(meta) if meta.is_file() => results.push("file".to_string()),
            Ok(_) => results.push("dir".to_string()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                results.push("missing".to_string())
            }
            // 探测异常（权限、非法路径等）按「无法判断」处理，不误报缺失。
            Err(_) => results.push("error".to_string()),
        }
    }

    Ok(results)
}

/// 把外部图片复制到文档同级的 `.assets` 目录，返回可直接引用的相对路径。
#[tauri::command]
pub async fn import_image_asset(
    source_path: String,
    document_path: String,
    assets_dir: Option<String>,
) -> Result<MediaAssetImport, String> {
    let source = PathBuf::from(&source_path);
    if !is_image_extension(&source) {
        return Err("仅支持导入图片文件".to_string());
    }
    let source_meta = tokio::fs::metadata(&source)
        .await
        .map_err(|e| format!("无法读取图片文件：{e}"))?;
    if !source_meta.is_file() {
        return Err("图片源不是一个文件".to_string());
    }
    if source_meta.len() > MAX_IMAGE_BYTES {
        return Err("图片文件超过 64MB，请改用外链引用".to_string());
    }

    let (target_dir, folder) = assets_target_dir(&document_path, assets_dir, "图片")?;
    let original_name = source
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    let safe_name = sanitize_media_file_name(&original_name);
    let candidate = reserve_asset_name(&target_dir, &safe_name, source_meta.len(), "图片").await?;

    tokio::fs::create_dir_all(&target_dir)
        .await
        .map_err(|e| format!("创建图片资源目录失败：{e}"))?;
    let target_path = target_dir.join(&candidate);
    let same_file = tokio::fs::canonicalize(&source)
        .await
        .ok()
        .zip(tokio::fs::canonicalize(&target_path).await.ok())
        .map(|(left, right)| left == right)
        .unwrap_or(false);
    if !same_file {
        tokio::fs::copy(&source, &target_path)
            .await
            .map_err(|e| format!("复制图片文件失败：{e}"))?;
    }

    Ok(MediaAssetImport {
        file_name: candidate.clone(),
        absolute_path: path_without_verbatim_prefix(&target_path),
        relative_path: format!("{folder}/{candidate}"),
        size: source_meta.len(),
    })
}

/// 把剪贴板图片数据直接写进文档同级的 `.assets` 目录，不经过临时文件。
#[tauri::command]
pub async fn import_image_bytes(
    data_base64: String,
    extension: String,
    document_path: String,
    assets_dir: Option<String>,
) -> Result<MediaAssetImport, String> {
    let extension = extension
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase();
    if !IMAGE_EXTENSIONS.contains(&extension.as_str()) {
        return Err("不支持的图片格式".to_string());
    }
    if data_base64.len() as u64 > MAX_IMAGE_BYTES * 4 / 3 + 4 {
        return Err("图片超过 64MB，请改用外链引用".to_string());
    }
    let bytes = general_purpose::STANDARD
        .decode(data_base64.trim())
        .map_err(|error| format!("图片数据解析失败：{error}"))?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err("图片超过 64MB，请改用外链引用".to_string());
    }

    let (target_dir, folder) = assets_target_dir(&document_path, assets_dir, "图片")?;
    let timestamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let safe_name = sanitize_media_file_name(&format!("粘贴图片-{timestamp}.{extension}"));
    let candidate = reserve_asset_name(&target_dir, &safe_name, bytes.len() as u64, "图片").await?;

    tokio::fs::create_dir_all(&target_dir)
        .await
        .map_err(|e| format!("创建图片资源目录失败：{e}"))?;
    let target_path = target_dir.join(&candidate);
    tokio::fs::write(&target_path, &bytes)
        .await
        .map_err(|e| format!("写入图片文件失败：{e}"))?;

    Ok(MediaAssetImport {
        file_name: candidate.clone(),
        absolute_path: path_without_verbatim_prefix(&target_path),
        relative_path: format!("{folder}/{candidate}"),
        size: bytes.len() as u64,
    })
}

#[tauri::command]
pub async fn copy_fs_item(source: String, destination: String) -> Result<(), String> {
    ensure_fs_authorized(&source, "复制")?;
    ensure_fs_authorized(&destination, "复制")?;
    let src_meta = tokio::fs::metadata(&source)
        .await
        .map_err(|e| format!("无法读取源文件信息：{e}"))?;
    if src_meta.is_dir() {
        copy_dir_recursive(Path::new(&source), Path::new(&destination)).await
    } else {
        tokio::fs::copy(&source, &destination)
            .await
            .map_err(|e| format!("复制文件失败：{e}"))?;
        Ok(())
    }
}

async fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    tokio::fs::create_dir_all(dst)
        .await
        .map_err(|e| format!("创建目标目录失败：{e}"))?;
    let mut entries = tokio::fs::read_dir(src)
        .await
        .map_err(|e| format!("读取源目录失败：{e}"))?;
    while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
        let meta = entry.metadata().await.map_err(|e| e.to_string())?;
        // 跳过符号链接：跟随复制可能造成目录循环或越过授权根复制。
        if meta.is_symlink() {
            continue;
        }
        // 使用 Path::join 而非字符串拼接：拼接在 Windows 尾部反斜杠的
        // 目录上会产生 "\\"，且无法处理非 ASCII 分隔符场景。
        let src_path = src.join(entry.file_name());
        let dst_path = dst.join(entry.file_name());
        if meta.is_dir() {
            Box::pin(copy_dir_recursive(&src_path, &dst_path)).await?;
        } else {
            tokio::fs::copy(&src_path, &dst_path).await.map_err(|e| {
                format!("复制文件 {} 失败：{e}", entry.file_name().to_string_lossy())
            })?;
        }
    }
    Ok(())
}

static RECENT_FOLDERS_LOCK: Mutex<()> = Mutex::new(());

fn get_recent_folders_path(app: &AppHandle) -> Result<PathBuf, String> {
    app_config_file(app, "recent_folders.json")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentFolder {
    pub path: String,
    pub title: String,
    pub last_opened: u64,
}

#[tauri::command]
pub async fn get_recent_folders(app: AppHandle) -> Result<Vec<RecentFolder>, String> {
    let _guard = RECENT_FOLDERS_LOCK
        .lock()
        .map_err(|_| "最近文件夹记录锁已损坏".to_string())?;
    let p = get_recent_folders_path(&app)?;
    Ok(if p.exists() {
        serde_json::from_str(&std::fs::read_to_string(p).map_err(|e| e.to_string())?)
            .unwrap_or_default()
    } else {
        Vec::new()
    })
}

#[tauri::command]
pub async fn update_recent_folder(
    app: AppHandle,
    path: String,
    title: String,
) -> Result<Vec<RecentFolder>, String> {
    let _guard = RECENT_FOLDERS_LOCK
        .lock()
        .map_err(|_| "最近文件夹记录锁已损坏".to_string())?;
    let rp = get_recent_folders_path(&app)?;
    let mut recent: Vec<RecentFolder> = if rp.exists() {
        serde_json::from_str(&std::fs::read_to_string(&rp).map_err(|e| e.to_string())?)
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    recent.retain(|f| f.path != path);
    recent.insert(
        0,
        RecentFolder {
            path,
            title,
            last_opened: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        },
    );
    recent.truncate(30);
    std::fs::write(
        &rp,
        serde_json::to_string_pretty(&recent).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(recent)
}

#[tauri::command]
pub async fn remove_recent_folder(
    app: AppHandle,
    path: String,
) -> Result<Vec<RecentFolder>, String> {
    let _guard = RECENT_FOLDERS_LOCK
        .lock()
        .map_err(|_| "最近文件夹记录锁已损坏".to_string())?;
    let rp = get_recent_folders_path(&app)?;
    let mut recent: Vec<RecentFolder> = if rp.exists() {
        serde_json::from_str(&std::fs::read_to_string(&rp).map_err(|e| e.to_string())?)
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    recent.retain(|f| f.path != path);
    std::fs::write(
        &rp,
        serde_json::to_string_pretty(&recent).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(recent)
}

/// 清空最近文件夹列表（菜单「清除最近文件夹」）。
#[tauri::command]
pub async fn clear_recent_folders(app: AppHandle) -> Result<(), String> {
    let _guard = RECENT_FOLDERS_LOCK
        .lock()
        .map_err(|_| "最近文件夹记录锁已损坏".to_string())?;
    let rp = get_recent_folders_path(&app)?;
    if rp.exists() {
        std::fs::write(&rp, "[]").map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 判断路径是否为目录：拖放接入工作区时区分「文件夹」与「文件」。
#[tauri::command]
pub fn is_directory(path: String) -> Result<bool, String> {
    std::fs::metadata(&path)
        .map(|metadata| metadata.is_dir())
        .map_err(|e| e.to_string())
}

/// 搜索代数：每次发起检索自增一次，用于让旧扫描立刻中止。
/// 没有它时连续输入会叠加多次全盘扫描，把磁盘与 CPU 打满，表现为整个应用卡死。
static WORKSPACE_SEARCH_GENERATION: AtomicU64 = AtomicU64::new(0);
/// 普通检索读盘阶段的耗时上限（替换操作不设限，避免只替换了前缀）。
const WORKSPACE_SEARCH_TIME_BUDGET: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Deserialize)]
pub struct WorkspaceSearchOptions {
    pub roots: Vec<String>,
    pub query: String,
    pub case_sensitive: bool,
    pub use_regex: bool,
    #[serde(default)]
    pub extensions: Vec<String>,
    #[serde(default)]
    pub ignore_dirs: Vec<String>,
    pub replace_with: Option<String>,
    #[serde(default)]
    pub apply_replace: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceSearchMatch {
    pub path: String,
    pub line_number: usize,
    pub column: usize,
    pub line: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceSearchDiff {
    pub path: String,
    pub replacements: usize,
    pub diff: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceSearchResponse {
    pub matches: Vec<WorkspaceSearchMatch>,
    pub diffs: Vec<WorkspaceSearchDiff>,
    /// 文件名/路径命中的文件（纯内存匹配，不读磁盘，用于「工作区文件」分组）。
    pub files: Vec<String>,
    pub scanned_files: usize,
    pub truncated: bool,
    pub applied: bool,
}

fn is_searchable_workspace_file(path: &Path, extensions: &[String]) -> bool {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !extensions.is_empty() {
        return extensions.iter().any(|value| {
            value
                .trim_start_matches('.')
                .eq_ignore_ascii_case(&extension)
        });
    }
    matches!(
        extension.as_str(),
        "md" | "markdown"
            | "txt"
            | "json"
            | "yaml"
            | "yml"
            | "toml"
            | "csv"
            | "html"
            | "htm"
            | "xml"
            | "js"
            | "jsx"
            | "ts"
            | "tsx"
            | "css"
            | "rs"
            | "py"
            | "go"
            | "java"
            | "c"
            | "cpp"
            | "h"
    )
}

/// 工作区检索的候选文件（仅元数据，不读内容）。
struct WorkspaceFileEntry {
    path: PathBuf,
    modified: std::time::SystemTime,
}

/// 文件清单缓存：文件名检索与内容检索的候选排序都基于它。
/// 没有缓存时每敲一个字符都要重新遍历整个工作区（实测 14.8 万目录项），
/// 这正是「搜索极慢、整机卡死」的直接原因。
struct WorkspaceFileCache {
    key: String,
    entries: Vec<WorkspaceFileEntry>,
    built: Instant,
}

static WORKSPACE_FILE_CACHE: Mutex<Option<WorkspaceFileCache>> = Mutex::new(None);
/// 缓存有效期：够覆盖一次连续输入，又能在新建文件后较快刷新。
const WORKSPACE_FILE_CACHE_TTL: Duration = Duration::from_secs(10);
/// 普通内容检索的硬预算：文件数上限 + 耗时上限，超限即返回部分结果。
const WORKSPACE_CONTENT_FILE_LIMIT: usize = 1500;
/// 遍历安全上限，防止异常深/异常的目录结构拖垮遍历。
const WORKSPACE_WALK_LIMIT: usize = 400_000;

fn workspace_ignored_dirs(extra: &[String]) -> std::collections::HashSet<String> {
    [".git", "node_modules", "target", "dist", ".idea", ".vscode"]
        .into_iter()
        .map(String::from)
        .chain(extra.iter().map(|value| value.trim().to_string()))
        .collect()
}

fn workspace_file_cache_key(
    roots: &[String],
    extensions: &[String],
    ignore_dirs: &[String],
) -> String {
    format!(
        "{}\u{1}{}\u{1}{}",
        roots.join("\u{2}"),
        extensions.join(","),
        ignore_dirs.join(",")
    )
}

/// 仅遍历元数据收集候选文件；被更新的检索取代时返回 None（不写入缓存）。
fn collect_workspace_files(
    roots: &[String],
    extensions: &[String],
    ignored: &std::collections::HashSet<String>,
    generation: u64,
) -> Option<Vec<WorkspaceFileEntry>> {
    let mut pending: Vec<PathBuf> = roots.iter().map(PathBuf::from).collect();
    let mut files = Vec::new();
    let mut visited = 0usize;
    while let Some(path) = pending.pop() {
        visited += 1;
        if visited > WORKSPACE_WALK_LIMIT {
            break;
        }
        // 每遍历 512 个节点检查一次代数，避免旧遍历继续占用磁盘。
        if visited.is_multiple_of(512)
            && WORKSPACE_SEARCH_GENERATION.load(Ordering::Relaxed) != generation
        {
            return None;
        }
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            if path
                .file_name()
                .and_then(|value| value.to_str())
                .map(|name| ignored.contains(name))
                .unwrap_or(false)
            {
                continue;
            }
            if let Ok(entries) = std::fs::read_dir(&path) {
                pending.extend(entries.flatten().map(|entry| entry.path()));
            }
            continue;
        }
        if !metadata.is_file()
            || metadata.len() > 5 * 1024 * 1024
            || !is_searchable_workspace_file(&path, extensions)
        {
            continue;
        }
        files.push(WorkspaceFileEntry {
            path,
            modified: metadata.modified().unwrap_or(std::time::UNIX_EPOCH),
        });
    }
    Some(files)
}

/// 命中缓存则复用，否则重新遍历；返回候选文件与是否为缓存命中。
fn workspace_candidate_files(
    options: &WorkspaceSearchOptions,
    ignored: &std::collections::HashSet<String>,
    generation: u64,
) -> Result<(Vec<WorkspaceFileEntry>, bool), String> {
    let key = workspace_file_cache_key(&options.roots, &options.extensions, &options.ignore_dirs);
    if let Ok(guard) = WORKSPACE_FILE_CACHE.lock() {
        if let Some(cache) = guard.as_ref() {
            if cache.key == key && cache.built.elapsed() < WORKSPACE_FILE_CACHE_TTL {
                let entries = cache
                    .entries
                    .iter()
                    .map(|entry| WorkspaceFileEntry {
                        path: entry.path.clone(),
                        modified: entry.modified,
                    })
                    .collect();
                return Ok((entries, true));
            }
        }
    }
    let entries =
        match collect_workspace_files(&options.roots, &options.extensions, ignored, generation) {
            Some(value) => value,
            None => return Err("搜索已取消".into()),
        };
    if let Ok(mut guard) = WORKSPACE_FILE_CACHE.lock() {
        *guard = Some(WorkspaceFileCache {
            key,
            entries: entries
                .iter()
                .map(|entry| WorkspaceFileEntry {
                    path: entry.path.clone(),
                    modified: entry.modified,
                })
                .collect(),
            built: Instant::now(),
        });
    }
    Ok((entries, false))
}

fn short_workspace_diff(before: &str, after: &str, path: &Path) -> String {
    let before_lines: Vec<_> = before.lines().collect();
    let after_lines: Vec<_> = after.lines().collect();
    let mut output = format!("文件：{}\n", path.display());
    let mut shown = 0usize;
    for (index, (old, new)) in before_lines.iter().zip(after_lines.iter()).enumerate() {
        if old == new {
            continue;
        }
        output.push_str(&format!(
            "第 {} 行\n  原文：{}\n  替换后：{}\n",
            index + 1,
            old,
            new
        ));
        shown += 1;
        if shown >= 8 {
            break;
        }
    }
    if before_lines.len() != after_lines.len() && shown < 8 {
        output.push_str("提示：替换前后行数发生变化。\n");
    }
    output
}

fn workspace_match_column(line: &str, byte_offset: usize) -> usize {
    line[..byte_offset].encode_utf16().count() + 1
}

fn replace_workspace_matches(
    matcher: &regex::Regex,
    original: &str,
    replace_with: &str,
    use_regex: bool,
) -> String {
    if use_regex {
        matcher.replace_all(original, replace_with).into_owned()
    } else {
        matcher
            .replace_all(original, regex::NoExpand(replace_with))
            .into_owned()
    }
}

#[tauri::command]
pub async fn workspace_search(
    options: WorkspaceSearchOptions,
) -> Result<WorkspaceSearchResponse, String> {
    tokio::task::spawn_blocking(move || -> Result<WorkspaceSearchResponse, String> {
        // 先抢占新代数：任何仍在运行的旧扫描都会在下一次循环检查时立即退出。
        let generation = WORKSPACE_SEARCH_GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
        let query = options.query.trim().to_string();
        if query.is_empty() {
            return Err("搜索内容不能为空".into());
        }
        if options.roots.is_empty() {
            return Err("请先在资源管理器中打开一个文件夹".into());
        }
        let pattern = if options.use_regex {
            query
        } else {
            regex::escape(&query)
        };
        let matcher = regex::RegexBuilder::new(&pattern)
            .case_insensitive(!options.case_sensitive)
            .build()
            .map_err(|error| format!("正则表达式无效：{error}"))?;
        let ignored = workspace_ignored_dirs(&options.ignore_dirs);
        // 候选清单（命中缓存时纯内存）：文件名匹配与内容检索排序都基于它。
        let (candidates, _cache_hit) = workspace_candidate_files(&options, &ignored, generation)?;
        // 文件名/路径命中：内存匹配，不读磁盘，因此输入即时就能出结果。
        let mut files = Vec::new();
        for entry in &candidates {
            if files.len() >= 200 {
                break;
            }
            let text = entry.path.to_string_lossy();
            if matcher.is_match(&text) {
                files.push(text.to_string());
            }
        }
        // 内容检索的候选顺序：路径命中关键字的文件优先，其次按最近修改时间倒序，
        // 这样「正在编辑 / 近期文件」优先进入预算窗口，而不是被 DFS 顺序随机丢掉。
        let mut ordered = candidates
            .iter()
            .map(|entry| (matcher.is_match(&entry.path.to_string_lossy()), entry))
            .collect::<Vec<_>>();
        ordered.sort_by(|left, right| {
            right
                .0
                .cmp(&left.0)
                .then_with(|| right.1.modified.cmp(&left.1.modified))
        });
        let mut matches = Vec::new();
        let mut diffs = Vec::new();
        let mut scanned_files = 0usize;
        let mut truncated = false;
        // 读盘阶段单独计时：文件清单遍历/缓存构建不应吃掉内容检索的预算。
        let content_started = Instant::now();
        for (_, entry) in ordered {
            // 已被更新的检索取代：立即放弃本次扫描（过期响应会被前端丢弃）。
            if WORKSPACE_SEARCH_GENERATION.load(Ordering::Relaxed) != generation {
                return Err("搜索已取消".into());
            }
            // 普通检索受文件数与耗时双重上限约束，超限返回部分结果；
            // 替换操作不能截断，否则只会替换到工作区的一部分。
            if options.replace_with.is_none()
                && (scanned_files >= WORKSPACE_CONTENT_FILE_LIMIT
                    || content_started.elapsed() > WORKSPACE_SEARCH_TIME_BUDGET)
            {
                truncated = true;
                break;
            }
            let path = &entry.path;
            scanned_files += 1;
            let original = match std::fs::read_to_string(path) {
                Ok(value) => value,
                Err(_) => continue,
            };
            if !truncated {
                for (line_index, line) in original.lines().enumerate() {
                    for found in matcher.find_iter(line) {
                        if matches.len() >= 2000 {
                            truncated = true;
                            break;
                        }
                        matches.push(WorkspaceSearchMatch {
                            path: path.to_string_lossy().to_string(),
                            line_number: line_index + 1,
                            column: workspace_match_column(line, found.start()),
                            line: line.to_string(),
                        });
                    }
                    if truncated {
                        break;
                    }
                }
            }
            if let Some(replace_with) = &options.replace_with {
                let changed =
                    replace_workspace_matches(&matcher, &original, replace_with, options.use_regex);
                if changed != original {
                    let replacements = matcher.find_iter(&original).count();
                    diffs.push(WorkspaceSearchDiff {
                        path: path.to_string_lossy().to_string(),
                        replacements,
                        diff: short_workspace_diff(&original, &changed, path),
                    });
                    if options.apply_replace {
                        std::fs::write(path, changed)
                            .map_err(|error| format!("写入 {} 失败：{error}", path.display()))?;
                    }
                }
            }
            // Plain searches can stop once the result cap is reached. Replace
            // operations must keep scanning so "apply" never silently updates
            // only an arbitrary prefix of the workspace.
            if truncated && options.replace_with.is_none() {
                break;
            }
        }
        Ok(WorkspaceSearchResponse {
            matches,
            diffs,
            files,
            scanned_files,
            truncated,
            applied: options.apply_replace && options.replace_with.is_some(),
        })
    })
    .await
    .map_err(|error| format!("工作区搜索任务异常：{error}"))?
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSearchResult {
    pub title: String,
    pub url: String,
    pub content: String,
    pub score: Option<f64>,
    pub published_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSearchResponse {
    pub provider: String,
    pub query: String,
    pub answer: Option<String>,
    pub results: Vec<WebSearchResult>,
    pub accessed_at: String,
}

#[tauri::command]
pub async fn web_search(
    query: String,
    settings: WebSearchSettings,
) -> Result<WebSearchResponse, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err("搜索关键词不能为空".into());
    }
    if !settings.enabled {
        return Err("请先在设置中启用网络搜索".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("创建搜索客户端失败: {e}"))?;
    let accessed_at = chrono::Local::now().to_rfc3339();

    match settings.provider.as_str() {
        "tavily" => {
            if settings.tavily_api_key.trim().is_empty() {
                return Err("请先填写 Tavily API Key".into());
            }
            let payload = serde_json::json!({
                "query": query,
                "search_depth": settings.tavily_search_depth,
                "include_answer": settings.tavily_include_answer,
                "include_raw_content": false,
                "max_results": settings.tavily_max_results.clamp(1, 20),
            });
            let response = client
                .post("https://api.tavily.com/search")
                .bearer_auth(&settings.tavily_api_key)
                .json(&payload)
                .send()
                .await
                .map_err(|e| format!("Tavily 搜索失败: {e}"))?;
            let status = response.status();
            let body: serde_json::Value = response
                .json()
                .await
                .map_err(|e| format!("解析 Tavily 响应失败: {e}"))?;
            if !status.is_success() {
                return Err(format!("Tavily 搜索失败 ({status}): {}", body));
            }
            let results = body["results"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|item| WebSearchResult {
                    title: item["title"].as_str().unwrap_or("").to_string(),
                    url: item["url"].as_str().unwrap_or("").to_string(),
                    content: item["content"].as_str().unwrap_or("").to_string(),
                    score: item["score"].as_f64(),
                    published_at: item["published_date"].as_str().map(ToString::to_string),
                })
                .collect();
            Ok(WebSearchResponse {
                provider: "tavily".into(),
                query,
                answer: body["answer"].as_str().map(ToString::to_string),
                results,
                accessed_at,
            })
        }
        "searxng" => {
            let base = settings.searxng_url.trim().trim_end_matches('/');
            if base.is_empty() {
                return Err("请先填写 SearXNG 地址".into());
            }
            let endpoint = if base.ends_with("/search") {
                base.to_string()
            } else {
                format!("{base}/search")
            };
            let mut request = client.get(endpoint).query(&[
                ("q", query.as_str()),
                ("format", "json"),
                (
                    "language",
                    if settings.searxng_language == "auto" {
                        "all"
                    } else {
                        settings.searxng_language.as_str()
                    },
                ),
                ("categories", settings.searxng_categories.as_str()),
                ("safesearch", &settings.searxng_safesearch.to_string()),
                ("time_range", settings.searxng_time_range.as_str()),
            ]);
            if !settings.searxng_api_key.trim().is_empty() {
                request = request.bearer_auth(&settings.searxng_api_key);
            }
            let response = request
                .send()
                .await
                .map_err(|e| format!("SearXNG 搜索失败: {e}"))?;
            let status = response.status();
            let body: serde_json::Value = response
                .json()
                .await
                .map_err(|e| format!("解析 SearXNG 响应失败: {e}"))?;
            if !status.is_success() {
                return Err(format!("SearXNG 搜索失败 ({status}): {}", body));
            }
            let limit = settings.searxng_max_results.clamp(1, 20) as usize;
            let results = body["results"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .take(limit)
                .map(|item| WebSearchResult {
                    title: item["title"].as_str().unwrap_or("").to_string(),
                    url: item["url"].as_str().unwrap_or("").to_string(),
                    content: item["content"]
                        .as_str()
                        .or_else(|| item["snippet"].as_str())
                        .unwrap_or("")
                        .to_string(),
                    score: item["score"].as_f64(),
                    published_at: item["publishedDate"]
                        .as_str()
                        .or_else(|| item["published_date"].as_str())
                        .map(ToString::to_string),
                })
                .collect();
            Ok(WebSearchResponse {
                provider: "searxng".into(),
                query,
                answer: None,
                results,
                accessed_at,
            })
        }
        _ => Err("不支持的网络搜索服务商".into()),
    }
}

#[tauri::command]
pub async fn check_for_updates() -> Result<UpdateInfo, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP: {}", e))?;
    let current = VERSION.to_string();
    let resp = match client
        .get("https://api.github.com/repos/zhcx/zeditor/releases/latest")
        .header("User-Agent", "Zeditor")
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => resp,
        Ok(resp) => {
            return check_updates_from_atom(
                &client,
                current,
                format!("GitHub API: {}", resp.status()),
            )
            .await
        }
        Err(error) => {
            return check_updates_from_atom(&client, current, format!("GitHub API: {}", error))
                .await
        }
    };
    let rel: serde_json::Value = resp.json().await.map_err(|e| format!("JSON: {}", e))?;
    let latest = rel["tag_name"]
        .as_str()
        .ok_or("GitHub API response is missing tag_name")?
        .trim_start_matches('v')
        .to_string();
    let has_update = compare_versions(&latest, &current)?;

    let selected_asset = rel["assets"].as_array().and_then(|assets| {
        select_release_asset(assets, std::env::consts::OS, std::env::consts::ARCH)
    });
    let asset_download_url = selected_asset
        .and_then(|asset| asset["browser_download_url"].as_str())
        .unwrap_or("")
        .to_string();
    let asset_name = selected_asset
        .and_then(|asset| asset["name"].as_str())
        .unwrap_or("")
        .to_string();
    let asset_size = selected_asset
        .and_then(|asset| asset["size"].as_u64())
        .unwrap_or(0);

    Ok(UpdateInfo {
        has_update,
        current_version: current,
        latest_version: latest,
        download_url: rel["html_url"]
            .as_str()
            .unwrap_or("https://github.com/zhcx/zeditor/releases")
            .into(),
        asset_download_url,
        asset_name,
        asset_size,
        auto_install_supported: cfg!(target_os = "windows"),
        release_notes: rel["body"].as_str().unwrap_or("暂无更新说明").into(),
        published_at: rel["published_at"].as_str().unwrap_or("").into(),
    })
}

fn select_release_asset<'a>(
    assets: &'a [serde_json::Value],
    target_os: &str,
    target_arch: &str,
) -> Option<&'a serde_json::Value> {
    let matches = |asset: &&serde_json::Value| {
        let name = asset["name"].as_str().unwrap_or("").to_ascii_lowercase();
        match (target_os, target_arch) {
            ("windows", "x86_64") => {
                name.ends_with("_x64-setup.exe") || name.ends_with("_x64_en-us.msi")
            }
            ("macos", "aarch64") => name.ends_with("_aarch64.dmg"),
            ("macos", "x86_64") => name.ends_with("_x64.dmg"),
            ("linux", "x86_64") => {
                name.ends_with("_amd64.appimage")
                    || name.ends_with("_amd64.deb")
                    || name.ends_with("-1.x86_64.rpm")
            }
            _ => false,
        }
    };
    let candidates: Vec<&serde_json::Value> = assets.iter().filter(matches).collect();
    if target_os == "windows" {
        candidates
            .iter()
            .copied()
            .find(|asset| asset["name"].as_str().unwrap_or("").ends_with(".exe"))
            .or_else(|| candidates.first().copied())
    } else {
        candidates.first().copied()
    }
}

async fn check_updates_from_atom(
    client: &reqwest::Client,
    current: String,
    api_error: String,
) -> Result<UpdateInfo, String> {
    let feed = client
        .get("https://github.com/zhcx/zeditor/releases.atom")
        .header("User-Agent", "Zeditor")
        .send()
        .await
        .map_err(|error| format!("{}; Release feed: {}", api_error, error))?;
    if !feed.status().is_success() {
        return Err(format!("{}; Release feed: {}", api_error, feed.status()));
    }

    let latest = extract_latest_tag_from_atom(
        &feed
            .text()
            .await
            .map_err(|error| format!("Release feed body: {}", error))?,
    )?;
    let has_update = compare_versions(&latest, &current)?;
    let download_url = format!("https://github.com/zhcx/zeditor/releases/tag/v{}", latest);

    Ok(UpdateInfo {
        has_update,
        current_version: current,
        latest_version: latest,
        download_url,
        asset_download_url: String::new(),
        asset_name: String::new(),
        asset_size: 0,
        auto_install_supported: cfg!(target_os = "windows"),
        release_notes: "GitHub API 暂时不可用，已通过 Release feed 检测到该版本。请前往 Release 页面下载安装包。".into(),
        published_at: String::new(),
    })
}

fn extract_latest_tag_from_atom(feed: &str) -> Result<String, String> {
    const TAG_PREFIX: &str = "/releases/tag/";
    let tag_start = feed
        .find(TAG_PREFIX)
        .ok_or("Release feed does not contain a release tag")?
        + TAG_PREFIX.len();
    let tag = feed[tag_start..]
        .split(['\"', '\'', '<', '&'])
        .next()
        .unwrap_or("")
        .trim_start_matches('v');
    if tag.is_empty() {
        return Err("Release feed contains an empty release tag".into());
    }
    tag.split('.').try_for_each(|part| {
        part.parse::<u32>()
            .map(|_| ())
            .map_err(|_| format!("Invalid release tag: {}", tag))
    })?;
    Ok(tag.to_string())
}

fn compare_versions(latest: &str, current: &str) -> Result<bool, String> {
    // 复用 semver crate（已是依赖），替代此前的手写逐段比较。
    let latest = semver::Version::parse(latest).map_err(|e| format!("无效版本号 {latest}：{e}"))?;
    let current =
        semver::Version::parse(current).map_err(|e| format!("无效版本号 {current}：{e}"))?;
    Ok(latest > current)
}

#[cfg(test)]
mod update_tests {
    use super::{extract_latest_tag_from_atom, validate_update_download, Settings};

    #[test]
    fn typography_preferences_survive_and_old_settings_receive_defaults() {
        let mut value = serde_json::to_value(Settings::default()).unwrap();
        value["appearance"]["ui_font_size"] = serde_json::json!(18);
        value["appearance"]["letter_spacing"] = serde_json::json!(1.2);
        let saved: Settings = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(saved.appearance.ui_font_size, 18);
        assert_eq!(saved.appearance.letter_spacing, 1.2);
        value["appearance"]
            .as_object_mut()
            .unwrap()
            .remove("ui_font_size");
        value["appearance"]
            .as_object_mut()
            .unwrap()
            .remove("letter_spacing");
        let old: Settings = serde_json::from_value(value).unwrap();
        assert_eq!(old.appearance.ui_font_size, 13);
        assert_eq!(old.appearance.letter_spacing, 0.6);
    }

    #[tokio::test]
    async fn encoded_file_commands_round_trip_and_failed_conversion_preserves_file() {
        let temp = std::env::temp_dir();
        let root = temp.join(format!("zeditor-encoding-test-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir(&root).await.unwrap();
        let path = root.join("note.md");
        let text = "中文 😀";
        for encoding in ["utf-8-bom", "utf-16le-bom", "utf-16be", "gb18030"] {
            super::save_file_content(
                path.to_string_lossy().into(),
                text.into(),
                Some(encoding.into()),
            )
            .await
            .unwrap();
            let decoded =
                super::read_text_document(path.to_string_lossy().into(), Some(encoding.into()))
                    .await
                    .unwrap();
            assert_eq!(decoded.content, text);
            assert_eq!(decoded.encoding, encoding);
            let bytes = tokio::fs::read(&path).await.unwrap();
            let base64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
            let memory = super::decode_text_document(base64.clone(), Some(encoding.into()))
                .await
                .unwrap();
            assert_eq!(memory.content, text);
            assert_eq!(memory.encoding, encoding);
            super::save_file_bytes(path.to_string_lossy().into(), base64)
                .await
                .unwrap();
            assert_eq!(tokio::fs::read(&path).await.unwrap(), bytes);
        }
        let before = tokio::fs::read(&path).await.unwrap();
        assert!(super::save_file_content(
            path.to_string_lossy().into(),
            text.into(),
            Some("gbk".into())
        )
        .await
        .is_err());
        assert_eq!(tokio::fs::read(&path).await.unwrap(), before);
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        assert_eq!(root.parent(), Some(temp.as_path()));
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[test]
    fn frontend_feature_switches_survive_settings_round_trip() {
        let mut value = serde_json::to_value(Settings::default()).unwrap();
        value["workflow"] = serde_json::json!({
            "render_in_preview": false,
            "preserve_format": false,
        });
        value["editor"]["inline_popups"] = serde_json::json!(false);
        value["ai"]["proofread_with_ai"] = serde_json::json!(false);
        let restored: Settings = serde_json::from_value(value).unwrap();
        let saved = serde_json::to_value(restored).unwrap();
        assert_eq!(saved["workflow"]["render_in_preview"], false);
        assert_eq!(saved["workflow"]["preserve_format"], false);
        assert_eq!(saved["editor"]["inline_popups"], false);
        assert_eq!(saved["ai"]["proofread_with_ai"], false);
    }

    #[test]
    fn old_settings_default_new_feature_switches_to_enabled() {
        let mut value = serde_json::to_value(Settings::default()).unwrap();
        value.as_object_mut().unwrap().remove("workflow");
        value["editor"]
            .as_object_mut()
            .unwrap()
            .remove("inline_popups");
        value["ai"]
            .as_object_mut()
            .unwrap()
            .remove("proofread_with_ai");
        let saved =
            serde_json::to_value(serde_json::from_value::<Settings>(value).unwrap()).unwrap();
        assert_eq!(saved["workflow"]["render_in_preview"], true);
        assert_eq!(saved["workflow"]["preserve_format"], true);
        assert_eq!(saved["editor"]["inline_popups"], true);
        assert_eq!(saved["ai"]["proofread_with_ai"], true);
    }

    #[tokio::test]
    async fn save_replaces_the_complete_file_without_truncating_open_readers() {
        use tokio::io::AsyncReadExt;
        let root = std::env::temp_dir().join(format!("zeditor-save-test-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let path = root.join("note.md");
        tokio::fs::write(&path, "original").await.unwrap();
        let mut reader = tokio::fs::File::open(&path).await.unwrap();
        super::write_utf8_text_file(path.to_str().unwrap(), "updated")
            .await
            .unwrap();
        let mut original = String::new();
        reader.read_to_string(&mut original).await.unwrap();
        drop(reader);
        let saved = tokio::fs::read_to_string(&path).await.unwrap();
        let entries = std::fs::read_dir(&root).unwrap().count();
        tokio::fs::remove_dir_all(&root).await.unwrap();
        assert_eq!(original, "original");
        assert_eq!(saved, "updated");
        assert_eq!(entries, 1, "保存后不应残留临时文件");
    }

    #[test]
    fn editor_input_engine_survives_settings_round_trip() {
        for engine in ["editContext", "textarea"] {
            let mut value = serde_json::to_value(Settings::default()).unwrap();
            value["editor"]["input_engine"] = serde_json::json!(engine);
            value["editor"]["pin_toolbar"] = serde_json::json!(true);
            let restored: Settings = serde_json::from_value(value).unwrap();
            let saved = serde_json::to_value(restored).unwrap();
            assert_eq!(saved["editor"]["input_engine"], engine);
            assert_eq!(saved["editor"]["pin_toolbar"], true);
        }
    }

    #[test]
    fn old_editor_settings_default_to_native_input() {
        let mut value = serde_json::to_value(Settings::default()).unwrap();
        value["editor"]
            .as_object_mut()
            .unwrap()
            .remove("input_engine");
        let restored: Settings = serde_json::from_value(value).unwrap();
        assert_eq!(
            serde_json::to_value(restored).unwrap()["editor"]["input_engine"],
            "editContext"
        );
    }

    #[test]
    fn old_settings_without_agent_configuration_receive_safe_defaults() {
        let mut value = serde_json::to_value(Settings::default()).unwrap();
        value.as_object_mut().unwrap().remove("agent");
        let restored: Settings = serde_json::from_value(value).unwrap();
        assert!(!restored.agent.enabled);
        assert_eq!(restored.agent.backend, "claude_code");
        assert_eq!(restored.agent.backends.len(), 3);
    }

    #[test]
    fn settings_without_webdav_use_defaults() {
        let mut value = serde_json::to_value(Settings::default()).unwrap();
        value.as_object_mut().unwrap().remove("webdav");
        let restored: Settings = serde_json::from_value(value).unwrap();
        assert!(!restored.webdav.enabled);
        assert_eq!(restored.webdav.remote_root, "/Zeditor");
    }

    #[test]
    fn extracts_the_first_release_tag_from_an_atom_feed() {
        let feed = r#"
            <feed>
              <entry><link href="https://github.com/zhcx/zeditor/releases/tag/v0.3.7" /></entry>
              <entry><link href="https://github.com/zhcx/zeditor/releases/tag/v0.3.6" /></entry>
            </feed>
        "#;

        assert_eq!(extract_latest_tag_from_atom(feed).unwrap(), "0.3.7");
    }

    #[test]
    fn accepts_only_safe_installers_from_this_projects_releases() {
        assert!(validate_update_download(
            "https://github.com/zhcx/zeditor/releases/download/v0.3.7/Zeditor_0.3.7_x64-setup.exe",
            "Zeditor_0.3.7_x64-setup.exe",
        )
        .is_ok());
        assert!(validate_update_download(
            "http://github.com/zhcx/zeditor/releases/download/v1/app.exe",
            "app.exe"
        )
        .is_err());
        assert!(validate_update_download("https://example.com/app.exe", "app.exe").is_err());
        assert!(validate_update_download(
            "https://github.com/other/repo/releases/download/v1/app.exe",
            "app.exe"
        )
        .is_err());
        assert!(validate_update_download(
            "https://github.com/zhcx/zeditor/releases/download/v1/app.exe",
            "..\\app.exe"
        )
        .is_err());
        assert!(validate_update_download(
            "https://github.com/zhcx/zeditor/releases/download/v1/app.zip",
            "app.zip"
        )
        .is_err());
    }
}

#[cfg(test)]
mod workspace_search_tests {
    use super::{
        is_workspace_file, replace_workspace_matches, workspace_match_column, workspace_search,
        WorkspaceSearchOptions,
    };

    #[test]
    fn explorer_keeps_source_and_configuration_files_visible() {
        for name in [
            "main.ts",
            "Component.tsx",
            "Cargo.toml",
            "Dockerfile",
            ".gitignore",
            ".env.local",
            "query.sql",
        ] {
            assert!(is_workspace_file(name), "{name}");
        }
    }

    #[test]
    fn literal_replacements_preserve_dollar_signs() {
        let matcher = regex::Regex::new("price").unwrap();
        assert_eq!(
            replace_workspace_matches(&matcher, "price", "$10", false),
            "$10"
        );
    }

    #[test]
    fn regex_replacements_still_expand_capture_groups() {
        let matcher = regex::Regex::new("(price)").unwrap();
        assert_eq!(
            replace_workspace_matches(&matcher, "price", "$1 list", true),
            "price list"
        );
    }

    #[test]
    fn columns_match_javascript_utf16_offsets() {
        let line = "中😀target";
        assert_eq!(
            workspace_match_column(line, line.find("target").unwrap()),
            4
        );
    }

    #[tokio::test]
    async fn capped_results_do_not_partially_apply_workspace_replacements() {
        let root = std::env::temp_dir().join(format!("zeditor-search-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create search fixture");
        let content = "needle\n".repeat(1_100);
        let first = root.join("first.md");
        let second = root.join("second.md");
        std::fs::write(&first, &content).expect("write first fixture");
        std::fs::write(&second, &content).expect("write second fixture");

        let response = workspace_search(WorkspaceSearchOptions {
            roots: vec![root.to_string_lossy().into_owned()],
            query: "needle".into(),
            case_sensitive: true,
            use_regex: false,
            extensions: vec!["md".into()],
            ignore_dirs: Vec::new(),
            replace_with: Some("replaced".into()),
            apply_replace: true,
        })
        .await
        .expect("workspace replacement succeeds");

        assert!(response.truncated);
        assert!(response.applied);
        assert_eq!(response.diffs.len(), 2);
        assert!(!std::fs::read_to_string(&first)
            .expect("read first result")
            .contains("needle"));
        assert!(!std::fs::read_to_string(&second)
            .expect("read second result")
            .contains("needle"));
        std::fs::remove_dir_all(root).ok();
    }
}

#[cfg(test)]
mod link_check_tests {
    use super::{
        document_drive_prefix, is_drive_relative_path, is_unc_path, is_windows_root_relative,
        Settings,
    };

    #[test]
    fn unc_and_drive_relative_paths_are_rejected() {
        assert!(is_unc_path(r"\\server\share\a.md"));
        assert!(is_unc_path("//server/share/a.md"));
        assert!(!is_unc_path("docs/a.md"));
        assert!(is_drive_relative_path("C:file.md"));
        assert!(!is_drive_relative_path("C:\\file.md"));
        assert!(!is_drive_relative_path("C:/file.md"));
        assert!(!is_drive_relative_path("src/a.md"));
    }

    #[test]
    fn windows_root_relative_paths_map_to_document_drive() {
        assert!(is_windows_root_relative("/docs/a.md"));
        assert!(is_windows_root_relative("\\docs\\a.md"));
        assert!(!is_windows_root_relative("//server/share"));
        assert!(!is_windows_root_relative("./a.md"));
        #[cfg(target_os = "windows")]
        {
            assert_eq!(
                document_drive_prefix("D:\\notes\\a.md").as_deref(),
                Some("D:")
            );
            assert_eq!(document_drive_prefix(r"\\server\share\a.md"), None);
        }
    }

    #[test]
    fn old_settings_default_to_link_check_enabled() {
        let mut value = serde_json::to_value(Settings::default()).unwrap();
        value["editor"]
            .as_object_mut()
            .unwrap()
            .remove("check_local_links");
        let restored: Settings = serde_json::from_value(value).unwrap();
        assert_eq!(
            serde_json::to_value(restored).unwrap()["editor"]["check_local_links"],
            true
        );
    }
}

fn validate_update_download(download_url: &str, file_name: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(download_url).map_err(|_| "更新下载地址无效".to_string())?;
    let valid_release = url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url.path().starts_with("/zhcx/zeditor/releases/download/")
        && url.query().is_none()
        && url.fragment().is_none();
    if !valid_release {
        return Err("更新安装包必须来自 Zeditor 的 GitHub Release".into());
    }

    let path = Path::new(file_name);
    let safe_name = !file_name.is_empty()
        && path.file_name().and_then(|value| value.to_str()) == Some(file_name)
        && !file_name.contains(['/', '\\', ':']);
    let supported = path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("exe") || extension.eq_ignore_ascii_case("msi")
        });
    if !safe_name || !supported {
        return Err("更新安装包文件名无效，仅支持安全的 .exe 或 .msi 文件".into());
    }

    Ok(url)
}

#[tauri::command]
pub async fn download_and_install_update(
    app: AppHandle,
    download_url: String,
    file_name: String,
    asset_size: Option<u64>,
) -> Result<String, String> {
    const MAX_UPDATE_BYTES: u64 = 1024 * 1024 * 1024;
    let download_url = validate_update_download(&download_url, &file_name)?;
    let temp_dir = std::env::temp_dir().join("zeditor_update");
    std::fs::create_dir_all(&temp_dir).map_err(|e| format!("创建临时目录失败: {}", e))?;
    let installer_path = temp_dir.join(&file_name);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP: {}", e))?;

    let resp = client
        .get(download_url)
        .header("User-Agent", "Zeditor")
        .send()
        .await
        .map_err(|e| format!("下载请求失败: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("下载失败: HTTP {}", resp.status()));
    }

    let total_size = resp.content_length().unwrap_or(0);
    if total_size > MAX_UPDATE_BYTES {
        return Err("更新安装包超过 1 GiB 安全限制".into());
    }

    let mut downloaded: u64 = 0;
    let mut file =
        std::fs::File::create(&installer_path).map_err(|e| format!("创建文件失败: {}", e))?;

    let mut stream = resp.bytes_stream();
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("下载数据失败: {}", e))?;
        std::io::Write::write_all(&mut file, &chunk).map_err(|e| format!("写入文件失败: {}", e))?;
        downloaded += chunk.len() as u64;
        if downloaded > MAX_UPDATE_BYTES {
            return Err("更新安装包超过 1 GiB 安全限制".into());
        }

        let progress = if total_size > 0 {
            ((downloaded as f64 / total_size as f64) * 100.0) as u32
        } else {
            0
        };

        app.emit(
            "update-download-progress",
            serde_json::json!({
                "downloaded": downloaded,
                "total": total_size,
                "progress": progress,
            }),
        )
        .ok();
    }

    drop(file);

    // 下载完整性：与 Release 元数据声明的 asset_size 一致（如已知）。
    if let Some(expected) = asset_size.filter(|value| *value > 0) {
        if downloaded != expected {
            let _ = std::fs::remove_file(&installer_path);
            return Err(format!(
                "更新包大小校验失败：期望 {expected} 字节，实际 {downloaded} 字节"
            ));
        }
    }

    let installer = installer_path.to_string_lossy().to_string();
    // 只通知前端；安装与退由前端在保存未落盘内容后调用
    // finalize_update_install 触发。此前在 emit 之后立即启动安装器并
    // process::exit，事件尚未送达前端，未保存的编辑会直接丢失。
    app.emit(
        "update-download-complete",
        serde_json::json!({ "path": &installer }),
    )
    .ok();
    Ok(installer)
}

/// 前端确认（保存未落盘内容）后调用：启动更新安装器并退出应用。
#[tauri::command]
pub async fn finalize_update_install(installer_path: String) -> Result<(), String> {
    // 校验安装包位于受控临时目录且扩展名合法，防止任意路径执行。
    let canonical =
        std::fs::canonicalize(&installer_path).map_err(|e| format!("无法访问安装包：{e}"))?;
    let update_dir = std::env::temp_dir().join("zeditor_update");
    let update_dir = std::fs::canonicalize(&update_dir).unwrap_or(update_dir);
    if !canonical.starts_with(&update_dir) {
        return Err("安装包路径无效".into());
    }
    let lower = canonical.to_string_lossy().to_ascii_lowercase();
    if !(lower.ends_with(".exe") || lower.ends_with(".msi")) {
        return Err("仅支持 .exe 或 .msi 安装包".into());
    }

    // Launch the installer directly. `cmd /c start` is unreliable when the
    // path contains spaces and can leave the update UI appearing unresponsive.
    #[cfg(target_os = "windows")]
    {
        let installer = canonical.to_string_lossy().to_string();
        let mut command = if lower.ends_with(".msi") {
            let mut command = std::process::Command::new("msiexec.exe");
            command.args(["/i", &installer]);
            command
        } else {
            std::process::Command::new(&installer)
        };
        command
            .spawn()
            .map_err(|e| format!("启动安装程序失败: {}", e))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        return Err("自动安装仅支持 Windows".to_string());
    }

    // Exit the app so the installer can replace files
    std::process::exit(0);
}
