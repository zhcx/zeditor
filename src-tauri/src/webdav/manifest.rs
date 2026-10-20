use std::{cmp::Ordering, collections::HashSet};

use chrono::{DateTime, Utc};

use super::{
    model::{
        BackupIndex, BackupIndexEntry, DocumentManifest, RemoteDocumentPath, WebDavVersion,
        HISTORY_LIMIT,
    },
    path::{normalize_remote_root, validate_canonical_resource_path},
};

impl DocumentManifest {
    pub fn new(document_id: &str, display_name: &str, current_path: &str) -> Self {
        Self {
            document_id: document_id.to_string(),
            display_name: display_name.to_string(),
            current_path: current_path.to_string(),
            versions: Vec::new(),
        }
    }

    pub fn newest_hash(&self) -> Option<&str> {
        self.versions.first().map(|version| version.sha256.as_str())
    }

    pub fn insert_version(&mut self, version: WebDavVersion) -> Vec<WebDavVersion> {
        self.versions.push(version);
        sort_versions(&mut self.versions);

        let mut retained = Vec::with_capacity(self.versions.len().min(HISTORY_LIMIT));
        let mut pruned = Vec::new();
        let mut version_ids = HashSet::new();
        let mut content_hashes = HashSet::new();
        for candidate in self.versions.drain(..) {
            let is_duplicate = version_ids.contains(&candidate.id)
                || content_hashes.contains(&content_identity(&candidate));
            if is_duplicate || retained.len() == HISTORY_LIMIT {
                pruned.push(candidate);
            } else {
                version_ids.insert(candidate.id.clone());
                content_hashes.insert(content_identity(&candidate));
                retained.push(candidate);
            }
        }
        self.versions = retained;

        let retained_paths: HashSet<_> = self
            .versions
            .iter()
            .map(|version| version.snapshot_path.as_str())
            .collect();
        let mut cleanup_paths = HashSet::new();
        pruned.retain(|version| {
            !retained_paths.contains(version.snapshot_path.as_str())
                && cleanup_paths.insert(version.snapshot_path.clone())
        });
        pruned
    }
}

/// Snapshot locations depend on version IDs, so only relative names and content
/// hashes participate in deduplication. Legacy None stays distinguishable from
/// a verified attachment-free version.
type ContentIdentity = (String, Option<Vec<(String, String, u64)>>);

fn content_identity(version: &WebDavVersion) -> ContentIdentity {
    let assets = version.assets.as_ref().map(|assets| {
        let mut identities: Vec<_> = assets
            .iter()
            .map(|asset| {
                (
                    asset.relative_path.clone(),
                    asset.sha256.clone(),
                    asset.size,
                )
            })
            .collect();
        identities.sort();
        identities
    });
    (version.sha256.clone(), assets)
}

fn sort_versions(versions: &mut [WebDavVersion]) {
    versions.sort_by(|left, right| {
        compare_rfc3339_desc(&left.created_at, &right.created_at)
            .then_with(|| right.id.cmp(&left.id))
            .then_with(|| right.sha256.cmp(&left.sha256))
    });
}

impl BackupIndex {
    pub fn upsert(&mut self, entry: BackupIndexEntry) {
        self.documents.push(entry);
        sort_index_entries(&mut self.documents);
        let mut document_ids = HashSet::new();
        self.documents
            .retain(|candidate| document_ids.insert(candidate.document_id.clone()));
    }
}

fn sort_index_entries(entries: &mut [BackupIndexEntry]) {
    entries.sort_by(|left, right| {
        compare_rfc3339_desc(&left.latest_at, &right.latest_at)
            .then_with(|| left.document_id.cmp(&right.document_id))
    });
}

fn compare_rfc3339_desc(left: &str, right: &str) -> Ordering {
    // Parsed resources reject invalid values. Directly constructed values still receive a
    // deterministic fallback so sorting remains total before they reach a persistence boundary.
    match (parse_utc(left), parse_utc(right)) {
        (Some(left), Some(right)) => right.cmp(&left),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => right.cmp(left),
    }
}

fn parse_utc(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|timestamp| timestamp.with_timezone(&Utc))
}

pub fn parse_manifest(bytes: &[u8]) -> Result<DocumentManifest, String> {
    let mut manifest: DocumentManifest = serde_json::from_slice(bytes)
        .map_err(|error| format!("Invalid WebDAV manifest: {error}"))?;

    for version in &manifest.versions {
        DateTime::parse_from_rfc3339(&version.created_at).map_err(|error| {
            format!(
                "Invalid WebDAV manifest timestamp for version '{}': {error}",
                version.id
            )
        })?;
    }

    sort_versions(&mut manifest.versions);

    Ok(manifest)
}

pub fn parse_index(bytes: &[u8]) -> Result<BackupIndex, String> {
    let mut index: BackupIndex = serde_json::from_slice(bytes)
        .map_err(|error| format!("Invalid WebDAV backup index: {error}"))?;

    for entry in &index.documents {
        DateTime::parse_from_rfc3339(&entry.latest_at).map_err(|error| {
            format!(
                "Invalid WebDAV index timestamp for document '{}': {error}",
                entry.document_id
            )
        })?;
    }

    sort_index_entries(&mut index.documents);
    let mut document_ids = HashSet::new();
    index
        .documents
        .retain(|entry| document_ids.insert(entry.document_id.clone()));

    Ok(index)
}

pub fn validate_manifest_namespace(
    manifest: &DocumentManifest,
    expected: &RemoteDocumentPath,
    remote_root: &str,
) -> Result<(), String> {
    if !is_lower_hex_with_len(&expected.document_id, 24) {
        return Err(
            "Expected WebDAV document ID must be 24 lowercase hexadecimal characters".to_string(),
        );
    }
    if !is_lower_hex_with_len(&manifest.document_id, 24) {
        return Err("Manifest document ID must be 24 lowercase hexadecimal characters".to_string());
    }
    if manifest.document_id != expected.document_id {
        return Err("Manifest document ID does not match the requested document".to_string());
    }

    let remote_root = normalize_remote_root(remote_root)
        .map_err(|error| format!("Invalid WebDAV remote root: {error}"))?;
    let history_root = append_namespace_path(&remote_root, ".zeditor-history");
    let documents_root = append_namespace_path(&history_root, "documents");
    let expected_manifest_path = append_namespace_path(
        &documents_root,
        &format!("{}/manifest.json", expected.document_id),
    );
    let expected_versions_dir = append_namespace_path(
        &documents_root,
        &format!("{}/versions", expected.document_id),
    );

    validate_canonical_remote_path(&expected.current_path, "expected current path")?;
    if !is_strict_descendant(&expected.current_path, &remote_root) {
        return Err("Expected current path is outside the configured remote root".to_string());
    }
    if expected.current_path == history_root
        || expected
            .current_path
            .strip_prefix(&history_root)
            .is_some_and(|suffix| suffix.starts_with('/'))
    {
        return Err("Expected current path must be outside WebDAV history".to_string());
    }
    validate_canonical_remote_path(&expected.manifest_path, "expected manifest path")?;
    if expected.manifest_path != expected_manifest_path {
        return Err("Expected manifest path does not match its document namespace".to_string());
    }
    validate_canonical_remote_path(&expected.versions_dir, "expected versions directory")?;
    if expected.versions_dir != expected_versions_dir {
        return Err(
            "Expected versions directory does not match its document namespace".to_string(),
        );
    }
    if manifest.current_path != expected.current_path {
        return Err("Manifest current path does not match the expected document path".to_string());
    }

    for version in &manifest.versions {
        if !is_lower_hex_with_len(&version.id, 24) {
            return Err(format!(
                "WebDAV version ID '{}' must be 24 lowercase hexadecimal characters",
                version.id
            ));
        }
        if !is_lower_hex_with_len(&version.sha256, 64) {
            return Err(format!(
                "WebDAV version '{}' SHA-256 must be 64 lowercase hexadecimal characters",
                version.id
            ));
        }
        if let Some(assets) = &version.assets {
            super::assets::validate_asset_manifest(assets, &expected.versions_dir, &version.id)?;
        }
        validate_canonical_remote_path(&version.snapshot_path, "version snapshot path")?;
        let Some((parent, basename)) = version.snapshot_path.rsplit_once('/') else {
            return Err(format!(
                "WebDAV version '{}' snapshot path has no parent directory",
                version.id
            ));
        };
        if parent != expected.versions_dir {
            return Err(format!(
                "WebDAV version '{}' snapshot is not a direct child of its versions directory",
                version.id
            ));
        }
        let basename_prefix = format!("{}.", version.id);
        if !basename.starts_with(&basename_prefix) || basename.len() == basename_prefix.len() {
            return Err(format!(
                "WebDAV version '{}' snapshot basename does not match its version ID",
                version.id
            ));
        }
    }

    Ok(())
}

pub fn validate_index_namespace(index: &BackupIndex, remote_root: &str) -> Result<(), String> {
    let remote_root = normalize_remote_root(remote_root)
        .map_err(|error| format!("Invalid WebDAV remote root: {error}"))?;
    let history_root = append_namespace_path(&remote_root, ".zeditor-history");
    let documents_root = append_namespace_path(&history_root, "documents");
    let mut document_ids = HashSet::new();
    let mut current_paths = HashSet::new();
    let mut manifest_paths = HashSet::new();

    for entry in &index.documents {
        if !is_lower_hex_with_len(&entry.document_id, 24) {
            return Err(format!(
                "WebDAV index document ID '{}' must be 24 lowercase hexadecimal characters",
                entry.document_id
            ));
        }
        if !document_ids.insert(entry.document_id.clone()) {
            return Err(format!(
                "WebDAV index contains duplicate document ID '{}'",
                entry.document_id
            ));
        }

        validate_canonical_remote_path(&entry.current_path, "index current path")?;
        if !is_strict_descendant(&entry.current_path, &remote_root) {
            return Err(format!(
                "WebDAV index current path for '{}' is outside the configured remote root",
                entry.document_id
            ));
        }
        if entry.current_path == history_root
            || entry
                .current_path
                .strip_prefix(&history_root)
                .is_some_and(|suffix| suffix.starts_with('/'))
        {
            return Err(format!(
                "WebDAV index current path for '{}' must be outside history",
                entry.document_id
            ));
        }
        if !current_paths.insert(entry.current_path.clone()) {
            return Err(format!(
                "WebDAV index contains duplicate current path for '{}'",
                entry.document_id
            ));
        }

        validate_canonical_remote_path(&entry.manifest_path, "index manifest path")?;
        let expected_manifest_path = append_namespace_path(
            &documents_root,
            &format!("{}/manifest.json", entry.document_id),
        );
        if entry.manifest_path != expected_manifest_path {
            return Err(format!(
                "WebDAV index manifest path for '{}' does not match its document namespace",
                entry.document_id
            ));
        }
        if !manifest_paths.insert(entry.manifest_path.clone()) {
            return Err(format!(
                "WebDAV index contains duplicate manifest path for '{}'",
                entry.document_id
            ));
        }
    }

    Ok(())
}

fn is_lower_hex_with_len(value: &str, expected_len: usize) -> bool {
    value.len() == expected_len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn append_namespace_path(root: &str, suffix: &str) -> String {
    if root == "/" {
        format!("/{suffix}")
    } else {
        format!("{root}/{suffix}")
    }
}

fn validate_canonical_remote_path(path: &str, label: &str) -> Result<(), String> {
    validate_canonical_resource_path(path).map_err(|error| format!("Invalid {label}: {error}"))
}

fn is_strict_descendant(path: &str, root: &str) -> bool {
    if root == "/" {
        path.starts_with('/') && path != "/"
    } else {
        path.strip_prefix(root)
            .is_some_and(|suffix| suffix.starts_with('/'))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn version(id: &str, created_at: &str, sha256: &str, snapshot_path: &str) -> WebDavVersion {
        WebDavVersion {
            id: id.to_string(),
            assets: None,
            encoding: None,
            created_at: created_at.to_string(),
            size: 1,
            sha256: sha256.to_string(),
            snapshot_path: snapshot_path.to_string(),
        }
    }

    fn index_entry(document_id: &str, latest_at: &str) -> BackupIndexEntry {
        BackupIndexEntry {
            document_id: document_id.to_string(),
            display_name: format!("{document_id}.md"),
            current_path: format!("/Zeditor/{document_id}.md"),
            manifest_path: format!("/history/{document_id}/manifest.json"),
            latest_at: latest_at.to_string(),
        }
    }

    fn namespaced_expected_path() -> crate::webdav::RemoteDocumentPath {
        let document_id = "a".repeat(24);
        crate::webdav::RemoteDocumentPath {
            document_id: document_id.clone(),
            display_name: "note.md".to_string(),
            current_path: "/Zeditor/project-1234567890abcdef12345678/note.md".to_string(),
            manifest_path: format!(
                "/Zeditor/.zeditor-history/documents/{document_id}/manifest.json"
            ),
            versions_dir: format!("/Zeditor/.zeditor-history/documents/{document_id}/versions"),
        }
    }

    fn namespaced_manifest() -> DocumentManifest {
        let expected = namespaced_expected_path();
        let version_id = "b".repeat(24);
        DocumentManifest {
            document_id: expected.document_id.clone(),
            display_name: "note.md".to_string(),
            current_path: expected.current_path.clone(),
            versions: vec![version(
                &version_id,
                "2026-08-19T12:00:00Z",
                &"c".repeat(64),
                &format!("{}/{version_id}.md", expected.versions_dir),
            )],
        }
    }

    fn namespaced_index_entry(document_id: &str) -> BackupIndexEntry {
        BackupIndexEntry {
            document_id: document_id.to_string(),
            display_name: "note.md".to_string(),
            current_path: format!("/Zeditor/project-{document_id}/note.md"),
            manifest_path: format!(
                "/Zeditor/.zeditor-history/documents/{document_id}/manifest.json"
            ),
            latest_at: "2026-08-19T12:00:00Z".to_string(),
        }
    }

    #[test]
    fn document_manifest_deduplicates_and_keeps_twenty_newest_versions() {
        let mut manifest = DocumentManifest::new("doc", "note.md", "/Zeditor/notes/note.md");
        let mut limit_pruned = Vec::new();

        for index in 0..21 {
            limit_pruned.extend(manifest.insert_version(WebDavVersion {
                id: format!("v{index:02}"),
                assets: None,
                encoding: None,
                created_at: format!("2026-08-19T12:{index:02}:00Z"),
                size: index,
                sha256: format!("hash-{index}"),
                snapshot_path: format!("/history/v{index:02}.md"),
            }));
        }

        let duplicate = manifest.versions[0].clone();
        manifest.insert_version(duplicate.clone());

        assert_eq!(manifest.versions.len(), 20);
        assert_eq!(manifest.versions[0].id, "v20");
        assert_eq!(
            limit_pruned
                .iter()
                .map(|version| version.id.as_str())
                .collect::<Vec<_>>(),
            vec!["v00"]
        );
        assert_eq!(
            manifest
                .versions
                .iter()
                .filter(|version| version.sha256 == duplicate.sha256)
                .count(),
            1
        );
    }

    #[test]
    fn duplicate_versions_are_returned_for_snapshot_cleanup() {
        let mut manifest = DocumentManifest::new("doc", "note.md", "/Zeditor/note.md");
        let old = version(
            "old",
            "2026-08-19T10:00:00Z",
            "same-hash",
            "/history/old.md",
        );
        manifest.insert_version(old.clone());

        let pruned = manifest.insert_version(version(
            "new",
            "2026-08-19T11:00:00Z",
            "same-hash",
            "/history/new.md",
        ));

        assert_eq!(pruned, vec![old]);
        assert_eq!(manifest.versions[0].id, "new");
    }

    #[test]
    fn older_incoming_duplicate_never_replaces_newer_version() {
        let mut manifest = DocumentManifest::new("doc", "note.md", "/Zeditor/note.md");
        let newer = version(
            "newer",
            "2026-08-19T11:00:00Z",
            "same-hash",
            "/history/newer.md",
        );
        manifest.insert_version(newer.clone());
        let older = version(
            "older",
            "2026-08-19T10:00:00Z",
            "same-hash",
            "/history/older.md",
        );

        let pruned = manifest.insert_version(older.clone());

        assert_eq!(manifest.versions, vec![newer]);
        assert_eq!(pruned, vec![older]);
    }

    #[test]
    fn replacement_does_not_prune_a_reused_snapshot_path() {
        let mut manifest = DocumentManifest::new("doc", "note.md", "/Zeditor/note.md");
        manifest.insert_version(version(
            "same-id",
            "2026-08-19T10:00:00Z",
            "old-hash",
            "/history/shared.md",
        ));

        let pruned = manifest.insert_version(version(
            "same-id",
            "2026-08-19T11:00:00Z",
            "new-hash",
            "/history/shared.md",
        ));

        assert!(pruned.is_empty());
    }

    #[test]
    fn manifest_orders_rfc3339_timestamps_by_utc_instant() {
        let mut manifest = DocumentManifest::new("doc", "note.md", "/Zeditor/note.md");
        manifest.insert_version(version(
            "earlier",
            "2026-08-19T10:30:00+02:00",
            "hash-earlier",
            "/history/earlier.md",
        ));
        manifest.insert_version(version(
            "newer",
            "2026-08-19T09:00:00Z",
            "hash-newer",
            "/history/newer.md",
        ));

        assert_eq!(manifest.versions[0].id, "newer");
        assert_eq!(manifest.newest_hash(), Some("hash-newer"));
    }

    #[test]
    fn backup_index_upsert_replaces_entries_and_orders_by_utc_instant() {
        let mut index = BackupIndex::default();
        index.upsert(index_entry("doc-a", "2026-08-19T08:00:00Z"));
        index.upsert(index_entry("doc-b", "2026-08-19T09:00:00Z"));
        index.upsert(index_entry("doc-a", "2026-08-19T10:30:00+02:00"));

        assert_eq!(index.documents.len(), 2);
        assert_eq!(index.documents[0].document_id, "doc-b");
        assert_eq!(index.documents[1].document_id, "doc-a");
        assert_eq!(index.documents[1].latest_at, "2026-08-19T10:30:00+02:00");
    }

    #[test]
    fn backup_index_upsert_ignores_older_incoming_entry() {
        let mut index = BackupIndex::default();
        index.upsert(index_entry("doc-a", "2026-08-19T11:00:00Z"));
        index.upsert(index_entry("doc-a", "2026-08-19T10:00:00Z"));

        assert_eq!(index.documents.len(), 1);
        assert_eq!(index.documents[0].latest_at, "2026-08-19T11:00:00Z");
    }

    #[test]
    fn malformed_manifest_and_index_json_are_rejected() {
        assert!(parse_manifest(br#"{"document_id": }"#).is_err());
        assert!(parse_index(br#"{"documents": [}"#).is_err());
    }

    #[test]
    fn parse_manifest_sorts_but_preserves_legacy_rows_for_reconciliation() {
        let mut legacy = DocumentManifest::new("doc", "note.md", "/Zeditor/note.md");
        for index in 0..22 {
            legacy.versions.push(version(
                &format!("v{index:02}"),
                &format!("2026-08-19T12:{index:02}:00Z"),
                &format!("hash-{index}"),
                &format!("/history/v{index:02}.md"),
            ));
        }
        legacy.versions.push(version(
            "duplicate-hash",
            "2026-08-19T11:00:00Z",
            "hash-21",
            "/history/duplicate-hash.md",
        ));
        legacy.versions.push(version(
            "v20",
            "2026-08-19T10:00:00Z",
            "duplicate-id-hash",
            "/history/duplicate-id.md",
        ));
        let bytes = serde_json::to_vec(&legacy).expect("legacy manifest JSON");

        let parsed = parse_manifest(&bytes).expect("sorted legacy manifest");

        assert_eq!(parsed.versions.len(), 24);
        assert_eq!(parsed.versions[0].id, "v21");
        assert_eq!(parsed.newest_hash(), Some("hash-21"));
        assert_eq!(
            parsed
                .versions
                .iter()
                .filter(|version| version.id == "v20")
                .count(),
            2
        );
        assert_eq!(
            parsed
                .versions
                .iter()
                .filter(|version| version.sha256 == "hash-21")
                .count(),
            2
        );
    }

    #[test]
    fn next_insert_reconciles_legacy_duplicates_and_over_limit_rows_for_cleanup() {
        let mut legacy = DocumentManifest::new("doc", "note.md", "/Zeditor/note.md");
        for index in 0..21 {
            legacy.versions.push(version(
                &format!("v{index:02}"),
                &format!("2026-08-19T12:{index:02}:00Z"),
                &format!("hash-{index}"),
                &format!("/history/v{index:02}.md"),
            ));
        }
        legacy.versions.push(version(
            "duplicate-hash",
            "2026-08-19T11:00:00Z",
            "hash-20",
            "/history/duplicate-hash.md",
        ));
        let bytes = serde_json::to_vec(&legacy).expect("legacy manifest JSON");
        let mut parsed = parse_manifest(&bytes).expect("preserved legacy manifest");
        assert_eq!(parsed.versions.len(), 22);

        let pruned = parsed.insert_version(version(
            "v21",
            "2026-08-19T12:21:00Z",
            "hash-21",
            "/history/v21.md",
        ));
        let cleanup_paths: HashSet<_> = pruned
            .iter()
            .map(|version| version.snapshot_path.as_str())
            .collect();

        assert_eq!(parsed.versions.len(), HISTORY_LIMIT);
        assert_eq!(parsed.versions[0].id, "v21");
        assert_eq!(
            cleanup_paths,
            HashSet::from([
                "/history/duplicate-hash.md",
                "/history/v00.md",
                "/history/v01.md",
            ])
        );
    }

    #[test]
    fn parse_index_restores_sort_and_document_deduplication_invariants() {
        let legacy = BackupIndex {
            documents: vec![
                index_entry("doc-a", "2026-08-19T08:00:00Z"),
                index_entry("doc-b", "2026-08-19T09:00:00Z"),
                index_entry("doc-a", "2026-08-19T10:30:00+02:00"),
            ],
        };
        let bytes = serde_json::to_vec(&legacy).expect("legacy index JSON");

        let parsed = parse_index(&bytes).expect("normalized legacy index");

        assert_eq!(parsed.documents.len(), 2);
        assert_eq!(parsed.documents[0].document_id, "doc-b");
        assert_eq!(parsed.documents[1].document_id, "doc-a");
        assert_eq!(parsed.documents[1].latest_at, "2026-08-19T10:30:00+02:00");
    }

    #[test]
    fn parse_rejects_invalid_timestamps_with_document_context() {
        let mut manifest = DocumentManifest::new("doc", "note.md", "/Zeditor/note.md");
        manifest.versions.push(version(
            "bad-version",
            "not-rfc3339",
            "hash",
            "/history/bad.md",
        ));
        let manifest_error = parse_manifest(
            &serde_json::to_vec(&manifest).expect("invalid timestamp manifest JSON"),
        )
        .expect_err("invalid manifest timestamp");

        let index = BackupIndex {
            documents: vec![index_entry("bad-document", "not-rfc3339")],
        };
        let index_error =
            parse_index(&serde_json::to_vec(&index).expect("invalid timestamp index JSON"))
                .expect_err("invalid index timestamp");

        assert!(manifest_error.contains("bad-version"));
        assert!(manifest_error.contains("timestamp"));
        assert!(index_error.contains("bad-document"));
        assert!(index_error.contains("timestamp"));
    }

    #[test]
    fn persisted_manifest_namespace_accepts_generated_layout() {
        let expected = namespaced_expected_path();
        let bytes = serde_json::to_vec(&namespaced_manifest()).expect("manifest JSON");
        let manifest = parse_manifest(&bytes).expect("parsed manifest");

        validate_manifest_namespace(&manifest, &expected, "/Zeditor")
            .expect("valid manifest round trip");
    }

    #[test]
    fn persisted_manifest_namespace_rejects_tampered_ids_and_hashes() {
        let expected = namespaced_expected_path();
        let valid = namespaced_manifest();

        let mut mismatched_document = valid.clone();
        mismatched_document.document_id = "d".repeat(24);
        assert!(validate_manifest_namespace(&mismatched_document, &expected, "/Zeditor").is_err());

        let mut malformed_document = valid.clone();
        malformed_document.document_id = "not-a-document-id".to_string();
        assert!(validate_manifest_namespace(&malformed_document, &expected, "/Zeditor").is_err());

        let mut malformed_version = valid.clone();
        malformed_version.versions[0].id = "not-a-version-id".to_string();
        assert!(validate_manifest_namespace(&malformed_version, &expected, "/Zeditor").is_err());

        let mut uppercase_version = valid.clone();
        uppercase_version.versions[0].id = "B".repeat(24);
        assert!(validate_manifest_namespace(&uppercase_version, &expected, "/Zeditor").is_err());

        let mut malformed_hash = valid.clone();
        malformed_hash.versions[0].sha256 = "not-a-sha256".to_string();
        assert!(validate_manifest_namespace(&malformed_hash, &expected, "/Zeditor").is_err());

        let mut uppercase_hash = valid.clone();
        uppercase_hash.versions[0].sha256 = "C".repeat(64);
        assert!(validate_manifest_namespace(&uppercase_hash, &expected, "/Zeditor").is_err());
    }

    #[test]
    fn persisted_manifest_namespace_rejects_tampered_current_paths() {
        let expected = namespaced_expected_path();
        let valid = namespaced_manifest();
        for current_path in [
            "/Zeditor/project/../note.md",
            "/Zeditor/note.md?download=1",
            "/Zeditor/note.md#fragment",
            "/Zeditor/.zeditor-history/documents/hidden.md",
            "/Elsewhere/note.md",
            "/Zeditor/project-1234567890abcdef12345678/sibling.md",
        ] {
            let mut tampered = valid.clone();
            tampered.current_path = current_path.to_string();
            assert!(
                validate_manifest_namespace(&tampered, &expected, "/Zeditor").is_err(),
                "accepted current path {current_path}"
            );
        }
    }

    #[test]
    fn persisted_manifest_namespace_rejects_tampered_snapshot_paths() {
        let expected = namespaced_expected_path();
        let valid = namespaced_manifest();
        let expected_prefix = format!(
            "/Zeditor/.zeditor-history/documents/{}/versions",
            valid.document_id
        );
        for snapshot_path in [
            format!("{expected_prefix}/../outside.md"),
            format!("{expected_prefix}/snapshot.md?download=1"),
            format!("{expected_prefix}/snapshot.md#fragment"),
            format!(
                "/Zeditor/.zeditor-history/documents/{}/versions/snapshot.md",
                "d".repeat(24)
            ),
            "/Elsewhere/snapshot.md".to_string(),
        ] {
            let mut tampered = valid.clone();
            tampered.versions[0].snapshot_path = snapshot_path.clone();
            assert!(
                validate_manifest_namespace(&tampered, &expected, "/Zeditor").is_err(),
                "accepted snapshot path {snapshot_path}"
            );
        }
    }

    #[test]
    fn persisted_manifest_namespace_binds_each_version_to_its_direct_snapshot() {
        let expected = namespaced_expected_path();
        let valid = namespaced_manifest();
        let version_id = valid.versions[0].id.clone();
        let other_version_id = "d".repeat(24);
        for snapshot_path in [
            format!("{}/{other_version_id}.md", expected.versions_dir),
            format!("{}/{version_id}/nested.md", expected.versions_dir),
            format!("{}/not-{version_id}.md", expected.versions_dir),
        ] {
            let mut tampered = valid.clone();
            tampered.versions[0].snapshot_path = snapshot_path.clone();
            assert!(
                validate_manifest_namespace(&tampered, &expected, "/Zeditor").is_err(),
                "accepted snapshot binding {snapshot_path}"
            );
        }
    }

    #[test]
    fn persisted_manifest_namespace_rejects_tampered_expected_paths() {
        let manifest = namespaced_manifest();

        let mut current = namespaced_expected_path();
        current.current_path.push_str("?download=1");
        assert!(validate_manifest_namespace(&manifest, &current, "/Zeditor").is_err());

        let mut manifest_path = namespaced_expected_path();
        manifest_path.manifest_path = "/Elsewhere/manifest.json".to_string();
        assert!(validate_manifest_namespace(&manifest, &manifest_path, "/Zeditor").is_err());

        let mut versions_dir = namespaced_expected_path();
        versions_dir.versions_dir.push_str("/nested");
        assert!(validate_manifest_namespace(&manifest, &versions_dir, "/Zeditor").is_err());
    }

    #[test]
    fn persisted_index_namespace_accepts_valid_round_trip() {
        let index = BackupIndex {
            documents: vec![namespaced_index_entry(&"a".repeat(24))],
        };
        let bytes = serde_json::to_vec(&index).expect("index JSON");
        let parsed = parse_index(&bytes).expect("parsed index");

        validate_index_namespace(&parsed, "/Zeditor").expect("valid index namespace");
    }

    #[test]
    fn persisted_index_namespace_rejects_redirected_manifest_path() {
        let mut entry = namespaced_index_entry(&"a".repeat(24));
        entry.manifest_path = "/Elsewhere/manifest.json".to_string();
        let index = BackupIndex {
            documents: vec![entry],
        };

        assert!(validate_index_namespace(&index, "/Zeditor").is_err());
    }

    #[test]
    fn persisted_index_namespace_rejects_malformed_or_uppercase_document_id() {
        for document_id in ["short".to_string(), "A".repeat(24)] {
            let index = BackupIndex {
                documents: vec![namespaced_index_entry(&document_id)],
            };
            assert!(
                validate_index_namespace(&index, "/Zeditor").is_err(),
                "accepted document ID {document_id}"
            );
        }
    }

    #[test]
    fn persisted_index_namespace_rejects_current_path_outside_current_namespace() {
        let valid = namespaced_index_entry(&"a".repeat(24));
        for current_path in [
            "/Zeditor/.zeditor-history/current.md",
            "/Elsewhere/note.md",
            "/Zeditor/project/../note.md",
            "/Zeditor/note.md?download=1",
            "/Zeditor/note.md#fragment",
        ] {
            let mut entry = valid.clone();
            entry.current_path = current_path.to_string();
            let index = BackupIndex {
                documents: vec![entry],
            };
            assert!(
                validate_index_namespace(&index, "/Zeditor").is_err(),
                "accepted current path {current_path}"
            );
        }
    }

    #[test]
    fn persisted_index_namespace_rejects_duplicate_or_mismatched_entries() {
        let first = namespaced_index_entry(&"a".repeat(24));
        let duplicate = first.clone();
        assert!(validate_index_namespace(
            &BackupIndex {
                documents: vec![first.clone(), duplicate],
            },
            "/Zeditor"
        )
        .is_err());

        let mut mismatched = namespaced_index_entry(&"b".repeat(24));
        mismatched.manifest_path = first.manifest_path.clone();
        assert!(validate_index_namespace(
            &BackupIndex {
                documents: vec![first, mismatched],
            },
            "/Zeditor"
        )
        .is_err());
    }

    #[test]
    fn mapper_resources_with_encoded_data_round_trip_through_namespace_validation() {
        let expected = crate::webdav::map_remote_document(
            "/work/报告 #? 100% foo\\bar.md",
            &["/work".to_string()],
            "/Zeditor",
        )
        .expect("mapped encoded resource");
        for encoded in ["%23", "%3F", "%25", "%20", "%E6", "%5C"] {
            assert!(
                expected.current_path.contains(encoded),
                "missing encoded data {encoded}"
            );
        }

        let version_id = "b".repeat(24);
        let manifest = DocumentManifest {
            document_id: expected.document_id.clone(),
            display_name: expected.display_name.clone(),
            current_path: expected.current_path.clone(),
            versions: vec![version(
                &version_id,
                "2026-08-19T12:00:00Z",
                &"c".repeat(64),
                &format!("{}/{version_id}.md", expected.versions_dir),
            )],
        };
        let index = BackupIndex {
            documents: vec![BackupIndexEntry {
                document_id: expected.document_id.clone(),
                display_name: expected.display_name.clone(),
                current_path: expected.current_path.clone(),
                manifest_path: expected.manifest_path.clone(),
                latest_at: "2026-08-19T12:00:00Z".to_string(),
            }],
        };

        validate_manifest_namespace(&manifest, &expected, "/Zeditor")
            .expect("encoded manifest namespace");
        validate_index_namespace(&index, "/Zeditor").expect("encoded index namespace");
    }

    #[test]
    fn mapper_resources_with_literal_percent_filename_round_trip_through_namespace_validation() {
        let expected = crate::webdav::map_remote_document(
            "/work/foo%20bar.md",
            &["/work".to_string()],
            "/Zeditor",
        )
        .expect("mapped literal percent resource");

        assert!(expected.current_path.ends_with("/foo%2520bar.md"));

        let version_id = "b".repeat(24);
        let manifest = DocumentManifest {
            document_id: expected.document_id.clone(),
            display_name: expected.display_name.clone(),
            current_path: expected.current_path.clone(),
            versions: vec![version(
                &version_id,
                "2026-08-19T12:00:00Z",
                &"c".repeat(64),
                &format!("{}/{version_id}.md", expected.versions_dir),
            )],
        };
        let index = BackupIndex {
            documents: vec![BackupIndexEntry {
                document_id: expected.document_id.clone(),
                display_name: expected.display_name.clone(),
                current_path: expected.current_path.clone(),
                manifest_path: expected.manifest_path.clone(),
                latest_at: "2026-08-19T12:00:00Z".to_string(),
            }],
        };

        validate_manifest_namespace(&manifest, &expected, "/Zeditor")
            .expect("literal percent manifest namespace");
        validate_index_namespace(&index, "/Zeditor").expect("literal percent index namespace");
    }

    #[test]
    fn generated_resource_validation_rejects_unsafe_or_noncanonical_encodings() {
        let valid_expected = namespaced_expected_path();
        let valid_manifest = namespaced_manifest();
        let valid_index_entry = namespaced_index_entry(&valid_expected.document_id);
        for current_path in [
            "/Zeditor/raw?query.md",
            "/Zeditor/raw#fragment.md",
            "/Zeditor/file%2Fchild.md",
            "/Zeditor/%2E%2E/note.md",
            "/Zeditor/file%GG.md",
            "/Zeditor/%41.md",
        ] {
            let mut expected = valid_expected.clone();
            expected.current_path = current_path.to_string();
            let mut manifest = valid_manifest.clone();
            manifest.current_path = current_path.to_string();
            assert!(
                validate_manifest_namespace(&manifest, &expected, "/Zeditor").is_err(),
                "manifest accepted resource {current_path}"
            );

            let mut entry = valid_index_entry.clone();
            entry.current_path = current_path.to_string();
            assert!(
                validate_index_namespace(
                    &BackupIndex {
                        documents: vec![entry],
                    },
                    "/Zeditor"
                )
                .is_err(),
                "index accepted resource {current_path}"
            );
        }
    }
}
