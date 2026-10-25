use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, BufReader};

const HASH_BUFFER_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileVersion {
    pub size: u64,
    pub sha256: String,
}

impl FileVersion {
    pub fn from_bytes(bytes: &[u8]) -> Self {
        Self {
            size: bytes.len() as u64,
            sha256: hex::encode(Sha256::digest(bytes)),
        }
    }

    pub fn matches_bytes(&self, bytes: &[u8]) -> bool {
        self.size == bytes.len() as u64 && self.sha256 == hex::encode(Sha256::digest(bytes))
    }
}

/// Hash a file incrementally so opening large files never duplicates their
/// entire contents in memory.
async fn hash_file_streaming(path: &str) -> std::io::Result<(u64, String)> {
    let file = tokio::fs::File::open(path).await?;
    let mut reader = BufReader::with_capacity(HASH_BUFFER_BYTES, file);
    let mut buffer = vec![0_u8; HASH_BUFFER_BYTES];
    let mut hasher = Sha256::new();
    let mut total_bytes: u64 = 0;
    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        total_bytes = total_bytes.saturating_add(read as u64);
        hasher.update(&buffer[..read]);
    }
    Ok((total_bytes, hex::encode(hasher.finalize())))
}

pub async fn read_file_version(path: &str) -> Result<Option<FileVersion>, String> {
    match hash_file_streaming(path).await {
        Ok((size, sha256)) => Ok(Some(FileVersion { size, sha256 })),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("无法读取文件版本：{error}")),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SaveIfUnchanged {
    Saved(FileVersion),
    Conflict,
}

/// The shared atomic writer compares disk bytes immediately before replacement,
/// after flushing the temporary file. A missing file also counts as a conflict.
pub async fn save_if_unchanged(
    path: &str,
    expected: &FileVersion,
    bytes: &[u8],
) -> Result<SaveIfUnchanged, String> {
    if !crate::commands::write_file_bytes_atomic_if_unchanged(path, bytes, expected).await? {
        return Ok(SaveIfUnchanged::Conflict);
    }
    Ok(SaveIfUnchanged::Saved(FileVersion::from_bytes(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_changes_when_file_bytes_change() {
        let original = FileVersion::from_bytes(b"before");
        assert!(original.matches_bytes(b"before"));
        assert!(!original.matches_bytes(b"after!"));
    }

    #[tokio::test]
    async fn compare_and_save_preserves_external_content_on_conflict() {
        let root =
            std::env::temp_dir().join(format!("zeditor-file-version-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let path = root.join("note.md");
        tokio::fs::write(&path, b"external edit").await.unwrap();
        let stale = FileVersion::from_bytes(b"original");

        let result = save_if_unchanged(path.to_str().unwrap(), &stale, b"local edit").await;

        assert!(matches!(result.unwrap(), SaveIfUnchanged::Conflict));
        assert_eq!(tokio::fs::read(&path).await.unwrap(), b"external edit");
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn compare_and_save_writes_when_the_baseline_matches() {
        let root =
            std::env::temp_dir().join(format!("zeditor-file-version-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let path = root.join("note.md");
        tokio::fs::write(&path, b"original").await.unwrap();
        let expected = FileVersion::from_bytes(b"original");

        let result = save_if_unchanged(path.to_str().unwrap(), &expected, b"local edit").await;

        assert_eq!(
            result.unwrap(),
            SaveIfUnchanged::Saved(FileVersion::from_bytes(b"local edit"))
        );
        assert_eq!(tokio::fs::read(&path).await.unwrap(), b"local edit");
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn simultaneous_checked_saves_cannot_both_replace_the_same_baseline() {
        let root =
            std::env::temp_dir().join(format!("zeditor-concurrent-save-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let path = root.join("并发文档.md");
        let path = path.to_str().unwrap();
        tokio::fs::create_dir(root.join("子目录")).await.unwrap();
        let alias = root.join("子目录").join("..").join("并发文档.md");
        let alias = alias.to_str().unwrap();
        let original = vec![b'0'; 1024 * 1024];
        let first = vec![b'1'; original.len()];
        let second = vec![b'2'; original.len()];
        let expected = FileVersion::from_bytes(&original);
        for attempt in 0..8 {
            tokio::fs::write(path, &original).await.unwrap();
            let (first_result, second_result) = tokio::join!(
                save_if_unchanged(path, &expected, &first),
                save_if_unchanged(
                    if attempt % 2 == 0 { path } else { alias },
                    &expected,
                    &second
                )
            );
            let results = [first_result.unwrap(), second_result.unwrap()];
            let saved = results
                .iter()
                .filter(|result| matches!(result, SaveIfUnchanged::Saved(_)))
                .count();
            assert_eq!(
                saved, 1,
                "attempt {attempt}: both concurrent saves used the same baseline"
            );
            let bytes = tokio::fs::read(path).await.unwrap();
            assert!(bytes == first || bytes == second);
        }
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn missing_files_have_no_fingerprint() {
        let path =
            std::env::temp_dir().join(format!("zeditor-missing-{}.md", uuid::Uuid::new_v4()));
        assert_eq!(
            read_file_version(path.to_str().unwrap()).await.unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn streaming_hash_matches_in_memory_digest_for_large_files() {
        let root = std::env::temp_dir().join(format!("zeditor-file-hash-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let path = root.join("large.bin");
        let bytes: Vec<u8> = (0..(2 * 1024 * 1024 + 123))
            .map(|index| (index % 251) as u8)
            .collect();
        tokio::fs::write(&path, &bytes).await.unwrap();

        let version = read_file_version(path.to_str().unwrap())
            .await
            .unwrap()
            .expect("file exists");

        assert_eq!(version, FileVersion::from_bytes(&bytes));
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
}
