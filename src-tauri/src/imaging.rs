// 共享的 HTML 资源处理工具：本地图片内嵌（导出 HTML/Word/PDF 复用）
// 以及 file:// URL 的百分号编码。
// 从 pdf/chrome.rs 与 commands.rs 的两份重复实现合并而来；此处保留
// chrome.rs 的版本（先截断 <img> 标签体再匹配 src，避免跨标签误匹配）。
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use base64::Engine;

fn unescape_image_attribute(source: &str) -> std::borrow::Cow<'_, str> {
    static REFERENCES: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"&(?:amp|quot|apos|lt|gt|#[xX][0-9a-fA-F]+|#[0-9]+);").unwrap()
    });
    REFERENCES.replace_all(source, |capture: &regex::Captures<'_>| {
        let entity = &capture[0];
        match entity {
            "&amp;" => "&".into(),
            "&quot;" => "\"".into(),
            "&apos;" => "'".into(),
            "&lt;" => "<".into(),
            "&gt;" => ">".into(),
            _ => {
                let digits = &entity[2..entity.len() - 1];
                let code = if digits.starts_with(['x', 'X']) {
                    u32::from_str_radix(&digits[1..], 16)
                } else {
                    digits.parse()
                };
                code.ok()
                    .and_then(char::from_u32)
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| entity.to_owned())
            }
        }
    })
}

/// 将 HTML 中引用的本地图片替换为 base64 data URL。
pub(crate) fn embed_images(html: &str, md_file_path: Option<&str>) -> String {
    let mut result = String::with_capacity(html.len());
    let mut rest = html;
    let base_dir = md_file_path
        .and_then(|md| Path::new(md).parent())
        .map(Path::to_path_buf);
    let mut image_cache: HashMap<PathBuf, Option<String>> = HashMap::new();

    loop {
        let tag_start = match rest.find("<img") {
            Some(i) => i,
            None => {
                result.push_str(rest);
                break;
            }
        };
        result.push_str(&rest[..tag_start]);
        let after_tag = &rest[tag_start..];

        let tag_end = match after_tag.find('>') {
            Some(i) => i + 1,
            None => {
                result.push_str(after_tag);
                break;
            }
        };
        let tag = &after_tag[..tag_end];

        if let Some((src_key, src_end)) = find_img_src_range(tag) {
            let src_val = &tag[src_key..src_end];
            if let Some(data_url) =
                resolve_image_src(base_dir.as_deref(), src_val, &mut image_cache)
            {
                result.push_str(&tag[..src_key]);
                result.push_str(&data_url);
                result.push_str(&tag[src_end..]);
            } else {
                result.push_str(tag);
            }
        } else {
            result.push_str(tag);
        }

        rest = &after_tag[tag_end..];
    }
    result
}

/// 在单个 <img ...> 标签体内定位 src 属性值（支持单/双引号）。
fn find_img_src_range(tag: &str) -> Option<(usize, usize)> {
    for quote in ['"', '\''] {
        let pattern = if quote == '"' { "src=\"" } else { "src='" };
        if let Some(start) = tag.find(pattern) {
            let value_start = start + pattern.len();
            let value_end = tag[value_start..]
                .find(quote)
                .map(|index| value_start + index)?;
            return Some((value_start, value_end));
        }
    }
    None
}

fn resolve_image_src(
    base_dir: Option<&Path>,
    src: &str,
    image_cache: &mut HashMap<PathBuf, Option<String>>,
) -> Option<String> {
    if src.starts_with("http://") || src.starts_with("https://") || src.starts_with("data:") {
        return None;
    }

    let source = unescape_image_attribute(src);
    let path = source.split(['?', '#']).next()?;
    let decoded = urlencoding::decode(path).ok()?;
    if decoded.starts_with(['\\']) || decoded.starts_with("//") || decoded.contains("://") {
        return None;
    }
    let p = std::path::Path::new(decoded.as_ref());
    let resolved = if p.is_absolute() {
        p.to_path_buf()
    } else {
        let base_dir = base_dir?;
        base_dir.join(p)
    };
    let cache_key = std::fs::canonicalize(&resolved).unwrap_or(resolved);

    if let Some(cached) = image_cache.get(&cache_key) {
        return cached.clone();
    }

    if !cache_key.exists() {
        image_cache.insert(cache_key, None);
        return None;
    }

    let data = match std::fs::read(&cache_key) {
        Ok(data) => data,
        Err(_) => {
            image_cache.insert(cache_key, None);
            return None;
        }
    };
    let mime = guess_mime(&cache_key);
    let data_url = format!(
        "data:{};base64,{}",
        mime,
        base64::engine::general_purpose::STANDARD.encode(&data)
    );
    image_cache.insert(cache_key, Some(data_url.clone()));
    Some(data_url)
}

pub(crate) fn guess_mime(p: &Path) -> &'static str {
    match p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => "image/png",
    }
}

/// 把本地路径转换为合法的 file:// URL（含百分号编码）。
/// Windows 路径中的空格、#、中文等字符必须编码，否则 Chrome 无法打开。
pub(crate) fn file_url_from_path(path: &Path) -> String {
    let mut path = path.to_string_lossy().replace('\\', "/");
    if !path.starts_with('/') {
        path = format!("/{path}");
    }
    format!("file://{}", encode_file_url_path(&path))
}

fn encode_file_url_path(path: &str) -> String {
    let mut encoded = String::with_capacity(path.len());
    for byte in path.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b':' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_url_from_path_encodes_spaces_and_unicode() {
        let url = file_url_from_path(Path::new(r"C:\Temp Dir\中文.html"));

        assert_eq!(url, "file:///C:/Temp%20Dir/%E4%B8%AD%E6%96%87.html");
    }

    #[test]
    fn embed_images_continues_after_img_without_src() {
        let temp_dir =
            std::env::temp_dir().join(format!("zeditor_pdf_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let image_path = temp_dir.join("image.png");
        std::fs::write(&image_path, [0_u8, 1, 2, 3]).unwrap();

        let md_path = temp_dir.join("doc.md");
        let html = r#"<p>A</p><img alt="cover"><p>B</p><img src="image.png"><p>C</p>"#;
        let output = embed_images(html, Some(&md_path.to_string_lossy()));

        assert!(output.contains(r#"<img alt="cover">"#));
        assert!(output.contains("data:image/png;base64,AAECAw=="));
        assert!(output.contains("<p>C</p>"));

        std::fs::remove_dir_all(temp_dir).ok();
    }

    #[test]
    fn embed_images_does_not_match_src_across_tags() {
        // 回归测试：src 的匹配不得越过标签结束符。
        // 旧实现（commands.rs 版本）会错误地匹配到后续 <video> 的 src。
        let html = r#"<p><img></p><video src="clip.mp4"></video>"#;
        let output = embed_images(html, None);

        assert_eq!(output, html);
    }

    #[test]
    fn embeds_uri_encoded_cjk_and_html_escaped_local_image_paths() {
        let root =
            std::env::temp_dir().join(format!("zeditor-encoded-export-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join(".assets")).unwrap();
        std::fs::write(root.join(".assets/中文 图# &.png"), [0_u8, 1, 2, 3]).unwrap();
        let document = root.join("note.md");
        let html =
            r#"<img src=".assets/%E4%B8%AD%E6%96%87%20%E5%9B%BE%23%20&amp;.png?v=1#preview">"#;
        let output = embed_images(html, Some(&document.to_string_lossy()));
        assert!(
            output.contains("data:image/png;base64,AAECAw=="),
            "{output}"
        );
        std::fs::write(root.join(".assets/literal&#35;.png"), [4_u8, 5]).unwrap();
        let literal = embed_images(
            r#"<img src=".assets/literal&amp;%2335;.png">"#,
            Some(&document.to_string_lossy()),
        );
        assert!(
            literal.contains("data:image/png;base64,BAU="),
            "HTML and URI references must each decode once: {literal}"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
