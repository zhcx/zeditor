mod client;
pub mod genies;
mod prompts;

use tauri::WebviewWindow;

use crate::commands::{self, AISettings};

pub use client::AIResponse;

/// 本地免密钥提供商（如 Ollama）：无需配置 API 密钥即可调用。
fn provider_requires_key(settings: &AISettings) -> bool {
    settings.provider != "ollama"
}

/// 将 AI 操作隔离到独立 tokio task 中，通过 JoinError 捕获 panic，
/// 防止 hyper/reqwest 内部 panic 导致进程死亡。
#[allow(clippy::too_many_arguments)]
async fn run_ai_action_safely(
    action: String,
    content: String,
    context: Option<String>,
    settings: AISettings,
    temperature: Option<f32>,
    max_tokens: Option<u32>,
    doc_context: Option<String>,
    doc_title: Option<String>,
    enable_thinking: bool,
) -> Result<AIResponse, String> {
    let action_for_log = action.clone();
    let handle = tokio::task::spawn(async move {
        match action.as_str() {
            "proofread" => {
                client::proofread(&content, &settings, settings.proofread_use_agent).await
            }
            "companion" => {
                client::companion(
                    &content,
                    context.as_deref(),
                    &settings,
                    settings.companion_use_agent,
                )
                .await
            }
            "rewrite" => client::rewrite(&content, &settings).await,
            "translate" => client::translate(&content, context.as_deref(), &settings).await,
            "summarize" => client::summarize(&content, &settings).await,
            "outline" => client::outline(&content, &settings).await,
            "filename" => client::filename(&content, &settings).await,
            "polish" => client::polish(&content, &settings).await,
            "condense" => client::condense(&content, &settings).await,
            "simplify" => client::simplify(&content, &settings).await,
            "expand" => client::expand(&content, &settings).await,
            "vivid" => client::vivid(&content, &settings).await,
            "title" => client::title(&content, &settings).await,
            "transform" => client::transform(&content, context.as_deref(), &settings).await,
            "chat" => {
                client::chat(
                    &content,
                    context.as_deref(),
                    &settings,
                    temperature,
                    max_tokens,
                    doc_context,
                    doc_title,
                    enable_thinking,
                )
                .await
            }
            _ => Err(format!("未知的AI操作: {}", action)),
        }
    });

    match handle.await {
        Ok(result) => result,
        Err(join_error) => {
            let msg = if join_error.is_panic() {
                let payload = join_error.into_panic();
                let info = payload
                    .downcast_ref::<&str>()
                    .map(|s| (*s).to_string())
                    .or_else(|| payload.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "unknown panic".to_string());
                format!("[{}] task panic: {}", action_for_log, info)
            } else {
                format!("[{}] task cancelled: {}", action_for_log, join_error)
            };
            eprintln!("{}", msg);
            commands::log_to_file(&msg);
            Err(msg)
        }
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ai_request(
    action: String,
    content: String,
    context: Option<String>,
    settings: AISettings,
    temperature: Option<f32>,
    max_tokens: Option<u32>,
    doc_context: Option<String>,
    doc_title: Option<String>,
    enable_thinking: Option<bool>,
) -> Result<AIResponse, String> {
    // 这里不再因「未启用 / 缺少密钥」直接报错：call_api_with_messages 会把
    // 同一动作交给本地 Agent 后备（agent::bridge）执行，全部失败时才返回
    // 可读的组合错误。AI 助手与本地 Agent 因此互为可用路径。
    run_ai_action_safely(
        action,
        content,
        context,
        settings,
        temperature,
        max_tokens,
        doc_context,
        doc_title,
        enable_thinking.unwrap_or(false),
    )
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ai_chat_streaming(
    content: String,
    context: Option<String>,
    settings: AISettings,
    temperature: Option<f32>,
    max_tokens: Option<u32>,
    doc_context: Option<String>,
    doc_title: Option<String>,
    enable_thinking: Option<bool>,
    request_id: String,
    window: WebviewWindow,
) -> Result<(), String> {
    // 聊天是交互流式场景，不桥接 Agent（无打字机体验）；未配置时引导用户
    // 切换到聊天面板内置的 Agent 运行时（RuntimeTabs）。
    if !settings.enabled {
        return Err(
            "AI 助手未启用。请在设置中配置，或点击面板顶部的「Agent」切换到本地 Agent 运行时"
                .to_string(),
        );
    }

    if settings.api_key.is_empty() && provider_requires_key(&settings) {
        return Err(
            "请先配置 API 密钥，或点击面板顶部的「Agent」切换到本地 Agent 运行时".to_string(),
        );
    }

    // chat_streaming 也用 spawn 隔离，防止 panic 传播
    let handle = tokio::task::spawn(async move {
        client::chat_streaming(
            &content,
            context.as_deref(),
            &settings,
            temperature,
            max_tokens,
            doc_context,
            doc_title,
            enable_thinking.unwrap_or(false),
            request_id,
            window,
        )
        .await
    });

    match handle.await {
        Ok(result) => result,
        Err(join_error) => {
            let msg = if join_error.is_panic() {
                format!("[chat_streaming] task panic: {}", join_error)
            } else {
                format!("[chat_streaming] task cancelled: {}", join_error)
            };
            eprintln!("{}", msg);
            commands::log_to_file(&msg);
            Err(msg)
        }
    }
}

#[tauri::command]
pub async fn ai_streaming(
    action: String,
    content: String,
    settings: AISettings,
    window: WebviewWindow,
) -> Result<(), String> {
    if !settings.enabled {
        return Err("AI功能未启用".to_string());
    }

    if settings.api_key.is_empty() && provider_requires_key(&settings) {
        return Err("请先配置API密钥".to_string());
    }

    client::streaming_request(&action, &content, &settings, window).await
}

#[tauri::command]
pub async fn fetch_ai_models(
    api_key: String,
    api_endpoint: String,
    provider: Option<String>,
) -> Result<Vec<String>, String> {
    // Ollama 等本地提供商无需密钥即可拉取模型列表。
    if api_key.is_empty() && provider.as_deref() != Some("ollama") {
        return Err("API密钥不能为空".to_string());
    }
    if api_endpoint.is_empty() {
        return Err("API端点不能为空".to_string());
    }

    client::fetch_models(&api_key, &api_endpoint).await
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct EnvKeyResult {
    pub api_key: String,
    pub var_name: String,
}

/// 按服务商读取常见的环境变量 API 密钥，用于设置页一键导入。
/// 变量在进程启动时读取一次；Windows 用户/系统变量对 GUI 启动同样生效。
#[tauri::command]
pub fn read_ai_env_key(provider: String) -> Option<EnvKeyResult> {
    let candidates: &[&str] = match provider.as_str() {
        "anthropic" => &["ANTHROPIC_API_KEY"],
        "openai" => &["OPENAI_API_KEY"],
        "gemini" => &["GOOGLE_API_KEY", "GEMINI_API_KEY"],
        "deepseek" => &["DEEPSEEK_API_KEY"],
        "kimi" => &["MOONSHOT_API_KEY", "KIMI_API_KEY"],
        "zhipu" => &["ZHIPUAI_API_KEY", "ZHIPU_API_KEY"],
        "minimax" => &["MINIMAX_API_KEY"],
        "siliconflow" => &["SILICONFLOW_API_KEY"],
        "mimo" => &["MIMO_API_KEY"],
        "volcengine" => &["ARK_API_KEY", "VOLCENGINE_API_KEY"],
        "longcat" => &["LONGCAT_API_KEY"],
        _ => &[],
    };

    for var_name in candidates {
        if let Ok(value) = std::env::var(var_name) {
            let trimmed = value.trim().to_string();
            if !trimmed.is_empty() {
                return Some(EnvKeyResult {
                    api_key: trimmed,
                    var_name: (*var_name).to_string(),
                });
            }
        }
    }
    None
}
