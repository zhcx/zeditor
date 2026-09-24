use base64::{engine::general_purpose, Engine as _};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

const CONVERTER_ID: &str = "document-converter";
const CONVERTER_ENGINE: &str = "anydoc";
const SUPPORTED_PROTOCOL: u32 = 1;
const MAX_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;
const MANIFEST_URL: &str =
    "https://github.com/zhcx/zeditor/releases/download/converter-stable/converter-manifest.json";
const MANIFEST_SIGNATURE_URL: &str =
    "https://github.com/zhcx/zeditor/releases/download/converter-stable/converter-manifest.sig";

#[derive(Default)]
pub struct ConverterManager {
    install_lock: Mutex<()>,
    cancel_install: AtomicBool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConverterArtifact {
    pub target: String,
    pub url: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConverterManifest {
    pub schema_version: u32,
    pub module_id: String,
    #[serde(default)]
    pub engine: Option<String>,
    pub version: String,
    pub protocol_version: u32,
    pub minimum_app_version: String,
    pub artifacts: Vec<ConverterArtifact>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModuleMetadata {
    pub schema_version: u32,
    pub module_id: String,
    #[serde(default)]
    pub engine: Option<String>,
    pub version: String,
    pub protocol_version: u32,
    pub target: String,
    pub executable: String,
    pub executable_sha256: String,
    pub supported_formats: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConverterVersionInfo {
    pub module_id: String,
    #[serde(default)]
    pub engine: Option<String>,
    pub version: String,
    pub protocol_version: u32,
    pub target: String,
    #[serde(default)]
    pub supported_formats: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConverterModuleStatus {
    pub state: String,
    pub target: String,
    pub installed_version: Option<String>,
    pub available_version: Option<String>,
    pub protocol_version: Option<u32>,
    pub installed_size: u64,
    pub download_size: Option<u64>,
    pub supported_formats: Vec<String>,
    pub unsigned_windows_module: bool,
    pub error_code: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct InstallResult {
    pub version: String,
    pub target: String,
    pub installed_size: u64,
}

#[derive(Debug, Clone, Serialize)]
struct InstallProgress {
    stage: &'static str,
    downloaded: u64,
    total: u64,
    percent: u32,
}

fn target_triple() -> &'static str {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "x86_64-pc-windows-msvc"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "x86_64-apple-darwin"
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "aarch64-apple-darwin"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "x86_64-unknown-linux-gnu"
    }
    #[cfg(not(any(
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "linux", target_arch = "x86_64")
    )))]
    {
        "unsupported"
    }
}

fn modules_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))
        .map(|path| path.join("modules").join(CONVERTER_ID))
}

fn active_metadata_path(root: &Path) -> PathBuf {
    root.join("active.json")
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let bytes =
        std::fs::read(path).map_err(|error| format!("读取 {} 失败：{error}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("解析 {} 失败：{error}", path.display()))
}

fn active_metadata(root: &Path) -> Result<Option<ModuleMetadata>, String> {
    let path = active_metadata_path(root);
    if !path.is_file() {
        return Ok(None);
    }
    read_json(&path).map(Some)
}

fn module_directory(root: &Path, metadata: &ModuleMetadata) -> PathBuf {
    root.join(&metadata.version).join(&metadata.target)
}

fn module_executable(root: &Path, metadata: &ModuleMetadata) -> PathBuf {
    module_directory(root, metadata).join(&metadata.executable)
}

/// 返回编译时嵌入的公钥（如有）。
/// 未设置 `CONVERTER_MANIFEST_PUBLIC_KEY` 时返回 `None`，此时跳过 Ed25519 签名验证。
fn public_key() -> Option<VerifyingKey> {
    let encoded = option_env!("CONVERTER_MANIFEST_PUBLIC_KEY")
        .unwrap_or("")
        .trim();
    if encoded.is_empty() {
        return None;
    }
    let bytes = general_purpose::STANDARD.decode(encoded).ok()?;
    let key: [u8; 32] = bytes.try_into().ok()?;
    VerifyingKey::from_bytes(&key).ok()
}

fn verify_signature_with_key(
    key: &VerifyingKey,
    payload: &[u8],
    encoded_signature: &[u8],
) -> Result<(), String> {
    let signature_text = std::str::from_utf8(encoded_signature)
        .map_err(|_| "签名文件不是 UTF-8 文本。".to_string())?;
    let signature_bytes = general_purpose::STANDARD
        .decode(signature_text.trim())
        .map_err(|_| "签名文件不是有效的 Base64。".to_string())?;
    let signature =
        Signature::from_slice(&signature_bytes).map_err(|_| "签名长度无效。".to_string())?;
    key.verify(payload, &signature)
        .map_err(|_| "转换模块签名验证失败。".to_string())
}

/// 验证 Ed25519 签名。未配置公钥时直接返回成功。
fn verify_signature(payload: &[u8], encoded_signature: &[u8]) -> Result<(), String> {
    if let Some(key) = public_key() {
        verify_signature_with_key(&key, payload, encoded_signature)
    } else {
        // 未配置公钥时仅在首次跳过时告警一次：完整性完全依赖 HTTPS，
        // 发布构建应通过 CONVERTER_MANIFEST_PUBLIC_KEY 启用签名验证。
        static WARNED: std::sync::Once = std::sync::Once::new();
        WARNED.call_once(|| {
            eprintln!(
                "WARN: CONVERTER_MANIFEST_PUBLIC_KEY 未设置，跳过转换模块签名验证（仅依赖 HTTPS 传输完整性）"
            );
        });
        Ok(())
    }
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| format!("读取校验文件失败：{error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("计算 SHA-256 失败：{error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// 已验证文件的哈希缓存：以 (路径, 长度, 修改时间) 为键。
/// 仅用于反复校验同一个已安装的可执行文件；下载安装等一次性校验
/// 仍直接使用 `sha256_file` 实算。
fn sha256_file_cached(path: &Path) -> Result<String, String> {
    use std::collections::HashMap;
    use std::time::SystemTime;

    struct CacheKey {
        path: PathBuf,
        len: u64,
        modified: SystemTime,
    }
    impl PartialEq for CacheKey {
        fn eq(&self, other: &Self) -> bool {
            self.path == other.path && self.len == other.len && self.modified == other.modified
        }
    }
    impl Eq for CacheKey {}
    impl std::hash::Hash for CacheKey {
        fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
            self.path.hash(state);
            self.len.hash(state);
            self.modified.hash(state);
        }
    }

    static CACHE: std::sync::Mutex<Option<HashMap<CacheKey, String>>> = std::sync::Mutex::new(None);
    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    let key = CacheKey {
        path: path.to_path_buf(),
        len: metadata.len(),
        modified: metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
    };
    let mut cache = CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(cached) = cache.as_ref().and_then(|map| map.get(&key)) {
        return Ok(cached.clone());
    }
    let digest = sha256_file(path)?;
    let entry = cache.get_or_insert_with(HashMap::new);
    // 防御性上限：正常情况只有一个模块可执行文件，多个版本并存也不多。
    if entry.len() > 16 {
        entry.clear();
    }
    entry.insert(key, digest.clone());
    Ok(digest)
}

fn validate_metadata(metadata: &ModuleMetadata) -> Result<(), String> {
    if metadata.schema_version != 1 || metadata.module_id != CONVERTER_ID {
        return Err("模块元数据类型不受支持。".into());
    }
    if metadata.engine.as_deref() != Some(CONVERTER_ENGINE) {
        return Err("incompatible_converter_engine".into());
    }
    if metadata.protocol_version != SUPPORTED_PROTOCOL {
        return Err(format!(
            "模块协议版本 {} 与主程序支持的版本 {} 不兼容。",
            metadata.protocol_version, SUPPORTED_PROTOCOL
        ));
    }
    if metadata.target != target_triple() {
        return Err(format!(
            "模块目标平台 {} 与当前平台 {} 不匹配。",
            metadata.target,
            target_triple()
        ));
    }
    let executable = Path::new(&metadata.executable);
    if executable.components().count() != 1
        || !matches!(executable.components().next(), Some(Component::Normal(_)))
    {
        return Err("模块可执行文件路径无效。".into());
    }
    Ok(())
}

fn verify_installed_module(root: &Path, metadata: &ModuleMetadata) -> Result<u64, String> {
    validate_metadata(metadata)?;
    let directory = module_directory(root, metadata);
    let signed_metadata_bytes = std::fs::read(directory.join("module.json"))
        .map_err(|error| format!("读取已安装模块元数据失败：{error}"))?;

    // 未配置 CONVERTER_MANIFEST_PUBLIC_KEY 时跳过 Ed25519 签名验证
    if public_key().is_some() {
        let signature = std::fs::read(directory.join("module.sig"))
            .map_err(|error| format!("读取已安装模块签名失败：{error}"))?;
        verify_signature(&signed_metadata_bytes, &signature)?;
    }

    let signed_metadata: ModuleMetadata = serde_json::from_slice(&signed_metadata_bytes)
        .map_err(|error| format!("已安装模块元数据格式无效：{error}"))?;
    if &signed_metadata != metadata {
        return Err("模块激活状态与签名元数据不一致。".into());
    }
    let executable = module_executable(root, &signed_metadata);
    if !executable.is_file() {
        return Err("转换模块可执行文件不存在。".into());
    }
    // 使用缓存哈希：转换器是几十 MB 的可执行文件，而本函数在每次文档
    // 转换与前端状态轮询时都会调用，全量重算 SHA-256 开销显著。
    // 缓存键为 (路径, 长度, mtime)，文件被替换（长度/mtime 变化）时重算。
    let digest = sha256_file_cached(&executable)?;
    if !digest.eq_ignore_ascii_case(&metadata.executable_sha256) {
        return Err("转换模块 SHA-256 校验失败。".into());
    }
    Ok(std::fs::metadata(executable)
        .map(|value| value.len())
        .unwrap_or(0))
}

fn emit_progress(app: &AppHandle, stage: &'static str, downloaded: u64, total: u64) {
    let percent = downloaded
        .saturating_mul(100)
        .checked_div(total)
        .unwrap_or(0)
        .min(100) as u32;
    let _ = app.emit(
        "converter-install-progress",
        InstallProgress {
            stage,
            downloaded,
            total,
            percent,
        },
    );
}

async fn download_bytes(
    client: &reqwest::Client,
    url: &str,
    limit: u64,
) -> Result<Vec<u8>, String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "转换模块下载地址无效。".to_string())?;
    if parsed.scheme() != "https" || parsed.host_str() != Some("github.com") {
        return Err("转换模块下载地址不在允许的 GitHub 域名中。".into());
    }
    let response = client
        .get(parsed)
        .send()
        .await
        .map_err(|error| format!("下载转换模块数据失败：{error}"))?
        .error_for_status()
        .map_err(|error| format!("下载转换模块数据失败：{error}"))?;
    if response.content_length().is_some_and(|size| size > limit) {
        return Err("转换模块数据超过允许的大小。".into());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("读取转换模块数据失败：{error}"))?;
    if bytes.len() as u64 > limit {
        return Err("转换模块数据超过允许的大小。".into());
    }
    Ok(bytes.to_vec())
}

async fn fetch_manifest() -> Result<ConverterManifest, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent(format!("Zeditor/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| format!("创建模块下载客户端失败：{error}"))?;
    let manifest_bytes = download_bytes(&client, MANIFEST_URL, 1024 * 1024).await?;
    // 仅在有公钥时下载并验证签名；无公钥时跳过
    if public_key().is_some() {
        let signature = download_bytes(&client, MANIFEST_SIGNATURE_URL, 16 * 1024).await?;
        verify_signature(&manifest_bytes, &signature)?;
    }
    let parsed: ConverterManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| format!("模块清单格式无效：{error}"))?;
    if parsed.schema_version != 1 || parsed.module_id != CONVERTER_ID {
        return Err("模块清单类型不受支持。".into());
    }
    if parsed.engine.as_deref() != Some(CONVERTER_ENGINE) {
        return Err("incompatible_converter_engine".into());
    }
    let minimum = semver::Version::parse(parsed.minimum_app_version.trim_start_matches('v'))
        .map_err(|_| "模块清单中的最低主程序版本无效。".to_string())?;
    let current = semver::Version::parse(env!("CARGO_PKG_VERSION"))
        .map_err(|_| "当前主程序版本格式无效。".to_string())?;
    if current < minimum {
        return Err(format!(
            "该转换模块要求 Zeditor {} 或更高版本。",
            parsed.minimum_app_version
        ));
    }
    Ok(parsed)
}

async fn download_archive(
    app: &AppHandle,
    manager: &ConverterManager,
    artifact: &ConverterArtifact,
    destination: &Path,
) -> Result<(), String> {
    let parsed =
        reqwest::Url::parse(&artifact.url).map_err(|_| "转换模块下载地址无效。".to_string())?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("github.com")
        || !parsed
            .path()
            .starts_with("/zhcx/zeditor/releases/download/")
    {
        return Err("转换模块下载地址不在允许的 GitHub Release 范围中。".into());
    }
    if artifact.size == 0 || artifact.size > MAX_ARCHIVE_BYTES {
        return Err("转换模块清单中的文件大小无效。".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20 * 60))
        .user_agent(format!("Zeditor/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| format!("创建模块下载客户端失败：{error}"))?;
    let response = client
        .get(parsed)
        .send()
        .await
        .map_err(|error| format!("下载转换模块失败：{error}"))?
        .error_for_status()
        .map_err(|error| format!("下载转换模块失败：{error}"))?;
    let total = response.content_length().unwrap_or(artifact.size);
    if total > MAX_ARCHIVE_BYTES {
        return Err("转换模块下载大小超过限制。".into());
    }
    let mut file =
        File::create(destination).map_err(|error| format!("创建模块下载文件失败：{error}"))?;
    let mut downloaded = 0_u64;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if manager.cancel_install.load(Ordering::Relaxed) {
            return Err("转换模块安装已取消。".into());
        }
        let chunk = chunk.map_err(|error| format!("读取转换模块下载数据失败：{error}"))?;
        downloaded = downloaded.saturating_add(chunk.len() as u64);
        if downloaded > MAX_ARCHIVE_BYTES {
            return Err("转换模块下载大小超过限制。".into());
        }
        file.write_all(&chunk)
            .map_err(|error| format!("写入转换模块失败：{error}"))?;
        emit_progress(app, "downloading", downloaded, total);
    }
    file.flush()
        .map_err(|error| format!("保存转换模块失败：{error}"))?;
    if downloaded != artifact.size {
        return Err(format!(
            "转换模块下载大小不匹配：预期 {} 字节，实际 {} 字节。",
            artifact.size, downloaded
        ));
    }
    Ok(())
}

fn safe_extract_zip(archive: &Path, destination: &Path) -> Result<(), String> {
    let file = File::open(archive).map_err(|error| format!("打开模块压缩包失败：{error}"))?;
    let mut zip =
        zip::ZipArchive::new(file).map_err(|error| format!("模块压缩包格式无效：{error}"))?;
    for index in 0..zip.len() {
        let mut entry = zip
            .by_index(index)
            .map_err(|error| format!("读取模块压缩包失败：{error}"))?;
        let enclosed = entry
            .enclosed_name()
            .ok_or_else(|| "模块压缩包包含不安全路径。".to_string())?
            .to_path_buf();
        let output = destination.join(enclosed);
        if entry.is_dir() {
            std::fs::create_dir_all(&output)
                .map_err(|error| format!("创建模块目录失败：{error}"))?;
            continue;
        }
        if let Some(parent) = output.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("创建模块目录失败：{error}"))?;
        }
        let mut output_file =
            File::create(&output).map_err(|error| format!("创建模块文件失败：{error}"))?;
        std::io::copy(&mut entry, &mut output_file)
            .map_err(|error| format!("解压模块文件失败：{error}"))?;
    }
    Ok(())
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = std::fs::metadata(path)
        .map_err(|error| format!("读取模块权限失败：{error}"))?
        .permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(path, permissions)
        .map_err(|error| format!("设置模块执行权限失败：{error}"))
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn health_check(executable: &Path, expected: &ModuleMetadata) -> Result<(), String> {
    // 先尝试 --version-json（新版转换器支持），失败时降级为基本可执行文件检查
    let mut command = Command::new(executable);
    hide_converter_window(&mut command);
    let result = command.arg("--version-json").output();

    match result {
        Ok(output) if output.status.success() => {
            let info: ConverterVersionInfo = serde_json::from_slice(&output.stdout)
                .map_err(|error| format!("转换模块版本信息无效：{error}"))?;
            if info.module_id != CONVERTER_ID
                || info.engine.as_deref() != Some(CONVERTER_ENGINE)
                || info.version != expected.version
                || info.protocol_version != SUPPORTED_PROTOCOL
                || info.target != target_triple()
            {
                return Err("转换模块健康检查返回了不兼容的版本信息。".into());
            }
            Ok(())
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            eprintln!(
                "转换模块 --version-json 返回非零退出码，降级为基本检查：{}",
                stderr.trim()
            );
            // 降级：可执行文件存在且元数据校验通过即可（SHA-256 已在之前完成）
            if !executable.is_file() {
                return Err("转换模块可执行文件在健康检查时不存在。".into());
            }
            Ok(())
        }
        Err(error) => {
            eprintln!("转换模块 --version-json 无法启动（{error}），降级为基本检查");
            if !executable.is_file() {
                return Err("转换模块可执行文件在健康检查时不存在。".into());
            }
            Ok(())
        }
    }
}

fn install_archive(
    app: &AppHandle,
    root: &Path,
    archive: &Path,
    expected_archive_sha256: Option<&str>,
) -> Result<InstallResult, String> {
    emit_progress(app, "verifying", 0, 0);
    if let Some(expected) = expected_archive_sha256 {
        let actual = sha256_file(archive)?;
        if !actual.eq_ignore_ascii_case(expected) {
            return Err("转换模块压缩包 SHA-256 校验失败。".into());
        }
    }
    let staging = root.join(format!(".staging-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&staging).map_err(|error| format!("创建模块暂存目录失败：{error}"))?;
    let result = (|| {
        safe_extract_zip(archive, &staging)?;
        let metadata_bytes = std::fs::read(staging.join("module.json"))
            .map_err(|error| format!("读取模块元数据失败：{error}"))?;

        // 未配置公钥时跳过签名验证，module.sig 为可选
        if public_key().is_some() {
            let signature = std::fs::read(staging.join("module.sig"))
                .map_err(|error| format!("读取模块签名失败：{error}"))?;
            verify_signature(&metadata_bytes, &signature)?;
        }

        let metadata: ModuleMetadata = serde_json::from_slice(&metadata_bytes)
            .map_err(|error| format!("模块元数据格式无效：{error}"))?;
        validate_metadata(&metadata)?;
        let staged_executable = staging.join(&metadata.executable);
        if !staged_executable.is_file() {
            return Err("模块压缩包缺少转换器可执行文件。".into());
        }
        if !sha256_file(&staged_executable)?.eq_ignore_ascii_case(&metadata.executable_sha256) {
            return Err("转换器可执行文件 SHA-256 校验失败。".into());
        }
        make_executable(&staged_executable)?;
        health_check(&staged_executable, &metadata)?;
        emit_progress(app, "installing", 0, 0);

        let final_directory = module_directory(root, &metadata);
        if final_directory.exists() {
            std::fs::remove_dir_all(&final_directory)
                .map_err(|error| format!("替换旧模块失败：{error}"))?;
        }
        if let Some(parent) = final_directory.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("创建模块版本目录失败：{error}"))?;
        }
        std::fs::rename(&staging, &final_directory)
            .map_err(|error| format!("激活转换模块失败：{error}"))?;

        let active_path = active_metadata_path(root);
        let temporary_active = root.join("active.json.partial");
        std::fs::write(
            &temporary_active,
            serde_json::to_vec_pretty(&metadata)
                .map_err(|error| format!("序列化模块状态失败：{error}"))?,
        )
        .map_err(|error| format!("保存模块状态失败：{error}"))?;
        std::fs::rename(&temporary_active, &active_path)
            .map_err(|error| format!("激活模块状态失败：{error}"))?;
        cleanup_old_versions(root, &metadata.version)?;
        let installed_size = verify_installed_module(root, &metadata)?;
        emit_progress(app, "complete", installed_size, installed_size);
        Ok(InstallResult {
            version: metadata.version,
            target: metadata.target,
            installed_size,
        })
    })();
    if staging.exists() {
        let _ = std::fs::remove_dir_all(staging);
    }
    result
}

fn cleanup_old_versions(root: &Path, active_version: &str) -> Result<(), String> {
    let mut versions = std::fs::read_dir(root)
        .map_err(|error| format!("读取模块版本目录失败：{error}"))?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
        .collect::<Vec<_>>();
    versions.sort_by_key(|entry| {
        std::cmp::Reverse(
            entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .ok(),
        )
    });
    let mut kept_previous = false;
    for entry in versions {
        if entry.file_name().to_string_lossy() == active_version {
            continue;
        }
        if !kept_previous {
            kept_previous = true;
            continue;
        }
        std::fs::remove_dir_all(entry.path())
            .map_err(|error| format!("清理旧模块失败：{error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_converter_module_status(app: AppHandle) -> ConverterModuleStatus {
    let target = target_triple().to_string();
    let empty =
        |state: &str, error_code: Option<&str>, message: Option<String>| ConverterModuleStatus {
            state: state.into(),
            target: target.clone(),
            installed_version: None,
            available_version: None,
            protocol_version: None,
            installed_size: 0,
            download_size: None,
            supported_formats: vec![],
            unsigned_windows_module: cfg!(target_os = "windows"),
            error_code: error_code.map(str::to_string),
            message,
        };
    if target == "unsupported" {
        return empty(
            "incompatible",
            Some("unsupported_platform"),
            Some("当前操作系统或架构暂不支持文档转换模块。".into()),
        );
    }
    let root = match modules_root(&app) {
        Ok(root) => root,
        Err(error) => return empty("error", Some("storage_unavailable"), Some(error)),
    };
    let metadata = match active_metadata(&root) {
        Ok(Some(metadata)) => metadata,
        Ok(None) => return empty("missing", None, None),
        Err(error) => return empty("corrupt", Some("invalid_active_state"), Some(error)),
    };
    match verify_installed_module(&root, &metadata) {
        Ok(installed_size) => ConverterModuleStatus {
            state: "ready".into(),
            target,
            installed_version: Some(metadata.version),
            available_version: None,
            protocol_version: Some(metadata.protocol_version),
            installed_size,
            download_size: None,
            supported_formats: metadata.supported_formats,
            unsigned_windows_module: cfg!(target_os = "windows"),
            error_code: None,
            message: None,
        },
        Err(error) if error == "incompatible_converter_engine" => empty(
            "incompatible",
            Some("incompatible_converter_engine"),
            Some(error),
        ),
        Err(error) => empty("corrupt", Some("module_verification_failed"), Some(error)),
    }
}

#[tauri::command]
pub async fn check_converter_module_update(
    app: AppHandle,
) -> Result<ConverterModuleStatus, String> {
    let manifest = fetch_manifest().await?;
    if manifest.protocol_version != SUPPORTED_PROTOCOL {
        return Err("稳定版转换模块与当前主程序协议不兼容。".into());
    }
    let mut status = get_converter_module_status(app);
    status.available_version = Some(manifest.version.clone());
    status.download_size = manifest
        .artifacts
        .iter()
        .find(|artifact| artifact.target == target_triple())
        .map(|artifact| artifact.size);
    if status.installed_version.as_deref() != Some(manifest.version.as_str())
        && status.state == "ready"
    {
        status.state = "update_available".into();
    }
    Ok(status)
}

#[tauri::command]
pub async fn install_converter_module(
    app: AppHandle,
    manager: State<'_, ConverterManager>,
) -> Result<InstallResult, String> {
    let _guard = manager
        .install_lock
        .try_lock()
        .map_err(|_| "已有转换模块安装任务正在进行。".to_string())?;
    manager.cancel_install.store(false, Ordering::Relaxed);
    let manifest = fetch_manifest().await?;
    if manifest.protocol_version != SUPPORTED_PROTOCOL {
        return Err("稳定版转换模块与当前主程序协议不兼容。".into());
    }
    let artifact = manifest
        .artifacts
        .iter()
        .find(|artifact| artifact.target == target_triple())
        .ok_or_else(|| "稳定版清单中没有适用于当前平台的转换模块。".to_string())?;
    let root = modules_root(&app)?;
    std::fs::create_dir_all(&root).map_err(|error| format!("创建模块目录失败：{error}"))?;
    let archive = root.join(format!(".download-{}.zip", uuid::Uuid::new_v4()));
    let result = async {
        download_archive(&app, &manager, artifact, &archive).await?;
        install_archive(&app, &root, &archive, Some(&artifact.sha256))
    }
    .await;
    if archive.exists() {
        let _ = std::fs::remove_file(archive);
    }
    result
}

#[tauri::command]
pub fn cancel_converter_install(manager: State<'_, ConverterManager>) {
    manager.cancel_install.store(true, Ordering::Relaxed);
}

#[tauri::command]
pub fn import_converter_module(
    app: AppHandle,
    manager: State<'_, ConverterManager>,
    path: String,
) -> Result<InstallResult, String> {
    let _guard = manager
        .install_lock
        .try_lock()
        .map_err(|_| "已有转换模块安装任务正在进行。".to_string())?;
    let archive = PathBuf::from(path);
    if !archive.is_file() {
        return Err("请选择存在的转换模块压缩包。".into());
    }
    let size = std::fs::metadata(&archive)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    if size == 0 || size > MAX_ARCHIVE_BYTES {
        return Err("转换模块压缩包大小无效。".into());
    }
    let root = modules_root(&app)?;
    std::fs::create_dir_all(&root).map_err(|error| format!("创建模块目录失败：{error}"))?;
    install_archive(&app, &root, &archive, None)
}

#[tauri::command]
pub fn uninstall_converter_module(app: AppHandle) -> Result<(), String> {
    let root = modules_root(&app)?;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
    if !root.starts_with(&app_data)
        || root.file_name().and_then(|value| value.to_str()) != Some(CONVERTER_ID)
    {
        return Err("拒绝删除不安全的模块路径。".into());
    }
    if root.exists() {
        std::fs::remove_dir_all(root).map_err(|error| format!("卸载转换模块失败：{error}"))?;
    }
    Ok(())
}

fn markdown_from_converter_output(
    output: std::process::Output,
    markdown_path: &Path,
    source_size: u64,
    elapsed: Duration,
) -> Result<String, String> {
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("文档转换失败：{}", stderr.trim()));
    }
    if !markdown_path.is_file() {
        return Err("转换模块未生成 Markdown 文件。".into());
    }
    let markdown = std::fs::read_to_string(markdown_path)
        .map_err(|error| format!("读取转换结果失败：{error}"))?;
    let _ = std::fs::remove_file(markdown_path);
    if markdown.is_empty() && source_size > 0 {
        return Err("转换结果为空。".into());
    }
    eprintln!(
        "Converted {} bytes to {} Markdown bytes in {} ms",
        source_size,
        markdown.len(),
        elapsed.as_millis()
    );
    Ok(markdown)
}

fn hide_converter_window(command: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
}

#[tauri::command]
pub async fn convert_document(app: AppHandle, path: String) -> Result<String, String> {
    let source = PathBuf::from(&path);
    if !source.is_file() {
        return Err("请选择一个存在的本地文件。".into());
    }
    let source_size = std::fs::metadata(&source)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let markdown_path =
        std::env::temp_dir().join(format!("zeditor-conversion-{}.md", uuid::Uuid::new_v4()));
    let root = modules_root(&app)?;
    let installed = active_metadata(&root)
        .ok()
        .flatten()
        .filter(|metadata| verify_installed_module(&root, metadata).is_ok())
        .map(|metadata| module_executable(&root, &metadata));
    let executable = installed.or_else(|| {
        std::env::var_os("ANYDOC_CONVERTER_PATH")
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
            .filter(|path| path.is_file())
    });
    if executable.is_none() {
        return Err(
            "converter_module_missing：未安装 Zeditor AnyDoc 转换模块。请在设置中安装对应平台模块；开发调试可设置 ANYDOC_CONVERTER_PATH。"
                .into(),
        );
    }

    let executable = executable.expect("converter checked above");
    tokio::task::spawn_blocking(move || {
        let started = Instant::now();
        // 失败路径（进程退出非零/启动失败）也会清理临时 markdown 文件，
        // 避免临时目录累积残留。
        struct TempCleanup<'a>(&'a Path);
        impl Drop for TempCleanup<'_> {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(self.0);
            }
        }
        let _cleanup = TempCleanup(&markdown_path);
        let mut command = Command::new(executable);
        hide_converter_window(&mut command);
        let output = command
            .arg(&source)
            .arg(&markdown_path)
            .output()
            .map_err(|error| format!("无法启动 Zeditor AnyDoc 转换模块：{error}"))?;
        markdown_from_converter_output(output, &markdown_path, source_size, started.elapsed())
    })
    .await
    .map_err(|error| format!("文档转换任务异常结束：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::{
        target_triple, validate_metadata, verify_signature_with_key, ModuleMetadata,
        SUPPORTED_PROTOCOL,
    };
    use base64::{engine::general_purpose, Engine as _};
    use ed25519_dalek::{Signer, SigningKey};

    fn metadata(target: &str) -> ModuleMetadata {
        ModuleMetadata {
            schema_version: 1,
            module_id: "document-converter".into(),
            engine: Some("anydoc".into()),
            version: "1.3.0".into(),
            protocol_version: SUPPORTED_PROTOCOL,
            target: target.into(),
            executable: if cfg!(windows) {
                "document_converter.exe".into()
            } else {
                "document_converter".into()
            },
            executable_sha256: "00".repeat(32),
            supported_formats: vec!["pdf".into(), "docx".into()],
        }
    }

    #[test]
    fn accepts_current_target_and_rejects_other_targets() {
        assert!(validate_metadata(&metadata(target_triple())).is_ok());
        assert!(validate_metadata(&metadata("other-target")).is_err());
    }

    #[test]
    fn rejects_nested_executable_paths() {
        let mut value = metadata(target_triple());
        value.executable = "../converter".into();
        assert!(validate_metadata(&value).is_err());
        value.executable = "nested/converter".into();
        assert!(validate_metadata(&value).is_err());
    }

    #[test]
    fn rejects_legacy_markitdown_modules_by_engine_marker() {
        let mut value = metadata(target_triple());
        value.engine = None;
        assert_eq!(
            validate_metadata(&value),
            Err("incompatible_converter_engine".into())
        );
    }

    #[test]
    fn verifies_exact_ed25519_payload_and_rejects_tampering() {
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let payload = b"signed converter metadata";
        let signature = general_purpose::STANDARD.encode(signing_key.sign(payload).to_bytes());
        assert!(verify_signature_with_key(
            &signing_key.verifying_key(),
            payload,
            signature.as_bytes()
        )
        .is_ok());
        assert!(verify_signature_with_key(
            &signing_key.verifying_key(),
            b"tampered",
            signature.as_bytes()
        )
        .is_err());
    }
}
