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
        encoding: request.encoding,
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
    // sync_task refreshes byte/attachment fingerprints. Completion must still
    // compare the persisted enqueue identity, not those refreshed fields.
    let queued_task = task.clone();

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
            if let Err(error) = inner.queue.complete(&queued_task) {
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
    // Fail explicitly before network publication when any referenced attachment
    // is missing or unsafe. The pending task remains durable for a later retry.
    let local_assets =
        super::assets::collect_assets(&task.local_path, &bytes, task.encoding.as_deref())?;
    let bundle_hash = super::assets::bundle_hash(&task.sha256, &local_assets);
    task.version_id = deterministic_version_id(&queued_at, &bundle_hash);
    let assets =
        super::assets::describe_assets(&local_assets, &task.versions_dir, &task.version_id);

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
    // Validate even a new document, since queued metadata is persisted input.
    validate_manifest_namespace(&manifest, &expected, &remote_root)?;

    let mut pruned = Vec::new();
    // 3. Skip snapshot creation when the newest version already matches.
    let same_bundle = manifest.versions.first().is_some_and(|latest| {
        latest.sha256 == task.sha256
            && latest.assets.as_ref().is_some_and(|previous| {
                previous.len() == assets.len()
                    && previous.iter().zip(&assets).all(|(a, b)| {
                        a.relative_path == b.relative_path
                            && a.sha256 == b.sha256
                            && a.size == b.size
                    })
            })
    });
    if !same_bundle {
        // 4-5. Create collections and upload the deterministic snapshot.
        client.ensure_collection(&task.versions_dir).await?;
        let snapshot_path = format!("{}/{}.md", task.versions_dir, task.version_id);
        // Upload every attachment before publishing the version manifest.
        for (asset, local) in assets.iter().zip(&local_assets) {
            client
                .ensure_collection(&parent_path(&asset.snapshot_path))
                .await?;
            client.put(&asset.snapshot_path, &local.bytes).await?;
        }
        client.put(&snapshot_path, &bytes).await?;

        // 6. Insert the new version, build the manifest, and upload it.
        pruned = manifest.insert_version(WebDavVersion {
            id: task.version_id.clone(),
            assets: Some(assets),
            encoding: task.encoding.clone(),
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
    let retained_assets: std::collections::HashSet<_> = manifest
        .versions
        .iter()
        .flat_map(|version| version.assets.as_deref().unwrap_or_default())
        .map(|asset| asset.snapshot_path.as_str())
        .collect();
    for version in &pruned {
        let _ = client.delete_optional(&version.snapshot_path).await;
        for asset in version.assets.as_deref().unwrap_or_default() {
            if !retained_assets.contains(asset.snapshot_path.as_str()) {
                let _ = client.delete_optional(&asset.snapshot_path).await;
            }
        }
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
            encoding: None,
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
        let version_id = deterministic_version_id(
            "2026-08-19T14:32:00Z",
            &super::super::assets::bundle_hash(&sha256_hex(b"version one"), &[]),
        );
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
    async fn older_success_never_removes_a_newer_durable_pending_task() {
        struct EnqueueDuringSync {
            queue: PendingTaskStore,
            newer: PendingBackupTask,
        }
        impl WebDavEventSink for EnqueueDuringSync {
            fn emit(&self, event: &WebDavSyncEvent) -> Result<(), String> {
                if event.phase == "syncing" {
                    self.queue.upsert(self.newer.clone())?;
                }
                Ok(())
            }
        }
        let fixture = TestDavServer::success().await;
        let root = test_temp_dir();
        let task = task_for(&root.join("note.md"), b"version one");
        let queue_path = root.join("pending.json");
        let mut newer = task.clone();
        newer.queued_at = "2026-08-19T14:33:00Z".into();
        newer.version_id = deterministic_version_id(&newer.queued_at, &newer.sha256);
        let manager = WebDavSyncManager::new(
            queue_path.clone(),
            Arc::new(EnqueueDuringSync {
                queue: PendingTaskStore::new(queue_path),
                newer: newer.clone(),
            }),
        );
        manager.inner.queue.upsert(task.clone()).unwrap();
        manager
            .process(task, settings_for(&fixture.url))
            .await
            .unwrap();
        // This is the restart boundary: the newer worker has not run yet.
        assert_eq!(manager.inner.queue.load().unwrap(), vec![newer]);
    }

    #[tokio::test]
    async fn refreshed_success_completes_the_original_durable_task() {
        let fixture = TestDavServer::success().await;
        let root = test_temp_dir();
        let manager = manager_for(root.join("pending.json"));
        let task = task_for(&root.join("note.md"), b"queued bytes");
        manager.inner.queue.upsert(task.clone()).unwrap();
        std::fs::write(&task.local_path, b"latest bytes before retry").unwrap();
        manager
            .process(task, settings_for(&fixture.url))
            .await
            .unwrap();
        assert!(manager.inner.queue.load().unwrap().is_empty());
        assert_eq!(
            fixture.resource("/Zeditor/notes/note.md").await.unwrap(),
            b"latest bytes before retry"
        );
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

    #[tokio::test]
    async fn document_with_attachments_restores_exact_versions_on_webdav_and_s3() {
        for use_s3 in [false, true] {
            let server = TestDavServer::success().await;
            let root = test_temp_dir();
            let destination = test_temp_dir();
            let note = root.join("note.md");
            let bytes = "![中文图](.assets/%E4%B8%AD%E6%96%87%20%E5%9B%BE.png)\n@[video](.assets/movie.mp4)\n".as_bytes();
            fs_assets(&root, b"image version one");
            let mut task = task_for(&note, bytes);
            let client = if use_s3 {
                RemoteClient::S3(
                    super::super::S3Client::new_for_mapped_paths(&super::super::S3Settings {
                        enabled: true,
                        endpoint: server.url.clone(),
                        bucket: "backup".into(),
                        region: "test".into(),
                        access_key: "key".into(),
                        secret_key: "secret".into(),
                        path_style: true,
                        remote_root: "/Zeditor".into(),
                    })
                    .unwrap(),
                )
            } else {
                RemoteClient::WebDav(
                    super::super::WebDavClient::new(&settings_for(&server.url)).unwrap(),
                )
            };
            sync_task(&client, &mut task, "/Zeditor").await.unwrap();
            let first_id = task.version_id.clone();
            let first = super::super::restore_version(
                &client,
                "/Zeditor",
                &task.document_id,
                &first_id,
                destination.to_str().unwrap(),
            )
            .await
            .unwrap();
            let restored = Path::new(&first.path);
            assert_eq!(std::fs::read(restored).unwrap(), bytes);
            assert_eq!(
                std::fs::read(restored.parent().unwrap().join(".assets/中文 图.png")).unwrap(),
                b"image version one"
            );
            assert_eq!(first.asset_count, 2);
            assert!(!first.legacy_document_only);
            // Only the attachment changes. It must produce a new history version.
            fs_assets(&root, b"image version two");
            task.queued_at = "2026-08-19T14:33:00Z".into();
            sync_task(&client, &mut task, "/Zeditor").await.unwrap();
            assert_ne!(task.version_id, first_id);
            let first_again = super::super::restore_version(
                &client,
                "/Zeditor",
                &task.document_id,
                &first_id,
                destination.to_str().unwrap(),
            )
            .await
            .unwrap();
            let latest = super::super::restore_version(
                &client,
                "/Zeditor",
                &task.document_id,
                &task.version_id,
                destination.to_str().unwrap(),
            )
            .await
            .unwrap();
            for (result, image) in [
                (&first_again, b"image version one"),
                (&latest, b"image version two"),
            ] {
                assert_eq!(
                    std::fs::read(
                        Path::new(&result.path)
                            .parent()
                            .unwrap()
                            .join(".assets/中文 图.png")
                    )
                    .unwrap(),
                    image
                );
            }
            assert_ne!(first.path, first_again.path); // repeat restore never overwrites
            std::fs::remove_dir_all(root).unwrap();
            std::fs::remove_dir_all(destination).unwrap();
        }
    }

    fn fs_assets(root: &Path, image: &[u8]) {
        std::fs::create_dir_all(root.join(".assets")).unwrap();
        std::fs::write(root.join(".assets/中文 图.png"), image).unwrap();
        std::fs::write(root.join(".assets/movie.mp4"), b"movie bytes").unwrap();
    }

    #[tokio::test]
    async fn legacy_duplicate_cleanup_preserves_assets_used_by_retained_version() {
        let server = TestDavServer::success().await;
        let root = test_temp_dir();
        let destination = test_temp_dir();
        fs_assets(&root, b"retained picture");
        let bytes = "![图](<.assets/中文 图.png>)".as_bytes();
        let mut task = task_for(&root.join("note.md"), bytes);
        let client = RemoteClient::WebDav(
            super::super::WebDavClient::new(&settings_for(&server.url)).unwrap(),
        );
        sync_task(&client, &mut task, "/Zeditor").await.unwrap();
        let mut manifest = parse_manifest(
            &client
                .get_optional(&task.manifest_path)
                .await
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        let original = manifest.versions[0].clone();
        let mut duplicate = original.clone();
        // Legacy rows may share their version ID and attachment namespace but
        // name different document snapshots; the existing validator accepts it.
        duplicate.snapshot_path = format!("{}/{}.markdown", task.versions_dir, duplicate.id);
        client.put(&duplicate.snapshot_path, bytes).await.unwrap();
        manifest.versions.push(duplicate.clone());
        client
            .put(&task.manifest_path, &serde_json::to_vec(&manifest).unwrap())
            .await
            .unwrap();

        std::fs::write(
            &task.local_path,
            format!("# Updated\n{}", std::str::from_utf8(bytes).unwrap()),
        )
        .unwrap();
        task.queued_at = "2026-08-19T14:33:00Z".into();
        sync_task(&client, &mut task, "/Zeditor").await.unwrap();
        assert!(client
            .get_optional(&duplicate.snapshot_path)
            .await
            .unwrap()
            .is_none());
        let restored = super::super::restore_version(
            &client,
            "/Zeditor",
            &task.document_id,
            &original.id,
            destination.to_str().unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(restored.path).unwrap(), bytes);
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(destination).unwrap();
    }

    #[tokio::test]
    async fn undecodable_complete_bundle_cannot_restore_with_unchecked_references() {
        let server = TestDavServer::success().await;
        let destination = test_temp_dir();
        let client = RemoteClient::WebDav(
            super::super::WebDavClient::new(&settings_for(&server.url)).unwrap(),
        );
        let bytes = crate::text_encoding::encode_text("![图](.assets/a.png)", "utf-16le").unwrap();
        let version = WebDavVersion {
            id: "a".repeat(24),
            created_at: "2026-08-19T14:33:00Z".into(),
            size: bytes.len() as u64,
            sha256: sha256_hex(&bytes),
            snapshot_path: "/snapshot.md".into(),
            assets: Some(Vec::new()),
            encoding: None,
        };
        client.put(&version.snapshot_path, &bytes).await.unwrap();
        let error = super::super::assets::restore(
            &client,
            "note.md",
            &version,
            destination.to_str().unwrap(),
        )
        .await
        .unwrap_err();
        assert!(error.contains("附件引用"));
        assert_eq!(std::fs::read_dir(&destination).unwrap().count(), 0);
        std::fs::remove_dir_all(destination).unwrap();
    }

    #[tokio::test]
    async fn missing_local_attachment_keeps_task_pending_and_never_publishes_success() {
        let server = TestDavServer::success().await;
        let root = test_temp_dir();
        let sink = Arc::new(RecordingEventSink::default());
        let manager = WebDavSyncManager::new(root.join("pending.json"), sink.clone());
        let task = task_for(&root.join("note.md"), b"![x](.assets/missing.png)");
        manager.inner.queue.upsert(task.clone()).unwrap();
        assert!(manager
            .process(task, settings_for(&server.url))
            .await
            .is_err());
        assert_eq!(manager.inner.queue.load().unwrap().len(), 1);
        assert!(server.put_paths().await.is_empty());
        assert_eq!(sink.events.lock().unwrap().last().unwrap().phase, "error");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn tampered_or_missing_remote_asset_never_creates_recovery_files() {
        let server = TestDavServer::success().await;
        let root = test_temp_dir();
        let destination = test_temp_dir();
        fs_assets(&root, b"image version one");
        let mut task = task_for(&root.join("note.md"), b"![x](.assets/movie.mp4)");
        let client = RemoteClient::WebDav(
            super::super::WebDavClient::new(&settings_for(&server.url)).unwrap(),
        );
        sync_task(&client, &mut task, "/Zeditor").await.unwrap();
        // A syntactically valid but incomplete attachment manifest must not
        // produce a successful restore with silently broken local images.
        let original_manifest = client
            .get_optional(&task.manifest_path)
            .await
            .unwrap()
            .unwrap();
        let mut missing_entry = parse_manifest(&original_manifest).unwrap();
        missing_entry.versions[0].assets = Some(Vec::new());
        client
            .put(
                &task.manifest_path,
                &serde_json::to_vec(&missing_entry).unwrap(),
            )
            .await
            .unwrap();
        assert!(super::super::restore_version(
            &client,
            "/Zeditor",
            &task.document_id,
            &task.version_id,
            destination.to_str().unwrap()
        )
        .await
        .unwrap_err()
        .contains("清单与文档引用不一致"));
        client
            .put(&task.manifest_path, &original_manifest)
            .await
            .unwrap();
        let asset_path = format!(
            "{}/{}/assets/{}",
            task.versions_dir,
            task.version_id,
            sha256_hex(b"movie bytes")
        );
        client.put(&asset_path, b"tampered").await.unwrap();
        assert!(super::super::restore_version(
            &client,
            "/Zeditor",
            &task.document_id,
            &task.version_id,
            destination.to_str().unwrap()
        )
        .await
        .unwrap_err()
        .contains("校验失败"));
        client.delete_optional(&asset_path).await.unwrap();
        assert!(super::super::restore_version(
            &client,
            "/Zeditor",
            &task.document_id,
            &task.version_id,
            destination.to_str().unwrap()
        )
        .await
        .unwrap_err()
        .contains("附件缺失"));
        assert_eq!(std::fs::read_dir(&destination).unwrap().count(), 0);
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(destination).unwrap();
    }

    #[tokio::test]
    async fn restoration_retains_legacy_encoding_hint_and_original_bytes() {
        let server = TestDavServer::success().await;
        let root = test_temp_dir();
        let destination = test_temp_dir();
        fs_assets(&root, b"picture");
        let bytes =
            crate::text_encoding::encode_text("# 中文编码\n![图](<.assets/中文 图.png>)", "gbk")
                .unwrap();
        let mut task = task_for(&root.join("note.md"), &bytes);
        task.encoding = Some("gbk".into());
        let client = RemoteClient::WebDav(
            super::super::WebDavClient::new(&settings_for(&server.url)).unwrap(),
        );
        sync_task(&client, &mut task, "/Zeditor").await.unwrap();
        let restored = super::super::restore_version(
            &client,
            "/Zeditor",
            &task.document_id,
            &task.version_id,
            destination.to_str().unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(restored.encoding.as_deref(), Some("gbk"));
        assert_eq!(std::fs::read(&restored.path).unwrap(), bytes);
        assert_eq!(
            std::fs::read(
                Path::new(&restored.path)
                    .parent()
                    .unwrap()
                    .join(".assets/中文 图.png")
            )
            .unwrap(),
            b"picture"
        );
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(destination).unwrap();
    }
}
