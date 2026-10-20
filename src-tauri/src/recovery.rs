use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const RECOVERY_FILE_NAME: &str = "recovery-snapshots.json";
pub const MAX_CONTENT_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_SNAPSHOT_COUNT: usize = 20;
const MAX_STORE_BYTES: usize = 32 * 1024 * 1024;
const MAX_SNAPSHOT_AGE_MILLIS: i64 = 7 * 24 * 60 * 60 * 1000;

static RECOVERY_STORE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// One recoverable unsaved editor document. This store is intentionally separate
/// from the user's historical timeline and WebDAV version history.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecoverySnapshot {
    pub id: String,
    pub title: String,
    pub path: Option<String>,
    pub content: String,
    pub encoding: String,
    pub updated_at: i64,
    #[serde(default)]
    pub file_version: Option<crate::file_version::FileVersion>,
    #[serde(default)]
    pub external_change_pending: bool,
}

/// File-system-backed store, separated from Tauri so its safety rules are testable.
pub struct RecoveryStore {
    path: PathBuf,
}

impl RecoveryStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn list(&self) -> Result<Vec<RecoverySnapshot>, String> {
        let _guard = store_lock();
        let snapshots = self.read_unlocked()?;
        let (snapshots, pruned) = prune_snapshots(snapshots, current_time_millis())?;
        if pruned {
            self.write_unlocked(&snapshots)?;
        }
        Ok(snapshots)
    }

    pub fn upsert(&self, snapshot: RecoverySnapshot) -> Result<(), String> {
        validate_snapshot(&snapshot)?;
        let now = current_time_millis();
        if is_expired(&snapshot, now) {
            return Err("Recovery snapshot is already expired.".into());
        }

        let _guard = store_lock();
        let existing = self.read_unlocked()?;
        let (mut snapshots, pruned) = prune_snapshots(existing, now)?;

        // Ignore stale writes that arrive after a newer autosave for the same tab.
        if snapshots
            .iter()
            .any(|current| current.id == snapshot.id && current.updated_at > snapshot.updated_at)
        {
            if pruned {
                self.write_unlocked(&snapshots)?;
            }
            return Ok(());
        }

        snapshots.retain(|current| current.id != snapshot.id);
        snapshots.push(snapshot.clone());
        let (snapshots, _) = prune_snapshots(snapshots, now)?;
        if !snapshots.iter().any(|current| current.id == snapshot.id) {
            return Err(
                "Recovery snapshot could not be retained within the storage limits.".into(),
            );
        }
        self.write_unlocked(&snapshots)
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let _guard = store_lock();
        let existing = self.read_unlocked()?;
        let (mut snapshots, pruned) = prune_snapshots(existing, current_time_millis())?;
        let before = snapshots.len();
        snapshots.retain(|snapshot| snapshot.id != id);
        if snapshots.len() != before || pruned {
            self.write_unlocked(&snapshots)?;
        }
        Ok(())
    }

    fn read_unlocked(&self) -> Result<Vec<RecoverySnapshot>, String> {
        let file = match File::open(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => {
                return Err(format!(
                    "Failed to open recovery snapshots '{}': {error}",
                    self.path.display()
                ));
            }
        };

        let mut reader = file.take((MAX_STORE_BYTES + 1) as u64);
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).map_err(|error| {
            format!(
                "Failed to read recovery snapshots '{}': {error}",
                self.path.display()
            )
        })?;
        if bytes.len() > MAX_STORE_BYTES {
            return Err(format!(
                "Recovery snapshot store '{}' exceeds the {} byte limit.",
                self.path.display(),
                MAX_STORE_BYTES
            ));
        }

        let snapshots: Vec<RecoverySnapshot> = serde_json::from_slice(&bytes).map_err(|error| {
            format!(
                "Invalid recovery snapshot store '{}': {error}",
                self.path.display()
            )
        })?;
        for snapshot in &snapshots {
            validate_snapshot(snapshot)?;
        }
        Ok(snapshots)
    }

    fn write_unlocked(&self, snapshots: &[RecoverySnapshot]) -> Result<(), String> {
        for snapshot in snapshots {
            validate_snapshot(snapshot)?;
        }
        if snapshots.len() > MAX_SNAPSHOT_COUNT {
            return Err("Recovery snapshot count exceeds the storage limit.".into());
        }

        let bytes = serde_json::to_vec(snapshots)
            .map_err(|error| format!("Failed to serialize recovery snapshots: {error}"))?;
        if bytes.len() > MAX_STORE_BYTES {
            return Err("Recovery snapshot store exceeds the storage limit.".into());
        }

        if let Some(parent) = non_empty_parent(&self.path) {
            fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "Failed to create recovery snapshot directory '{}': {error}",
                    parent.display()
                )
            })?;
        }

        let temporary = sibling_temporary_path(&self.path);
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|error| {
                    format!(
                        "Failed to create recovery snapshot temp file '{}': {error}",
                        temporary.display()
                    )
                })?;
            file.write_all(&bytes)
                .and_then(|_| file.flush())
                .and_then(|_| file.sync_all())
                .map_err(|error| {
                    format!(
                        "Failed to write recovery snapshot temp file '{}': {error}",
                        temporary.display()
                    )
                })?;
            drop(file);
            fs::rename(&temporary, &self.path).map_err(|error| {
                format!(
                    "Failed to replace recovery snapshot store '{}': {error}",
                    self.path.display()
                )
            })
        })();

        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}

fn store_lock() -> std::sync::MutexGuard<'static, ()> {
    RECOVERY_STORE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn validate_snapshot(snapshot: &RecoverySnapshot) -> Result<(), String> {
    if snapshot.id.trim().is_empty() || snapshot.id.len() > 256 {
        return Err("Recovery snapshot id must contain 1 to 256 bytes.".into());
    }
    if snapshot.title.len() > 1024 {
        return Err("Recovery snapshot title exceeds 1024 bytes.".into());
    }
    if snapshot
        .path
        .as_ref()
        .is_some_and(|path| path.len() > 32 * 1024)
    {
        return Err("Recovery snapshot path exceeds 32768 bytes.".into());
    }
    if snapshot.encoding.is_empty() || snapshot.encoding.len() > 128 {
        return Err("Recovery snapshot encoding must contain 1 to 128 bytes.".into());
    }
    if snapshot.content.len() > MAX_CONTENT_BYTES {
        return Err(format!(
            "Recovery snapshot content exceeds the {} byte limit.",
            MAX_CONTENT_BYTES
        ));
    }
    if snapshot.updated_at < 0 {
        return Err("Recovery snapshot updatedAt must be a non-negative Unix timestamp.".into());
    }
    Ok(())
}

fn prune_snapshots(
    mut snapshots: Vec<RecoverySnapshot>,
    now: i64,
) -> Result<(Vec<RecoverySnapshot>, bool), String> {
    let initial_len = snapshots.len();
    snapshots.retain(|snapshot| !is_expired(snapshot, now));
    snapshots.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.id.cmp(&right.id))
    });

    let mut seen_ids = HashSet::new();
    snapshots.retain(|snapshot| seen_ids.insert(snapshot.id.clone()));
    snapshots.truncate(MAX_SNAPSHOT_COUNT);

    while serialized_len(&snapshots)? > MAX_STORE_BYTES {
        if snapshots.pop().is_none() {
            break;
        }
    }

    let pruned = snapshots.len() != initial_len;
    Ok((snapshots, pruned))
}

fn serialized_len(snapshots: &[RecoverySnapshot]) -> Result<usize, String> {
    serde_json::to_vec(snapshots)
        .map(|bytes| bytes.len())
        .map_err(|error| format!("Failed to serialize recovery snapshots: {error}"))
}

fn is_expired(snapshot: &RecoverySnapshot, now: i64) -> bool {
    snapshot.updated_at < now.saturating_sub(MAX_SNAPSHOT_AGE_MILLIS)
}

fn current_time_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

fn non_empty_parent(path: &Path) -> Option<&Path> {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
}

fn sibling_temporary_path(destination: &Path) -> PathBuf {
    let file_name = destination
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| RECOVERY_FILE_NAME.to_string());
    destination.with_file_name(format!("{file_name}.tmp-{}", uuid::Uuid::new_v4()))
}

fn app_recovery_store(app: &AppHandle) -> Result<RecoveryStore, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Failed to locate application config directory: {error}"))?;
    fs::create_dir_all(&config_dir).map_err(|error| {
        format!(
            "Failed to create application config directory '{}': {error}",
            config_dir.display()
        )
    })?;
    Ok(RecoveryStore::new(config_dir.join(RECOVERY_FILE_NAME)))
}

#[tauri::command]
pub async fn list_recovery_snapshots(app: AppHandle) -> Result<Vec<RecoverySnapshot>, String> {
    let store = app_recovery_store(&app)?;
    tokio::task::spawn_blocking(move || store.list())
        .await
        .map_err(|error| format!("Recovery storage worker failed: {error}"))?
}

#[tauri::command]
pub async fn save_recovery_snapshot(
    app: AppHandle,
    snapshot: RecoverySnapshot,
) -> Result<(), String> {
    let store = app_recovery_store(&app)?;
    tokio::task::spawn_blocking(move || store.upsert(snapshot))
        .await
        .map_err(|error| format!("Recovery storage worker failed: {error}"))?
}

#[tauri::command]
pub async fn delete_recovery_snapshot(app: AppHandle, id: String) -> Result<(), String> {
    let store = app_recovery_store(&app)?;
    tokio::task::spawn_blocking(move || store.delete(&id))
        .await
        .map_err(|error| format!("Recovery storage worker failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("zeditor-recovery-test-{nonce}"));
        fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    fn snapshot(id: &str, updated_at: i64, content: &str) -> RecoverySnapshot {
        RecoverySnapshot {
            id: id.into(),
            title: format!("{id}.md"),
            path: Some(format!("C:\\notes\\{id}.md")),
            content: content.into(),
            encoding: "utf-8".into(),
            updated_at,
            file_version: None,
            external_change_pending: false,
        }
    }

    #[test]
    fn saves_and_lists_a_camel_case_snapshot() {
        let root = test_dir();
        let store = RecoveryStore::new(root.join("recovery-snapshots.json"));
        let now = current_time_millis();
        store
            .upsert(snapshot("tab-a", now, "初始内容"))
            .expect("save initial snapshot");
        let expected = snapshot("tab-a", now.saturating_add(1), "恢复内容");

        store.upsert(expected.clone()).expect("save snapshot");

        assert_eq!(
            store.list().expect("list snapshots"),
            vec![expected.clone()]
        );
        let json: serde_json::Value = serde_json::from_slice(
            &fs::read(root.join("recovery-snapshots.json")).expect("read file"),
        )
        .expect("parse file");
        assert_eq!(json[0]["updatedAt"], expected.updated_at);
        assert!(json[0].get("updated_at").is_none());
        assert_eq!(fs::read_dir(root).expect("list temp dir").count(), 1);
    }

    #[test]
    fn rejects_oversized_content_without_replacing_the_previous_snapshot() {
        let root = test_dir();
        let store = RecoveryStore::new(root.join("recovery-snapshots.json"));
        let now = current_time_millis();
        store
            .upsert(snapshot("tab-a", now, "keep me"))
            .expect("initial save");

        let too_large = "x".repeat(MAX_CONTENT_BYTES + 1);
        assert!(store
            .upsert(snapshot("tab-a", now.saturating_add(1), &too_large))
            .is_err());

        assert_eq!(store.list().expect("list snapshots")[0].content, "keep me");
    }

    #[test]
    fn listing_prunes_expired_records_and_keeps_only_the_newest_limit() {
        let root = test_dir();
        let path = root.join("recovery-snapshots.json");
        let store = RecoveryStore::new(path.clone());
        let now = current_time_millis();
        let mut stored = vec![snapshot(
            "expired",
            now - MAX_SNAPSHOT_AGE_MILLIS - 1,
            "old",
        )];
        stored.extend(
            (0..=MAX_SNAPSHOT_COUNT)
                .map(|index| snapshot(&format!("tab-{index:02}"), now - index as i64, "content")),
        );
        fs::write(
            &path,
            serde_json::to_vec(&stored).expect("serialize fixtures"),
        )
        .expect("write fixture");

        let listed = store.list().expect("list snapshots");

        assert_eq!(listed.len(), MAX_SNAPSHOT_COUNT);
        assert!(listed.iter().all(|item| item.id != "expired"));
        assert!(listed.iter().all(|item| item.id != "tab-20"));
        assert_eq!(listed[0].id, "tab-00");
        let persisted: Vec<RecoverySnapshot> =
            serde_json::from_slice(&fs::read(path).expect("read pruned file"))
                .expect("parse pruned file");
        assert_eq!(persisted, listed);
    }

    #[test]
    fn delete_removes_one_snapshot_and_is_idempotent() {
        let root = test_dir();
        let store = RecoveryStore::new(root.join("recovery-snapshots.json"));
        let now = current_time_millis();
        store.upsert(snapshot("tab-a", now, "a")).expect("save a");
        store
            .upsert(snapshot("tab-b", now.saturating_add(1), "b"))
            .expect("save b");

        store.delete("tab-a").expect("delete a");
        store.delete("tab-a").expect("delete absent a");

        assert_eq!(
            store.list().expect("list snapshots"),
            vec![snapshot("tab-b", now.saturating_add(1), "b")]
        );
    }

    #[test]
    fn malformed_store_is_reported_and_never_overwritten() {
        let root = test_dir();
        let path = root.join("recovery-snapshots.json");
        let store = RecoveryStore::new(path.clone());
        let now = current_time_millis();
        fs::write(&path, b"{broken json").expect("write malformed file");

        assert!(store.list().is_err());
        assert!(store.upsert(snapshot("tab-a", now, "new")).is_err());
        assert_eq!(fs::read(path).expect("read original file"), b"{broken json");
    }

    #[test]
    fn stale_upsert_does_not_replace_a_newer_snapshot() {
        let root = test_dir();
        let store = RecoveryStore::new(root.join("recovery-snapshots.json"));
        let now = current_time_millis();
        let latest = snapshot("tab-a", now.saturating_add(5), "latest");
        store.upsert(latest.clone()).expect("save latest");
        store
            .upsert(snapshot("tab-a", now, "stale"))
            .expect("ignore stale update");

        assert_eq!(store.list().expect("list snapshots"), vec![latest]);
    }

    #[test]
    fn interrupted_temp_file_does_not_replace_the_last_durable_snapshot() {
        let root = test_dir();
        let path = root.join("recovery-snapshots.json");
        let store = RecoveryStore::new(path.clone());
        let now = current_time_millis();
        let original = snapshot("tab-a", now, "durable 中文 😀");
        store
            .upsert(original.clone())
            .expect("save durable snapshot");
        let temporary = sibling_temporary_path(&path);
        fs::write(&temporary, b"[{\"id\":\"tab-a\",\"content\":\"interrupted")
            .expect("simulate interrupted temp write");

        let restarted = RecoveryStore::new(path);
        assert_eq!(restarted.list().expect("reopen store"), vec![original]);
        assert!(
            temporary.exists(),
            "uncommitted data is not adopted as a valid store"
        );
        fs::remove_dir_all(root).expect("remove disposable fixture");
    }

    #[test]
    fn expired_upsert_cannot_replace_existing_recoverable_content() {
        let root = test_dir();
        let path = root.join("recovery-snapshots.json");
        let store = RecoveryStore::new(path.clone());
        let now = current_time_millis();
        let current = snapshot("tab-a", now, "keep current");
        store.upsert(current.clone()).expect("save current");
        let durable_bytes = fs::read(&path).expect("read durable store");
        assert!(store
            .upsert(snapshot(
                "tab-a",
                now - MAX_SNAPSHOT_AGE_MILLIS - 1,
                "expired"
            ))
            .is_err());
        assert_eq!(
            fs::read(&path).expect("read unchanged store"),
            durable_bytes
        );
        assert_eq!(
            store.list().expect("list unchanged snapshots"),
            vec![current]
        );
        fs::remove_dir_all(root).expect("remove disposable fixture");
    }
}
