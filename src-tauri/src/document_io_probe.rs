//! Opt-in measurements of the real command paths on disposable filesystem fixtures.
//! Run with `cargo test --bin zeditor document_io_probe::benchmark -- --ignored --nocapture`.
//! Measurements use a warm filesystem cache and include durable atomic replacement.

use std::{fs, path::PathBuf, time::Instant};

use crate::{file_version::FileVersion, text_encoding::encode_text};

struct Fixtures(PathBuf);

impl Fixtures {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("zeditor-io-probe-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
}

impl Drop for Fixtures {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn median_ms(samples: &mut [f64]) -> f64 {
    samples.sort_by(f64::total_cmp);
    samples[samples.len() / 2]
}

#[tokio::test]
async fn media_resolution_preserves_imported_literal_hash_and_percent_names() {
    let fixtures = Fixtures::new();
    fs::create_dir(fixtures.0.join(".assets")).unwrap();
    let document = fixtures.0.join("note.md");
    let names = ["clip#1.mp4", "clip%20v1.mp4", "clip v1.mp4"];
    for name in names {
        fs::write(fixtures.0.join(".assets").join(name), name).unwrap();
    }
    let sources = names.map(|name| format!(".assets/{name}")).to_vec();
    let resolved =
        super::resolve_media_sources(document.to_string_lossy().into_owned(), sources, None)
            .await
            .unwrap();
    for (index, name) in names.iter().enumerate() {
        assert_eq!(
            resolved[index],
            Some(super::path_without_verbatim_prefix(
                &fixtures.0.join(format!(".assets/{name}"))
            ))
        );
        assert_eq!(
            fs::read(resolved[index].as_ref().unwrap()).unwrap(),
            name.as_bytes()
        );
    }
}

#[tokio::test]
async fn media_resolution_decodes_markdown_paths_once_and_preserves_exact_files() {
    let fixtures = Fixtures::new();
    fs::create_dir(fixtures.0.join(".assets")).unwrap();
    let document = fixtures.0.join("note.md");
    fs::write(&document, "![图](<.assets/中文 图#.png>)").unwrap();
    let image = fixtures.0.join(".assets/中文 图#.png");
    fs::write(&image, b"exact image").unwrap();
    let percent = fixtures.0.join(".assets/100%20.png");
    fs::write(&percent, b"literal percent").unwrap();
    let space = fixtures.0.join(".assets/100 .png");
    fs::write(&space, b"space filename").unwrap();
    let absolute_url = format!(
        "{}/%E4%B8%AD%E6%96%87%20%E5%9B%BE%23.png",
        image.parent().unwrap().to_string_lossy().replace('\\', "/")
    );
    let resolved = super::resolve_media_sources(
        document.to_string_lossy().into_owned(),
        vec![
            ".assets/%E4%B8%AD%E6%96%87%20%E5%9B%BE%23.png?v=1#preview".into(),
            ".assets/100%2520.png".into(),
            "%2F%2Fserver/private.png".into(),
            ".assets/100%20.png".into(),
            absolute_url,
        ],
        Some(true),
    )
    .await
    .unwrap();
    assert_eq!(
        resolved[0],
        Some(super::path_without_verbatim_prefix(&image))
    );
    assert_eq!(
        resolved[1],
        Some(super::path_without_verbatim_prefix(&percent))
    );
    assert_eq!(resolved[2], None);
    assert_eq!(
        resolved[3],
        Some(super::path_without_verbatim_prefix(&space))
    );
    assert_eq!(PathBuf::from(resolved[4].as_ref().unwrap()), image);
}

#[tokio::test]
async fn checked_save_preserves_exact_encoding_bytes_and_unicode_paths() {
    let fixtures = Fixtures::new();
    let path = fixtures.0.join("文档 café #1.md");
    let path = path.to_str().unwrap().to_owned();
    for (encoding, text) in [
        ("utf-8", "中文 😀\r\n"),
        ("utf-8-bom", "中文 😀\r\n"),
        ("utf-16le-bom", "中文 😀\r\n"),
        ("utf-16be", "中文 😀\r\n"),
        ("gb18030", "中文 😀\r\n"),
        ("gbk", "中文\r\n"),
        ("windows-1252", "café €\r\n"),
    ] {
        let initial = encode_text("original\r\n", encoding).unwrap();
        fs::write(&path, &initial).unwrap();
        let saved = super::save_file_content_checked(
            path.clone(),
            text.into(),
            Some(encoding.into()),
            Some(FileVersion::from_bytes(&initial)),
        )
        .await
        .unwrap();
        let expected = encode_text(text, encoding).unwrap();
        assert_eq!(saved.status, "saved");
        assert_eq!(saved.file_version, Some(FileVersion::from_bytes(&expected)));
        assert_eq!(fs::read(&path).unwrap(), expected, "{encoding}");
    }
    assert_eq!(fs::read_dir(&fixtures.0).unwrap().count(), 1);
}

#[tokio::test]
async fn checked_save_rejects_readonly_and_encoding_errors_without_touching_bytes() {
    let fixtures = Fixtures::new();
    let path = fixtures.0.join("只读.md");
    fs::write(&path, b"original").unwrap();
    let original_permissions = fs::metadata(&path).unwrap().permissions();
    let mut readonly = original_permissions.clone();
    readonly.set_readonly(true);
    fs::set_permissions(&path, readonly).unwrap();
    let result = super::save_file_content_checked(
        path.to_str().unwrap().into(),
        "changed".into(),
        None,
        Some(FileVersion::from_bytes(b"original")),
    )
    .await;
    fs::set_permissions(&path, original_permissions).unwrap();
    assert!(result.is_err());
    assert_eq!(fs::read(&path).unwrap(), b"original");
    let result = super::save_file_content_checked(
        path.to_str().unwrap().into(),
        "😀".into(),
        Some("gbk".into()),
        Some(FileVersion::from_bytes(b"original")),
    )
    .await;
    assert!(result.is_err());
    assert_eq!(fs::read(&path).unwrap(), b"original");
    assert_eq!(fs::read_dir(&fixtures.0).unwrap().count(), 1);
}

#[tokio::test]
async fn checked_save_reports_same_length_external_edits_and_missing_files() {
    let fixtures = Fixtures::new();
    let path = fixtures.0.join("external.md");
    fs::write(&path, b"external").unwrap();
    let result = super::save_file_content_checked(
        path.to_str().unwrap().into(),
        "my edits".into(),
        None,
        Some(FileVersion::from_bytes(b"original")),
    )
    .await
    .unwrap();
    assert_eq!(result.status, "conflict");
    assert!(result.disk_exists);
    assert_eq!(result.current.unwrap().content, "external");
    assert_eq!(
        result.file_version,
        Some(FileVersion::from_bytes(b"external"))
    );
    assert_eq!(fs::read(&path).unwrap(), b"external");
    fs::remove_file(&path).unwrap();
    let result = super::save_file_content_checked(
        path.to_str().unwrap().into(),
        "my edits".into(),
        None,
        Some(FileVersion::from_bytes(b"original")),
    )
    .await
    .unwrap();
    assert_eq!(result.status, "conflict");
    assert!(!result.disk_exists);
    assert!(result.current.is_none());
    assert!(result.file_version.is_none());
    assert!(!path.exists());
}

#[tokio::test]
#[ignore = "opt-in real filesystem benchmark; run on the same machine before and after changes"]
async fn benchmark_document_open_and_checked_save() {
    let fixtures = Fixtures::new();
    let iterations = std::env::var("ZEDITOR_IO_PROBE_ITERATIONS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(11)
        .clamp(3, 101);
    let profile = if cfg!(debug_assertions) {
        "debug"
    } else {
        "release"
    };
    println!("DOCUMENT_IO_PROBE iterations={iterations} warm_cache=true profile={profile}");
    println!("encoding,utf8_bytes,disk_bytes,open_median_ms,checked_save_median_ms");
    for size in [100_usize * 1024, 1024 * 1024, 5 * 1024 * 1024] {
        let line = "# 文档性能核验\r\n中文 mixed café 😀 1234567890\r\n";
        let content = line.repeat(size.div_ceil(line.len()));
        // Keep the same byte count/encoding across each measured save while changing content.
        let updated = content.replace('1', "2");
        for encoding in ["utf-8", "utf-8-bom", "utf-16le-bom", "gb18030"] {
            let path = fixtures.0.join(format!("中文文档-{size}-{encoding}.md"));
            let original_bytes = encode_text(&content, encoding).unwrap();
            let updated_bytes = encode_text(&updated, encoding).unwrap();
            fs::write(&path, &original_bytes).unwrap();
            let path_string = path.to_str().unwrap().to_owned();
            let mut open = Vec::with_capacity(iterations);
            let mut save = Vec::with_capacity(iterations);
            // One unmeasured iteration primes command/runtime/filesystem code paths.
            for index in 0..=iterations {
                let start = Instant::now();
                let document =
                    super::read_text_document(path_string.clone(), Some(encoding.into()))
                        .await
                        .unwrap();
                let open_ms = start.elapsed().as_secs_f64() * 1000.0;
                let (expected_content, target_content, target_bytes) = if index % 2 == 0 {
                    (&content, &updated, &updated_bytes)
                } else {
                    (&updated, &content, &original_bytes)
                };
                assert_eq!(document.content, *expected_content);
                assert_eq!(document.encoding, encoding);
                let disk = fs::read(&path).unwrap();
                assert_eq!(document.file_version, Some(FileVersion::from_bytes(&disk)));
                let start = Instant::now();
                let result = super::save_file_content_checked(
                    path_string.clone(),
                    target_content.to_owned(),
                    Some(encoding.into()),
                    document.file_version,
                )
                .await
                .unwrap();
                let save_ms = start.elapsed().as_secs_f64() * 1000.0;
                assert_eq!(result.status, "saved");
                assert_eq!(
                    result.file_version,
                    Some(FileVersion::from_bytes(target_bytes))
                );
                assert_eq!(fs::read(&path).unwrap(), *target_bytes);
                if index > 0 {
                    open.push(open_ms);
                    save.push(save_ms);
                }
            }
            println!(
                "{encoding},{},{},{:.3},{:.3}",
                content.len(),
                original_bytes.len(),
                median_ms(&mut open),
                median_ms(&mut save)
            );
        }
    }
}
