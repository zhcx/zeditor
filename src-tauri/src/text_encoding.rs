use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct TextDocument {
    pub content: String,
    pub encoding: String,
}

fn legacy_encoding(name: &str) -> Option<&'static encoding_rs::Encoding> {
    match name {
        "gbk" => Some(encoding_rs::GBK),
        "gb18030" => Some(encoding_rs::GB18030),
        "big5" => Some(encoding_rs::BIG5),
        "shift-jis" => Some(encoding_rs::SHIFT_JIS),
        "windows-1252" => Some(encoding_rs::WINDOWS_1252),
        _ => None,
    }
}

pub fn decode_text(bytes: &[u8], encoding: Option<&str>) -> Result<TextDocument, String> {
    let detected = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        "utf-8-bom"
    } else if bytes.starts_with(&[0xFF, 0xFE, 0, 0]) || bytes.starts_with(&[0, 0, 0xFE, 0xFF]) {
        return Err("text_encoding_required: 暂不支持 UTF-32，请先转换为 UTF-8。".into());
    } else if bytes.starts_with(&[0xFF, 0xFE]) {
        "utf-16le-bom"
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        "utf-16be-bom"
    } else {
        "utf-8"
    };
    if encoding.is_none() && detected == "utf-8" && bytes.contains(&0) {
        return Err(
            "text_encoding_required: 文件包含空字节，可能是无 BOM 的 UTF-16，请选择实际编码。"
                .into(),
        );
    }
    let name = encoding.unwrap_or(detected);
    let failure = || format!("{name} 解码失败，请选择文件实际使用的文字编码。");
    let (content, actual) = match name {
        "utf-8" | "utf-8-bom" => {
            let bom = bytes.starts_with(&[0xEF, 0xBB, 0xBF]);
            let source = if bom { &bytes[3..] } else { bytes };
            let text = std::str::from_utf8(source).map_err(|_| {
                if encoding.is_none() {
                    "text_encoding_required: 无法自动识别文件编码，请选择正确编码打开。".into()
                } else {
                    failure()
                }
            })?;
            (text.to_owned(), if bom { "utf-8-bom" } else { "utf-8" })
        }
        "utf-16le" | "utf-16le-bom" | "utf-16be" | "utf-16be-bom" => {
            let little = name.starts_with("utf-16le");
            let bom = bytes.starts_with(if little { &[0xFF, 0xFE] } else { &[0xFE, 0xFF] });
            let source = if bom { &bytes[2..] } else { bytes };
            if source.len() % 2 != 0 {
                return Err(failure());
            }
            let units: Vec<u16> = source
                .chunks_exact(2)
                .map(|pair| {
                    if little {
                        u16::from_le_bytes([pair[0], pair[1]])
                    } else {
                        u16::from_be_bytes([pair[0], pair[1]])
                    }
                })
                .collect();
            let text = String::from_utf16(&units).map_err(|_| failure())?;
            let actual = match (little, bom) {
                (true, true) => "utf-16le-bom",
                (true, false) => "utf-16le",
                (false, true) => "utf-16be-bom",
                (false, false) => "utf-16be",
            };
            (text, actual)
        }
        _ => {
            let codec = legacy_encoding(name).ok_or_else(|| "不支持的文字编码".to_string())?;
            let text = codec
                .decode_without_bom_handling_and_without_replacement(bytes)
                .ok_or_else(failure)?;
            (text.into_owned(), name)
        }
    };
    Ok(TextDocument {
        content,
        encoding: actual.into(),
    })
}

pub fn encode_text(content: &str, encoding: &str) -> Result<Vec<u8>, String> {
    match encoding {
        "utf-8" => Ok(content.as_bytes().to_vec()),
        "utf-8-bom" => {
            let mut bytes = vec![0xEF, 0xBB, 0xBF];
            bytes.extend_from_slice(content.as_bytes());
            Ok(bytes)
        }
        "utf-16le" | "utf-16le-bom" | "utf-16be" | "utf-16be-bom" => {
            let little = encoding.starts_with("utf-16le");
            let mut bytes = Vec::with_capacity(content.len() * 2 + 2);
            if encoding.ends_with("-bom") {
                bytes.extend_from_slice(if little { &[0xFF, 0xFE] } else { &[0xFE, 0xFF] });
            }
            for unit in content.encode_utf16() {
                bytes.extend_from_slice(&if little {
                    unit.to_le_bytes()
                } else {
                    unit.to_be_bytes()
                });
            }
            Ok(bytes)
        }
        _ => {
            let codec = legacy_encoding(encoding).ok_or_else(|| "不支持的文字编码".to_string())?;
            let (bytes, _, errors) = codec.encode(content);
            if errors {
                return Err(format!("文本包含 {encoding} 无法表示的字符，文件未修改，请改用 UTF-8 或其他 Unicode 编码。"));
            }
            Ok(bytes.into_owned())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unicode_and_legacy_encodings_round_trip() {
        for (encoding, text) in [
            ("utf-8", "中文 😀"),
            ("utf-8-bom", "中文 😀"),
            ("utf-16le", "中文 😀"),
            ("utf-16le-bom", "中文 😀"),
            ("utf-16be", "中文 😀"),
            ("utf-16be-bom", "中文 😀"),
            ("gbk", "中文"),
            ("gb18030", "中文 😀"),
            ("big5", "繁體中文"),
            ("shift-jis", "日本語"),
            ("windows-1252", "café €"),
        ] {
            let bytes = encode_text(text, encoding).unwrap();
            let decoded = decode_text(&bytes, Some(encoding)).unwrap();
            assert_eq!(decoded.content, text, "{encoding}");
            assert_eq!(decoded.encoding, encoding, "{encoding}");
        }
    }

    #[test]
    fn detects_bom_and_preserves_encoding_identity() {
        for encoding in ["utf-8-bom", "utf-16le-bom", "utf-16be-bom"] {
            let bytes = encode_text("正文", encoding).unwrap();
            let decoded = decode_text(&bytes, None).unwrap();
            assert_eq!(decoded.content, "正文");
            assert_eq!(decoded.encoding, encoding);
        }
    }

    #[test]
    fn known_gbk_bytes_decode_as_chinese() {
        assert_eq!(
            decode_text(&[0xD6, 0xD0, 0xCE, 0xC4], Some("gbk"))
                .unwrap()
                .content,
            "中文"
        );
    }

    #[test]
    fn unknown_bytes_request_explicit_encoding_without_guessing() {
        assert!(decode_text(&[0xD6, 0xD0], None)
            .unwrap_err()
            .starts_with("text_encoding_required:"));
        let utf16 = encode_text("plain text", "utf-16le").unwrap();
        assert!(decode_text(&utf16, None)
            .unwrap_err()
            .starts_with("text_encoding_required:"));
        assert_eq!(
            decode_text(&utf16, Some("utf-16le")).unwrap().content,
            "plain text"
        );
        assert_eq!(
            decode_text(b"has\0null", Some("utf-8")).unwrap().content,
            "has\0null"
        );
    }

    #[test]
    fn malformed_unicode_is_rejected() {
        assert!(decode_text(&[0x41], Some("utf-16le")).is_err());
        assert!(decode_text(&[0x00, 0xD8], Some("utf-16le")).is_err());
        assert!(decode_text(&[0xFF], Some("utf-8")).is_err());
    }

    #[test]
    fn unrepresentable_characters_are_not_replaced() {
        assert!(encode_text("😀", "gbk").is_err());
        assert!(encode_text("中文", "windows-1252").is_err());
        assert!(encode_text("正文", "unsupported").is_err());
    }
}
