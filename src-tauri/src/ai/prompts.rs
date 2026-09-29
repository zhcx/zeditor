use crate::commands::AISettings;

#[derive(Debug, Clone, Copy)]
pub enum PromptAction {
    Proofread,
    Companion,
    Rewrite,
    Translate,
    Summarize,
    Outline,
    Chat,
    Filename,
    Polish,
    Condense,
    Simplify,
    Expand,
    Vivid,
    Title,
    /// 自定义精灵 / 自由格式指令：context 为用户指令，content 为待处理文本。
    Transform,
}

fn get_style_prompt(settings: &AISettings) -> String {
    if settings.writing_style == "custom" && !settings.custom_style_prompt.trim().is_empty() {
        return settings.custom_style_prompt.trim().to_string();
    }

    match settings.writing_style.as_str() {
        "formal" => "请使用正式、专业、清晰的表达风格".to_string(),
        "casual" => "请使用轻松、自然、有亲和力的表达风格".to_string(),
        "academic" => "请使用严谨、准确、偏学术的表达风格".to_string(),
        "creative" => "请使用富有创意、节奏更鲜明的表达风格".to_string(),
        _ => "请使用自然、流畅、易读的表达风格".to_string(),
    }
}

pub fn get_prompt(
    action: PromptAction,
    content: &str,
    context: Option<&str>,
    settings: &AISettings,
) -> String {
    match action {
        PromptAction::Proofread => format!(
            r#"你是一个文本校对助手。校对下面的文本，只找真实的拼写、语法、标点错误。

规则：
- 只输出 JSON 数组，不要任何其他文字
- 没问题时输出：[]
- from/to 是字符位置索引（从0开始），to不包含
- type 只能是：spelling、grammar、punctuation、style、markdown、layout
- 每次只改最小范围（1-10个字符）

示例：
[{{"from":5,"to":7,"original":"的","suggestion":"地","type":"grammar","explanation":"副词后应用地"}}]

文本：
{}"#,
            content
        ),
        PromptAction::Companion => {
            let style = get_style_prompt(settings);
            let context_info = context
                .filter(|c| !c.trim().is_empty())
                .map(|c| format!("\n\n前文上下文：\n{}", c))
                .unwrap_or_default();

            format!(
                r#"{}。请根据下面内容给出 3 条可直接接在光标后的续写建议。

要求：
1. 每条建议 1-3 句话，延续原文语气，不重复原文。
2. 只输出 JSON 数组格式的字符串，例如：["建议 1", "建议 2", "建议 3"]
3. 数组元素必须是字符串。
4. 无论上下文长短，都必须返回至少 1 条续写建议。

格式示例：["续写建议一", "续写建议二", "续写建议三"]{}

内容：
{}"#,
                style, context_info, content
            )
        }
        PromptAction::Rewrite => {
            let style = get_style_prompt(settings);
            format!(
                r#"{}。请重写下面的内容，保持原意，提升表达质量。直接输出重写后的文本。

内容：
{}"#,
                style, content
            )
        }
        PromptAction::Translate => {
            let target_lang = context.unwrap_or("英文");
            format!(
                r#"请将下面内容翻译成{}。如果原文已经是英文且目标为英文，请翻译成中文。保留 Markdown 结构，直接输出译文。

内容：
{}"#,
                target_lang, content
            )
        }
        PromptAction::Summarize => format!(
            r#"请为下面内容生成 100 字以内的中文摘要，突出主要观点，直接输出摘要。

内容：
{}"#,
            content
        ),
        PromptAction::Outline => format!(
            r#"请根据下面内容生成一个清晰、可执行的写作大纲，使用 Markdown 列表输出。

内容：
{}"#,
            content
        ),
        PromptAction::Chat => {
            let style = get_style_prompt(settings);
            format!(
                r#"{}。你是一个有用的 AI 助手，帮助用户进行写作、编辑和讨论 Markdown 文档。
请根据对话历史自然地回复用户的最新消息。
直接输出你的回复，不要添加额外的前缀或格式标记。"#,
                style
            )
        }
        PromptAction::Filename => format!(
            r#"你是一个文件命名助手。为下面的文档内容拟一个文件名。

规则：
- 只输出文件名本身：不要引号、不要句号、不要扩展名、不要任何解释
- 中文文档用中文命名，英文文档用英文命名
- 不超过 12 个字（词），概括文档主题
- 不能包含 \ / : * ? " < > | 等字符
- 无法概括时输出「未命名」

文档内容：
{}"#,
            content
        ),
        PromptAction::Polish => {
            let style = get_style_prompt(settings);
            format!(
                r#"你是一位资深编辑。{style}。请润色下面的文本，提升清晰度和流畅性。

规则：
- 保留作者的声音与意图，不改变含义、语气和事实
- 只输出润色后的文本，不要任何解释或前后缀
- 保留原有的 Markdown 格式

文本：
{content}"#,
                style = style,
                content = content
            )
        }
        PromptAction::Condense => format!(
            r#"你是一位资深编辑。请精简下面的文本，使其更简洁。

规则：
- 删除冗余表达和填充词，不遗漏关键信息，不改变含义
- 只输出精简后的文本，不要任何解释或前后缀
- 保留原有的 Markdown 格式

文本：
{}"#,
            content
        ),
        PromptAction::Simplify => format!(
            r#"你是一位通俗化写作专家。请用更简单的语言改写下面的文本。

规则：
- 用平实的词汇和短句，让普通读者也能轻松理解
- 保持原意不变，专业术语改为日常说法（必要时在括号内保留原术语）
- 只输出改写后的文本，不要任何解释或前后缀

文本：
{}"#,
            content
        ),
        PromptAction::Expand => format!(
            r#"你是一位经验丰富的作者。请将下面的内容扩展为更完整的段落。

规则：
- 补充合理的细节、例子和过渡，把想法发展成完整表达
- 不虚构具体的事实、数据或引用；不确定的内容用概括性表述
- 延续原文的语气、人称与 Markdown 格式习惯
- 只输出扩展后的文本，不要任何解释或前后缀

内容：
{}"#,
            content
        ),
        PromptAction::Vivid => format!(
            r#"你是一位文笔生动的作家。请改写下面的文本，添加感官细节和意象，让画面感更强。

规则：
- 调动视觉、听觉、触觉等感官细节，使用贴切的比喻和意象
- 不改变核心含义，不堆砌形容词
- 只输出改写后的文本，不要任何解释或前后缀

文本：
{}"#,
            content
        ),
        PromptAction::Title => format!(
            r#"你是一位起标题专家。请为下面的文档内容建议标题。

规则：
- 输出 5 个候选标题，每行一个，不要编号、引号或任何解释
- 标题风格多样：准确概括型、吸引眼球型、简洁有力型各至少一个
- 每个标题不超过 20 个字

文档内容：
{}"#,
            content
        ),
        PromptAction::Transform => {
            let instruction = context.unwrap_or("改进下面的文本。").trim();
            format!(
                r#"你是一位专业的写作与文本处理助手。请严格按照用户的指令处理文本。

规则：
- 只输出处理结果本身，不要添加解释、前言或后缀
- 保留文本原有的 Markdown 格式习惯，除非指令另有要求

用户指令：
{}

待处理文本：
{}"#,
                instruction, content
            )
        }
    }
}
