use crate::image::{self, CloudinaryConfig, ImageService, LocalImageConfig, PicGoConfig, S3Config};
use base64::{engine::general_purpose, Engine as _};
use font_kit::source::SystemSource;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfAnnotationSidecar {
    pub version: u8,
    pub pdf_path: String,
    pub pdf_sha256: String,
    pub active_layer_id: String,
    #[serde(default)]
    pub layers: Vec<serde_json::Value>,
    #[serde(default)]
    pub strokes: Vec<serde_json::Value>,
    #[serde(default)]
    pub area_highlights: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfAnnotationLoadResult {
    pub sidecar: PdfAnnotationSidecar,
    pub source_changed: bool,
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
    pub font_family: String,
    pub font_size: u32,
    pub line_height: f32,
}

fn default_favorite_emojis() -> Vec<String> {
    ["😀", "👍", "❤️", "🎉", "✅", "⚠️", "💡", "🚀"]
        .iter()
        .map(|value| (*value).into())
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditorSettings {
    pub auto_save_interval: u32,
    pub spell_check: bool,
    pub auto_complete: bool,
    #[serde(default = "default_favorite_emojis")]
    pub favorite_emojis: Vec<String>,
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

impl Default for Settings {
    fn default() -> Self {
        Settings {
            appearance: AppearanceSettings {
                theme: "vscode-dark".into(),
                language: None,
                ui_font_family: default_ui_font_family(),
                font_family: "Microsoft YaHei".into(),
                font_size: 14,
                line_height: 1.6,
            },
            editor: EditorSettings {
                auto_save_interval: 30000,
                spell_check: false,
                auto_complete: true,
                favorite_emojis: default_favorite_emojis(),
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
    tokio::fs::write(path, content.as_bytes())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_file_content(path: String) -> Result<String, String> {
    read_utf8_text_file(&path, None).await
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
pub async fn save_file_content(path: String, content: String) -> Result<(), String> {
    write_utf8_text_file(&path, &content).await
}

fn pdf_annotation_path(pdf_path: &str) -> PathBuf {
    PathBuf::from(format!("{}.zditor-pdf-annotation.json", pdf_path))
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|error| format!("无法读取 PDF：{error}"))?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

fn empty_pdf_annotation_sidecar(pdf_path: &str, pdf_sha256: String) -> PdfAnnotationSidecar {
    PdfAnnotationSidecar {
        version: 1,
        pdf_path: pdf_path.to_string(),
        pdf_sha256,
        active_layer_id: "default".into(),
        layers: vec![serde_json::json!({ "id": "default", "name": "Default", "visible": true })],
        strokes: Vec::new(),
        area_highlights: Vec::new(),
    }
}

#[tauri::command]
pub async fn load_pdf_annotations(pdf_path: String) -> Result<PdfAnnotationLoadResult, String> {
    ensure_fs_authorized(&pdf_path, "读取 PDF 批注")?;
    let pdf = Path::new(&pdf_path);
    if !pdf.is_file() {
        return Err("PDF 文件不存在".into());
    }
    let current_hash = sha256_file(pdf)?;
    let sidecar_path = pdf_annotation_path(&pdf_path);
    if !sidecar_path.exists() {
        return Ok(PdfAnnotationLoadResult {
            sidecar: empty_pdf_annotation_sidecar(&pdf_path, current_hash),
            source_changed: false,
        });
    }

    let sidecar: PdfAnnotationSidecar = serde_json::from_str(
        &std::fs::read_to_string(&sidecar_path)
            .map_err(|error| format!("无法读取 PDF 批注 sidecar：{error}"))?,
    )
    .map_err(|error| format!("PDF 批注 sidecar 格式无效：{error}"))?;
    if sidecar.version != 1 {
        return Err(format!("不支持的 PDF 批注版本：{}", sidecar.version));
    }
    if sidecar.pdf_path != pdf_path {
        return Err("PDF 批注 sidecar 与当前 PDF 路径不匹配".into());
    }
    Ok(PdfAnnotationLoadResult {
        source_changed: sidecar.pdf_sha256 != current_hash,
        sidecar,
    })
}

#[tauri::command]
pub async fn save_pdf_annotations(
    pdf_path: String,
    sidecar: PdfAnnotationSidecar,
) -> Result<(), String> {
    ensure_fs_authorized(&pdf_path, "保存 PDF 批注")?;
    let pdf = Path::new(&pdf_path);
    if !pdf.is_file() {
        return Err("PDF 文件不存在".into());
    }
    if sidecar.version != 1 {
        return Err("只支持 PDF 批注 sidecar 版本 1".into());
    }
    if sidecar.pdf_path != pdf_path {
        return Err("PDF 批注 sidecar 与当前 PDF 路径不匹配".into());
    }
    let current_hash = sha256_file(pdf)?;
    if sidecar.pdf_sha256 != current_hash {
        return Err("pdf_source_changed: PDF 已变化，未覆盖现有批注".into());
    }

    let sidecar_path = pdf_annotation_path(&pdf_path);
    let content = serde_json::to_string_pretty(&sidecar).map_err(|error| error.to_string())?;
    let temporary_path = sidecar_path.with_file_name(format!(
        "{}.tmp",
        sidecar_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("pdf-annotation.json"),
    ));
    std::fs::write(&temporary_path, content.as_bytes())
        .map_err(|error| format!("无法写入 PDF 批注：{error}"))?;
    std::fs::rename(&temporary_path, &sidecar_path)
        .map_err(|error| format!("无法提交 PDF 批注：{error}"))?;
    Ok(())
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

pub(crate) fn ensure_fs_authorized(path: &str, operation: &str) -> Result<(), String> {
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
        let ignored: std::collections::HashSet<String> =
            [".git", "node_modules", "target", "dist", ".idea", ".vscode"]
                .into_iter()
                .map(String::from)
                .chain(
                    options
                        .ignore_dirs
                        .iter()
                        .map(|value| value.trim().to_string()),
                )
                .collect();
        let mut pending = options
            .roots
            .into_iter()
            .map(PathBuf::from)
            .collect::<Vec<_>>();
        let mut matches = Vec::new();
        let mut diffs = Vec::new();
        let mut scanned_files = 0usize;
        let mut truncated = false;
        while let Some(path) = pending.pop() {
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
                || !is_searchable_workspace_file(&path, &options.extensions)
            {
                continue;
            }
            scanned_files += 1;
            let original = match std::fs::read_to_string(&path) {
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
                        diff: short_workspace_diff(&original, &changed, &path),
                    });
                    if options.apply_replace {
                        std::fs::write(&path, changed)
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

    // Find the NSIS installer asset (.exe)
    let mut asset_download_url = String::new();
    let mut asset_name = String::new();
    let mut asset_size: u64 = 0;
    if let Some(assets) = rel["assets"].as_array() {
        for asset in assets {
            let name = asset["name"].as_str().unwrap_or("");
            let lower = name.to_ascii_lowercase();
            let is_current_platform_asset = if cfg!(target_os = "windows") {
                lower.ends_with(".exe") || lower.ends_with(".msi")
            } else if cfg!(target_os = "macos") {
                lower.ends_with(".dmg")
            } else {
                lower.ends_with(".appimage") || lower.ends_with(".deb") || lower.ends_with(".rpm")
            };
            if is_current_platform_asset {
                asset_download_url = asset["browser_download_url"]
                    .as_str()
                    .unwrap_or("")
                    .to_string();
                asset_name = name.to_string();
                asset_size = asset["size"].as_u64().unwrap_or(0);
                // Prefer the NSIS installer over MSI on Windows.
                if lower.ends_with(".exe") {
                    break;
                }
            }
        }
    }

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
    fn old_settings_without_agent_configuration_receive_safe_defaults() {
        let mut value = serde_json::to_value(Settings::default()).unwrap();
        value.as_object_mut().unwrap().remove("agent");
        let restored: Settings = serde_json::from_value(value).unwrap();
        assert!(!restored.agent.enabled);
        assert_eq!(restored.agent.backend, "claude_code");
        assert_eq!(restored.agent.backends.len(), 3);
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
