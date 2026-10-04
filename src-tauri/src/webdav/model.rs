use serde::{Deserialize, Serialize};

pub const HISTORY_LIMIT: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WebDavSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub server_url: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default = "default_webdav_remote_root")]
    pub remote_root: String,
}

fn default_webdav_remote_root() -> String {
    "/Zeditor".into()
}

impl Default for WebDavSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            server_url: String::new(),
            username: String::new(),
            password: String::new(),
            remote_root: default_webdav_remote_root(),
        }
    }
}

/// S3-compatible object storage settings (AWS S3, Aliyun OSS, Tencent COS,
/// MinIO, Cloudflare R2, ...). The remote root acts as an object key prefix.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct S3Settings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub endpoint: String,
    #[serde(default)]
    pub bucket: String,
    #[serde(default)]
    pub region: String,
    #[serde(default)]
    pub access_key: String,
    #[serde(default)]
    pub secret_key: String,
    #[serde(default)]
    pub path_style: bool,
    #[serde(default = "default_s3_remote_root")]
    pub remote_root: String,
}

fn default_s3_remote_root() -> String {
    "/Zeditor".into()
}

impl Default for S3Settings {
    fn default() -> Self {
        Self {
            enabled: false,
            endpoint: String::new(),
            bucket: String::new(),
            region: String::new(),
            access_key: String::new(),
            secret_key: String::new(),
            path_style: false,
            remote_root: default_s3_remote_root(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteDocumentPath {
    pub document_id: String,
    pub display_name: String,
    pub current_path: String,
    pub manifest_path: String,
    pub versions_dir: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WebDavVersion {
    pub id: String,
    pub created_at: String,
    pub size: u64,
    pub sha256: String,
    pub snapshot_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocumentManifest {
    pub document_id: String,
    pub display_name: String,
    pub current_path: String,
    pub versions: Vec<WebDavVersion>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackupIndexEntry {
    pub document_id: String,
    pub display_name: String,
    pub current_path: String,
    pub manifest_path: String,
    pub latest_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackupIndex {
    pub documents: Vec<BackupIndexEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WebDavBackupRequest {
    pub local_path: String,
    pub workspace_roots: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingBackupTask {
    pub document_id: String,
    pub display_name: String,
    pub local_path: String,
    pub workspace_roots: Vec<String>,
    pub current_path: String,
    pub manifest_path: String,
    pub versions_dir: String,
    pub queued_at: String,
    pub sha256: String,
    pub version_id: String,
}

impl PendingBackupTask {
    /// Refresh the expected hash and deterministic version ID for the current
    /// local bytes. Preserves every other field so retries upload the newest
    /// local state without mislabeling an earlier snapshot.
    pub fn refresh_for_bytes(&mut self, bytes: &[u8], created_at: &str) {
        let sha256 = crate::webdav::path::sha256_hex(bytes);
        self.sha256 = sha256.clone();
        self.version_id = crate::webdav::path::deterministic_version_id(created_at, &sha256);
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WebDavDocumentRef {
    pub document_id: String,
    pub display_name: String,
    pub local_path: String,
    pub current_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WebDavConnectionResult {
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WebDavQueuedResult {
    pub document: WebDavDocumentRef,
    pub queued_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WebDavRetryResult {
    pub retried: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WebDavDocumentSummary {
    pub document_id: String,
    pub display_name: String,
    pub current_path: String,
    pub latest_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WebDavDownloadedVersion {
    pub filename: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_base64: Option<String>,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WebDavSyncEvent {
    /// Backend that produced the event (`"webdav"` or `"s3"`). Defaults to
    /// `"webdav"` so events serialized before S3 support still parse.
    #[serde(default = "default_sync_provider")]
    pub provider: String,
    pub document_id: String,
    pub local_path: String,
    pub phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<String>,
    pub timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn default_sync_provider() -> String {
    "webdav".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_event_omits_absent_optional_fields() {
        let event = WebDavSyncEvent {
            provider: "webdav".to_string(),
            document_id: "doc".to_string(),
            local_path: "/work/note.md".to_string(),
            phase: "queued".to_string(),
            progress: None,
            timestamp: "2026-08-19T09:00:00Z".to_string(),
            error: None,
        };

        let value = serde_json::to_value(event).expect("serialize sync event");

        assert!(value.get("progress").is_none());
        assert!(value.get("error").is_none());
        assert_eq!(
            value.get("provider").and_then(|v| v.as_str()),
            Some("webdav")
        );
    }

    #[test]
    fn sync_event_provider_defaults_to_webdav_for_legacy_json() {
        let legacy = br#"{"document_id":"doc","local_path":"/work/note.md","phase":"queued","timestamp":"2026-08-19T09:00:00Z"}"#;
        let event: WebDavSyncEvent = serde_json::from_slice(legacy).expect("legacy event");
        assert_eq!(event.provider, "webdav");
    }
}
