//! Opt-in end-to-end tests against real WebDAV and S3-compatible servers.
//!
//! These tests are ignored by default because they need external services.
//! When no endpoint is configured they print a SKIP line and return, so an
//! explicit `cargo test -- --ignored` on a developer machine stays harmless.
//!
//! ```text
//! ZEDITOR_LIVE_WEBDAV_URL=https://dav.example.com/remote.php/dav/files/alice \
//! ZEDITOR_LIVE_WEBDAV_USERNAME=alice \
//! ZEDITOR_LIVE_WEBDAV_PASSWORD=... \
//! cargo test live_webdav -- --ignored --nocapture
//!
//! ZEDITOR_LIVE_S3_ENDPOINT=http://127.0.0.1:9000 \
//! ZEDITOR_LIVE_S3_BUCKET=zeditor-test \
//! ZEDITOR_LIVE_S3_ACCESS_KEY=<access-key> \
//! ZEDITOR_LIVE_S3_SECRET_KEY=<secret-key> \
//! cargo test live_s3 -- --ignored --nocapture
//! ```
//!
//! Every run writes under a fresh unique root (`ZEDITOR_LIVE_*_ROOT`, default
//! `/zeditor-live-tests`), so repeated or parallel runs never share history.
//! Files are removed best effort at the end. The account must allow create,
//! overwrite, delete, and conditional PUT (strong ETag plus `If-Match`); the
//! deterministic probe test fails with an explicit message when it does not.

use std::path::Path;
use std::sync::Arc;

use super::assets;
use super::model::{PendingBackupTask, RemoteDocumentPath};
use super::{
    deterministic_version_id, history_index_path, map_remote_document, parse_index, parse_manifest,
    sha256_hex, validate_index_namespace, validate_manifest_namespace, PutOutcome, RemoteClient,
    RemoteSyncClient, RestoredBackup, S3Client, S3Settings, S3SyncManager, WebDavClient,
    WebDavEventSink, WebDavSettings, WebDavSyncEvent, WebDavSyncManager, WritePrecondition,
};

/// Two devices sync three edits each; both writers must survive merging.
const ROUNDS: usize = 3;

struct SilentSink;

impl WebDavEventSink for SilentSink {
    fn emit(&self, _event: &WebDavSyncEvent) -> Result<(), String> {
        Ok(())
    }
}

/// Simulated devices share one logical document identity while keeping
/// independent local files, queues, and clients.
enum LiveDevice {
    WebDav(WebDavSyncManager, WebDavSettings),
    S3(S3SyncManager, S3Settings),
}

impl LiveDevice {
    async fn process(&self, task: PendingBackupTask) -> Result<(), String> {
        match self {
            Self::WebDav(manager, settings) => manager.process(task, settings.clone()).await,
            Self::S3(manager, settings) => manager.process(task, settings.clone()).await,
        }
    }

    async fn restore(
        &self,
        document_id: &str,
        version_id: &str,
        destination: &Path,
    ) -> Result<RestoredBackup, String> {
        let destination = destination.to_string_lossy().into_owned();
        match self {
            Self::WebDav(_, settings) => {
                super::webdav_restore_version(
                    document_id.to_string(),
                    version_id.to_string(),
                    destination,
                    settings.clone(),
                )
                .await
            }
            Self::S3(_, settings) => {
                super::s3_restore_version(
                    document_id.to_string(),
                    version_id.to_string(),
                    destination,
                    settings.clone(),
                )
                .await
            }
        }
    }
}

fn env_nonempty(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn live_root(base: Option<String>) -> String {
    let base = base.unwrap_or_else(|| "/zeditor-live-tests".to_string());
    let base = base.trim().trim_matches('/');
    let suffix = format!("zeditor-live-{}", uuid::Uuid::new_v4());
    if base.is_empty() {
        format!("/{suffix}")
    } else {
        format!("/{base}/{suffix}")
    }
}

fn live_webdav_settings() -> Option<WebDavSettings> {
    let Some(server_url) = env_nonempty("ZEDITOR_LIVE_WEBDAV_URL") else {
        eprintln!("SKIP live WebDAV tests: ZEDITOR_LIVE_WEBDAV_URL is not set");
        return None;
    };
    Some(WebDavSettings {
        enabled: true,
        server_url,
        username: env_nonempty("ZEDITOR_LIVE_WEBDAV_USERNAME").unwrap_or_default(),
        // Passwords may intentionally contain surrounding whitespace.
        password: std::env::var("ZEDITOR_LIVE_WEBDAV_PASSWORD").unwrap_or_default(),
        remote_root: live_root(env_nonempty("ZEDITOR_LIVE_WEBDAV_ROOT")),
    })
}

fn live_s3_settings() -> Option<S3Settings> {
    let Some(endpoint) = env_nonempty("ZEDITOR_LIVE_S3_ENDPOINT") else {
        eprintln!("SKIP live S3 tests: ZEDITOR_LIVE_S3_ENDPOINT is not set");
        return None;
    };
    let required = |name: &str| {
        env_nonempty(name)
            .unwrap_or_else(|| panic!("{name} must be set when ZEDITOR_LIVE_S3_ENDPOINT is set"))
    };
    let path_style = env_nonempty("ZEDITOR_LIVE_S3_PATH_STYLE")
        .map(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        // MinIO and most self-hosted gateways use path-style addressing.
        .unwrap_or(true);
    Some(S3Settings {
        enabled: true,
        endpoint,
        bucket: required("ZEDITOR_LIVE_S3_BUCKET"),
        region: env_nonempty("ZEDITOR_LIVE_S3_REGION").unwrap_or_else(|| "us-east-1".to_string()),
        access_key: required("ZEDITOR_LIVE_S3_ACCESS_KEY"),
        secret_key: required("ZEDITOR_LIVE_S3_SECRET_KEY"),
        path_style,
        remote_root: live_root(env_nonempty("ZEDITOR_LIVE_S3_ROOT")),
    })
}

/// Derive one stable remote identity that both simulated devices share.
fn live_document_paths(remote_root: &str) -> RemoteDocumentPath {
    let root = remote_root.trim_end_matches('/');
    let workspace = format!("{root}/workspace");
    let local = format!("{workspace}/note.md");
    map_remote_document(&local, &[workspace], remote_root)
        .expect("synthetic live workspace should map to a remote document")
}

fn live_timestamp(round: usize, device: usize) -> String {
    format!("2026-10-25T00:00:{:02}Z", round * 2 + device)
}

fn live_task(
    mapped: &RemoteDocumentPath,
    local: &Path,
    bytes: &[u8],
    queued_at: &str,
) -> PendingBackupTask {
    let sha256 = sha256_hex(bytes);
    let version_id = deterministic_version_id(queued_at, &assets::bundle_hash(&sha256, &[]));
    PendingBackupTask {
        encoding: None,
        document_id: mapped.document_id.clone(),
        display_name: mapped.display_name.clone(),
        local_path: local.to_string_lossy().into_owned(),
        workspace_roots: Vec::new(),
        current_path: mapped.current_path.clone(),
        manifest_path: mapped.manifest_path.clone(),
        versions_dir: mapped.versions_dir.clone(),
        queued_at: queued_at.to_string(),
        sha256,
        version_id,
    }
}

struct ExpectedVersion {
    id: String,
    bytes: Vec<u8>,
}

async fn run_rounds(
    left: &LiveDevice,
    right: &LiveDevice,
    mapped: &RemoteDocumentPath,
    temp: &Path,
) -> Result<Vec<ExpectedVersion>, String> {
    let mut expected = Vec::with_capacity(ROUNDS * 2);
    for round in 0..ROUNDS {
        let bytes_a = format!("device A round {round}\n").into_bytes();
        let bytes_b = format!("device B round {round}\n").into_bytes();
        let path_a = temp.join(format!("device-a-{round}.md"));
        let path_b = temp.join(format!("device-b-{round}.md"));
        std::fs::write(&path_a, &bytes_a)
            .map_err(|error| format!("Failed to write local fixture: {error}"))?;
        std::fs::write(&path_b, &bytes_b)
            .map_err(|error| format!("Failed to write local fixture: {error}"))?;

        let task_a = live_task(mapped, &path_a, &bytes_a, &live_timestamp(round, 0));
        let task_b = live_task(mapped, &path_b, &bytes_b, &live_timestamp(round, 1));
        expected.push(ExpectedVersion {
            id: task_a.version_id.clone(),
            bytes: bytes_a,
        });
        expected.push(ExpectedVersion {
            id: task_b.version_id.clone(),
            bytes: bytes_b,
        });

        tokio::try_join!(left.process(task_a), right.process(task_b))?;
    }
    Ok(expected)
}

/// Verify the merged manifest, the global index, the current copy, and every
/// snapshot byte-for-byte. Any lost update fails here.
async fn verify_live_history(
    client: &RemoteClient,
    remote_root: &str,
    mapped: &RemoteDocumentPath,
    expected: &[ExpectedVersion],
) -> Result<(), String> {
    let manifest_bytes = client
        .get_optional(&mapped.manifest_path)
        .await?
        .ok_or_else(|| "manifest was not uploaded".to_string())?;
    let manifest = parse_manifest(&manifest_bytes)?;
    validate_manifest_namespace(&manifest, mapped, remote_root)?;

    if manifest.versions.len() != expected.len() {
        return Err(format!(
            "expected {} merged versions, found {} — a concurrent write was lost",
            expected.len(),
            manifest.versions.len()
        ));
    }
    for wanted in expected {
        let version = manifest
            .versions
            .iter()
            .find(|version| version.id == wanted.id)
            .ok_or_else(|| format!("merged manifest lost version {}", wanted.id))?;
        let expected_hash = sha256_hex(&wanted.bytes);
        if version.sha256 != expected_hash {
            return Err(format!("version {} has the wrong hash", wanted.id));
        }
        let snapshot = client
            .get_optional(&version.snapshot_path)
            .await?
            .ok_or_else(|| format!("snapshot for version {} is missing", wanted.id))?;
        if snapshot != wanted.bytes {
            return Err(format!(
                "snapshot for version {} was overwritten",
                wanted.id
            ));
        }
        if sha256_hex(&snapshot) != version.sha256 {
            return Err(format!(
                "snapshot for version {} failed its hash check",
                wanted.id
            ));
        }
    }

    let index_bytes = client
        .get_optional(&history_index_path(remote_root))
        .await?
        .ok_or_else(|| "backup index was not uploaded".to_string())?;
    let index = parse_index(&index_bytes)?;
    validate_index_namespace(&index, remote_root)?;
    if !index
        .documents
        .iter()
        .any(|entry| entry.document_id == mapped.document_id)
    {
        return Err("backup index does not list the synced document".to_string());
    }

    let current = client
        .get_optional(&mapped.current_path)
        .await?
        .ok_or_else(|| "current document copy was not uploaded".to_string())?;
    if !expected.iter().any(|version| version.bytes == current) {
        return Err("current copy does not match any uploaded device version".to_string());
    }
    Ok(())
}

async fn run_multi_device_scenario(
    left: &LiveDevice,
    right: &LiveDevice,
    verify_client: &RemoteClient,
    remote_root: &str,
    mapped: &RemoteDocumentPath,
) -> Result<(), String> {
    let temp = super::test_support::test_temp_dir();
    let expected = run_rounds(left, right, mapped, &temp).await?;
    verify_live_history(verify_client, remote_root, mapped, &expected).await?;

    // Restore one version written by each device through the real download
    // path, which re-validates the manifest and every SHA-256.
    for wanted in expected.iter().take(2) {
        let destination = super::test_support::test_temp_dir();
        let restored = left
            .restore(&mapped.document_id, &wanted.id, &destination)
            .await?;
        let bytes = std::fs::read(&restored.path)
            .map_err(|error| format!("Failed to read restored file: {error}"))?;
        if bytes != wanted.bytes {
            return Err(format!("restored content for {} differs", wanted.id));
        }
    }
    Ok(())
}

async fn cleanup_live_history(
    client: &RemoteClient,
    remote_root: &str,
    mapped: &RemoteDocumentPath,
) {
    let mut paths = vec![
        mapped.manifest_path.clone(),
        history_index_path(remote_root),
        mapped.current_path.clone(),
    ];
    if let Ok(Some(bytes)) = client.get_optional(&mapped.manifest_path).await {
        if let Ok(manifest) = parse_manifest(&bytes) {
            for version in manifest.versions {
                paths.push(version.snapshot_path);
                for asset in version.assets.unwrap_or_default() {
                    paths.push(asset.snapshot_path);
                }
            }
        }
    }
    for path in &paths {
        if let Err(error) = client.delete_optional(path).await {
            eprintln!("cleanup: could not delete {path}: {error}");
        }
    }

    let document_dir = parent_path(&mapped.manifest_path);
    let history_dir = parent_path(&document_dir);
    let current_dir = parent_path(&mapped.current_path);
    for collection in [
        mapped.versions_dir.clone(),
        document_dir,
        history_dir,
        current_dir,
        remote_root.trim_end_matches('/').to_string(),
    ] {
        if collection.is_empty() || collection == "/" {
            continue;
        }
        // S3 has no collections; its DELETE is a harmless no-op for a prefix.
        let _ = client.delete_optional(&collection).await;
    }
}

fn parent_path(path: &str) -> String {
    path.rsplit_once('/')
        .map(|(parent, _)| parent.to_string())
        .unwrap_or_else(|| "/".to_string())
}

fn webdav_remote(settings: &WebDavSettings) -> RemoteClient {
    RemoteClient::WebDav(WebDavClient::new(settings).expect("WebDAV client"))
}

fn s3_remote(settings: &S3Settings) -> RemoteClient {
    RemoteClient::S3(S3Client::new_for_mapped_paths(settings).expect("S3 client for mapped paths"))
}

#[tokio::test]
#[ignore = "requires a real WebDAV server via ZEDITOR_LIVE_WEBDAV_URL"]
async fn live_webdav_enforces_conditional_writes() {
    let Some(settings) = live_webdav_settings() else {
        return;
    };
    let client = WebDavClient::new(&settings).expect("WebDAV client");
    let probe = format!(
        "{}/conditional-probe.md",
        settings.remote_root.trim_end_matches('/')
    );
    client
        .ensure_collection(&settings.remote_root)
        .await
        .expect("create live root");

    let outcome: Result<(), String> = async {
        let created = client
            .put_conditional(&probe, b"first", WritePrecondition::MustNotExist)
            .await?;
        if created != PutOutcome::Applied {
            return Err("creating a new resource was rejected".to_string());
        }
        let object = client
            .get_optional_with_etag(&probe)
            .await?
            .ok_or_else(|| "probe resource disappeared".to_string())?;
        let etag = object.etag.ok_or_else(|| {
            "server returned no strong ETag; concurrent multi-device sync cannot be safe"
                .to_string()
        })?;

        let stale = client
            .put_conditional(
                &probe,
                b"stale",
                WritePrecondition::Match("\"stale-validator\""),
            )
            .await?;
        if stale != PutOutcome::PreconditionFailed {
            return Err(
                "server accepted a stale If-Match; conditional writes are not enforced".to_string(),
            );
        }
        let applied = client
            .put_conditional(&probe, b"second", WritePrecondition::Match(&etag))
            .await?;
        if applied != PutOutcome::Applied {
            return Err("server rejected the current ETag".to_string());
        }
        let recreate = client
            .put_conditional(&probe, b"third", WritePrecondition::MustNotExist)
            .await?;
        if recreate != PutOutcome::PreconditionFailed {
            return Err("server ignored If-None-Match: * on an existing resource".to_string());
        }
        if client.get(&probe).await? != b"second" {
            return Err("the conditional overwrite was not stored".to_string());
        }
        Ok(())
    }
    .await;

    let _ = client.delete_optional(&probe).await;
    let _ = client.delete_optional(&settings.remote_root).await;
    if let Err(error) = outcome {
        panic!("live WebDAV conditional-write test failed: {error}");
    }
}

#[tokio::test]
#[ignore = "requires a real WebDAV server via ZEDITOR_LIVE_WEBDAV_URL"]
async fn live_webdav_two_devices_preserve_both_versions() {
    let Some(settings) = live_webdav_settings() else {
        return;
    };
    let mapped = live_document_paths(&settings.remote_root);
    let verify_client = webdav_remote(&settings);
    let temp = super::test_support::test_temp_dir();
    let left = LiveDevice::WebDav(
        WebDavSyncManager::new(temp.join("device-a-queue.json"), Arc::new(SilentSink)),
        settings.clone(),
    );
    let right = LiveDevice::WebDav(
        WebDavSyncManager::new(temp.join("device-b-queue.json"), Arc::new(SilentSink)),
        settings.clone(),
    );

    let outcome = run_multi_device_scenario(
        &left,
        &right,
        &verify_client,
        &settings.remote_root,
        &mapped,
    )
    .await;
    cleanup_live_history(&verify_client, &settings.remote_root, &mapped).await;
    if let Err(error) = outcome {
        panic!("live WebDAV multi-device test failed: {error}");
    }
}

#[tokio::test]
#[ignore = "requires a real S3-compatible server via ZEDITOR_LIVE_S3_ENDPOINT"]
async fn live_s3_enforces_conditional_writes() {
    let Some(settings) = live_s3_settings() else {
        return;
    };
    let client = S3Client::new(&settings).expect("S3 client");
    let probe = "/conditional-probe.md";

    let outcome: Result<(), String> = async {
        let created = client
            .put_conditional(probe, b"first", WritePrecondition::MustNotExist)
            .await?;
        if created != PutOutcome::Applied {
            return Err("creating a new object was rejected".to_string());
        }
        let object = client
            .get_optional_with_etag(probe)
            .await?
            .ok_or_else(|| "probe object disappeared".to_string())?;
        let etag = object.etag.ok_or_else(|| {
            "server returned no strong ETag; concurrent multi-device sync cannot be safe"
                .to_string()
        })?;

        let stale = client
            .put_conditional(
                probe,
                b"stale",
                WritePrecondition::Match("\"stale-validator\""),
            )
            .await?;
        if stale != PutOutcome::PreconditionFailed {
            return Err(
                "server accepted a stale If-Match; conditional writes are not enforced".to_string(),
            );
        }
        let applied = client
            .put_conditional(probe, b"second", WritePrecondition::Match(&etag))
            .await?;
        if applied != PutOutcome::Applied {
            return Err("server rejected the current ETag".to_string());
        }
        let recreate = client
            .put_conditional(probe, b"third", WritePrecondition::MustNotExist)
            .await?;
        if recreate != PutOutcome::PreconditionFailed {
            return Err("server ignored If-None-Match: * on an existing object".to_string());
        }
        if client.get(probe).await? != b"second" {
            return Err("the conditional overwrite was not stored".to_string());
        }
        Ok(())
    }
    .await;

    let _ = client.delete_optional(probe).await;
    if let Err(error) = outcome {
        panic!("live S3 conditional-write test failed: {error}");
    }
}

#[tokio::test]
#[ignore = "requires a real S3-compatible server via ZEDITOR_LIVE_S3_ENDPOINT"]
async fn live_s3_two_devices_preserve_both_versions() {
    let Some(settings) = live_s3_settings() else {
        return;
    };
    let mapped = live_document_paths(&settings.remote_root);
    let verify_client = s3_remote(&settings);
    let temp = super::test_support::test_temp_dir();
    let left = LiveDevice::S3(
        S3SyncManager::new(temp.join("device-a-queue.json"), Arc::new(SilentSink)),
        settings.clone(),
    );
    let right = LiveDevice::S3(
        S3SyncManager::new(temp.join("device-b-queue.json"), Arc::new(SilentSink)),
        settings.clone(),
    );

    let outcome = run_multi_device_scenario(
        &left,
        &right,
        &verify_client,
        &settings.remote_root,
        &mapped,
    )
    .await;
    cleanup_live_history(&verify_client, &settings.remote_root, &mapped).await;
    if let Err(error) = outcome {
        panic!("live S3 multi-device test failed: {error}");
    }
}
