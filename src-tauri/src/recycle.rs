//! Recoverable deletion. Records are durable before the source is touched.
//! Never fall back to permanent deletion when a system bin is unavailable.
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

static RECYCLE_LOCK: Mutex<()> = Mutex::new(());
const MAX_RECORD_BYTES: u64 = 64 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecycleEntry {
    pub id: String,
    pub name: String,
    pub original_path: String,
    pub deleted_at: i64,
    pub is_directory: bool,
    pub location: String,
    pub can_restore: bool,
    pub available: bool,
    pub note: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    entry: RecycleEntry,
    canonical_parent: PathBuf,
    native_id: Option<String>,
    // The location is derived from UUID, never supplied by a webview caller.
    payload: Option<PathBuf>,
    pending: bool,
}

pub struct RecycleStore {
    root: PathBuf,
}

impl RecycleStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn original_path(&self, id: &str) -> Result<PathBuf, String> {
        Ok(PathBuf::from(self.read_record(id)?.entry.original_path))
    }

    pub fn recycle(&self, path: &Path) -> Result<RecycleEntry, String> {
        self.recycle_with(path, &NativeTrash)
    }

    fn recycle_with(&self, path: &Path, native: &dyn TrashAdapter) -> Result<RecycleEntry, String> {
        let _guard = RECYCLE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        if !path.is_absolute() || path.file_name().is_none() {
            return Err("仅允许回收具有完整路径的文件或文件夹".into());
        }
        let metadata = fs::symlink_metadata(path).map_err(io_error)?;
        // Never canonicalize the leaf: doing so could recycle a link's target.
        if is_link(&metadata) {
            return Err("为保护链接指向的内容，暂不支持回收符号链接或目录联接".into());
        }
        let canonical_parent =
            ordinary_path(&fs::canonicalize(path.parent().unwrap()).map_err(io_error)?);
        let source = canonical_parent.join(path.file_name().unwrap());
        let id = uuid::Uuid::new_v4().to_string();
        let operation_dir = self.root.join(&id);
        fs::create_dir_all(&self.root).map_err(io_error)?;
        let canonical_store = ordinary_path(&fs::canonicalize(&self.root).map_err(io_error)?);
        if path_contains(&source, &canonical_store) || path_contains(&canonical_store, &source) {
            return Err("为保留恢复记录，不能回收 Zeditor 恢复区或包含恢复区的文件夹".into());
        }
        fs::create_dir(&operation_dir).map_err(io_error)?;
        let mut record = Record {
            entry: RecycleEntry {
                id,
                name: path.file_name().unwrap().to_string_lossy().into_owned(),
                original_path: source.to_str().ok_or("文件路径无法编码为 Unicode")?.into(),
                deleted_at: chrono::Utc::now().timestamp_millis(),
                is_directory: metadata.is_dir(),
                location: "system".into(),
                can_restore: false,
                available: true,
                note: String::new(),
            },
            canonical_parent,
            native_id: None,
            payload: None,
            pending: true,
        };
        self.write_record(&record)?;

        // Capture IDs, not just filenames/timestamps: repeated deletions of the
        // same name must never restore an older, unrelated object.
        let before = native.list().ok();
        match native.delete(&source) {
            Ok(()) => {
                if fs::symlink_metadata(&source).is_ok() {
                    return Err("系统回收站未移动文件；原文件仍保留，请重试".into());
                }
                let after = native.list().ok();
                if let (Some(before), Some(after)) = (&before, &after) {
                    let matching: Vec<_> = after
                        .iter()
                        .filter(|item| {
                            same_path(&item.path, &source)
                                && !before.iter().any(|old| old.id == item.id)
                        })
                        .collect();
                    if matching.len() == 1 {
                        record.native_id = Some(matching[0].id.clone());
                    }
                }
                record.entry.can_restore = record.native_id.is_some();
                if !record.entry.can_restore {
                    record.entry.note = "已移入系统回收站。当前平台或系统状态无法安全定位此项目，请在系统回收站中恢复。".into();
                }
            }
            Err(native_error) => {
                if fs::symlink_metadata(&source).is_err() {
                    // A system call may report an error after completing. Never
                    // attempt another destructive operation against that path.
                    record.entry.note =
                        format!("系统回收结果无法确认，请检查系统回收站：{native_error}");
                } else {
                    // Same-volume atomic rename only. EXDEV is a cancellation,
                    // never a recursive copy-and-delete of the user's source.
                    let payload = operation_dir.join("payload");
                    record.payload = Some(payload.clone());
                    record.entry.location = "app".into();
                    self.write_record(&record)?;
                    if let Err(error) = native.quarantine(&source, &payload) {
                        // Keep the small failure record for audit; list omits it
                        // because source exists and no payload was moved.
                        return Err(format!("系统回收站不可用，安全暂存也未成功，已取消删除，原文件仍保留。系统：{native_error}；暂存：{error}"));
                    }
                    record.entry.can_restore = true;
                    record.entry.note = format!("系统回收站不可用，已保存在 Zeditor 恢复区，可在此恢复。原因：{native_error}");
                }
            }
        }
        record.pending = false;
        // If this write fails, the already durable pending record plus payload
        // or native ID difference can still be reconciled by list().
        self.write_record(&record)?;
        Ok(record.entry)
    }

    pub fn list(&self) -> Result<Vec<RecycleEntry>, String> {
        self.list_with(&NativeTrash)
    }

    fn list_with(&self, native: &dyn TrashAdapter) -> Result<Vec<RecycleEntry>, String> {
        let _guard = RECYCLE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        if !self.root.exists() {
            return Ok(Vec::new());
        }
        let native_items = native.list().ok();
        let mut entries = Vec::new();
        for item in fs::read_dir(&self.root).map_err(io_error)? {
            let item = item.map_err(io_error)?;
            let Some(id) = item.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if uuid::Uuid::parse_str(&id).is_err() {
                continue;
            }
            let mut record = self.read_record(&id)?;
            if record.entry.location == "restored" {
                continue;
            }
            if let Some(payload) = &record.payload {
                record.entry.available = fs::symlink_metadata(payload).is_ok();
                record.entry.can_restore = record.entry.available;
                if record.pending
                    && !record.entry.available
                    && Path::new(&record.entry.original_path).exists()
                {
                    continue;
                }
            } else if let Some(native_id) = &record.native_id {
                record.entry.available = native_items
                    .as_ref()
                    .is_none_or(|items| items.iter().any(|item| &item.id == native_id));
                record.entry.can_restore = record.entry.available && native_items.is_some();
            } else {
                record.entry.can_restore = false;
                if record.pending && Path::new(&record.entry.original_path).exists() {
                    continue;
                }
            }
            if !record.entry.available {
                record.entry.note = "项目已在系统回收站中还原或被清理；此记录不可恢复。".into();
            }
            entries.push(record.entry);
        }
        entries.sort_by_key(|entry| std::cmp::Reverse(entry.deleted_at));
        Ok(entries)
    }

    pub fn restore(&self, id: &str) -> Result<String, String> {
        self.restore_with(id, &NativeTrash)
    }

    fn restore_with(&self, id: &str, native: &dyn TrashAdapter) -> Result<String, String> {
        let _guard = RECYCLE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut record = self.read_record(id)?;
        if record.entry.location == "restored" {
            return Err("此项目已经恢复".into());
        }
        let target = PathBuf::from(&record.entry.original_path);
        if !same_path(
            &fs::canonicalize(target.parent().ok_or("恢复路径无效")?).map_err(io_error)?,
            &record.canonical_parent,
        ) {
            return Err("原文件夹位置已改变，请先恢复原文件夹；为保护文件，本次恢复已取消".into());
        }
        reject_existing(&target)?;
        let payload = if let Some(payload) = &record.payload {
            payload.clone()
        } else {
            let native_id = record
                .native_id
                .as_ref()
                .ok_or("请在系统回收站中恢复此项目")?;
            let items = native.list()?;
            let selected = items
                .into_iter()
                .find(|item| &item.id == native_id && same_path(&item.path, &target))
                .ok_or("回收站项目不存在，可能已在系统中恢复或被清理")?;
            // Restore into a newly created private staging directory first.
            // Upstream Windows restore checks for collisions non-atomically;
            // a private staging name removes that race at the user's path.
            let staging = record
                .canonical_parent
                .join(format!(".zeditor-restore-{id}"));
            fs::create_dir(&staging).map_err(|e| format!("无法创建安全恢复暂存目录：{e}"))?;
            let payload = staging.join("payload");
            record.payload = Some(payload.clone());
            self.write_record(&record)?;
            if let Err(error) = native.restore(&selected.id, &payload) {
                if fs::symlink_metadata(&payload).is_err() {
                    record.payload = None;
                    self.write_record(&record)?;
                    let _ = fs::remove_dir(&staging);
                }
                return Err(format!(
                    "系统恢复未完成，项目保留在回收站或恢复暂存目录：{error}"
                ));
            }
            payload
        };
        // Exclusive creation for every destination; no rename or copy API that
        // replaces an existing file. A failed copy retains the entire source.
        copy_exclusive(&payload, &target).map_err(|e| {
            format!("恢复未完成，恢复区中的原件仍保留；目标可能含已复制内容，请检查后重试：{e}")
        })?;
        record.entry.location = "restored".into();
        record.entry.can_restore = false;
        record.entry.available = false;
        self.write_record(&record)?;
        // Only app-owned payloads are removed after a verified successful copy.
        if let Ok(metadata) = fs::symlink_metadata(&payload) {
            if metadata.is_dir() && !is_link(&metadata) {
                let _ = fs::remove_dir_all(&payload);
            } else {
                let _ = fs::remove_file(&payload);
            }
        }
        if let Some(parent) = payload.parent() {
            if parent != self.root.join(id) {
                let _ = fs::remove_dir(parent);
            }
        }
        Ok(record.entry.original_path)
    }

    fn read_record(&self, id: &str) -> Result<Record, String> {
        if uuid::Uuid::parse_str(id).is_err() {
            return Err("恢复记录标识无效".into());
        }
        let path = self.root.join(id).join("record.json");
        let file = File::open(&path).map_err(io_error)?;
        if file.metadata().map_err(io_error)?.len() > MAX_RECORD_BYTES {
            return Err("恢复记录过大".into());
        }
        let record: Record =
            serde_json::from_reader(file).map_err(|e| format!("恢复记录损坏：{e}"))?;
        if record.entry.id != id {
            return Err("恢复记录标识不匹配".into());
        }
        if is_link(&fs::symlink_metadata(self.root.join(id)).map_err(io_error)?) {
            return Err("恢复记录目录不能是链接".into());
        }
        let target = Path::new(&record.entry.original_path);
        if !target.is_absolute()
            || target.parent() != Some(record.canonical_parent.as_path())
            || target.file_name().is_none()
        {
            return Err("恢复记录路径无效".into());
        }
        if let Some(payload) = &record.payload {
            let app_payload = self.root.join(id).join("payload");
            let native_payload = record
                .canonical_parent
                .join(format!(".zeditor-restore-{id}"))
                .join("payload");
            if payload != &app_payload && payload != &native_payload {
                return Err("恢复区路径无效".into());
            }
            if let Some(parent) = payload.parent() {
                if let Ok(metadata) = fs::symlink_metadata(parent) {
                    if is_link(&metadata) {
                        return Err("恢复区目录不能是链接".into());
                    }
                }
            }
        }
        Ok(record)
    }

    fn write_record(&self, record: &Record) -> Result<(), String> {
        let directory = self.root.join(&record.entry.id);
        let temporary = directory.join(format!("record-{}.tmp", uuid::Uuid::new_v4()));
        let bytes = serde_json::to_vec(record).map_err(|e| e.to_string())?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(io_error)?;
        file.write_all(&bytes).map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
        drop(file);
        fs::rename(&temporary, directory.join("record.json")).map_err(io_error)
    }
}

fn reject_existing(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(_) => {
            Err("原位置已有同名项目。请先移动或重命名该项目，再恢复；不会覆盖已有内容。".into())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_error(error)),
    }
}

fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn copy_exclusive(source: &Path, target: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source).map_err(io_error)?;
    if is_link(&metadata) {
        let link_target = fs::read_link(source).map_err(io_error)?;
        #[cfg(unix)]
        std::os::unix::fs::symlink(link_target, target).map_err(io_error)?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::{symlink_dir, symlink_file};
            if source.is_dir() {
                symlink_dir(link_target, target).map_err(io_error)?;
            } else {
                symlink_file(link_target, target).map_err(io_error)?;
            }
        }
    } else if metadata.is_dir() {
        fs::create_dir(target).map_err(io_error)?;
        for child in fs::read_dir(source).map_err(io_error)? {
            let child = child.map_err(io_error)?;
            copy_exclusive(&child.path(), &target.join(child.file_name()))?;
        }
    } else if metadata.is_file() {
        let mut input = File::open(source).map_err(io_error)?;
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)
            .map_err(io_error)?;
        let copied = std::io::copy(&mut input, &mut output).map_err(io_error)?;
        output.sync_all().map_err(io_error)?;
        if copied != metadata.len() {
            return Err("恢复时原件发生变化，已保留恢复区原件".into());
        }
        // Compare bytes after writing; a readable, complete destination is the
        // prerequisite for disposing of our retained payload.
        drop(output);
        let mut original = File::open(source).map_err(io_error)?;
        let mut restored = File::open(target).map_err(io_error)?;
        let mut a = [0u8; 64 * 1024];
        let mut b = [0u8; 64 * 1024];
        loop {
            let n = original.read(&mut a).map_err(io_error)?;
            restored.read_exact(&mut b[..n]).map_err(io_error)?;
            if a[..n] != b[..n] {
                return Err("恢复后的内容校验不一致，已保留恢复区原件".into());
            }
            if n == 0 {
                break;
            }
        }
    } else {
        return Err("恢复区包含不支持的特殊文件，原件仍保留".into());
    }
    Ok(())
}

fn io_error(error: std::io::Error) -> String {
    error.to_string()
}

// std::fs::canonicalize adds a verbatim prefix on Windows. Shell APIs and
// recycle-bin properties use ordinary drive/UNC names, so normalize it once.
fn ordinary_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let value = path.to_string_lossy();
        if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        if let Some(local) = value.strip_prefix(r"\\?\") {
            return PathBuf::from(local);
        }
    }
    path.to_path_buf()
}

fn same_path(a: &Path, b: &Path) -> bool {
    #[cfg(windows)]
    {
        ordinary_path(a).to_string_lossy().to_lowercase()
            == ordinary_path(b).to_string_lossy().to_lowercase()
    }
    #[cfg(not(windows))]
    {
        a == b
    }
}

fn path_contains(parent: &Path, child: &Path) -> bool {
    #[cfg(windows)]
    {
        PathBuf::from(ordinary_path(child).to_string_lossy().to_lowercase()).starts_with(
            PathBuf::from(ordinary_path(parent).to_string_lossy().to_lowercase()),
        )
    }
    #[cfg(not(windows))]
    {
        child.starts_with(parent)
    }
}

#[derive(Clone)]
struct NativeItem {
    id: String,
    path: PathBuf,
}
trait TrashAdapter {
    fn delete(&self, path: &Path) -> Result<(), String>;
    fn list(&self) -> Result<Vec<NativeItem>, String>;
    fn restore(&self, id: &str, target: &Path) -> Result<(), String>;
    fn quarantine(&self, source: &Path, target: &Path) -> Result<(), std::io::Error> {
        fs::rename(source, target)
    }
}
struct NativeTrash;
impl TrashAdapter for NativeTrash {
    fn delete(&self, path: &Path) -> Result<(), String> {
        #[cfg(windows)]
        {
            recycle_windows(path)
        }
        #[cfg(not(windows))]
        {
            trash::delete(path).map_err(|e| e.to_string())
        }
    }
    fn list(&self) -> Result<Vec<NativeItem>, String> {
        #[cfg(any(windows, target_os = "linux"))]
        {
            Ok(trash::os_limited::list()
                .map_err(|e| e.to_string())?
                .into_iter()
                .filter_map(|item| {
                    Some(NativeItem {
                        id: item.id.to_str()?.into(),
                        path: item.original_path(),
                    })
                })
                .collect())
        }
        #[cfg(not(any(windows, target_os = "linux")))]
        {
            Err("此平台请使用系统废纸篓恢复".into())
        }
    }
    fn restore(&self, id: &str, target: &Path) -> Result<(), String> {
        #[cfg(any(windows, target_os = "linux"))]
        {
            let mut item = trash::os_limited::list()
                .map_err(|e| e.to_string())?
                .into_iter()
                .find(|item| item.id.to_str() == Some(id))
                .ok_or("系统回收站项目不存在")?;
            item.original_parent = ordinary_path(target.parent().ok_or("恢复目标无效")?);
            item.name = target.file_name().ok_or("恢复目标无效")?.to_os_string();
            trash::os_limited::restore_all([item]).map_err(|e| e.to_string())?;
            if fs::symlink_metadata(target).is_err() {
                return Err("系统未完成恢复操作".into());
            }
            Ok(())
        }
        #[cfg(not(any(windows, target_os = "linux")))]
        {
            let _ = (id, target);
            Err("请使用系统废纸篓恢复".into())
        }
    }
}

#[cfg(windows)]
fn recycle_windows(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::PCWSTR,
        Win32::{System::Com::*, UI::Shell::*},
    };
    // trash initializes a per-thread COM apartment during the preceding list;
    // an already initialized apartment is valid for this synchronous operation.
    unsafe {
        let initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        struct ComGuard(bool);
        impl Drop for ComGuard {
            fn drop(&mut self) {
                if self.0 {
                    unsafe { CoUninitialize() }
                }
            }
        }
        let _guard = ComGuard(initialized.is_ok());
        let operation: IFileOperation =
            CoCreateInstance(&FileOperation, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
        operation
            .SetOperationFlags(
                FOF_SILENT
                    | FOF_NOERRORUI
                    | FOFX_EARLYFAILURE
                    | FOFX_RECYCLEONDELETE
                    | FOFX_ADDUNDORECORD,
            )
            .map_err(|e| e.to_string())?;
        let ordinary = ordinary_path(path);
        let wide: Vec<u16> = ordinary.as_os_str().encode_wide().chain(Some(0)).collect();
        let item: IShellItem =
            SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None).map_err(|e| e.to_string())?;
        operation
            .DeleteItem(&item, None)
            .map_err(|e| e.to_string())?;
        operation.PerformOperations().map_err(|e| e.to_string())?;
        if operation
            .GetAnyOperationsAborted()
            .map_err(|e| e.to_string())?
            .as_bool()
        {
            return Err("系统取消了回收操作".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        root: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("zeditor-recycle-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&root).unwrap();
            Self { root }
        }
        fn store(&self) -> RecycleStore {
            RecycleStore::new(self.root.join("recycle"))
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    struct Unavailable;
    impl TrashAdapter for Unavailable {
        fn delete(&self, _: &Path) -> Result<(), String> {
            Err("injected unavailable bin".into())
        }
        fn list(&self) -> Result<Vec<NativeItem>, String> {
            Err("unavailable".into())
        }
        fn restore(&self, _: &str, _: &Path) -> Result<(), String> {
            panic!("must not call native restore for fallback")
        }
    }
    struct FakeNative {
        bin: PathBuf,
        entries: Mutex<Vec<NativeItem>>,
        ambiguous: bool,
    }
    impl FakeNative {
        fn new(root: &Path) -> Self {
            let bin = root.join("fake-native-bin");
            fs::create_dir(&bin).unwrap();
            Self {
                bin,
                entries: Mutex::new(Vec::new()),
                ambiguous: false,
            }
        }
    }
    impl TrashAdapter for FakeNative {
        fn delete(&self, path: &Path) -> Result<(), String> {
            let id = uuid::Uuid::new_v4().to_string();
            fs::rename(path, self.bin.join(&id)).map_err(io_error)?;
            let mut entries = self.entries.lock().unwrap();
            entries.push(NativeItem {
                id,
                path: path.into(),
            });
            if self.ambiguous {
                entries.push(NativeItem {
                    id: uuid::Uuid::new_v4().to_string(),
                    path: path.into(),
                });
            }
            Ok(())
        }
        fn list(&self) -> Result<Vec<NativeItem>, String> {
            Ok(self.entries.lock().unwrap().clone())
        }
        fn restore(&self, id: &str, target: &Path) -> Result<(), String> {
            reject_existing(target)?;
            fs::rename(self.bin.join(id), target).map_err(io_error)?;
            self.entries.lock().unwrap().retain(|entry| entry.id != id);
            Ok(())
        }
    }
    #[test]
    fn fallback_roundtrips_unicode_directory_and_nested_file() {
        let fixture = Fixture::new();
        let original = fixture.root.join("中文 文稿");
        fs::create_dir(&original).unwrap();
        fs::write(original.join("图片 🦜.png"), b"image contents").unwrap();
        let store = fixture.store();
        let entry = store.recycle_with(&original, &Unavailable).unwrap();
        assert_eq!(entry.location, "app");
        assert!(!original.exists());
        assert_eq!(store.list_with(&Unavailable).unwrap().len(), 1);
        store.restore_with(&entry.id, &Unavailable).unwrap();
        assert_eq!(
            fs::read(original.join("图片 🦜.png")).unwrap(),
            b"image contents"
        );
        assert!(store.list_with(&Unavailable).unwrap().is_empty());
    }
    #[test]
    fn restore_never_overwrites_collision_and_retains_payload() {
        let fixture = Fixture::new();
        let original = fixture.root.join("note.md");
        fs::write(&original, b"old").unwrap();
        let store = fixture.store();
        let entry = store.recycle_with(&original, &Unavailable).unwrap();
        fs::write(&original, b"new").unwrap();
        assert!(store
            .restore_with(&entry.id, &Unavailable)
            .unwrap_err()
            .contains("同名"));
        assert_eq!(fs::read(&original).unwrap(), b"new");
        assert_eq!(
            fs::read(store.root.join(entry.id).join("payload")).unwrap(),
            b"old"
        );
    }
    #[test]
    fn invalid_ids_and_changed_parent_do_not_restore() {
        let fixture = Fixture::new();
        let directory = fixture.root.join("parent");
        fs::create_dir(&directory).unwrap();
        let original = directory.join("note.md");
        fs::write(&original, b"original").unwrap();
        let store = fixture.store();
        let entry = store.recycle_with(&original, &Unavailable).unwrap();
        assert!(store.restore_with("../outside", &Unavailable).is_err());
        fs::rename(&directory, fixture.root.join("moved")).unwrap();
        assert!(store.restore_with(&entry.id, &Unavailable).is_err());
    }
    #[test]
    fn duplicate_deletions_have_distinct_records() {
        let fixture = Fixture::new();
        let original = fixture.root.join("same.md");
        let store = fixture.store();
        fs::write(&original, b"version one").unwrap();
        let a = store.recycle_with(&original, &Unavailable).unwrap();
        fs::write(&original, b"version two").unwrap();
        let b = store.recycle_with(&original, &Unavailable).unwrap();
        assert_ne!(a.id, b.id);
        store.restore_with(&a.id, &Unavailable).unwrap();
        assert_eq!(fs::read(&original).unwrap(), b"version one");
        assert!(store.restore_with(&b.id, &Unavailable).is_err());
    }
    #[test]
    fn native_ids_distinguish_repeated_names_and_restore_through_staging() {
        let fixture = Fixture::new();
        let native = FakeNative::new(&fixture.root);
        let store = fixture.store();
        let original = fixture.root.join("same.md");
        fs::write(&original, b"old native version").unwrap();
        let first = store.recycle_with(&original, &native).unwrap();
        fs::write(&original, b"new native version").unwrap();
        let second = store.recycle_with(&original, &native).unwrap();
        assert!(first.can_restore && second.can_restore);
        store.restore_with(&second.id, &native).unwrap();
        assert_eq!(fs::read(&original).unwrap(), b"new native version");
        let remaining = store.list_with(&native).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, first.id);
    }
    #[test]
    fn ambiguous_native_results_require_system_recovery_and_never_guess() {
        let fixture = Fixture::new();
        let mut native = FakeNative::new(&fixture.root);
        native.ambiguous = true;
        let store = fixture.store();
        let original = fixture.root.join("ambiguous.md");
        fs::write(&original, b"original").unwrap();
        let entry = store.recycle_with(&original, &native).unwrap();
        assert!(!entry.can_restore);
        assert!(store
            .restore_with(&entry.id, &native)
            .unwrap_err()
            .contains("系统回收站"));
        assert!(!original.exists());
    }
    #[test]
    fn cleared_native_bin_is_reported_unavailable() {
        let fixture = Fixture::new();
        let native = FakeNative::new(&fixture.root);
        let store = fixture.store();
        let original = fixture.root.join("cleared.md");
        fs::write(&original, b"original").unwrap();
        let entry = store.recycle_with(&original, &native).unwrap();
        native.entries.lock().unwrap().clear();
        let listed = store.list_with(&native).unwrap();
        assert!(!listed[0].available);
        assert!(!listed[0].can_restore);
        assert!(store.restore_with(&entry.id, &native).is_err());
    }
    #[test]
    fn exclusive_directory_copy_preserves_conflicting_target_and_entire_source() {
        let fixture = Fixture::new();
        let source = fixture.root.join("payload");
        let target = fixture.root.join("target");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&target).unwrap();
        fs::write(source.join("note.md"), b"source").unwrap();
        fs::write(target.join("note.md"), b"existing").unwrap();
        assert!(copy_exclusive(&source, &target).is_err());
        assert_eq!(fs::read(target.join("note.md")).unwrap(), b"existing");
        assert_eq!(fs::read(source.join("note.md")).unwrap(), b"source");
    }
    #[test]
    fn cross_volume_fallback_failure_cancels_and_keeps_original() {
        struct CrossVolume;
        impl TrashAdapter for CrossVolume {
            fn delete(&self, _: &Path) -> Result<(), String> {
                Err("native unavailable".into())
            }
            fn list(&self) -> Result<Vec<NativeItem>, String> {
                Ok(Vec::new())
            }
            fn restore(&self, _: &str, _: &Path) -> Result<(), String> {
                panic!("not restorable")
            }
            fn quarantine(&self, _: &Path, _: &Path) -> Result<(), std::io::Error> {
                Err(std::io::Error::new(
                    std::io::ErrorKind::CrossesDevices,
                    "injected cross-volume rename",
                ))
            }
        }
        let fixture = Fixture::new();
        let source = fixture.root.join("keep.md");
        fs::write(&source, b"do not lose").unwrap();
        let store = fixture.store();
        let error = store.recycle_with(&source, &CrossVolume).unwrap_err();
        assert!(error.contains("已取消删除"));
        assert_eq!(fs::read(source).unwrap(), b"do not lose");
        assert!(store.list_with(&CrossVolume).unwrap().is_empty());
    }
    #[test]
    fn never_recycles_the_recovery_store_or_its_ancestor() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let note = fixture.root.join("original.md");
        fs::write(&note, b"keep").unwrap();
        assert!(store
            .recycle_with(&fixture.root, &Unavailable)
            .unwrap_err()
            .contains("恢复区"));
        assert!(store
            .recycle_with(&store.root, &Unavailable)
            .unwrap_err()
            .contains("恢复区"));
        assert_eq!(fs::read(note).unwrap(), b"keep");
        assert!(fixture.root.exists());
    }
    #[cfg(windows)]
    #[test]
    fn windows_verbatim_paths_match_native_shell_paths() {
        assert!(same_path(
            Path::new(r"\\?\C:\Folder\中文.md"),
            Path::new(r"c:\folder\中文.md")
        ));
        assert!(same_path(
            Path::new(r"\\?\UNC\server\share\文稿.md"),
            Path::new(r"\\server\share\文稿.md")
        ));
        assert_eq!(
            ordinary_path(Path::new(r"\\?\C:\Folder")),
            PathBuf::from(r"C:\Folder")
        );
    }
    #[test]
    #[ignore = "manual native roundtrip; touches only a new temporary fixture and its recycle entry"]
    fn native_recycle_and_restore_disposable_file() {
        let fixture = Fixture::new();
        let original = fixture
            .root
            .join(format!("zeditor-中文-{}.md", uuid::Uuid::new_v4()));
        fs::write(&original, b"disposable native fixture").unwrap();
        let store = fixture.store();
        let entry = store.recycle(&original).unwrap();
        assert_eq!(entry.location, "system");
        assert!(entry.can_restore);
        assert!(!original.exists());
        store.restore(&entry.id).unwrap();
        assert_eq!(fs::read(&original).unwrap(), b"disposable native fixture");
    }
}
