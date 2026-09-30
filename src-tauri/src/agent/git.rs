use super::{
    process,
    types::{AgentChangeSet, AgentFileChange, AgentSession},
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};

fn git(workdir: &Path, args: &[&str]) -> Result<String, String> {
    let output = process::system_command("git")
        .args(args)
        .current_dir(workdir)
        .output()
        .map_err(|error| format!("无法启动 Git：{error}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

pub fn ensure_git_workspace(root: &Path) -> Result<(), String> {
    if !root.is_dir() {
        return Err("工作区目录不存在".into());
    }
    let top = git(root, &["rev-parse", "--show-toplevel"])?;
    let top = fs::canonicalize(top.trim()).map_err(|error| error.to_string())?;
    let root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    if top != root {
        return Err("Agent 工作区必须选择 Git 仓库根目录".into());
    }
    Ok(())
}

fn file_hash(path: &Path) -> Result<Option<String>, String> {
    use std::io::Read;
    if !path.exists() {
        return Ok(None);
    }
    if path.is_dir() {
        return Ok(None);
    }
    // 流式分块读取：此前 fs::read 整文件载入内存，大文件（GB 级）会
    // 触发内存峰值/OOM。
    let mut file =
        fs::File::open(path).map_err(|error| format!("读取 {} 失败：{error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("读取 {} 失败：{error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(Some(hex::encode(hasher.finalize())))
}

fn tracked_and_untracked(root: &Path) -> Result<Vec<String>, String> {
    let output = git(
        root,
        &[
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ],
    )?;
    Ok(output
        .split('\0')
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .collect())
}

fn copy_untracked(root: &Path, worktree: &Path) -> Result<(), String> {
    let output = git(root, &["ls-files", "-z", "--others", "--exclude-standard"])?;
    for relative in output.split('\0').filter(|item| !item.is_empty()) {
        let source = root.join(relative);
        let target = worktree.join(relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::copy(&source, &target)
            .map_err(|error| format!("复制 {} 失败：{error}", source.display()))?;
    }
    Ok(())
}

/// 为会话起始快照计算每个文件的哈希（应用变更前用于冲突检测）。
///
/// 串行哈希在万级文件的仓库上需要数秒，而 SHA-256 计算与文件读取互相独立，
/// 这里按可用并行度分片并行；结果与串行实现完全一致。
fn hash_baselines(
    root: &Path,
    files: Vec<String>,
) -> Result<HashMap<String, Option<String>>, String> {
    if files.is_empty() {
        return Ok(HashMap::new());
    }
    let workers = std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1)
        .clamp(1, 8)
        .min(files.len());
    if workers <= 1 {
        let mut hashes = HashMap::with_capacity(files.len());
        for relative in &files {
            hashes.insert(relative.clone(), file_hash(&root.join(relative))?);
        }
        return Ok(hashes);
    }
    let chunk = files.len().div_ceil(workers);
    let joined = std::thread::scope(|scope| {
        files
            .chunks(chunk)
            .map(|slice| {
                scope.spawn(move || -> Result<Vec<(String, Option<String>)>, String> {
                    slice
                        .iter()
                        .map(|relative| Ok((relative.clone(), file_hash(&root.join(relative))?)))
                        .collect()
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|handle| handle.join())
            .collect::<Vec<_>>()
    });
    let mut hashes = HashMap::with_capacity(files.len());
    for entry in joined {
        for (relative, hash) in entry.map_err(|_| "基线哈希线程异常退出".to_string())?? {
            hashes.insert(relative, hash);
        }
    }
    Ok(hashes)
}

pub fn create_isolated_worktree(
    root: &Path,
    session_dir: &Path,
) -> Result<(String, HashMap<String, Option<String>>), String> {
    ensure_git_workspace(root)?;
    if session_dir.exists() {
        return Err("Agent 隔离目录已存在".into());
    }
    fs::create_dir_all(session_dir.parent().ok_or("无效的隔离目录")?)
        .map_err(|error| error.to_string())?;
    let session_arg = session_dir.to_string_lossy().to_string();
    git(root, &["worktree", "add", "--detach", &session_arg, "HEAD"])?;

    let patch = git(root, &["diff", "--binary", "HEAD"])?;
    if !patch.trim().is_empty() {
        let patch_path = session_dir.join(".zeditor-baseline.patch");
        fs::write(&patch_path, patch.as_bytes()).map_err(|error| error.to_string())?;
        let patch_arg = patch_path.to_string_lossy().to_string();
        let apply_result = git(session_dir, &["apply", "--binary", &patch_arg]);
        let _ = fs::remove_file(&patch_path);
        apply_result?;
    }
    copy_untracked(root, session_dir)?;

    let baseline_hashes = hash_baselines(root, tracked_and_untracked(root)?)?;

    git(session_dir, &["add", "-A"])?;
    git(
        session_dir,
        &[
            "-c",
            "user.name=Zeditor Agent",
            "-c",
            "user.email=agent@zeditor.local",
            "commit",
            "--allow-empty",
            "-m",
            "Zeditor Agent baseline",
        ],
    )?;
    let base_commit = git(session_dir, &["rev-parse", "HEAD"])?.trim().to_string();
    Ok((base_commit, baseline_hashes))
}

fn status_name(code: &str) -> (&'static str, bool) {
    match code.chars().next().unwrap_or('M') {
        'A' | '?' => ("added", false),
        'D' => ("deleted", false),
        'R' => ("renamed", false),
        _ => ("modified", false),
    }
}

/// 解析 `git status --porcelain=v1 -z` 输出。
/// -z 模式下每条记录为 `XY PATH\0`，重命名/复制条目额外跟一个
/// `ORIG_PATH\0` 字段。此前的实现把 ORIG_PATH 残段当作独立条目处理，
/// 会在变更列表里产生一个不存在的“幽灵文件”（状态回退为 modified、
/// 行数 0、diff 为空）。这里通过校验条目格式并显式消费第二字段修复。
fn parse_porcelain_z(status: &str) -> Vec<(String, &'static str)> {
    let mut entries = Vec::new();
    let mut fields = status.split('\0').filter(|field| !field.is_empty());
    while let Some(field) = fields.next() {
        let bytes = field.as_bytes();
        // 合法条目形如 "XY PATH"（第 3 个字符为空格，路径至少 1 字符）。
        if bytes.len() < 4 || !(bytes[2] as char).is_ascii_whitespace() {
            continue;
        }
        let code = &field[..2];
        // 状态码必须由合法 porcelain 字符组成，防止把碰巧以
        // "字母字母空格" 开头的普通路径（rename 的 ORIG_PATH 残段）误判。
        let code_valid = code
            .chars()
            .all(|c| c.is_ascii_uppercase() || c == '?' || c == '!' || c == ' ');
        if !code_valid {
            continue;
        }
        let path = field[3..].to_string();
        if code.starts_with('R') || code.starts_with('C') {
            // rename/copy 条目后面紧跟 ORIG_PATH 字段，跳过。
            fields.next();
        }
        let (state, _) = status_name(code);
        entries.push((path, state));
    }
    entries
}

/// 从一次性 `git diff --cached` 输出中按文件拆分 diff 块。
/// 键为路径（取 "diff --git a/PATH b/PATH" 中的 PATH，即新路径）。
fn split_diff_by_path(diff: &str) -> HashMap<String, String> {
    use std::collections::HashMap;

    let mut result: HashMap<String, String> = HashMap::new();
    let mut current_path: Option<String> = None;
    let mut current_body = String::new();
    for line in diff.split_inclusive('\n') {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            if let Some(path) = extract_diffgit_path(rest) {
                if let Some(previous) = current_path.take() {
                    result.insert(previous, current_body.clone());
                }
                current_path = Some(path);
                current_body.clear();
                current_body.push_str(line);
                continue;
            }
        }
        if current_path.is_some() {
            current_body.push_str(line);
        }
    }
    if let Some(path) = current_path {
        result.insert(path, current_body);
    }
    result
}

/// 从 "a/PATH b/PATH" 尾部提取 PATH（两侧相同；含空格路径也能命中，
/// 引号包裹的异常路径返回 None，由调用方跳过该块）。
fn extract_diffgit_path(rest: &str) -> Option<String> {
    let a_start = rest.find("a/")?;
    let after_a = &rest[a_start + 2..];
    let relative = after_a.find(" b/")?;
    Some(after_a[..relative].to_string())
}

pub fn get_changes(session: &AgentSession) -> Result<AgentChangeSet, String> {
    let worktree = Path::new(
        session
            .worktree_path
            .as_deref()
            .ok_or("会话没有隔离工作区")?,
    );
    // The isolated index belongs only to this Agent session. Staging the final
    // tree makes additions, deletions and binary files available to one diff.
    git(worktree, &["add", "-A"])?;
    let status = git(worktree, &["status", "--porcelain=v1", "-z"])?;

    // 性能：此前每个文件分别启动 2 个 git 进程（numstat + diff），
    // 100 个文件即 200 次进程调用。这里改为 3 次调用批量获取。
    let numstat = git(worktree, &["diff", "--cached", "--numstat", "HEAD"]).unwrap_or_default();
    let stats_by_path: HashMap<&str, (&str, &str)> = numstat
        .lines()
        .filter_map(|line| {
            let mut columns = line.split('\t');
            let additions = columns.next()?;
            let deletions = columns.next()?;
            // rename 记录为 "adds\tdels\tNEW\tOLD"，第三列即新路径。
            let path = columns.next()?;
            Some((path, (additions, deletions)))
        })
        .collect();
    let diff_by_path = if stats_by_path
        .values()
        .any(|(additions, _)| *additions != "-")
    {
        // 存在文本 diff 时才需要全量 diff 输出。
        let full =
            git(worktree, &["diff", "--cached", "--no-ext-diff", "HEAD"]).unwrap_or_default();
        split_diff_by_path(&full)
    } else {
        HashMap::new()
    };

    let mut files = Vec::new();
    for (path, state) in parse_porcelain_z(&status) {
        let mut state = state;
        let (additions_str, deletions_str) = stats_by_path
            .get(path.as_str())
            .copied()
            .unwrap_or(("0", "0"));
        let binary = additions_str == "-";
        if binary {
            state = "binary";
        }
        let additions = additions_str.parse().unwrap_or(0);
        let deletions = deletions_str.parse().unwrap_or(0);
        let diff = if binary {
            None
        } else {
            Some(diff_by_path.get(&path).cloned().unwrap_or_default())
        };
        files.push(AgentFileChange {
            path,
            status: state.into(),
            additions,
            deletions,
            binary,
            diff,
        });
    }
    Ok(AgentChangeSet {
        session_id: session.id.clone(),
        files,
        base_commit: session.base_commit.clone(),
    })
}

pub fn apply_changes(
    session: &mut AgentSession,
    selected: Option<&[String]>,
) -> Result<(), String> {
    let root = Path::new(&session.workspace_root);
    let worktree = Path::new(
        session
            .worktree_path
            .as_deref()
            .ok_or("会话没有隔离工作区")?,
    );
    let changes = get_changes(session)?;
    let paths: Vec<String> = selected
        .map(|items| items.to_vec())
        .unwrap_or_else(|| changes.files.iter().map(|item| item.path.clone()).collect());
    if paths.is_empty() {
        return Ok(());
    }
    for relative in &paths {
        let current = file_hash(&root.join(relative))?;
        let baseline = session
            .baseline_hashes
            .get(relative)
            .cloned()
            .unwrap_or(None);
        if current != baseline {
            return Err(format!(
                "文件 {relative} 在 Agent 运行期间发生变化，已停止应用"
            ));
        }
    }

    git(worktree, &["add", "-A"])?;
    let mut args = vec!["diff", "--cached", "--binary", "HEAD", "--"];
    args.extend(paths.iter().map(String::as_str));
    let patch = git(worktree, &args)?;
    if patch.trim().is_empty() {
        return Ok(());
    }
    let patch_path = worktree.join(".zeditor-agent-result.patch");
    fs::write(&patch_path, patch.as_bytes()).map_err(|error| error.to_string())?;
    let patch_arg = patch_path.to_string_lossy().to_string();
    let result = git(
        root,
        &["apply", "--binary", "--whitespace=nowarn", &patch_arg],
    );
    let _ = fs::remove_file(patch_path);
    result?;

    let mut commit_args = vec![
        "-c",
        "user.name=Zeditor Agent",
        "-c",
        "user.email=agent@zeditor.local",
        "commit",
        "--allow-empty",
        "--only",
        "-m",
        "Zeditor Agent applied changes",
        "--",
    ];
    commit_args.extend(paths.iter().map(String::as_str));
    git(worktree, &commit_args)?;
    session.base_commit = git(worktree, &["rev-parse", "HEAD"])?.trim().to_string();
    for relative in paths {
        session
            .baseline_hashes
            .insert(relative.clone(), file_hash(&root.join(relative))?);
    }
    Ok(())
}

pub fn remove_worktree(session: &AgentSession) -> Result<(), String> {
    if let Some(path) = &session.worktree_path {
        let root = Path::new(&session.workspace_root);
        git(root, &["worktree", "remove", "--force", path])?;
        let _ = git(root, &["worktree", "prune"]);
    }
    Ok(())
}

pub fn session_worktree_path(storage_root: &Path, session_id: &str) -> PathBuf {
    storage_root.join("worktrees").join(session_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::{AgentApprovalMode, AgentBackendId, AgentSessionStatus};

    #[test]
    fn baseline_hashes_match_serial_hashing_across_shards() {
        let root =
            std::env::temp_dir().join(format!("zeditor-agent-hash-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("nested")).unwrap();
        let mut files = (0..25)
            .map(|index| format!("file-{index}.md"))
            .collect::<Vec<_>>();
        for (index, name) in files.iter().enumerate() {
            fs::write(root.join(name), format!("content {index}")).unwrap();
        }
        fs::write(root.join("nested").join("inner.md"), "inner").unwrap();
        files.push("nested/inner.md".into());
        files.push("missing.md".into());

        let hashes = hash_baselines(&root, files.clone()).unwrap();

        assert_eq!(hashes.len(), files.len());
        for relative in &files {
            assert_eq!(hashes[relative], file_hash(&root.join(relative)).unwrap());
        }
        assert!(hashes["missing.md"].is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn porcelain_z_rename_entry_does_not_produce_ghost_file() {
        // -z 格式：rename 条目 "R  NEW\0OLD\0"。OLD 残段不得被解析为
        // 额外的 modified 条目。
        let status = "R  renamed.md\0original.md\0M  notes.md\0";

        let entries = parse_porcelain_z(status);

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0], ("renamed.md".to_string(), "renamed"));
        assert_eq!(entries[1], ("notes.md".to_string(), "modified"));
    }

    #[test]
    fn split_diff_by_path_splits_on_file_boundaries() {
        let diff = "diff --git a/one.md b/one.md\n--- a/one.md\n+++ b/one.md\n@@\n-x\n+y\n\
                    diff --git a/two.md b/two.md\n--- a/two.md\n+++ b/two.md\n@@\n-z\n";

        let result = split_diff_by_path(diff);

        assert_eq!(result.len(), 2);
        assert!(result["one.md"].starts_with("diff --git a/one.md"));
        assert!(result["one.md"].contains("-x"));
        assert!(result["two.md"].contains("-z"));
    }

    fn run(root: &Path, args: &[&str]) {
        let output = process::system_command("git")
            .args(args)
            .current_dir(root)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn isolated_baseline_preserves_dirty_files_and_applies_only_agent_delta() {
        let parent =
            std::env::temp_dir().join(format!("zeditor-agent-test-{}", uuid::Uuid::new_v4()));
        let root = parent.join("repo");
        let worktree = parent.join("worktree");
        fs::create_dir_all(&root).unwrap();
        run(&root, &["init"]);
        fs::write(root.join("notes.md"), "committed\n").unwrap();
        run(&root, &["add", "notes.md"]);
        run(
            &root,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-m",
                "initial",
            ],
        );

        fs::write(root.join("notes.md"), "user draft\n").unwrap();
        fs::write(root.join("local.md"), "local context\n").unwrap();
        let (base_commit, baseline_hashes) = create_isolated_worktree(&root, &worktree).unwrap();
        assert_eq!(
            fs::read_to_string(worktree.join("notes.md"))
                .unwrap()
                .replace("\r\n", "\n"),
            "user draft\n"
        );
        assert_eq!(
            fs::read_to_string(worktree.join("local.md"))
                .unwrap()
                .replace("\r\n", "\n"),
            "local context\n"
        );

        fs::write(worktree.join("notes.md"), "user draft\nagent edit\n").unwrap();
        fs::write(worktree.join("created.md"), "agent file\n").unwrap();
        let mut session = AgentSession {
            id: "test".into(),
            backend: AgentBackendId::Codex,
            workspace_root: root.to_string_lossy().into_owned(),
            worktree_path: Some(worktree.to_string_lossy().into_owned()),
            backend_session_id: None,
            status: AgentSessionStatus::Completed,
            title: None,
            approval_mode: AgentApprovalMode::Tiered,
            created_at: String::new(),
            updated_at: String::new(),
            last_error: None,
            has_changes: true,
            read_only: false,
            direct_write: false,
            base_commit,
            baseline_hashes,
        };
        let changes = get_changes(&session).unwrap();
        assert!(changes.files.iter().any(|item| item.path == "notes.md"));
        assert!(changes
            .files
            .iter()
            .any(|item| item.path == "created.md" && item.status == "added"));

        apply_changes(&mut session, Some(&["notes.md".into()])).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("notes.md"))
                .unwrap()
                .replace("\r\n", "\n"),
            "user draft\nagent edit\n"
        );
        assert!(!root.join("created.md").exists());
        let remaining = get_changes(&session).unwrap();
        assert_eq!(remaining.files.len(), 1);
        assert_eq!(remaining.files[0].path, "created.md");

        apply_changes(&mut session, None).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("created.md"))
                .unwrap()
                .replace("\r\n", "\n"),
            "agent file\n"
        );
        assert!(get_changes(&session).unwrap().files.is_empty());
        remove_worktree(&session).unwrap();
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn refuses_to_apply_when_original_changed_after_session_started() {
        let parent =
            std::env::temp_dir().join(format!("zeditor-agent-conflict-{}", uuid::Uuid::new_v4()));
        let root = parent.join("repo");
        let worktree = parent.join("worktree");
        fs::create_dir_all(&root).unwrap();
        run(&root, &["init"]);
        fs::write(root.join("notes.md"), "base\n").unwrap();
        run(&root, &["add", "notes.md"]);
        run(
            &root,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-m",
                "initial",
            ],
        );
        let (base_commit, baseline_hashes) = create_isolated_worktree(&root, &worktree).unwrap();
        fs::write(worktree.join("notes.md"), "agent\n").unwrap();
        fs::write(root.join("notes.md"), "user changed later\n").unwrap();
        let mut session = AgentSession {
            id: "test".into(),
            backend: AgentBackendId::ClaudeCode,
            workspace_root: root.to_string_lossy().into_owned(),
            worktree_path: Some(worktree.to_string_lossy().into_owned()),
            backend_session_id: None,
            status: AgentSessionStatus::Completed,
            title: None,
            approval_mode: AgentApprovalMode::Tiered,
            created_at: String::new(),
            updated_at: String::new(),
            last_error: None,
            has_changes: true,
            read_only: false,
            direct_write: false,
            base_commit,
            baseline_hashes,
        };
        assert!(apply_changes(&mut session, None)
            .unwrap_err()
            .contains("发生变化"));
        remove_worktree(&session).unwrap();
        fs::remove_dir_all(parent).unwrap();
    }
}
