//! 自定义 AI 精灵：每个精灵是一个 Markdown 文件（YAML frontmatter + 提示词模板），
//! 存放在应用配置目录的 `genies/` 下；子目录自动成为分类。参考 VMark AI Genies 设计。
//!
//! 文件格式：
//! ```markdown
//! ---
//! description: 改进清晰度和流畅性
//! scope: selection      # selection | block | document
//! category: editing     # 缺省为子目录名
//! action: replace       # replace | insert
//! model:                # 可选，覆盖全局模型
//! ---
//!
//! 你是一位资深编辑。请润色以下文本，只输出结果。
//!
//! {{content}}
//! ```

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri::Manager;

/// 扫描深度与条目上限：防止符号链接环与超大目录拖慢面板打开。
const MAX_SCAN_DEPTH: usize = 8;
const MAX_ENTRIES: usize = 10_000;

#[derive(Debug, Clone, Serialize)]
pub struct CustomGenie {
    /// 相对 genies/ 的路径（不含扩展名），作为稳定 ID，如 "editing/fix-grammar"。
    pub id: String,
    /// 显示名：文件名去掉 .md。
    pub name: String,
    pub description: String,
    /// selection | block | document
    pub scope: String,
    pub category: String,
    /// replace | insert
    pub action: String,
    /// 精灵级模型覆盖；空字符串表示跟随全局设置。
    pub model: String,
    /// 提示词模板正文（包含 {{content}} 占位符）。
    pub prompt: String,
}

fn genies_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|error| format!("无法定位应用配置目录：{error}"))
        .map(|path| path.join("genies"))
}

/// 解析简单的单行 `key: value` frontmatter。不引入 YAML 依赖：
/// 精灵的元数据只有扁平的字符串字段，逐行按首个冒号切分即可。
fn split_frontmatter(raw: &str) -> (Vec<(String, String)>, String) {
    let trimmed = raw.trim_start_matches('\u{feff}');
    if !trimmed.starts_with("---") {
        return (Vec::new(), raw.to_string());
    }
    let after_first_fence = &trimmed[3..];
    let rest = after_first_fence.trim_start_matches(['\r', '\n']);
    if let Some(end) = rest.find("\n---") {
        let frontmatter = &rest[..end];
        // 结束围栏后剩余的正文。
        let after_end = &rest[end + 4..];
        let body = after_end.trim_start_matches(['\r', '\n']);
        let fields = frontmatter
            .lines()
            .filter_map(|line| {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    return None;
                }
                let (key, value) = line.split_once(':')?;
                let key = key.trim().to_string();
                let value = value.trim().trim_matches(['"', '\'']).to_string();
                if key.is_empty() {
                    None
                } else {
                    Some((key, value))
                }
            })
            .collect();
        return (fields, body.to_string());
    }
    (Vec::new(), raw.to_string())
}

fn parse_genie_file(rel_path: &str, raw: &str) -> Option<CustomGenie> {
    let (fields, prompt) = split_frontmatter(raw);
    if prompt.trim().is_empty() {
        return None;
    }

    let field = |key: &str| -> String {
        fields
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.clone())
            .unwrap_or_default()
    };

    let name = rel_path
        .rsplit('/')
        .next()
        .unwrap_or(rel_path)
        .to_string();

    let scope = match field("scope").as_str() {
        "block" => "block".to_string(),
        "document" => "document".to_string(),
        _ => "selection".to_string(),
    };
    let action = match field("action").as_str() {
        "insert" => "insert".to_string(),
        _ => "replace".to_string(),
    };
    // 分类缺省取相对路径的父目录；顶层文件归入「自定义」。
    let category = {
        let declared = field("category");
        if !declared.is_empty() {
            declared
        } else if let Some(parent) = rel_path.rsplit_once('/') {
            parent.0.to_string()
        } else {
            "自定义".to_string()
        }
    };

    Some(CustomGenie {
        id: rel_path.to_string(),
        name,
        description: field("description"),
        scope,
        category,
        action,
        model: field("model"),
        prompt,
    })
}

fn scan_dir(
    dir: &Path,
    prefix: &str,
    depth: usize,
    budget: &mut usize,
    out: &mut Vec<CustomGenie>,
) -> Result<(), String> {
    if depth > MAX_SCAN_DEPTH {
        return Ok(());
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(()), // 子目录不可读时跳过，不影响其余精灵。
    };
    for entry in entries.flatten() {
        if *budget == 0 {
            return Ok(());
        }
        *budget -= 1;

        let path = entry.path();
        // 跳过符号链接，防止目录环。
        if path.is_symlink() {
            continue;
        }
        let file_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(name) => name.to_string(),
            None => continue,
        };
        if file_name.starts_with('.') {
            continue;
        }
        let rel = if prefix.is_empty() {
            file_name.trim_end_matches(".md").to_string()
        } else {
            format!("{}/{}", prefix, file_name.trim_end_matches(".md"))
        };

        if path.is_dir() {
            scan_dir(&path, &rel, depth + 1, budget, out)?;
        } else if file_name.to_lowercase().ends_with(".md") {
            if let Ok(raw) = fs::read_to_string(&path) {
                if let Some(genie) = parse_genie_file(&rel, &raw) {
                    out.push(genie);
                }
            }
        }
    }
    Ok(())
}

/// 列出全部自定义精灵。目录不存在时返回空列表（首次使用是正常状态）。
#[tauri::command]
pub fn list_custom_genies(app: AppHandle) -> Result<Vec<CustomGenie>, String> {
    let root = genies_root(&app)?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut genies = Vec::new();
    let mut budget = MAX_ENTRIES;
    scan_dir(&root, "", 1, &mut budget, &mut genies)?;
    genies.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(genies)
}

/// 在系统文件管理器中打开精灵文件夹；不存在时先创建并写入示例精灵。
#[tauri::command]
pub fn open_genies_folder(app: AppHandle) -> Result<String, String> {
    let root = genies_root(&app)?;
    fs::create_dir_all(&root).map_err(|error| format!("无法创建精灵目录：{error}"))?;

    // 首次打开时放置一个示例精灵，帮助用户理解文件格式。
    let example = root.join("示例-润色.md");
    if !example.exists() {
        let template = "---\ndescription: 提升清晰度和流畅性，保留作者的声音\nscope: selection\naction: replace\n---\n\n你是一位资深编辑。请润色下面的文本，只输出润色后的文本，不要任何解释。\n\n{{content}}\n";
        let _ = fs::write(&example, template);
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .arg(&root)
            .spawn()
            .map_err(|error| format!("无法打开精灵文件夹：{error}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&root)
            .spawn()
            .map_err(|error| format!("无法打开精灵文件夹：{error}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&root)
            .spawn()
            .map_err(|error| format!("无法打开精灵文件夹：{error}"))?;
    }
    Ok(root.to_string_lossy().to_string())
}
