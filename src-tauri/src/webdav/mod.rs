use base64::{engine::general_purpose, Engine as _};
mod client;
mod manager;
mod manifest;
mod model;
mod path;
mod queue;
mod s3;
mod sigv4;

pub use client::{sanitize_webdav_error, RemoteClient, RemoteSyncClient, WebDavClient};
pub use manager::{S3SyncManager, SyncProvider, WebDavEventSink, WebDavSyncManager};
pub use manifest::{
    parse_index, parse_manifest, validate_index_namespace, validate_manifest_namespace,
};
pub use model::{
    BackupIndex, BackupIndexEntry, DocumentManifest, PendingBackupTask, RemoteDocumentPath,
    S3Settings, WebDavBackupRequest, WebDavConnectionResult, WebDavDocumentRef,
    WebDavDocumentSummary, WebDavDownloadedVersion, WebDavQueuedResult, WebDavRetryResult,
    WebDavSettings, WebDavSyncEvent, WebDavVersion, HISTORY_LIMIT,
};
pub use path::{
    deterministic_version_id, document_manifest_path, document_versions_dir, history_index_path,
    map_remote_document, normalize_remote_root, sha256_hex, validate_endpoint,
};
pub use queue::PendingTaskStore;
pub use s3::S3Client;

use tauri::{Emitter, State};

/// Tauri-backed event sink that emits WebDAV sync status through the app bus.
pub struct TauriWebDavEventSink(pub tauri::AppHandle);

impl WebDavEventSink for TauriWebDavEventSink {
    fn emit(&self, event: &WebDavSyncEvent) -> Result<(), String> {
        self.0
            .emit("webdav-sync-status", event)
            .map_err(|error| format!("WebDAV event emission failed: {error}"))
    }
}

/// Test the configured WebDAV server with a real write-read-delete probe.
#[tauri::command]
pub async fn webdav_test_connection(
    settings: WebDavSettings,
) -> Result<WebDavConnectionResult, String> {
    let client = WebDavClient::new(&settings)?;
    client.test_connection(&settings.remote_root).await?;
    Ok(WebDavConnectionResult {
        message: "WebDAV 连接测试成功".to_string(),
    })
}

/// Durable enqueue of a saved document's backup task.
#[tauri::command]
pub async fn webdav_enqueue_backup(
    manager: State<'_, WebDavSyncManager>,
    request: WebDavBackupRequest,
    settings: WebDavSettings,
) -> Result<WebDavQueuedResult, String> {
    manager.enqueue(request, settings).await
}

/// Re-run every persisted pending backup task.
#[tauri::command]
pub async fn webdav_retry_pending(
    manager: State<'_, WebDavSyncManager>,
    settings: WebDavSettings,
) -> Result<WebDavRetryResult, String> {
    manager.retry_pending(settings).await
}

/// List all documents in the remote backup index.
#[tauri::command]
pub async fn webdav_list_documents(
    settings: WebDavSettings,
) -> Result<Vec<WebDavDocumentSummary>, String> {
    let client = WebDavClient::new(&settings)?;
    let remote_root = normalize_remote_root(&settings.remote_root)?;
    let index_path = history_index_path(&remote_root);
    let Some(bytes) = client.get_optional(&index_path).await? else {
        return Ok(Vec::new());
    };
    let index = parse_index(&bytes)?;
    validate_index_namespace(&index, &remote_root)?;
    Ok(index
        .documents
        .into_iter()
        .map(|entry| WebDavDocumentSummary {
            document_id: entry.document_id,
            display_name: entry.display_name,
            current_path: entry.current_path,
            latest_at: entry.latest_at,
        })
        .collect())
}

/// List the historical versions of one remote document.
#[tauri::command]
pub async fn webdav_list_versions(
    document_id: String,
    settings: WebDavSettings,
) -> Result<Vec<WebDavVersion>, String> {
    let client = WebDavClient::new(&settings)?;
    let remote_root = normalize_remote_root(&settings.remote_root)?;
    let manifest_path = document_manifest_path(&remote_root, &document_id);
    let Some(bytes) = client.get_optional(&manifest_path).await? else {
        return Ok(Vec::new());
    };
    let manifest = parse_manifest(&bytes)?;
    let expected = expected_for_download(
        &remote_root,
        &document_id,
        &manifest.display_name,
        &manifest.current_path,
    )?;
    validate_manifest_namespace(&manifest, &expected, &remote_root)?;
    Ok(manifest.versions)
}

/// Download one historical version after verifying its SHA-256.
#[tauri::command]
pub async fn webdav_download_version(
    document_id: String,
    version_id: String,
    settings: WebDavSettings,
) -> Result<WebDavDownloadedVersion, String> {
    let client = WebDavClient::new(&settings)?;
    let remote_root = normalize_remote_root(&settings.remote_root)?;
    let manifest_path = document_manifest_path(&remote_root, &document_id);
    let bytes = client.get(&manifest_path).await?;
    let manifest = parse_manifest(&bytes)?;
    validate_manifest_namespace(
        &manifest,
        &expected_for_download(
            &remote_root,
            &document_id,
            &manifest.display_name,
            &manifest.current_path,
        )?,
        &remote_root,
    )?;
    let version = manifest
        .versions
        .iter()
        .find(|candidate| candidate.id == version_id)
        .ok_or_else(|| format!("WebDAV version '{version_id}' was not found"))?;

    let content = client.get(&version.snapshot_path).await?;
    let actual_hash = sha256_hex(&content);
    if actual_hash != version.sha256 {
        return Err("WebDAV 下载校验失败：内容哈希与清单不一致".to_string());
    }
    let size = content.len() as u64;
    let data_base64 = Some(general_purpose::STANDARD.encode(&content));
    let text = String::from_utf8(content).unwrap_or_default();

    Ok(WebDavDownloadedVersion {
        filename: manifest.display_name,
        content: text,
        data_base64,
        size,
        sha256: version.sha256.clone(),
    })
}

/// The expected remote layout for a downloaded document's manifest.
fn expected_for_download(
    remote_root: &str,
    document_id: &str,
    display_name: &str,
    current_path: &str,
) -> Result<RemoteDocumentPath, String> {
    Ok(RemoteDocumentPath {
        document_id: document_id.to_string(),
        display_name: display_name.to_string(),
        current_path: current_path.to_string(),
        manifest_path: document_manifest_path(remote_root, document_id),
        versions_dir: document_versions_dir(remote_root, document_id),
    })
}

/// Test the configured S3 endpoint with a real write-read-delete probe.
#[tauri::command]
pub async fn s3_test_connection(settings: S3Settings) -> Result<WebDavConnectionResult, String> {
    let client = S3Client::new(&settings)?;
    client.test_connection(&settings.remote_root).await?;
    Ok(WebDavConnectionResult {
        message: "S3 连接测试成功".to_string(),
    })
}

/// Durable enqueue of a saved document's S3 backup task.
#[tauri::command]
pub async fn s3_enqueue_backup(
    manager: State<'_, S3SyncManager>,
    request: WebDavBackupRequest,
    settings: S3Settings,
) -> Result<WebDavQueuedResult, String> {
    manager.enqueue(request, settings).await
}

/// Re-run every persisted pending S3 backup task.
#[tauri::command]
pub async fn s3_retry_pending(
    manager: State<'_, S3SyncManager>,
    settings: S3Settings,
) -> Result<WebDavRetryResult, String> {
    manager.retry_pending(settings).await
}

/// List all documents in the S3 backup index.
#[tauri::command]
pub async fn s3_list_documents(settings: S3Settings) -> Result<Vec<WebDavDocumentSummary>, String> {
    let client = S3Client::new(&settings)?;
    let remote_root = normalize_remote_root(&settings.remote_root)?;
    let index_path = history_index_path(&remote_root);
    let Some(bytes) = client.get_optional(&index_path).await? else {
        return Ok(Vec::new());
    };
    let index = parse_index(&bytes)?;
    validate_index_namespace(&index, &remote_root)?;
    Ok(index
        .documents
        .into_iter()
        .map(|entry| WebDavDocumentSummary {
            document_id: entry.document_id,
            display_name: entry.display_name,
            current_path: entry.current_path,
            latest_at: entry.latest_at,
        })
        .collect())
}

/// List the historical versions of one S3-backed document.
#[tauri::command]
pub async fn s3_list_versions(
    document_id: String,
    settings: S3Settings,
) -> Result<Vec<WebDavVersion>, String> {
    let client = S3Client::new(&settings)?;
    let remote_root = normalize_remote_root(&settings.remote_root)?;
    let manifest_path = document_manifest_path(&remote_root, &document_id);
    let Some(bytes) = client.get_optional(&manifest_path).await? else {
        return Ok(Vec::new());
    };
    let manifest = parse_manifest(&bytes)?;
    let expected = expected_for_download(
        &remote_root,
        &document_id,
        &manifest.display_name,
        &manifest.current_path,
    )?;
    validate_manifest_namespace(&manifest, &expected, &remote_root)?;
    Ok(manifest.versions)
}

/// Download one S3 historical version after verifying its SHA-256.
#[tauri::command]
pub async fn s3_download_version(
    document_id: String,
    version_id: String,
    settings: S3Settings,
) -> Result<WebDavDownloadedVersion, String> {
    let client = S3Client::new(&settings)?;
    let remote_root = normalize_remote_root(&settings.remote_root)?;
    let manifest_path = document_manifest_path(&remote_root, &document_id);
    let bytes = client.get(&manifest_path).await?;
    let manifest = parse_manifest(&bytes)?;
    validate_manifest_namespace(
        &manifest,
        &expected_for_download(
            &remote_root,
            &document_id,
            &manifest.display_name,
            &manifest.current_path,
        )?,
        &remote_root,
    )?;
    let version = manifest
        .versions
        .iter()
        .find(|candidate| candidate.id == version_id)
        .ok_or_else(|| format!("S3 version '{version_id}' was not found"))?;

    let content = client.get(&version.snapshot_path).await?;
    let actual_hash = sha256_hex(&content);
    if actual_hash != version.sha256 {
        return Err("S3 下载校验失败：内容哈希与清单不一致".to_string());
    }
    let size = content.len() as u64;
    let data_base64 = Some(general_purpose::STANDARD.encode(&content));
    let text = String::from_utf8(content).unwrap_or_default();

    Ok(WebDavDownloadedVersion {
        filename: manifest.display_name,
        content: text,
        data_base64,
        size,
        sha256: version.sha256.clone(),
    })
}

#[cfg(test)]
pub(crate) mod test_support {
    /// Shared temp directory helper for WebDAV persistence tests.
    pub(crate) fn test_temp_dir() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("zeditor-webdav-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("create temp directory");
        path
    }
}

#[cfg(test)]
mod tests {
    use super::{
        map_remote_document, normalize_remote_root, parse_index, validate_index_namespace,
        validate_manifest_namespace, BackupIndex, DocumentManifest, RemoteDocumentPath,
        WebDavSettings, HISTORY_LIMIT,
    };

    #[test]
    fn intended_domain_api_is_reexported_from_webdav_root() {
        assert_eq!(HISTORY_LIMIT, 20);
        assert_eq!(normalize_remote_root("Zeditor").unwrap(), "/Zeditor");
        assert!(parse_index(br#"{"documents": []}"#).is_ok());
        assert!(validate_index_namespace(&BackupIndex::default(), "/Zeditor").is_ok());
        let manifest = DocumentManifest::new("doc", "note.md", "/Zeditor/note.md");
        assert!(manifest.versions.is_empty());
        let expected = RemoteDocumentPath {
            document_id: "doc".to_string(),
            display_name: "note.md".to_string(),
            current_path: "/Zeditor/note.md".to_string(),
            manifest_path: "/Zeditor/manifest.json".to_string(),
            versions_dir: "/Zeditor/versions".to_string(),
        };
        assert!(validate_manifest_namespace(&manifest, &expected, "/Zeditor").is_err());
        assert!(map_remote_document("/work/note.md", &[], "/Zeditor").is_ok());
    }

    #[test]
    fn webdav_settings_has_safe_defaults() {
        let settings = WebDavSettings::default();
        assert!(!settings.enabled);
        assert!(settings.server_url.is_empty());
        assert!(settings.username.is_empty());
        assert!(settings.password.is_empty());
        assert_eq!(settings.remote_root, "/Zeditor");
    }
}

#[cfg(test)]
mod command_tests {
    use super::*;
    use crate::webdav::client::test_support::{settings_for, TestDavServer};
    use crate::webdav::DocumentManifest;
    use std::collections::HashMap;

    fn seed_resources() -> HashMap<String, Vec<u8>> {
        let document_id = "a".repeat(24);
        let version_id = "b".repeat(24);
        let manifest = DocumentManifest {
            document_id: document_id.clone(),
            display_name: "note.md".to_string(),
            current_path: "/Zeditor/notes/note.md".to_string(),
            versions: vec![WebDavVersion {
                id: version_id.clone(),
                created_at: "2026-08-19T14:32:00Z".to_string(),
                size: 7,
                sha256: sha256_hex(b"version one"),
                snapshot_path: format!(
                    "/Zeditor/.zeditor-history/documents/{document_id}/versions/{version_id}.md"
                ),
            }],
        };
        let index = BackupIndex {
            documents: vec![BackupIndexEntry {
                document_id: document_id.clone(),
                display_name: "note.md".to_string(),
                current_path: "/Zeditor/notes/note.md".to_string(),
                manifest_path: format!(
                    "/Zeditor/.zeditor-history/documents/{document_id}/manifest.json"
                ),
                latest_at: "2026-08-19T14:32:00Z".to_string(),
            }],
        };
        let mut resources = HashMap::new();
        resources.insert(
            format!("/Zeditor/.zeditor-history/documents/{document_id}/manifest.json"),
            serde_json::to_vec(&manifest).expect("manifest json"),
        );
        resources.insert(
            "/Zeditor/.zeditor-history/index.json".to_string(),
            serde_json::to_vec(&index).expect("index json"),
        );
        resources.insert(
            format!("/Zeditor/.zeditor-history/documents/{document_id}/versions/{version_id}.md"),
            b"version one".to_vec(),
        );
        resources
    }

    #[tokio::test]
    async fn download_rejects_manifest_hash_mismatch() {
        let document_id = "a".repeat(24);
        let version_id = "b".repeat(24);
        let snapshot_path =
            format!("/Zeditor/.zeditor-history/documents/{document_id}/versions/{version_id}.md");
        let manifest = DocumentManifest {
            document_id: document_id.clone(),
            display_name: "note.md".to_string(),
            current_path: "/Zeditor/notes/note.md".to_string(),
            versions: vec![WebDavVersion {
                id: version_id.clone(),
                created_at: "2026-08-19T14:32:00Z".to_string(),
                size: 7,
                sha256: sha256_hex(b"expected"),
                snapshot_path: snapshot_path.clone(),
            }],
        };
        let mut resources = HashMap::new();
        resources.insert(
            format!("/Zeditor/.zeditor-history/documents/{document_id}/manifest.json"),
            serde_json::to_vec(&manifest).expect("manifest json"),
        );
        resources.insert(snapshot_path, b"tampered".to_vec());
        let server = TestDavServer::with_resources(resources).await;

        let error = webdav_download_version(document_id, version_id, settings_for(&server.url))
            .await
            .expect_err("hash mismatch");
        assert!(error.contains("校验失败"));
    }

    #[tokio::test]
    async fn lists_seeded_documents_and_versions() {
        let server = TestDavServer::with_resources(seed_resources()).await;
        let settings = settings_for(&server.url);

        let documents = webdav_list_documents(settings.clone())
            .await
            .expect("list documents");
        assert_eq!(documents.len(), 1);
        assert_eq!(documents[0].display_name, "note.md");

        let versions = webdav_list_versions(documents[0].document_id.clone(), settings)
            .await
            .expect("list versions");
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].sha256, sha256_hex(b"version one"));
    }

    #[tokio::test]
    async fn downloads_verified_version() {
        let document_id = "a".repeat(24);
        let version_id = "b".repeat(24);
        let server = TestDavServer::with_resources(seed_resources()).await;

        let downloaded =
            webdav_download_version(document_id, version_id, settings_for(&server.url))
                .await
                .expect("verified download");
        assert_eq!(downloaded.filename, "note.md");
        assert_eq!(downloaded.content, "version one");
        assert_eq!(downloaded.size, "version one".len() as u64);
        assert_eq!(downloaded.sha256, sha256_hex(b"version one"));
    }

    #[tokio::test]
    async fn connection_test_reports_success_with_write_read_delete() {
        let server = TestDavServer::start(vec![]).await;
        let result = webdav_test_connection(settings_for(&server.url))
            .await
            .expect("connection test");
        assert!(result.message.contains("成功"));

        let methods: Vec<String> = server
            .requests()
            .await
            .iter()
            .map(|request| request.method.clone())
            .collect();
        assert!(methods.contains(&"MKCOL".to_string()));
        assert!(methods.contains(&"PUT".to_string()));
        assert!(methods.contains(&"GET".to_string()));
        assert!(methods.contains(&"DELETE".to_string()));
    }
}
