use std::{
    collections::HashMap,
    ffi::OsStr,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    time::{Duration, Instant},
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    #[cfg(not(windows))]
    let _ = command;
}

pub fn system_command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    hide_console(&mut command);
    #[cfg(target_os = "macos")]
    extend_macos_command_environment(&mut command, None);
    command
}

/// 可执行文件发现结果缓存：该函数会扫描 PATH、npm/WinGet 目录与 VSCode
/// 扩展目录，而状态面板等调用方高频轮询。缓存 30 秒，新安装的 CLI 最迟
/// 在下一次 TTL 过期后可见（或重启应用）。
const DISCOVERY_CACHE_TTL: Duration = Duration::from_secs(30);

/// 可执行文件发现结果缓存条目：CLI 名称 → 找到的绝对路径（未找到为 None）。
type DiscoveryEntries = HashMap<String, Option<PathBuf>>;
static DISCOVERY_CACHE: Mutex<Option<(Instant, DiscoveryEntries)>> = Mutex::new(None);

pub fn discover_executable(name: &str) -> Option<PathBuf> {
    let mut cache = DISCOVERY_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((stamp, entries)) = cache.as_ref() {
        if stamp.elapsed() < DISCOVERY_CACHE_TTL {
            if let Some(hit) = entries.get(name) {
                return hit.clone();
            }
        }
    }
    let discovered = discover_executable_uncached(name);
    let entry = cache.get_or_insert_with(|| (Instant::now(), HashMap::new()));
    if entry.0.elapsed() >= DISCOVERY_CACHE_TTL {
        *entry = (Instant::now(), HashMap::new());
    }
    entry.1.insert(name.to_string(), discovered.clone());
    discovered
}

fn discover_executable_uncached(name: &str) -> Option<PathBuf> {
    let mut preferred = Vec::new();
    #[cfg(windows)]
    {
        if name.eq_ignore_ascii_case("claude") {
            preferred.extend(official_claude_npm_candidates());
        }
        if name.eq_ignore_ascii_case("codex") {
            preferred.extend(official_codex_extension_candidates());
        }
    }

    // Windows 和 macOS 会追加常见安装目录；Linux 读取继承的 PATH。
    #[allow(unused_mut)]
    let mut directories: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default();

    #[cfg(windows)]
    {
        if let Some(path) = std::env::var_os("APPDATA") {
            directories.push(PathBuf::from(path).join("npm"));
        }
        if let Some(path) = std::env::var_os("LOCALAPPDATA") {
            directories.push(
                PathBuf::from(path)
                    .join("Microsoft")
                    .join("WinGet")
                    .join("Links"),
            );
        }
        if let Some(path) = std::env::var_os("USERPROFILE") {
            let root = PathBuf::from(path);
            directories.push(root.join(".local").join("bin"));
            directories.push(root.join(".cargo").join("bin"));
        }
    }

    // macOS 从 Finder/Dock 启动的 GUI 进程只继承最小 PATH
    //（/usr/bin:/bin:/usr/sbin:/sbin），Homebrew、volta、cargo 与 nvm 装的
    // CLI 都不在其中。补齐常见位置，避免 AI 助手面板误报「未安装」。
    // 只做静态目录探测，不启动登录 shell：状态面板会周期性调用本函数。
    #[cfg(target_os = "macos")]
    {
        directories.extend(macos_binary_directories());
    }

    preferred.extend(candidate_paths(name, directories));
    select_discovered(preferred)
}

/// macOS 上 CLI 的常见安装位置（不依赖登录 shell 的 PATH）。
#[cfg(any(target_os = "macos", test))]
fn macos_binary_directories() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut directories = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        // PATH/HOME 缺失时仍保留系统工具（git、env、shell）的默认搜索位置。
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
        PathBuf::from("/usr/sbin"),
        PathBuf::from("/sbin"),
    ];
    let Some(home) = home else {
        return directories;
    };
    directories.push(home.join(".local").join("bin"));
    directories.push(home.join(".volta").join("bin"));
    directories.push(home.join(".cargo").join("bin"));
    // nvm 把 Node 装在 ~/.nvm/versions/node/<version>/bin，版本目录不在 PATH 中。
    if let Ok(entries) = std::fs::read_dir(home.join(".nvm").join("versions").join("node")) {
        let mut versions: Vec<PathBuf> = entries
            .flatten()
            .map(|entry| entry.path().join("bin"))
            .filter(|path| path.is_dir())
            .collect();
        versions.sort();
        versions.reverse();
        directories.extend(versions.into_iter().take(4));
    }
    directories
}

#[cfg(any(target_os = "macos", test))]
fn extended_command_path(
    executable: Option<&Path>,
    inherited: Option<&OsStr>,
    fallbacks: impl IntoIterator<Item = PathBuf>,
) -> Result<std::ffi::OsString, std::env::JoinPathsError> {
    let mut directories = Vec::new();
    // nvm 安装的 CLI 与 node 在同一目录，优先用与该 CLI 配套的运行时。
    if let Some(parent) = executable
        .and_then(Path::parent)
        .filter(|path| path.is_absolute())
    {
        directories.push(parent.to_path_buf());
    }
    for directory in inherited
        .into_iter()
        .flat_map(std::env::split_paths)
        .chain(fallbacks)
    {
        if !directories.contains(&directory) {
            directories.push(directory);
        }
    }
    std::env::join_paths(directories)
}

#[cfg(target_os = "macos")]
fn extend_macos_command_environment(command: &mut Command, executable: Option<&Path>) {
    // 发现绝对路径还不够：#!/usr/bin/env node 和 Agent 启动的工具仍需 PATH。
    // 只改当前子进程的环境，避免修改 GUI 进程全局环境造成并发竞态。
    if let Ok(path) = extended_command_path(
        executable,
        std::env::var_os("PATH").as_deref(),
        macos_binary_directories(),
    ) {
        command.env("PATH", path);
    }
}

#[cfg(windows)]
fn official_claude_npm_candidates() -> Vec<PathBuf> {
    let Some(app_data) = std::env::var_os("APPDATA") else {
        return Vec::new();
    };
    official_claude_candidates_from_roots([PathBuf::from(app_data).join("npm")])
}

#[cfg(windows)]
fn official_claude_candidates_from_roots(roots: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
    roots
        .into_iter()
        .map(|root| {
            root.join("node_modules")
                .join("@anthropic-ai")
                .join("claude-code")
                .join("bin")
                .join("claude.exe")
        })
        .filter(|path| path.is_file())
        .collect()
}

#[cfg(all(test, windows))]
fn discover_in_directories(
    name: &str,
    directories: impl IntoIterator<Item = PathBuf>,
) -> Option<PathBuf> {
    select_discovered(candidate_paths(name, directories))
}

fn candidate_paths(name: &str, directories: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    for directory in directories {
        #[cfg(windows)]
        {
            candidates.extend(
                ["exe", "com", "cmd", "bat"]
                    .map(|extension| directory.join(name).with_extension(extension)),
            );
            candidates.push(directory.join(name));
        }
        #[cfg(not(windows))]
        candidates.push(directory.join(name));
    }
    candidates
}

#[cfg(windows)]
fn official_codex_extension_candidates() -> Vec<PathBuf> {
    let Some(profile) = std::env::var_os("USERPROFILE") else {
        return Vec::new();
    };
    let profile = PathBuf::from(profile);
    official_codex_candidates_from_roots([
        profile.join(".vscode").join("extensions"),
        profile.join(".vscode-insiders").join("extensions"),
        profile.join(".cursor").join("extensions"),
        profile.join(".windsurf").join("extensions"),
    ])
}

#[cfg(windows)]
fn extension_dir_version(path: &Path) -> Option<semver::Version> {
    let name = path.file_name()?.to_str()?;
    let after_prefix = name.strip_prefix("openai.chatgpt-")?;
    let version = after_prefix.split('-').next()?;
    semver::Version::parse(version).ok()
}

#[cfg(windows)]
fn official_codex_candidates_from_roots(roots: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
    let architecture = match std::env::consts::ARCH {
        "aarch64" => "windows-aarch64",
        _ => "windows-x86_64",
    };
    let mut extension_dirs = roots
        .into_iter()
        .flat_map(|root| std::fs::read_dir(root).into_iter().flatten().flatten())
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(OsStr::to_str)
                .is_some_and(|name| name.starts_with("openai.chatgpt-"))
        })
        .collect::<Vec<_>>();
    // 按 semver 降序取最新版本。此前按文件名字符串排序，
    // "10.0.0" < "9.0.0" 会选错旧版本。
    extension_dirs.sort_by(|left, right| {
        let left_version = extension_dir_version(left);
        let right_version = extension_dir_version(right);
        match (left_version, right_version) {
            (Some(l), Some(r)) => r.cmp(&l),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => right.file_name().cmp(&left.file_name()),
        }
    });
    extension_dirs
        .into_iter()
        .map(|root| root.join("bin").join(architecture).join("codex.exe"))
        .filter(|path| path.is_file())
        .collect()
}

pub fn executable_command(executable: &Path) -> Result<Command, String> {
    #[cfg(windows)]
    let mut command = {
        let extension = executable
            .extension()
            .and_then(OsStr::to_str)
            .unwrap_or_default()
            .to_ascii_lowercase();
        match extension.as_str() {
            "cmd" | "bat" => {
                let shell = std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into());
                let mut command = Command::new(shell);
                command.args(["/D", "/S", "/C", "call"]).arg(executable);
                command
            }
            "ps1" => {
                return Err("Windows PowerShell 脚本不能直接作为 Agent 可执行文件；请指定 .exe、.cmd 或 .bat".into());
            }
            _ => Command::new(executable),
        }
    };

    #[cfg(not(windows))]
    let mut command = Command::new(executable);

    hide_console(&mut command);
    #[cfg(target_os = "macos")]
    extend_macos_command_environment(&mut command, Some(executable));
    Ok(command)
}

pub fn tokio_executable_command(executable: &Path) -> Result<tokio::process::Command, String> {
    Ok(tokio::process::Command::from(executable_command(
        executable,
    )?))
}

pub fn resolve_executable(path: PathBuf) -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        let extension = path.extension().and_then(OsStr::to_str).unwrap_or_default();
        if extension.is_empty() {
            for candidate_extension in ["exe", "com", "cmd", "bat"] {
                let candidate = path.with_extension(candidate_extension);
                if candidate.is_file() {
                    return Ok(candidate);
                }
            }
            return Err(format!(
                "{} 不是可执行的 Windows 程序；请指定 .exe、.cmd 或 .bat 文件",
                path.display()
            ));
        }
        if extension.eq_ignore_ascii_case("ps1") {
            return Err(
                "Windows PowerShell 脚本不能直接作为 Agent 可执行文件；请指定 .exe、.cmd 或 .bat"
                    .into(),
            );
        }
    }
    if !path.is_file() {
        return Err(format!("Agent 可执行文件不存在：{}", path.display()));
    }
    Ok(path)
}

pub fn select_discovered(paths: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    // 排序只在 Windows 上生效（按 exe/cmd/ps1 优先级），其它平台保持发现顺序。
    #[allow(unused_mut)]
    let mut paths: Vec<PathBuf> = paths.into_iter().filter(|path| path.is_file()).collect();
    #[cfg(windows)]
    paths.sort_by_key(|path| {
        match path
            .extension()
            .and_then(OsStr::to_str)
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str()
        {
            "exe" | "com" => 0,
            "cmd" | "bat" => 1,
            "ps1" => 3,
            _ => 2,
        }
    });
    paths
        .into_iter()
        .find_map(|path| resolve_executable(path).ok())
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_commands_receive_the_augmented_path() {
        use super::{executable_command, system_command};
        use std::{ffi::OsStr, path::Path};

        let command = executable_command(Path::new("/zeditor-fixture/node-bin/codex")).unwrap();
        let path = command
            .get_envs()
            .find(|(name, _)| *name == OsStr::new("PATH"))
            .and_then(|(_, value)| value)
            .unwrap();
        assert_eq!(
            std::env::split_paths(path).next().as_deref(),
            Some(Path::new("/zeditor-fixture/node-bin"))
        );
        let command = system_command("git");
        let path = command
            .get_envs()
            .find(|(name, _)| *name == OsStr::new("PATH"))
            .and_then(|(_, value)| value)
            .unwrap();
        assert!(std::env::split_paths(path).any(|path| path == Path::new("/opt/homebrew/bin")));
    }

    #[test]
    fn child_path_includes_cli_runtime_and_discovery_fallbacks() {
        use super::extended_command_path;
        use std::path::PathBuf;

        let root = std::env::temp_dir().join("zeditor-command-path-fixture");
        let runtime = root.join("node-bin");
        let system = root.join("system-bin");
        let homebrew = root.join("homebrew-bin");
        let inherited = std::env::join_paths([&system]).unwrap();
        let path = extended_command_path(
            Some(&runtime.join("codex")),
            Some(&inherited),
            [homebrew.clone(), system.clone(), runtime.clone()],
        )
        .unwrap();
        assert_eq!(
            std::env::split_paths(&path).collect::<Vec<PathBuf>>(),
            vec![runtime, system, homebrew]
        );
    }

    #[test]
    fn system_command_path_keeps_inherited_priority_and_handles_missing_path() {
        use super::extended_command_path;
        use std::path::PathBuf;

        let root = std::env::temp_dir().join("zeditor-system-path-fixture");
        let system = root.join("system-bin");
        let homebrew = root.join("homebrew-bin");
        let inherited = std::env::join_paths([&system]).unwrap();
        let path = extended_command_path(None, Some(&inherited), [homebrew.clone()]).unwrap();
        assert_eq!(
            std::env::split_paths(&path).collect::<Vec<PathBuf>>(),
            vec![system, homebrew.clone()]
        );
        let path = extended_command_path(None, None, [homebrew.clone()]).unwrap();
        assert_eq!(
            std::env::split_paths(&path).collect::<Vec<_>>(),
            vec![homebrew]
        );
    }

    #[test]
    fn missing_or_empty_path_keeps_macos_system_tools_searchable() {
        use super::{extended_command_path, macos_binary_directories};
        use std::{ffi::OsStr, path::PathBuf};

        for inherited in [None, Some(OsStr::new(""))] {
            let path = extended_command_path(None, inherited, macos_binary_directories()).unwrap();
            let directories = std::env::split_paths(&path).collect::<Vec<_>>();
            for system in ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
                assert!(
                    directories.contains(&PathBuf::from(system)),
                    "missing standard macOS tool directory: {system}"
                );
            }
        }
    }

    // 下方既有测试只在 Windows 上运行，平台无关的 PATH 测试显式导入依赖。
    #[cfg(windows)]
    use super::*;
    #[cfg(windows)]
    use std::fs;

    #[cfg(windows)]
    #[test]
    fn discovery_prefers_native_exe_over_npm_shims() {
        let root =
            std::env::temp_dir().join(format!("zeditor-process-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let shell_shim = root.join("codex");
        let cmd_shim = root.join("codex.cmd");
        let native_exe = root.join("codex.exe");
        fs::write(&shell_shim, "#!/bin/sh").unwrap();
        fs::write(&cmd_shim, "@echo off").unwrap();
        fs::write(&native_exe, []).unwrap();

        assert_eq!(
            select_discovered([shell_shim, cmd_shim, native_exe.clone()]),
            Some(native_exe)
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn path_discovery_does_not_need_a_shell_process() {
        let root =
            std::env::temp_dir().join(format!("zeditor-discovery-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let shim = root.join("opencode.cmd");
        fs::write(&shim, "@echo off").unwrap();

        assert_eq!(
            discover_in_directories("opencode", [root.clone()]),
            Some(shim)
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn official_extension_discovery_prefers_the_newest_codex_binary() {
        let root = std::env::temp_dir().join(format!(
            "zeditor-codex-extension-test-{}",
            uuid::Uuid::new_v4()
        ));
        let older = root
            .join("openai.chatgpt-1.0.0-win32-x64")
            .join("bin")
            .join("windows-x86_64")
            .join("codex.exe");
        let newer = root
            .join("openai.chatgpt-2.0.0-win32-x64")
            .join("bin")
            .join("windows-x86_64")
            .join("codex.exe");
        fs::create_dir_all(older.parent().unwrap()).unwrap();
        fs::create_dir_all(newer.parent().unwrap()).unwrap();
        fs::write(&older, []).unwrap();
        fs::write(&newer, []).unwrap();

        assert_eq!(
            official_codex_candidates_from_roots([root.clone()]),
            vec![newer, older]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn extension_version_sorting_is_numeric_not_lexicographic() {
        // 回归测试：字符串排序会把 "10.0.0" 排在 "9.0.0" 之前（即认为更旧）。
        let root = std::env::temp_dir().join(format!(
            "zeditor-codex-semver-test-{}",
            uuid::Uuid::new_v4()
        ));
        let nine = root
            .join("openai.chatgpt-9.0.0-win32-x64")
            .join("bin")
            .join("windows-x86_64")
            .join("codex.exe");
        let ten = root
            .join("openai.chatgpt-10.0.0-win32-x64")
            .join("bin")
            .join("windows-x86_64")
            .join("codex.exe");
        fs::create_dir_all(nine.parent().unwrap()).unwrap();
        fs::create_dir_all(ten.parent().unwrap()).unwrap();
        fs::write(&nine, []).unwrap();
        fs::write(&ten, []).unwrap();

        assert_eq!(
            official_codex_candidates_from_roots([root.clone()]),
            vec![ten, nine]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn claude_discovery_uses_native_npm_binary_before_cmd_shim() {
        let root = std::env::temp_dir().join(format!(
            "zeditor-claude-discovery-test-{}",
            uuid::Uuid::new_v4()
        ));
        let native = root
            .join("node_modules")
            .join("@anthropic-ai")
            .join("claude-code")
            .join("bin")
            .join("claude.exe");
        fs::create_dir_all(native.parent().unwrap()).unwrap();
        fs::write(&native, []).unwrap();

        assert_eq!(
            official_claude_candidates_from_roots([root.clone()]),
            vec![native]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn cmd_shims_run_without_a_console_window() {
        let root =
            std::env::temp_dir().join(format!("zeditor command test {}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let shim = root.join("agent.cmd");
        fs::write(&shim, "@echo off\r\necho %1").unwrap();

        let output = executable_command(&shim)
            .unwrap()
            .arg("ready")
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "ready");
        fs::remove_dir_all(root).unwrap();
    }
}
