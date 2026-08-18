// Prevents an additional console window on Windows, including debug builds.
#![cfg_attr(windows, windows_subsystem = "windows")]

use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{Emitter, Manager, State};

mod agent;
mod ai;
mod commands;
mod converter;
mod graph;
mod image;
mod imaging;
mod pdf;

#[tauri::command]
fn exit_application(app: tauri::AppHandle) {
    app.exit(0);
}

#[derive(Default)]
struct PendingOpenFiles(Mutex<Vec<String>>);

impl PendingOpenFiles {
    fn enqueue_open_files(&self, paths: Vec<String>) {
        let mut pending = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for path in paths {
            if !pending.contains(&path) {
                pending.push(path);
            }
        }
    }

    fn take(&self) -> Vec<String> {
        let mut pending = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        std::mem::take(&mut *pending)
    }
}

fn openable_document_paths<I, S>(args: I, cwd: &Path) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    args.into_iter()
        .filter_map(|argument| {
            let argument = PathBuf::from(argument.as_ref());
            let path = if argument.is_absolute() {
                argument
            } else {
                cwd.join(argument)
            };
            let supported = path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| {
                    matches!(
                        extension.to_ascii_lowercase().as_str(),
                        "md" | "markdown" | "txt"
                    )
                });
            supported.then(|| path.to_string_lossy().into_owned())
        })
        .collect()
}

fn initial_open_files() -> Vec<String> {
    let cwd = std::env::current_dir().unwrap_or_default();
    openable_document_paths(std::env::args_os().skip(1), &cwd)
}

#[tauri::command]
fn take_pending_open_files(state: State<'_, PendingOpenFiles>) -> Vec<String> {
    state.take()
}

// Prevent Tauri commands from panicking across the FFI boundary.
// Replace any remaining unwrap/expect in hot paths with proper error propagation.
// clippy::unwrap_used is not enabled globally; this is a targeted hardening.

fn main() {
    // 使用 args_os：args() 在遇到非 UTF-8 参数（如路径含非法字节的
    // 文件拖入）时会直接 panic；与上方 initial_open_files 保持一致。
    let args: Vec<String> = std::env::args_os()
        .map(|value| value.to_string_lossy().into_owned())
        .collect();
    if args
        .get(1)
        .is_some_and(|value| value == "--agent-permission-hook")
    {
        let result: Result<(), String> = args
            .get(2)
            .ok_or_else(|| "missing permission bridge directory".to_string())
            .map(PathBuf::from)
            .and_then(|path| agent::run_permission_hook(&path));
        if let Err(error) = result {
            eprintln!("Zeditor permission bridge failed: {error}");
        }
        return;
    }
    // Install a global panic hook that writes to stderr instead of
    // crashing the process immediately — the Tauri runtime handles the
    // error gracefully and the window stays open.
    std::panic::set_hook(Box::new(|info| {
        let msg = info.to_string();
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown location".to_string());
        let full = format!("[ZEDITOR PANIC] {location}: {msg}");
        eprintln!("{}", full);
        // 同时写入文件，方便 Windows GUI 模式下诊断。
        // 超过 1 MiB 时轮转重建，避免长期使用无限膨胀。
        let log_path = std::env::temp_dir().join("zeditor_crash.log");
        use std::io::Write;
        let needs_rotation = std::fs::metadata(&log_path)
            .map(|meta| meta.len() > 1024 * 1024)
            .unwrap_or(false);
        if needs_rotation {
            let _ = std::fs::remove_file(&log_path);
        }
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
        {
            let _ = writeln!(f, "[PANIC] {}", full);
        }
    }));

    let pending_open_files = PendingOpenFiles(Mutex::new(initial_open_files()));

    tauri::Builder::default()
        // This must be the first plugin: later launches deliver their argv to
        // the existing process instead of opening a second editor window.
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let paths = openable_document_paths(args.into_iter().skip(1), Path::new(&cwd));
            if !paths.is_empty() {
                app.state::<PendingOpenFiles>()
                    .enqueue_open_files(paths.clone());
                let _ = app.emit("open-files", paths);
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            exit_application,
            take_pending_open_files,
            commands::get_settings,
            commands::save_settings,
            commands::get_local_font_families,
            commands::upload_image,
            commands::upload_image_bytes,
            commands::export_pdf,
            commands::export_html,
            commands::export_word,
            commands::get_file_content,
            commands::get_text_attachment_content,
            converter::convert_document,
            converter::get_converter_module_status,
            converter::check_converter_module_update,
            converter::install_converter_module,
            converter::cancel_converter_install,
            converter::import_converter_module,
            converter::uninstall_converter_module,
            commands::save_file_content,
            commands::load_pdf_annotations,
            commands::save_pdf_annotations,
            commands::read_file_base64,
            commands::reveal_in_file_manager,
            commands::get_recent_files,
            commands::update_recent_file,
            commands::remove_recent_file,
            commands::read_folder,
            commands::create_file,
            commands::create_directory,
            commands::delete_fs_item,
            commands::rename_fs_item,
            commands::copy_fs_item,
            commands::get_recent_folders,
            commands::update_recent_folder,
            commands::remove_recent_folder,
            commands::workspace_search,
            graph::build_workspace_graph,
            commands::web_search,
            commands::check_for_updates,
            commands::download_and_install_update,
            commands::finalize_update_install,
            ai::ai_request,
            ai::ai_streaming,
            ai::ai_chat_streaming,
            ai::fetch_ai_models,
            agent::agent_detect_backends,
            agent::agent_list_models,
            agent::agent_list_sessions,
            agent::agent_get_session_events,
            agent::agent_start_turn,
            agent::agent_respond_approval,
            agent::agent_set_approval_mode,
            agent::agent_cancel_turn,
            agent::agent_get_changes,
            agent::agent_apply_changes,
            agent::agent_discard_session,
            pdf::converter::export_pdf_direct,
        ])
        .manage(pending_open_files)
        .setup(|_app| {
            let agent_storage = _app.path().app_data_dir()?.join("agent-runtime");
            _app.manage(agent::AgentSupervisor::new(agent_storage));
            _app.manage(converter::ConverterManager::default());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::openable_document_paths;
    use std::path::Path;

    #[test]
    fn resolves_supported_launch_arguments_against_the_launch_directory() {
        let paths = openable_document_paths(
            [
                "notes.md",
                "chapter.MARKDOWN",
                "draft.txt",
                "image.png",
                "--flag",
            ],
            Path::new("C:\\documents"),
        );

        assert_eq!(
            paths,
            vec![
                "C:\\documents\\notes.md",
                "C:\\documents\\chapter.MARKDOWN",
                "C:\\documents\\draft.txt",
            ]
        );
    }
}
