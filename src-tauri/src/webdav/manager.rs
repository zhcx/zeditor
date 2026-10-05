use std::path::PathBuf;
use std::sync::Arc;

use super::model::{
    BackupIndex, BackupIndexEntry, DocumentManifest, PendingBackupTask, RemoteDocumentPath,
    S3Settings, WebDavBackupRequest, WebDavDocumentRef, WebDavQueuedResult, WebDavRetryResult,
    WebDavSettings, WebDavSyncEvent, WebDavVersion,
};
use super::queue::PendingTaskStore;
use super::{
    deterministic_version_id, history_index_path, map_remote_document, normalize_remote_root,
    parse_index, parse_manifest, sha256_hex, validate_index_namespace, validate_manifest_namespace,
    RemoteClient, RemoteSyncClient,
};

/// Which remote backup backend a manager instance drives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncProvider {
    WebDav,
    S3,
}

impl SyncProvider {
    fn label(self) -> &'static str {
        match self {
            Self::WebDav => "webdav",
            Self::S3 => "s3",
        }
    }
}

/// Serialized background worker for remote document backups.
///
/// Owns the durable pending-task store and a global worker mutex so manifest,
/// index, and current-copy updates never race across documents. The concrete
/// client (WebDAV or S3) is built from settings at enqueue time, so one worker
/// shape serves both providers.
#[derive(Clone)]
pub struct WebDavSyncManager {
    inner: Arc<WebDavSyncInner>,
}

/// S3-backed twin of [`WebDavSyncManager`] with its own queue and worker.
#[derive(Clone)]
pub struct S3SyncManager {
    inner: Arc<WebDavSyncInner>,
}

struct WebDavSyncInner {
    provider: SyncProvider,
    queue: PendingTaskStore,
    worker: tokio::sync::Mutex<()>,
    events: Arc<dyn WebDavEventSink>,
}

pub trait WebDavEventSink: Send + Sync {
    fn emit(&self, event: &WebDavSyncEvent) -> Result<(), String>;
}

impl WebDavSyncManager {
    pub fn new(queue_path: PathBuf, events: Arc<dyn WebDavEventSink>) -> Self {
        Self {
            inner: Arc::new(WebDavSyncInner {
                provider: SyncProvider::WebDav,
                queue: PendingTaskStore::new(queue_path),
                worker: tokio::sync::Mutex::new(()),
                events,
            }),
        }
    }

    /// Build the WebDAV client for this provider from saved settings.
    pub fn client_for(&self, settings: &WebDavSettings) -> Result<RemoteClient, String> {
        Ok(RemoteClient::WebDav(super::WebDavClient::new(settings)?))
    }

    /// Persist a task for a saved document and spawn its background sync.
    pub async fn enqueue(
        &self,
        request: WebDavBackupRequest,
        settings: WebDavSettings,
    ) -> Result<WebDavQueuedResult, String> {
        let client = self.client_for(&settings)?;
        enqueue_impl(&self.inner, request, settings.remote_root, client).await
    }

    /// Re-queue every persisted pending task for a fresh synchronization pass.
    pub async fn retry_pending(
        &self,
        settings: WebDavSettings,
    ) -> Result<WebDavRetryResult, String> {
        let client = self.client_for(&settings)?;
        retry_impl(&self.inner, settings.remote_root, client).await
    }

    /// Run one document's sync transaction under the global worker lock.
    pub async fn process(
        &self,
        task: PendingBackupTask,
        settings: WebDavSettings,
    ) -> Result<(), String> {
        let client = self.client_for(&settings)?;
        process_impl(&self.inner, task, settings.remote_root, client).await
    }
}

impl S3SyncManager {
    pub fn new(queue_path: PathBuf, events: Arc<dyn WebDavEventSink>) -> Self {
        Self {
            inner: Arc::new(WebDavSyncInner {
                provider: SyncProvider::S3,
                queue: PendingTaskStore::new(queue_path),
                worker: tokio::sync::Mutex::new(()),
                events,
            }),
        }
    }

    /// Build an S3 client for paths that the sync manager has already mapped.
    pub fn client_for(&self, settings: &S3Settings) -> Result<RemoteClient, String> {
        Ok(RemoteClient::S3(super::S3Client::new_for_mapped_paths(
            settings,
        )?))
    }

    pub async fn enqueue(
        &self,
        request: WebDavBackupRequest,
        settings: S3Settings,
    ) -> Result<WebDavQueuedResult, String> {
        let client = self.client_for(&settings)?;
        enqueue_impl(&self.inner, request, settings.remote_root, client).await
    }

    pub async fn retry_pending(&self, settings: S3Settings) -> Result<WebDavRetryResult, String> {
        let client = self.client_for(&settings)?;
        retry_impl(&self.inner, settings.remote_root, client).await
    }

    pub async fn process(
        &self,
        task: PendingBackupTask,
        settings: S3Settings,
    ) -> Result<(), String> {
        let client = self.client_for(&settings)?;
        process_impl(&self.inner, task, settings.remote_root, client).await
    }
}

async fn enqueue_impl(
    inner: &Arc<WebDavSyncInner>,
    request: WebDavBackupRequest,
    remote_root: String,
    client: RemoteClient,
) -> Result<WebDavQueuedResult, String> {
    let mapped = map_remote_document(&request.local_path, &request.workspace_roots, &remote_root)?;
    let bytes = std::fs::read(&request.local_path).map_err(|error| {
        format!(
            "Failed to read local file '{}': {error}",
            request.local_path
        )
    })?;
    let sha256 = sha256_hex(&bytes);
    let queued_at = now_rfc3339();
    let version_id = deterministic_version_id(&queued_at, &sha256);

    let task = PendingBackupTask {
        document_id: mapped.document_id.clone(),
        display_name: mapped.display_name.clone(),
        local_path: request.local_path.clone(),
        workspace_roots: request.workspace_roots.clone(),
        current_path: mapped.current_path.clone(),
        manifest_path: mapped.manifest_path.clone(),
        versions_dir: mapped.versions_dir.clone(),
        queued_at: queued_at.clone(),
        sha256: sha256.clone(),
        version_id,
    };

    // Persist before spawning any network work.
    inner.queue.upsert(task.clone())?;

    emit(
        inner,
        WebDavSyncEvent {
            provider: inner.provider.label().to_string(),
            document_id: task.document_id.clone(),
            local_path: task.local_path.clone(),
            phase: "queued".to_string(),
            progress: None,
            timestamp: queued_at.clone(),
            error: None,
        },
    );

    let worker = inner.clone();
    tauri::async_runtime::spawn(async move {
        let _ = process_impl(&worker, task, remote_root, client).await;
    });

    Ok(WebDavQueuedResult {
        document: WebDavDocumentRef {
            document_id: mapped.document_id,
            display_name: mapped.display_name,
            local_path: request.local_path,
            current_path: mapped.current_path,
        },
        queued_at,
    })
}

async fn retry_impl(
    inner: &Arc<WebDavSyncInner>,
    remote_root: String,
    client: RemoteClient,
) -> Result<WebDavRetryResult, String> {
    let tasks = inner.queue.load()?;
    let count = tasks.len();
    for task in tasks {
        let worker = inner.clone();
        let client = client.clone();
        let remote_root = remote_root.clone();
        tauri::async_runtime::spawn(async move {
            let _ = process_impl(&worker, task, remote_root, client).await;
        });
    }
    Ok(WebDavRetryResult { retried: count })
}

/// Run one document's sync transaction under the global worker lock.
///
/// Order: snapshot, manifest, index, current copy, then cleanup. The task is
/// removed from the queue only after every upload succeeds; a partial failure
/// leaves the task queued for an idempotent retry.
async fn process_impl(
    inner: &Arc<WebDavSyncInner>,
    mut task: PendingBackupTask,
    remote_root: String,
    client: RemoteClient,
) -> Result<(), String> {
    let _guard = inner.worker.lock().await;

    emit(
        inner,
        WebDavSyncEvent {
            provider: inner.provider.label().to_string(),
            document_id: task.document_id.clone(),
            local_path: task.local_path.clone(),
            phase: "syncing".to_string(),
            progress: None,
            timestamp: now_rfc3339(),
            error: None,
        },
    );

    let result = sync_task(&client, &mut task, &remote_root).await;
    match result {
        Ok(()) => {
            if let Err(error) = inner.queue.remove(&task.document_id) {
                emit(
                    inner,
                    WebDavSyncEvent {
                        provider: inner.provider.label().to_string(),
                        document_id: task.document_id.clone(),
                        local_path: task.local_path.clone(),
                        phase: "error".to_string(),
                        progress: None,
                        timestamp: now_rfc3339(),
                        error: Some(error.clone()),
                    },
                );
                return Err(error);
            }
            emit(
                inner,
                WebDavSyncEvent {
                    provider: inner.provider.label().to_string(),
                    document_id: task.document_id.clone(),
                    local_path: task.local_path.clone(),
                    phase: "success".to_string(),
                    progress: None,
                    timestamp: now_rfc3339(),
                    error: None,
                },
            );
            Ok(())
        }
        Err(error) => {
            emit(
                inner,
                WebDavSyncEvent {
                    provider: inner.provider.label().to_string(),
                    document_id: task.document_id.clone(),
                    local_path: task.local_path.clone(),
                    phase: "error".to_string(),
                    progress: None,
                    timestamp: now_rfc3339(),
                    error: Some(sanitize_error(&error)),
                },
            );
            Err(error)
        }
    }
}

async fn sync_task(
    client: &RemoteClient,
    task: &mut PendingBackupTask,
    remote_root: &str,
) -> Result<(), String> {
    // 1. Read the latest local bytes.
    let bytes = std::fs::read(&task.local_path)
        .map_err(|error| format!("Failed to read local file '{}': {error}", task.local_path))?;

    // Refresh stale hash/version metadata before any network call.
    let queued_at = task.queued_at.clone();
    task.refresh_for_bytes(&bytes, &queued_at);

    let remote_root = normalize_remote_root(remote_root)?;

    let expected = RemoteDocumentPath {
        document_id: task.document_id.clone(),
        display_name: task.display_name.clone(),
        current_path: task.current_path.clone(),
        manifest_path: task.manifest_path.clone(),
        versions_dir: task.versions_dir.clone(),
    };

    // 2. Read and validate the remote manifest, never trusting its paths.
    let manifest_bytes = client.get_optional(&task.manifest_path).await?;
    let mut manifest = match &manifest_bytes {
        Some(bytes) => {
            let parsed = parse_manifest(bytes)?;
            validate_manifest_namespace(&parsed, &expected, &remote_root)?;
            parsed
        }
        None => DocumentManifest::new(&task.document_id, &task.display_name, &task.current_path),
    };

    let mut pruned = Vec::new();
    // 3. Skip snapshot creation when the newest version already matches.
    if manifest.newest_hash() != Some(task.sha256.as_str()) {
        // 4-5. Create collections and upload the deterministic snapshot.
        client.ensure_collection(&task.versions_dir).await?;
        let snapshot_path = format!("{}/{}.md", task.versions_dir, task.version_id);
        client.put(&snapshot_path, &bytes).await?;

        // 6. Insert the new version, build the manifest, and upload it.
        pruned = manifest.insert_version(WebDavVersion {
            id: task.version_id.clone(),
            created_at: task.queued_at.clone(),
            size: bytes.len() as u64,
            sha256: task.sha256.clone(),
            snapshot_path: snapshot_path.clone(),
        });
        let manifest_json = serde_json::to_vec_pretty(&manifest)
            .map_err(|error| format!("Failed to serialize WebDAV manifest: {error}"))?;
        client.put(&task.manifest_path, &manifest_json).await?;
    }

    // 7. Read and validate the global index, then upsert this document.
    let index_path = history_index_path(&remote_root);
    let index_bytes = client.get_optional(&index_path).await?;
    let mut index = match &index_bytes {
        Some(bytes) => {
            let parsed = parse_index(bytes)?;
            validate_index_namespace(&parsed, &remote_root)?;
            parsed
        }
        None => BackupIndex::default(),
    };
    index.upsert(BackupIndexEntry {
        document_id: task.document_id.clone(),
        display_name: task.display_name.clone(),
        current_path: task.current_path.clone(),
        manifest_path: task.manifest_path.clone(),
        latest_at: task.queued_at.clone(),
    });
    let index_json = serde_json::to_vec_pretty(&index)
        .map_err(|error| format!("Failed to serialize WebDAV index: {error}"))?;
    client.put(&index_path, &index_json).await?;

    // 8. Upload the current remote copy after its parent collections exist.
    let current_parent = parent_path(&task.current_path);
    client.ensure_collection(&current_parent).await?;
    client.put(&task.current_path, &bytes).await?;

    // 9. Clean up snapshot files pruned from the visible manifest.
    for version in &pruned {
        let _ = client.delete_optional(&version.snapshot_path).await;
    }

    Ok(())
}

fn emit(inner: &Arc<WebDavSyncInner>, event: WebDavSyncEvent) {
    let _ = inner.events.emit(&event);
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn parent_path(path: &str) -> String {
    path.rsplit_once('/')
        .map(|(parent, _)| parent.to_string())
        .unwrap_or_else(|| "/".to_string())
}

/// Cap event errors at 240 characters after stripping control characters.
fn sanitize_error(message: &str) -> String {
    let cleaned: String = message
        .chars()
        .filter(|character| !character.is_control())
        .take(240)
        .collect();
    cleaned
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::webdav::client::test_support::{settings_for, TestDavServer};
    use crate::webdav::path::deterministic_version_id;
    use crate::webdav::test_support::test_temp_dir;
    use std::path::Path;
    use std::sync::Mutex;

    fn task_for(path: &Path, bytes: &[u8]) -> PendingBackupTask {
        std::fs::write(path, bytes).expect("write local fixture");
        let sha256 = sha256_hex(bytes);
        let version_id = deterministic_version_id("2026-08-19T14:32:00Z", &sha256);
        let document_id = "a".repeat(24);
        PendingBackupTask {
            document_id: document_id.clone(),
            display_name: "note.md".into(),
            local_path: path.to_string_lossy().into_owned(),
            workspace_roots: vec![path.parent().unwrap().to_string_lossy().into_owned()],
            current_path: "/Zeditor/notes/note.md".into(),
            manifest_path: format!(
                "/Zeditor/.zeditor-history/documents/{document_id}/manifest.json"
            ),
            versions_dir: format!("/Zeditor/.zeditor-history/documents/{document_id}/versions"),
            queued_at: "2026-08-19T14:32:00Z".into(),
            sha256,
            version_id,
        }
    }

    #[derive(Default)]
    struct RecordingEventSink {
        events: Mutex<Vec<WebDavSyncEvent>>,
    }

    impl WebDavEventSink for RecordingEventSink {
        fn emit(&self, event: &WebDavSyncEvent) -> Result<(), String> {
            self.events.lock().expect("event lock").push(event.clone());
            Ok(())
        }
    }

    fn manager_for(queue_path: PathBuf) -> WebDavSyncManager {
        WebDavSyncManager::new(queue_path, Arc::new(RecordingEventSink::default()))
    }

    #[tokio::test]
    async fn uploads_snapshot_manifest_index_then_current() {
        let fixture = TestDavServer::success().await;
        let root = test_temp_dir();
        let manager = manager_for(root.join("pending.json"));
        let task = task_for(&root.join("note.md"), b"version one");
        manager
            .process(task, settings_for(&fixture.url))
            .await
            .expect("sync");

        let document_id = "a".repeat(24);
        let version_id =
            deterministic_version_id("2026-08-19T14:32:00Z", &sha256_hex(b"version one"));
        assert_eq!(
            fixture.put_paths().await,
            vec![
                format!(
                    "/Zeditor/.zeditor-history/documents/{document_id}/versions/{version_id}.md"
                ),
                format!("/Zeditor/.zeditor-history/documents/{document_id}/manifest.json"),
                "/Zeditor/.zeditor-history/index.json".to_string(),
                "/Zeditor/notes/note.md".to_string(),
            ]
        );
    }

    #[tokio::test]
    async fn retry_after_current_copy_failure_does_not_duplicate_history() {
        let fixture = TestDavServer::fail_once_on_current().await;
        let root = test_temp_dir();
        let manager = manager_for(root.join("pending.json"));
        let task = task_for(&root.join("note.md"), b"version one");
        assert!(manager
            .process(task.clone(), settings_for(&fixture.url))
            .await
            .is_err());
        manager
            .process(task, settings_for(&fixture.url))
            .await
            .expect("retry");
        assert_eq!(fixture.visible_manifest_versions().await, 1);
    }

    #[tokio::test]
    async fn emits_queued_syncing_then_success_events() {
        let fixture = TestDavServer::success().await;
        let root = test_temp_dir();
        let sink = Arc::new(RecordingEventSink::default());
        let manager = WebDavSyncManager::new(root.join("pending.json"), sink.clone());
        let task = task_for(&root.join("note.md"), b"version one");

        manager
            .process(task, settings_for(&fixture.url))
            .await
            .expect("sync");

        let phases: Vec<String> = sink
            .events
            .lock()
            .expect("event lock")
            .iter()
            .map(|event| event.phase.clone())
            .collect();
        assert_eq!(phases, vec!["syncing", "success"]);
    }

    #[tokio::test]
    async fn s3_manager_runs_same_transaction_against_s3_client() {
        let fixture = TestDavServer::success().await;
        let root = test_temp_dir();
        let manager = S3SyncManager::new(
            root.join("pending.json"),
            Arc::new(RecordingEventSink::default()),
        );
        let task = task_for(&root.join("note.md"), b"version one");
        let settings = crate::webdav::model::S3Settings {
            enabled: true,
            endpoint: fixture.url.clone(),
            bucket: "zeditor-backup".into(),
            region: "us-east-1".into(),
            access_key: "AKIDEXAMPLE".into(),
            secret_key: "secret".into(),
            path_style: true,
            remote_root: "/Zeditor".into(),
        };

        manager.process(task, settings).await.expect("s3 sync");

        // The S3 client PUTs every path under the bucket prefix.
        let paths = fixture.put_paths().await;
        assert!(paths
            .iter()
            .any(|path| path.contains("/Zeditor/.zeditor-history/index.json")));
        assert!(paths
            .iter()
            .any(|path| path.ends_with("/Zeditor/notes/note.md")));
    }
}
