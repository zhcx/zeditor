//! Images for native DOCX export. Reading is scoped to the saved document's directory.
use base64::Engine;
use std::io::Read;
use std::path::Path;

const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

fn read_local_image(document_path: &str, source: &str) -> Result<String, String> {
    let raw = source.split(['?', '#']).next().unwrap_or("");
    let decoded = urlencoding::decode(raw).map_err(|error| format!("图片路径编码无效：{error}"))?;
    // Also reject drive prefixes, UNC paths, URI schemes and Windows ADS on Unix,
    // so a document cannot become unsafe when opened on another platform.
    if decoded.is_empty()
        || decoded.contains(':')
        || decoded.starts_with(['/', '\\'])
        || decoded.contains('\0')
    {
        return Err("仅可导出当前文档目录内、使用相对路径引用的本地图片。".into());
    }
    let document = std::fs::canonicalize(document_path)
        .map_err(|error| format!("无法定位已保存的文档：{error}"))?;
    if !document.is_file() {
        return Err("文档路径不是文件。".into());
    }
    let directory = document.parent().ok_or("无法定位文档目录。")?;
    let relative = decoded.replace('\\', "/");
    let image = std::fs::canonicalize(directory.join(Path::new(&relative)))
        .map_err(|error| format!("无法读取本地图片：{error}"))?;
    if !image.starts_with(directory) {
        return Err("图片位于文档目录之外，请先复制到文档的 .assets 目录。".into());
    }
    let mime = match image
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        _ => {
            return Err(
                "本地图片格式不受支持，请使用 PNG、JPEG、GIF、BMP、WebP、SVG 或 AVIF。".into(),
            )
        }
    };
    let file = std::fs::File::open(&image).map_err(|error| format!("无法打开本地图片：{error}"))?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_IMAGE_BYTES {
        return Err("图片不是普通文件或超过 20 MiB。".into());
    }
    let mut data = Vec::new();
    file.take(MAX_IMAGE_BYTES + 1)
        .read_to_end(&mut data)
        .map_err(|error| format!("读取图片失败：{error}"))?;
    if data.len() as u64 > MAX_IMAGE_BYTES {
        return Err("图片超过 20 MiB。".into());
    }
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(data)
    ))
}

#[tauri::command]
pub async fn read_export_image(document_path: String, source: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || read_local_image(&document_path, &source))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("zeditor_docx_images_{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(dir.join("docs/.assets")).unwrap();
            std::fs::write(dir.join("docs/note.md"), "# test").unwrap();
            Self(dir)
        }
        fn document(&self) -> String {
            self.0.join("docs/note.md").to_string_lossy().into_owned()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn reads_percent_encoded_asset_and_ignores_query_fragment() {
        let fixture = Fixture::new();
        std::fs::write(fixture.0.join("docs/.assets/中文 图片.png"), b"png bytes").unwrap();
        let result = read_local_image(
            &fixture.document(),
            ".assets/%E4%B8%AD%E6%96%87%20%E5%9B%BE%E7%89%87.png?v=1#image",
        )
        .unwrap();
        assert_eq!(result, "data:image/png;base64,cG5nIGJ5dGVz");
    }

    #[test]
    fn rejects_traversal_schemes_absolute_paths_and_non_images() {
        let fixture = Fixture::new();
        std::fs::write(fixture.0.join("outside.png"), "private").unwrap();
        std::fs::write(fixture.0.join("docs/token.txt"), "private").unwrap();
        for source in [
            "../outside.png",
            "%2e%2e/outside.png",
            "C:/secret.png",
            "file:///secret.png",
            "https://example.com/a.png",
            "//server/a.png",
            "\\\\server\\a.png",
            "token.txt",
            ".assets/x.png:secret",
            "",
        ] {
            assert!(
                read_local_image(&fixture.document(), source).is_err(),
                "accepted {source}"
            );
        }
    }

    #[test]
    fn rejects_missing_oversized_and_directory_images() {
        let fixture = Fixture::new();
        let file = std::fs::File::create(fixture.0.join("docs/.assets/large.png")).unwrap();
        file.set_len(MAX_IMAGE_BYTES + 1).unwrap();
        std::fs::create_dir_all(fixture.0.join("docs/.assets/directory.png")).unwrap();
        for source in [
            ".assets/large.png",
            ".assets/missing.png",
            ".assets/directory.png",
        ] {
            assert!(read_local_image(&fixture.document(), source).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_outside_document_directory() {
        let fixture = Fixture::new();
        std::fs::write(fixture.0.join("outside.png"), "private").unwrap();
        std::os::unix::fs::symlink(
            fixture.0.join("outside.png"),
            fixture.0.join("docs/.assets/link.png"),
        )
        .unwrap();
        assert!(read_local_image(&fixture.document(), ".assets/link.png").is_err());
    }
}
