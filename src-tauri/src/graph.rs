use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGraphNode {
    pub id: String,
    pub path: String,
    #[serde(rename = "type")]
    pub file_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGraphEdge {
    pub source: String,
    pub target: String,
    pub label: Option<String>,
    pub mode: String,
    pub broken: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGraphSnapshot {
    pub nodes: Vec<WorkspaceGraphNode>,
    pub edges: Vec<WorkspaceGraphEdge>,
    pub generated_at: i64,
}

fn graph_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn graph_file_type(path: &Path) -> String {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "md" | "markdown" | "mdx" => "markdown".into(),
        "png" | "jpg" | "jpeg" | "gif" | "svg" | "webp" => "image".into(),
        "pdf" | "doc" | "docx" | "txt" | "rtf" => "document".into(),
        "ts" | "tsx" | "js" | "jsx" | "py" | "rs" | "json" | "css" => "code".into(),
        other if other.is_empty() => "other".into(),
        other => other.into(),
    }
}

fn collect_graph_files(root: &Path, output: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in std::fs::read_dir(root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if matches!(name.as_str(), ".git" | "node_modules" | "target" | "dist") {
                continue;
            }
            collect_graph_files(&path, output)?;
        } else if metadata.is_file()
            && matches!(
                path.extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or_default()
                    .to_ascii_lowercase()
                    .as_str(),
                "md" | "markdown" | "mdx"
            )
        {
            output.push(path);
        }
    }
    Ok(())
}

fn normalize_graph_target(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

#[tauri::command]
pub async fn build_workspace_graph(roots: Vec<String>) -> Result<WorkspaceGraphSnapshot, String> {
    let mut files = Vec::new();
    for root in roots {
        crate::commands::ensure_fs_authorized(&root, "构建 workspace graph")?;
        let canonical = std::fs::canonicalize(&root).map_err(|error| error.to_string())?;
        collect_graph_files(&canonical, &mut files)?;
    }
    files.sort();
    files.dedup();

    let nodes = files
        .iter()
        .map(|path| {
            let id = graph_path(path);
            WorkspaceGraphNode {
                id: id.clone(),
                path: id,
                file_type: graph_file_type(path),
            }
        })
        .collect::<Vec<_>>();
    let known = nodes
        .iter()
        .map(|node| node.id.clone())
        .collect::<std::collections::HashSet<_>>();
    let link_pattern =
        regex::Regex::new(r"\[([^\]\n]+)\]\(([^)\n]+)\)").map_err(|error| error.to_string())?;
    let mut edges = Vec::new();

    for source in &files {
        let source_id = graph_path(source);
        let content = match std::fs::read_to_string(source) {
            Ok(content) => content,
            Err(_) => continue,
        };
        for captures in link_pattern.captures_iter(&content) {
            let start = captures.get(0).map(|match_| match_.start()).unwrap_or(0);
            if start > 0 && content.as_bytes().get(start - 1) == Some(&b'!') {
                continue;
            }
            let label = captures.get(1).map(|value| value.as_str().to_string());
            let destination = captures
                .get(2)
                .map(|value| value.as_str())
                .unwrap_or_default();
            let mut parts = destination.split('|');
            let raw_target = parts.next().unwrap_or_default().replace("%20", " ");
            if raw_target.is_empty()
                || raw_target.starts_with('#')
                || raw_target.starts_with("http://")
                || raw_target.starts_with("https://")
            {
                continue;
            }
            let mut mode = "link".to_string();
            for part in parts {
                if let Some(value) = part.strip_prefix("mode=") {
                    mode = value.to_string();
                }
            }
            let target = normalize_graph_target(
                &source
                    .parent()
                    .unwrap_or_else(|| Path::new(""))
                    .join(raw_target),
            );
            let target_id = graph_path(&target);
            edges.push(WorkspaceGraphEdge {
                source: source_id.clone(),
                target: target_id.clone(),
                label,
                mode,
                broken: !known.contains(&target_id),
            });
        }
    }

    Ok(WorkspaceGraphSnapshot {
        nodes,
        edges,
        generated_at: chrono::Utc::now().timestamp_millis(),
    })
}
