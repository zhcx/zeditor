use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::model::PendingBackupTask;

/// Durable store for pending WebDAV backup tasks.
///
/// Persists one JSON file with atomic write-through-rename while holding an
/// in-process lock. Never stores settings or document bytes, only metadata.
pub struct PendingTaskStore {
    path: PathBuf,
    lock: Mutex<()>,
}

impl PendingTaskStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock: Mutex::new(()),
        }
    }

    /// Load all pending tasks. Returns an empty list when the file is absent.
    pub fn load(&self) -> Result<Vec<PendingBackupTask>, String> {
        let _guard = self.lock.lock().expect("queue lock");
        self.read_unlocked()
    }

    /// Insert or replace the task for a document. The most recent task per
    /// document wins, matching the coalescing rule.
    pub fn upsert(&self, task: PendingBackupTask) -> Result<(), String> {
        let _guard = self.lock.lock().expect("queue lock");
        let mut tasks = self.read_unlocked()?;
        tasks.retain(|existing| existing.document_id != task.document_id);
        tasks.push(task);
        self.write_atomically_unlocked(&tasks)
    }

    /// Remove the pending task for a document. Absence is not an error.
    pub fn remove(&self, document_id: &str) -> Result<(), String> {
        let _guard = self.lock.lock().expect("queue lock");
        let mut tasks = self.read_unlocked()?;
        let before = tasks.len();
        tasks.retain(|task| task.document_id != document_id);
        if tasks.len() == before {
            return Ok(());
        }
        self.write_atomically_unlocked(&tasks)
    }

    /// Read without acquiring the lock; callers must hold the lock.
    fn read_unlocked(&self) -> Result<Vec<PendingBackupTask>, String> {
        match fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|error| format!("Invalid WebDAV pending tasks file: {error}")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(error) => Err(format!(
                "Failed to read WebDAV pending tasks file '{}': {error}",
                self.path.display()
            )),
        }
    }

    /// Write tasks to a sibling temporary file, flush, then rename over the
    /// destination so readers never observe a partially written file.
    fn write_atomically_unlocked(&self, tasks: &[PendingBackupTask]) -> Result<(), String> {
        let json = serde_json::to_vec_pretty(tasks)
            .map_err(|error| format!("Failed to serialize WebDAV pending tasks: {error}"))?;
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "Failed to create WebDAV pending tasks directory '{}': {error}",
                    parent.display()
                )
            })?;
        }

        let temporary = sibling_temporary_path(&self.path);
        {
            let mut file = fs::File::create(&temporary).map_err(|error| {
                format!(
                    "Failed to create WebDAV pending tasks temp file '{}': {error}",
                    temporary.display()
                )
            })?;
            file.write_all(&json)
                .and_then(|_| file.flush())
                .and_then(|_| file.sync_all())
                .map_err(|error| {
                    format!(
                        "Failed to write WebDAV pending tasks temp file '{}': {error}",
                        temporary.display()
                    )
                })?;
        }
        fs::rename(&temporary, &self.path).map_err(|error| {
            format!(
                "Failed to replace WebDAV pending tasks file '{}': {error}",
                self.path.display()
            )
        })
    }
}

/// Build a unique sibling path for atomic replace, distinct from any existing
/// temp file so concurrent writers never collide on the rename target.
fn sibling_temporary_path(destination: &Path) -> PathBuf {
    let mut name = destination
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "webdav-pending.json".to_string());
    name.push_str(&format!(".tmp-{}", uuid::Uuid::new_v4()));
    destination.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::webdav::path::{deterministic_version_id, sha256_hex};
    use crate::webdav::test_support::test_temp_dir;

    fn task(document_id: &str, sha256: &str, version_id: &str) -> PendingBackupTask {
        PendingBackupTask {
            encoding: None,
            document_id: document_id.into(),
            display_name: "note.md".into(),
            local_path: "C:\\notes\\note.md".into(),
            workspace_roots: vec!["C:\\notes".into()],
            current_path: "/Zeditor/notes/note.md".into(),
            manifest_path: format!(
                "/Zeditor/.zeditor-history/documents/{document_id}/manifest.json"
            ),
            versions_dir: format!("/Zeditor/.zeditor-history/documents/{document_id}/versions"),
            queued_at: "2026-08-19T14:32:00Z".into(),
            sha256: sha256.into(),
            version_id: version_id.into(),
        }
    }

    #[test]
    fn coalesces_document_tasks_and_round_trips_atomically() {
        let root = test_temp_dir();
        let store = PendingTaskStore::new(root.join("webdav-pending.json"));
        store.upsert(task("doc-a", "hash-1", "v1")).expect("first");
        store
            .upsert(task("doc-a", "hash-2", "v2"))
            .expect("replace");
        store
            .upsert(task("doc-b", "hash-3", "v3"))
            .expect("second doc");
        let tasks = store.load().expect("load");
        assert_eq!(tasks.len(), 2);
        assert_eq!(
            tasks
                .iter()
                .find(|t| t.document_id == "doc-a")
                .unwrap()
                .sha256,
            "hash-2"
        );
    }

    #[test]
    fn remove_deletes_only_the_matching_document() {
        let root = test_temp_dir();
        let store = PendingTaskStore::new(root.join("webdav-pending.json"));
        store.upsert(task("doc-a", "hash-1", "v1")).expect("a");
        store.upsert(task("doc-b", "hash-2", "v2")).expect("b");
        store.remove("doc-a").expect("remove a");
        let tasks = store.load().expect("load");
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].document_id, "doc-b");
    }

    #[test]
    fn load_returns_empty_when_file_is_absent() {
        let root = test_temp_dir();
        let store = PendingTaskStore::new(root.join("webdav-pending.json"));
        let tasks = store.load().expect("absent load");
        assert!(tasks.is_empty());
    }

    #[test]
    fn updates_stale_hash_before_network_execution() {
        let mut task = task("doc-a", "old", "old-version");
        task.refresh_for_bytes(b"new bytes", "2026-08-19T14:32:00Z");
        assert_eq!(task.sha256, sha256_hex(b"new bytes"));
        assert_ne!(task.version_id, "old-version");
        assert_eq!(
            task.version_id,
            deterministic_version_id("2026-08-19T14:32:00Z", &sha256_hex(b"new bytes"))
        );
    }
}
