//! Version-bound local attachments and verified restoration shared by both providers.
use super::{
    model::{BackupAsset, RestoredBackup},
    sha256_hex, RemoteSyncClient,
};
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use regex::Regex;
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};

const MAX_ASSETS: usize = 1024;
const MAX_ASSET_BYTES: u64 = 128 * 1024 * 1024;
const MAX_BUNDLE_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug)]
pub struct LocalAsset {
    pub relative_path: String,
    pub bytes: Vec<u8>,
}

/// Portable paths are deliberately stricter than platform-specific paths, so a
/// backup made on Unix cannot write an NTFS stream or reserved device on Windows.
pub fn validate_asset_path(path: &str) -> Result<(), String> {
    if !path.starts_with(".assets/") || path.contains('\\') || path.len() > 4096 {
        return Err("附件路径必须位于文档同级的 .assets 目录".into());
    }
    for part in path.split('/') {
        let device = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with(['.', ' '])
            || part
                .chars()
                .any(|c| c.is_control() || ":<>\"|?*".contains(c))
            || matches!(device.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (device.len() == 4
                && (device.starts_with("COM") || device.starts_with("LPT"))
                && matches!(device.as_bytes()[3], b'1'..=b'9'))
        {
            return Err(format!("不安全的附件路径：{path}"));
        }
    }
    Ok(())
}

fn attachment_reference(raw: &str, embedded: bool) -> Result<Option<String>, String> {
    let raw = raw
        .trim()
        .replace("\\ ", " ")
        .replace("\\(", "(")
        .replace("\\)", ")");
    let without_suffix = raw.split(['?', '#']).next().unwrap_or(&raw);
    let decoded = match urlencoding::decode(without_suffix) {
        Ok(decoded) => decoded,
        Err(_) if raw.contains(".assets") => return Err("附件路径编码无效".into()),
        Err(_) => return Ok(None),
    };
    let decoded = decoded.strip_prefix("./").unwrap_or(&decoded);
    // Absolute paths, remote URLs and assets in other folders are outside the
    // documented scope and never cause arbitrary local files to be uploaded.
    if decoded.starts_with(".assets\\") {
        return Err("附件引用应使用 .assets/ 相对路径".into());
    }
    if !decoded.starts_with(".assets/") {
        let lower = decoded.to_ascii_lowercase();
        let remote_or_embedded = lower.starts_with("http:")
            || lower.starts_with("https:")
            || lower.starts_with("data:")
            || lower.starts_with("//")
            || lower.starts_with('#')
            || lower.starts_with("mailto:")
            || lower.starts_with("tel:");
        let extension = Path::new(decoded)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let resource_extension = !extension.is_empty()
            && !matches!(
                extension.as_str(),
                "md" | "markdown" | "txt" | "html" | "htm"
            );
        if !remote_or_embedded && (embedded || resource_extension || lower.starts_with("file:")) {
            return Err(format!("本地资源未位于文档同级 .assets 目录：{decoded}。请复制到 .assets 并更新引用后重试；本次未发布完整备份"));
        }
        return Ok(None);
    }
    validate_asset_path(decoded)?;
    Ok(Some(decoded.into()))
}

pub fn referenced_paths(text: &str) -> Result<Vec<String>, String> {
    let mut paths = BTreeMap::new();
    let mut add = |raw: &str, embedded: bool| -> Result<(), String> {
        if let Some(path) = attachment_reference(raw, embedded)? {
            let key = path.to_lowercase();
            if let Some(existing) = paths.insert(key, path.clone()) {
                if existing != path {
                    return Err("附件路径大小写冲突，无法跨平台恢复".into());
                }
            }
        }
        Ok(())
    };
    // Markdown syntax needs a parser: nested/escaped alt text, reference links,
    // multiline destinations and code blocks cannot be identified by a URL regex.
    let attributes =
        Regex::new(r#"(?i)\b(src|href|poster)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))"#).unwrap();
    let poster = Regex::new(r#"(?i)\bposter\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s}]+))"#).unwrap();
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS;
    let mut in_code_block = false;
    for (event, range) in Parser::new_ext(text, options).into_offset_iter() {
        match event {
            Event::Start(Tag::CodeBlock(_)) => in_code_block = true,
            Event::End(TagEnd::CodeBlock) => in_code_block = false,
            Event::Start(Tag::Image { dest_url, .. }) => add(&dest_url, true)?,
            Event::Start(Tag::Link { dest_url, .. }) => {
                // @[video](...) and the other editor media directives are
                // ordinary Markdown links preceded by @. Their poster lives
                // in the optional attribute block immediately after the link.
                let media = text[..range.start].ends_with('@')
                    && ["[video]", "[audio]", "[youtube]", "[embed]"]
                        .iter()
                        .any(|label| text[range.clone()].starts_with(label));
                add(&dest_url, media)?;
                if media {
                    let trailing = text[range.end..].trim_start();
                    if let Some(attributes) = trailing
                        .strip_prefix('{')
                        .and_then(|value| value.split_once('}').map(|(attrs, _)| attrs))
                    {
                        for capture in poster.captures_iter(attributes) {
                            if let Some(raw) = capture.iter().skip(1).flatten().next() {
                                add(raw.as_str(), true)?;
                            }
                        }
                    }
                }
            }
            Event::Html(html) | Event::InlineHtml(html) if !in_code_block => {
                for capture in attributes.captures_iter(&html) {
                    if let Some(raw) = capture.iter().skip(2).flatten().next() {
                        add(raw.as_str(), !capture[1].eq_ignore_ascii_case("href"))?;
                    }
                }
            }
            _ => {}
        }
    }
    if paths.len() > MAX_ASSETS {
        return Err("附件超过 1024 个，备份未完成".into());
    }
    Ok(paths.into_values().collect())
}

fn reject_link(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|e| format!("无法检查附件路径 {}：{e}", path.display()))?;
    let mut linked = metadata.file_type().is_symlink();
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        linked |= metadata.file_attributes() & 0x400 != 0; // junction/reparse point
    }
    if linked {
        return Err(format!(
            "附件或恢复路径不能是符号链接/目录联接：{}",
            path.display()
        ));
    }
    Ok(())
}

pub fn collect_assets(
    document_path: &str,
    document_bytes: &[u8],
    encoding: Option<&str>,
) -> Result<Vec<LocalAsset>, String> {
    if document_bytes.len() as u64 > MAX_BUNDLE_BYTES {
        return Err("文档和附件超过 512 MiB，备份未完成".into());
    }
    // Use exactly the editor's selected encoding to resolve resource names.
    let text = crate::text_encoding::decode_text(document_bytes, encoding)
        .map_err(|error| format!("无法解析附件引用，请按正确编码重新打开并保存文档：{error}"))?
        .content;
    let paths = referenced_paths(&text)?;
    let parent = Path::new(document_path).parent().ok_or("文档没有父目录")?;
    let base = fs::canonicalize(parent).map_err(|e| format!("无法定位文档目录：{e}"))?;
    let mut total = document_bytes.len() as u64;
    let mut assets = Vec::new();
    for relative_path in paths {
        let mut path = base.clone();
        for component in relative_path.split('/') {
            path.push(component);
            reject_link(&path)?;
        }
        let actual =
            fs::canonicalize(&path).map_err(|e| format!("附件不存在：{relative_path}：{e}"))?;
        if !actual.starts_with(&base) {
            return Err("附件越过文档目录，备份已停止".into());
        }
        let metadata = fs::metadata(&actual).map_err(|e| e.to_string())?;
        if !metadata.is_file() || metadata.len() > MAX_ASSET_BYTES {
            return Err(format!("附件不是普通文件或超过 128 MiB：{relative_path}"));
        }
        total = total.checked_add(metadata.len()).ok_or("附件大小溢出")?;
        if total > MAX_BUNDLE_BYTES {
            return Err("文档和附件超过 512 MiB，备份未完成".into());
        }
        let bytes = fs::read(&actual).map_err(|e| format!("无法读取附件 {relative_path}：{e}"))?;
        if bytes.len() as u64 != metadata.len() {
            return Err("读取时附件已变化，请重试备份".into());
        }
        assets.push(LocalAsset {
            relative_path,
            bytes,
        });
    }
    Ok(assets)
}

pub fn describe_assets(
    assets: &[LocalAsset],
    versions_dir: &str,
    version_id: &str,
) -> Vec<BackupAsset> {
    assets
        .iter()
        .map(|asset| {
            let sha256 = sha256_hex(&asset.bytes);
            BackupAsset {
                relative_path: asset.relative_path.clone(),
                snapshot_path: format!("{versions_dir}/{version_id}/assets/{sha256}"),
                size: asset.bytes.len() as u64,
                sha256,
            }
        })
        .collect()
}

pub fn bundle_hash(document_hash: &str, assets: &[LocalAsset]) -> String {
    let identities: Vec<_> = assets
        .iter()
        .map(|a| (&a.relative_path, sha256_hex(&a.bytes)))
        .collect();
    sha256_hex(
        &serde_json::to_vec(&("assets-v1", document_hash, identities))
            .expect("serialize bundle identity"),
    )
}

pub fn validate_asset_manifest(
    assets: &[BackupAsset],
    versions_dir: &str,
    version_id: &str,
) -> Result<(), String> {
    if assets.len() > MAX_ASSETS {
        return Err("远端附件数量超限".into());
    }
    let mut seen = std::collections::HashSet::new();
    let mut total = 0u64;
    for asset in assets {
        validate_asset_path(&asset.relative_path)?;
        if !seen.insert(asset.relative_path.to_lowercase()) {
            return Err("远端附件路径重复".into());
        }
        if asset.sha256.len() != 64
            || !asset
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || asset.snapshot_path != format!("{versions_dir}/{version_id}/assets/{}", asset.sha256)
        {
            return Err("远端附件不属于该文档版本的命名空间".into());
        }
        total = total.checked_add(asset.size).ok_or("远端附件大小溢出")?;
        if asset.size > MAX_ASSET_BYTES || total > MAX_BUNDLE_BYTES {
            return Err("远端附件大小超限".into());
        }
    }
    Ok(())
}

pub async fn restore<C: RemoteSyncClient>(
    client: &C,
    filename: &str,
    version: &super::WebDavVersion,
    destination_dir: &str,
) -> Result<RestoredBackup, String> {
    if filename.is_empty()
        || filename.contains(['/', '\\', ':'])
        || filename == "."
        || filename == ".."
        || filename.chars().any(char::is_control)
    {
        return Err("远端文档文件名无效".into());
    }
    validate_asset_path(&format!(".assets/{filename}"))?;
    let filename = filename.to_string();
    let parent = Path::new(destination_dir);
    for ancestor in parent.ancestors() {
        if !ancestor.as_os_str().is_empty() {
            reject_link(ancestor)?;
        }
    }
    let parent = fs::canonicalize(parent).map_err(|e| format!("无法打开恢复目录：{e}"))?;
    let content = client
        .get_optional(&version.snapshot_path)
        .await?
        .ok_or("云端文档快照不存在")?;
    if sha256_hex(&content) != version.sha256 {
        return Err("下载校验失败：文档哈希不一致".into());
    }
    if version.assets.is_some() && content.len() as u64 != version.size {
        return Err("下载校验失败：文档大小不一致".into());
    }
    let total = version
        .assets
        .as_deref()
        .unwrap_or_default()
        .iter()
        .try_fold(content.len() as u64, |total, asset| {
            total.checked_add(asset.size)
        })
        .ok_or("备份大小溢出")?;
    if total > MAX_BUNDLE_BYTES {
        return Err("备份超过 512 MiB，恢复已停止".into());
    }
    if let Some(assets) = &version.assets {
        // Hash validation alone cannot detect a valid manifest that accidentally
        // omits an attachment. Compare the document's actual reference set too.
        let text = crate::text_encoding::decode_text(&content, version.encoding.as_deref())
            .map_err(|error| format!("无法校验文档附件引用：{error}"))?
            .content;
        let expected: std::collections::BTreeSet<_> =
            referenced_paths(&text)?.into_iter().collect();
        let listed: std::collections::BTreeSet<_> = assets
            .iter()
            .map(|asset| asset.relative_path.clone())
            .collect();
        if expected != listed {
            return Err("附件清单与文档引用不一致，恢复已停止".into());
        }
    }
    let mut downloaded = Vec::new();
    for asset in version.assets.as_deref().unwrap_or_default() {
        let bytes = client
            .get_optional(&asset.snapshot_path)
            .await?
            .ok_or_else(|| format!("云端附件缺失：{}", asset.relative_path))?;
        if bytes.len() as u64 != asset.size || sha256_hex(&bytes) != asset.sha256 {
            return Err(format!("下载校验失败：附件 {}", asset.relative_path));
        }
        downloaded.push((asset.relative_path.clone(), bytes));
    }
    // A unique directory plus create_new files prevents accidental overwrite.
    // All downloads validate before a local directory is created.
    let target = parent.join(format!("zeditor-restored-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&target).map_err(|e| format!("无法创建恢复目录：{e}"))?;
    let result = (|| {
        for (relative, bytes) in &downloaded {
            let path = target.join(relative);
            fs::create_dir_all(path.parent().ok_or("附件没有父目录")?)
                .map_err(|e| e.to_string())?;
            write_new(&path, bytes)?;
        }
        let path = target.join(filename);
        write_new(&path, &content)?;
        Ok(RestoredBackup {
            encoding: version.encoding.clone(),
            path: path.to_string_lossy().into_owned(),
            asset_count: downloaded.len(),
            legacy_document_only: version.assets.is_none(),
        })
    })();
    // On an IO failure retain the partial directory for diagnosis; never remove
    // recursively through a path that another process could have replaced.
    result.map_err(|error: String| {
        format!(
            "{error}（恢复目录：{}；可能包含未完成的文件）",
            target.display()
        )
    })
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("恢复文件没有父目录")?;
    for ancestor in parent.ancestors() {
        if !ancestor.as_os_str().is_empty() {
            reject_link(ancestor)?;
        }
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| format!("无法新建恢复文件：{e}"))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| format!("恢复文件写入失败：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn finds_markdown_reference_html_and_encoded_paths_but_ignores_code() {
        let paths = referenced_paths("![a](.assets/a.png)\n![x][x]\n\n[x]: <.assets/中文%20图.png>\n\n<video src='.assets/a.mp4' poster=\".assets/p.png\"></video>\n\n`![code](.assets/no.png)`\n```md\n![code](.assets/no2.png)\n```\n").unwrap();
        assert_eq!(paths.len(), 4);
        assert!(paths.contains(&".assets/中文 图.png".to_string()));
    }

    #[test]
    fn markdown_parser_preserves_nested_escaped_alt_and_used_reference_destinations() {
        let paths = referenced_paths(concat!(
            "![a [b]](.assets/nested.png)\n\n",
            "![escaped \\] alt](.assets/escaped.png)\n\n",
            "![ref][picture] and [download][file]\n\n",
            "[picture]: <.assets/reference image.png>\n",
            "[file]: .assets/report.pdf\n",
            "[unused]: .assets/not-used.png\n",
        ))
        .unwrap();
        assert_eq!(
            paths,
            vec![
                ".assets/escaped.png",
                ".assets/nested.png",
                ".assets/reference image.png",
                ".assets/report.pdf",
            ]
        );
    }

    #[test]
    fn code_examples_do_not_upload_resources_but_custom_media_includes_posters() {
        let paths = referenced_paths(concat!(
            "    ![indented](.assets/no-indented.png)\n\n",
            "````md\n```\n![fenced](.assets/no-fenced.png)\n````\n\n",
            "`![inline](.assets/no-inline.png)`\n\n",
            "@[video](.assets/movie.mp4){title=\"demo\" poster=\".assets/cover.png\"}\n\n",
            "@[audio](.assets/sound.mp3)\n",
        ))
        .unwrap();
        assert_eq!(
            paths,
            vec![
                ".assets/cover.png",
                ".assets/movie.mp4",
                ".assets/sound.mp3"
            ]
        );
        assert!(
            referenced_paths("@[video](movie){poster=\".assets/cover.png\"}")
                .unwrap_err()
                .contains("未位于")
        );
    }
    #[test]
    fn out_of_scope_local_resources_fail_explicitly_but_note_and_remote_links_remain_links() {
        for text in [
            "![x](images/a.png)",
            "@[video](movie.mp4)",
            "<img src='photo'>",
            "[download](files/report.pdf)",
        ] {
            assert!(
                referenced_paths(text).unwrap_err().contains("未位于"),
                "{text}"
            );
        }
        assert!(referenced_paths("[note](other.md) [web](https://example.com/a.pdf) ![remote](https://example.com/a.png) ![embedded](data:image/png;base64,abc)").unwrap().is_empty());
    }

    #[test]
    fn rejects_traversal_windows_devices_and_encoded_traversal() {
        for path in [
            ".assets/../secret",
            ".assets/C:stream",
            ".assets/CON.png",
            ".assets/a\\b",
            ".assets/a.",
        ] {
            assert!(validate_asset_path(path).is_err(), "{path}");
        }
        assert!(referenced_paths("![x](.assets/%2e%2e/private)").is_err());
        assert!(referenced_paths("![x](.assets/A.png) ![y](.assets/a.png)").is_err());
    }
    #[test]
    fn missing_asset_is_an_explicit_failure_and_asset_only_changes_change_identity() {
        let root = super::super::test_support::test_temp_dir();
        let note = root.join("note.md");
        let bytes = b"![x](.assets/a.png)";
        assert!(collect_assets(note.to_str().unwrap(), bytes, None).is_err());
        fs::create_dir(root.join(".assets")).unwrap();
        fs::write(root.join(".assets/a.png"), b"one").unwrap();
        let first = collect_assets(note.to_str().unwrap(), bytes, None).unwrap();
        fs::write(root.join(".assets/a.png"), b"two").unwrap();
        let second = collect_assets(note.to_str().unwrap(), bytes, None).unwrap();
        assert_ne!(
            bundle_hash(&sha256_hex(bytes), &first),
            bundle_hash(&sha256_hex(bytes), &second)
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn attachment_namespace_rejects_tampered_paths_duplicates_and_hashes() {
        let bytes = b"one";
        let asset = BackupAsset {
            relative_path: ".assets/a.png".into(),
            snapshot_path: format!("/versions/v/assets/{}", sha256_hex(bytes)),
            size: 3,
            sha256: sha256_hex(bytes),
        };
        assert!(validate_asset_manifest(std::slice::from_ref(&asset), "/versions", "v").is_ok());
        for replacement in [
            "/outside/secret",
            "/versions/other/assets/x",
            "/versions/v/assets/../secret",
        ] {
            let mut changed = asset.clone();
            changed.snapshot_path = replacement.into();
            assert!(validate_asset_manifest(&[changed], "/versions", "v").is_err());
        }
        assert!(validate_asset_manifest(&[asset.clone(), asset], "/versions", "v").is_err());
    }

    #[test]
    fn explicit_legacy_encoding_preserves_non_ascii_attachment_names() {
        let root = super::super::test_support::test_temp_dir();
        let note = root.join("note.md");
        fs::create_dir(root.join(".assets")).unwrap();
        fs::write(root.join(".assets/图.png"), b"image").unwrap();
        let bytes = crate::text_encoding::encode_text("![x](.assets/图.png)", "gbk").unwrap();
        assert!(collect_assets(note.to_str().unwrap(), &bytes, None).is_err());
        let assets = collect_assets(note.to_str().unwrap(), &bytes, Some("gbk")).unwrap();
        assert_eq!(assets.len(), 1);
        assert_eq!(assets[0].bytes, b"image");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn undecodable_document_cannot_claim_an_empty_attachment_bundle() {
        let root = super::super::test_support::test_temp_dir();
        let note = root.join("note.md");
        // A legacy queue without an encoding hint can contain UTF-16. Looking
        // for ASCII `.assets` in undecoded bytes silently misses every resource.
        let bytes = crate::text_encoding::encode_text("![图](.assets/a.png)", "utf-16le").unwrap();
        let error = collect_assets(note.to_str().unwrap(), &bytes, None).unwrap_err();
        assert!(error.contains("编码"));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn attachment_symlinks_cannot_escape_document_directory() {
        let root = super::super::test_support::test_temp_dir();
        let external = super::super::test_support::test_temp_dir();
        fs::write(external.join("private.png"), b"private").unwrap();
        std::os::unix::fs::symlink(&external, root.join(".assets")).unwrap();
        let note = root.join("note.md");
        assert!(
            collect_assets(note.to_str().unwrap(), b"![x](.assets/private.png)", None)
                .unwrap_err()
                .contains("符号链接")
        );
        fs::remove_file(root.join(".assets")).unwrap();
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(external).unwrap();
    }
}
