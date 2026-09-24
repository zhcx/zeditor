export type AppLanguage = 'zh-CN' | 'zh-TW' | 'en';

export const LANGUAGE_OPTIONS: ReadonlyArray<{ value: AppLanguage; nativeLabel: string }> = [
  { value: 'zh-CN', nativeLabel: '简体中文' },
  { value: 'zh-TW', nativeLabel: '繁體中文' },
  { value: 'en', nativeLabel: 'English' },
];

export function detectSystemLanguage(languages?: readonly string[]): AppLanguage {
  const candidates = languages?.length
    ? languages
    : (typeof navigator !== 'undefined' ? navigator.languages : []);
  const locale = (candidates[0] || (typeof navigator !== 'undefined' ? navigator.language : '') || '').toLowerCase();

  if (/^zh(?:-|_)(?:tw|hk|mo|hant)\b/.test(locale) || locale === 'zh-hant') return 'zh-TW';
  if (locale === 'zh' || /^zh(?:-|_)/.test(locale)) return 'zh-CN';
  if (locale === 'en' || /^en(?:-|_)/.test(locale)) return 'en';
  return 'zh-CN';
}

export function normalizeLanguage(value: unknown, fallback = detectSystemLanguage()): AppLanguage {
  return value === 'zh-CN' || value === 'zh-TW' || value === 'en' ? value : fallback;
}

type Translation = { 'zh-CN': string; 'zh-TW': string; en: string };

const entries: Record<string, Translation> = {
  '语言': { 'zh-CN': '语言', 'zh-TW': '語言', en: 'Language' },
  '界面显示语言': { 'zh-CN': '界面显示语言', 'zh-TW': '介面顯示語言', en: 'Display language' },
  '根据系统语言自动选择，也可手动更改': { 'zh-CN': '根据系统语言自动选择，也可手动更改', 'zh-TW': '根據系統語言自動選擇，也可手動更改', en: 'Selected automatically from your system language; you can change it at any time' },
  '设置': { 'zh-CN': '设置', 'zh-TW': '設定', en: 'Settings' },
  '设置分类': { 'zh-CN': '设置分类', 'zh-TW': '設定分類', en: 'Settings categories' },
  '关闭设置': { 'zh-CN': '关闭设置', 'zh-TW': '關閉設定', en: 'Close settings' },
  '外观': { 'zh-CN': '外观', 'zh-TW': '外觀', en: 'Appearance' },
  '主题、界面字体与内容显示': { 'zh-CN': '主题、界面字体与内容显示', 'zh-TW': '主題、介面字體與內容顯示', en: 'Theme, interface fonts, and content display' },
  '编辑器': { 'zh-CN': '编辑器', 'zh-TW': '編輯器', en: 'Editor' },
  '编辑体验与自动保存': { 'zh-CN': '编辑体验与自动保存', 'zh-TW': '編輯體驗與自動儲存', en: 'Editing experience and autosave' },
  '图床': { 'zh-CN': '图床', 'zh-TW': '圖床', en: 'Image hosting' },
  '图片上传与存储服务': { 'zh-CN': '图片上传与存储服务', 'zh-TW': '圖片上傳與儲存服務', en: 'Image upload and storage services' },
  '导出': { 'zh-CN': '导出', 'zh-TW': '匯出', en: 'Export' },
  '文档导出与版式设置': { 'zh-CN': '文档导出与版式设置', 'zh-TW': '文件匯出與版式設定', en: 'Document export and layout' },
  'AI 助手': { 'zh-CN': 'AI 助手', 'zh-TW': 'AI 助手', en: 'AI Assistant' },
  '模型、提示与伴写设置': { 'zh-CN': '模型、提示与伴写设置', 'zh-TW': '模型、提示與伴寫設定', en: 'Model, prompting, and writing settings' },
  '网络搜索': { 'zh-CN': '网络搜索', 'zh-TW': '網路搜尋', en: 'Web search' },
  '搜索服务与结果偏好': { 'zh-CN': '搜索服务与结果偏好', 'zh-TW': '搜尋服務與結果偏好', en: 'Search services and result preferences' },
  '主题': { 'zh-CN': '主题', 'zh-TW': '主題', en: 'Theme' },
  '跟随系统': { 'zh-CN': '跟随系统', 'zh-TW': '跟隨系統', en: 'Follow system' },
  '界面字体': { 'zh-CN': '界面字体', 'zh-TW': '介面字體', en: 'Interface font' },
  '内容字体': { 'zh-CN': '内容字体', 'zh-TW': '內容字體', en: 'Content font' },
  '字号': { 'zh-CN': '字号', 'zh-TW': '字號', en: 'Font size' },
  '行高': { 'zh-CN': '行高', 'zh-TW': '行高', en: 'Line height' },
  '小': { 'zh-CN': '小', 'zh-TW': '小', en: 'Small' },
  '默认': { 'zh-CN': '默认', 'zh-TW': '預設', en: 'Default' },
  '大': { 'zh-CN': '大', 'zh-TW': '大', en: 'Large' },
  '保存': { 'zh-CN': '保存', 'zh-TW': '儲存', en: 'Save' },
  '取消': { 'zh-CN': '取消', 'zh-TW': '取消', en: 'Cancel' },
  '关闭': { 'zh-CN': '关闭', 'zh-TW': '關閉', en: 'Close' },
  '确认': { 'zh-CN': '确认', 'zh-TW': '確認', en: 'Apply' },
  '链接': { 'zh-CN': '链接', 'zh-TW': '連結', en: 'Link' },
  '图片': { 'zh-CN': '图片', 'zh-TW': '圖片', en: 'Image' },
  '数学公式': { 'zh-CN': '数学公式', 'zh-TW': '數學公式', en: 'Math' },
  '脚注': { 'zh-CN': '脚注', 'zh-TW': '腳註', en: 'Footnote' },
  'Wiki 链接': { 'zh-CN': 'Wiki 链接', 'zh-TW': 'Wiki 連結', en: 'Wiki Link' },
  '文字': { 'zh-CN': '文字', 'zh-TW': '文字', en: 'Text' },
  '链接文字': { 'zh-CN': '链接文字', 'zh-TW': '連結文字', en: 'Link text' },
  '来源': { 'zh-CN': '来源', 'zh-TW': '來源', en: 'Source' },
  '替代文本': { 'zh-CN': '替代文本', 'zh-TW': '替代文字', en: 'Alt text' },
  '标题': { 'zh-CN': '标题', 'zh-TW': '標題', en: 'Title' },
  '尺寸属性将原样保留': { 'zh-CN': '尺寸属性将原样保留', 'zh-TW': '尺寸屬性將原樣保留', en: 'Size attributes are kept as-is' },
  '标记': { 'zh-CN': '标记', 'zh-TW': '標記', en: 'Label' },
  '内容': { 'zh-CN': '内容', 'zh-TW': '內容', en: 'Content' },
  '未找到定义，确认后会在文末创建': { 'zh-CN': '未找到定义，确认后会在文末创建', 'zh-TW': '未找到定義，確認後會在文末建立', en: 'No definition found; one will be appended on apply' },
  '目标': { 'zh-CN': '目标', 'zh-TW': '目標', en: 'Target' },
  '显示文字': { 'zh-CN': '显示文字', 'zh-TW': '顯示文字', en: 'Display text' },
  '可选': { 'zh-CN': '可选', 'zh-TW': '可選', en: 'Optional' },
  '移除链接': { 'zh-CN': '移除链接', 'zh-TW': '移除連結', en: 'Remove link' },
  '删除': { 'zh-CN': '删除', 'zh-TW': '刪除', en: 'Delete' },
  '浏览': { 'zh-CN': '浏览', 'zh-TW': '瀏覽', en: 'Browse' },
  '跳转到定义': { 'zh-CN': '跳转到定义', 'zh-TW': '跳轉到定義', en: 'Jump to definition' },
  '撤销': { 'zh-CN': '撤销', 'zh-TW': '復原', en: 'Undo' },
  '重做': { 'zh-CN': '重做', 'zh-TW': '重做', en: 'Redo' },
  '剪切': { 'zh-CN': '剪切', 'zh-TW': '剪下', en: 'Cut' },
  '复制': { 'zh-CN': '复制', 'zh-TW': '複製', en: 'Copy' },
  '粘贴': { 'zh-CN': '粘贴', 'zh-TW': '貼上', en: 'Paste' },
  '全选': { 'zh-CN': '全选', 'zh-TW': '全選', en: 'Select All' },
  '文件': { 'zh-CN': '文件', 'zh-TW': '檔案', en: 'File' },
  '功能': { 'zh-CN': '功能', 'zh-TW': '功能', en: 'Actions' },
  '新建': { 'zh-CN': '新建', 'zh-TW': '新增', en: 'New' },
  '打开': { 'zh-CN': '打开', 'zh-TW': '開啟', en: 'Open' },
  '另存为': { 'zh-CN': '另存为', 'zh-TW': '另存新檔', en: 'Save As' },
  '分屏模式': { 'zh-CN': '分屏模式', 'zh-TW': '分割模式', en: 'Split view' },
  '沉浸阅读': { 'zh-CN': '沉浸阅读', 'zh-TW': '沉浸閱讀', en: 'Focus reading' },
  '沉浸写作': { 'zh-CN': '沉浸写作', 'zh-TW': '沉浸寫作', en: 'Focus writing' },
  '资源管理器': { 'zh-CN': '资源管理器', 'zh-TW': '檔案管理器', en: 'Explorer' },
  '搜索': { 'zh-CN': '搜索', 'zh-TW': '搜尋', en: 'Search' },
  '大纲': { 'zh-CN': '大纲', 'zh-TW': '大綱', en: 'Outline' },
  '文档大纲': { 'zh-CN': '文档大纲', 'zh-TW': '文件大綱', en: 'Document outline' },
  '时间线': { 'zh-CN': '时间线', 'zh-TW': '時間軸', en: 'Timeline' },
  '打开的编辑器': { 'zh-CN': '打开的编辑器', 'zh-TW': '已開啟的編輯器', en: 'Open editors' },
  '新建文件': { 'zh-CN': '新建文件', 'zh-TW': '新增檔案', en: 'New file' },
  '打开文件': { 'zh-CN': '打开文件', 'zh-TW': '開啟檔案', en: 'Open file' },
  '打开文件夹': { 'zh-CN': '打开文件夹', 'zh-TW': '開啟資料夾', en: 'Open folder' },
  '预览': { 'zh-CN': '预览', 'zh-TW': '預覽', en: 'Preview' },
  '应用': { 'zh-CN': '应用', 'zh-TW': '套用', en: 'Apply' },
  '忽略': { 'zh-CN': '忽略', 'zh-TW': '忽略', en: 'Ignore' },
  '刷新': { 'zh-CN': '刷新', 'zh-TW': '重新整理', en: 'Refresh' },
  '原文': { 'zh-CN': '原文', 'zh-TW': '原文', en: 'Original' },
  '译文': { 'zh-CN': '译文', 'zh-TW': '譯文', en: 'Translation' },
  '翻译结果': { 'zh-CN': '翻译结果', 'zh-TW': '翻譯結果', en: 'Translation result' },
  '复制为 Markdown 脚注来源': { 'zh-CN': '复制为 Markdown 脚注来源', 'zh-TW': '複製為 Markdown 腳註來源', en: 'Copy as Markdown footnote sources' },
  '没有找到相关结果': { 'zh-CN': '没有找到相关结果', 'zh-TW': '找不到相關結果', en: 'No relevant results found' },
  '插入图片': { 'zh-CN': '插入图片', 'zh-TW': '插入圖片', en: 'Insert image' },
  '插入视频': { 'zh-CN': '插入视频', 'zh-TW': '插入影片', en: 'Insert video' },
  '插入表格': { 'zh-CN': '插入表格', 'zh-TW': '插入表格', en: 'Insert table' },
  '导出为图片': { 'zh-CN': '导出为图片', 'zh-TW': '匯出為圖片', en: 'Export as image' },
  '页面设置': { 'zh-CN': '页面设置', 'zh-TW': '頁面設定', en: 'Page setup' },
  '页面方向': { 'zh-CN': '页面方向', 'zh-TW': '頁面方向', en: 'Orientation' },
  '纵向': { 'zh-CN': '纵向', 'zh-TW': '直向', en: 'Portrait' },
  '横向': { 'zh-CN': '横向', 'zh-TW': '橫向', en: 'Landscape' },
  '包含目录': { 'zh-CN': '包含目录', 'zh-TW': '包含目錄', en: 'Include table of contents' },
  '包含封面': { 'zh-CN': '包含封面', 'zh-TW': '包含封面', en: 'Include cover' },
  '导出失败': { 'zh-CN': '导出失败', 'zh-TW': '匯出失敗', en: 'Export failed' },
  '正在导出': { 'zh-CN': '正在导出', 'zh-TW': '正在匯出', en: 'Exporting' },
  '检查更新': { 'zh-CN': '检查更新', 'zh-TW': '檢查更新', en: 'Check for updates' },
  '关于 Zeditor': { 'zh-CN': '关于 Zeditor', 'zh-TW': '關於 Zeditor', en: 'About Zeditor' },
  '快捷键说明': { 'zh-CN': '快捷键说明', 'zh-TW': '快捷鍵說明', en: 'Keyboard shortcuts' },
  '正在检查更新...': { 'zh-CN': '正在检查更新…', 'zh-TW': '正在檢查更新…', en: 'Checking for updates…' },
  '已是最新版本': { 'zh-CN': '已是最新版本', 'zh-TW': '已是最新版本', en: 'You are up to date' },
  '发现新版本': { 'zh-CN': '发现新版本', 'zh-TW': '發現新版本', en: 'Update available' },
  '稍后提醒': { 'zh-CN': '稍后提醒', 'zh-TW': '稍後提醒', en: 'Remind me later' },
  'BEGINNER GUIDE': { 'zh-CN': '入门指南', 'zh-TW': '入門指南', en: 'BEGINNER GUIDE' },
  'Cloud Name': { 'zh-CN': '云名称', 'zh-TW': '雲端名稱', en: 'Cloud Name' },
  'API Secret': { 'zh-CN': 'API 密钥', 'zh-TW': 'API 密鑰', en: 'API Secret' },
  'Endpoint': { 'zh-CN': '服务端点', 'zh-TW': '服務端點', en: 'Endpoint' },
  'Region': { 'zh-CN': '地域', 'zh-TW': '區域', en: 'Region' },
  'Basic': { 'zh-CN': '基础', 'zh-TW': '基礎', en: 'Basic' },
  'Fast': { 'zh-CN': '快速', 'zh-TW': '快速', en: 'Fast' },
  'Advanced': { 'zh-CN': '高级', 'zh-TW': '進階', en: 'Advanced' },
  'Ultra fast': { 'zh-CN': '极速', 'zh-TW': '極速', en: 'Ultra fast' },
  'API Key': { 'zh-CN': 'API 密钥', 'zh-TW': 'API 密鑰', en: 'API Key' },
  'Access Key ID': { 'zh-CN': '访问密钥 ID', 'zh-TW': '存取密鑰 ID', en: 'Access Key ID' },
  'Access Key Secret': { 'zh-CN': '访问密钥', 'zh-TW': '存取密鑰', en: 'Access Key Secret' },
  'Dark Theme': { 'zh-CN': '深色主题', 'zh-TW': '深色主題', en: 'Dark Theme' },
  'Light Theme': { 'zh-CN': '浅色主题', 'zh-TW': '淺色主題', en: 'Light Theme' },
};

const englishEntries: Record<string, string> = {
  '入门指南': 'BEGINNER GUIDE', '基础': 'Basic', '快速': 'Fast', '高级': 'Advanced', '极速': 'Ultra fast',
  '深色主题': 'Dark Theme', '浅色主题': 'Light Theme',
  '云名称': 'Cloud Name', 'API 密钥': 'API Secret', '服务端点': 'Endpoint', '存储桶名称': 'Bucket name', '地域': 'Region', '访问密钥 ID': 'Access Key ID', '访问密钥': 'Access Key Secret',
  '功能导航': 'Feature navigation', '选择沉浸模式': 'Choose focus mode', '返回分屏模式': 'Return to split view',
  '隐藏编辑器，专注阅读预览': 'Hide the editor and focus on reading', '隐藏预览与侧栏，专注写作': 'Hide preview and sidebar and focus on writing',
  'AI 对话': 'AI Chat', '关闭 AI 对话': 'Close AI chat', '开始 AI 对话': 'Start an AI chat', '智能写作助手': 'AI writing assistant',
  '服务商': 'Provider', '模型': 'Model', '选择 AI 服务商': 'Choose AI provider', '请先在设置中配置模型': 'Configure a model in Settings first',
  '正在联网搜索': 'Searching the web', '取消关联': 'Remove attachment', '调整输入框高度': 'Resize message box', '向上拖动可增大输入框': 'Drag up to enlarge the message box',
  '上传附件': 'Attach file', '思考强度': 'Reasoning effort', '输入消息… (Enter 发送, Shift+Enter 换行)': 'Type a message… (Enter to send, Shift+Enter for a new line)',
  '清空对话': 'Clear chat', '网络搜索结果': 'Web search results', '工作区上下文': 'Workspace context', '选择工作区文件': 'Select workspace files',
  '仅检索片段，不上传全文': 'Retrieve excerpts only; do not upload full files', '摘要：': 'Summary:', '选择具体章节；未选择时使用整个文件': 'Choose sections; the whole file is used when none are selected',
  '敏感文件排除规则（名称片段，逗号分隔）': 'Sensitive-file exclusions (comma-separated name fragments)', '本轮将向': 'This request sends to', '发送：': ':',
  'AI伴写': 'AI Companion', '根据光标前文自动续写': 'Continue from the text before the cursor', '正在生成更贴合上下文的续写...': 'Generating a context-aware continuation…',
  '采用': 'Use', '暂无可用建议，试着多写一点上下文后刷新': 'No suggestion yet. Add more context and refresh.', '点击任一建议插入到当前光标处': 'Click a suggestion to insert it at the cursor',
  '确认 AI 修改': 'Confirm AI changes', '拒绝修改': 'Reject changes', 'AI 操作模式': 'AI operation mode', '修改依据：': 'Reason:', '修改前': 'Before', '修改后': 'After',
  '拒绝此处': 'Reject this change', '撤销上一轮': 'Undo previous round', '仅应用这一处': 'Apply this change only', '校对结果': 'Proofreading results', '处问题': ' issues',
  '保留原文': 'Keep original', '仅译文': 'Translation only', 'Markdown 快捷命令': 'Markdown quick commands', '没有匹配的命令': 'No matching commands', '输入文字可筛选': 'Type to filter',
  '拖动选择表格大小，松开鼠标插入': 'Drag to choose the table size; release to insert', '选择适合内容的画布比例': 'Choose a canvas ratio for the content', '导出模板': 'Export template',
  '导出 PDF': 'Export PDF', '正在导出': 'Exporting', '预设': 'Preset', '字体': 'Font', '水印': 'Watermark', '可选': 'Optional', '自定义 CSS': 'Custom CSS',
  '页面格式': 'Paper size', '页边距 (mm)': 'Margins (mm)', '包含页眉页脚': 'Include headers and footers', '公众号排版导出': 'WeChat layout export', '保存 HTML': 'Save HTML',
  'Markdown 语法分类': 'Markdown syntax categories', '3 分钟快速开始': 'Quick start in 3 minutes', '标记后通常要留空格': 'Usually add a space after a marker', '段落之间空一行': 'Leave a blank line between paragraphs',
  '边写边看右侧预览': 'Write while checking the preview', '搜索语法，例如：表格、流程图、图片': 'Search syntax, e.g. tables, flowcharts, images', '搜索 Markdown 语法': 'Search Markdown syntax',
  '从一个符号开始写 Markdown': 'Start writing Markdown with one symbol', '你会看到': 'Result', '提示': 'Tip', '没有找到相关语法': 'No matching syntax found',
  '展开大纲': 'Expand outline', '收起大纲': 'Collapse outline', '添加 Markdown 标题后，大纲会自动显示在这里。': 'Add Markdown headings to populate the outline.', '标题列表': 'Heading list',
  '文档中未检测到标题': 'No headings detected', '预览将在这里显示': 'Preview appears here', '开始写作后，这里会呈现舒适的阅读排版。': 'Start writing to see a comfortable reading preview.',
  '没有匹配的字体': 'No matching fonts', '输入或选择字体…': 'Type or choose a font…', '读取中…': 'Loading…', '读取本机字体': 'Load system fonts',
  '自动保存间隔 (ms)': 'Autosave interval (ms)', '常用表情': 'Favorite emoji', '图床服务': 'Image hosting service', '上传文件夹': 'Upload folder', '保存目录': 'Save directory', '命名规则': 'Naming rule',
  '时间戳': 'Timestamp', '原始名称': 'Original name', 'PDF边距 (mm)': 'PDF margin (mm)', 'HTML模板': 'HTML template', 'AI服务商': 'AI provider', 'API密钥': 'API key', 'API端点': 'API endpoint',
  '温度 (0-1)': 'Temperature (0–1)', '建议延迟 (ms)': 'Suggestion delay (ms)', '写作风格': 'Writing style', '正式': 'Formal', '活泼': 'Casual', '学术': 'Academic', '创意': 'Creative', '自定义': 'Custom',
  '首选搜索服务': 'Preferred search service', '搜索深度': 'Search depth', '最大结果数': 'Maximum results', '分类': 'Categories', '安全搜索': 'Safe search', '中等': 'Moderate', '严格': 'Strict', '时间范围': 'Time range', '不限': 'Any time', '一天': 'Past day', '一个月': 'Past month', '一年': 'Past year',
  '搜索工作区': 'Search workspace', '替换为': 'Replace with', '区分大小写': 'Match case', '正则': 'Regex', '文件类型筛选': 'File type filter', '忽略目录': 'Excluded folders', '确认替换': 'Confirm replacement', '没有匹配结果': 'No matches',
  '空文件夹': 'Empty folder', '未保存更改': 'Unsaved changes', '关闭编辑器': 'Close editor', '没有打开的编辑器': 'No open editors', '无打开的文件夹': 'No folder open', '尚未打开文件夹。': 'No folder has been opened.',
  '当前文档没有标题': 'The current document has no headings', '与当前内容对比': 'Compare with current content', '恢复此版本': 'Restore this version', '删除此记录': 'Delete this entry', '历史版本详情': 'Version details', '当前内容差异': 'Differences from current content',
  '调整 AI 伴写风格': 'Change AI companion style', '风格:': 'Style:', '发现': 'Found', '处问题，点击查看': ' issues; click to review', '上传中...': 'Uploading…', '上传成功': 'Upload complete', '上传失败:': 'Upload failed:',
  '打开的文档': 'Open documents', '关闭标签页': 'Close tab', '新建标签页': 'New tab', '最小化': 'Minimize', '最大化': 'Maximize', '图片链接': 'Image URL', '替代文本': 'Alt text', '图片描述': 'Image description',
  '返回': 'Back', '在线视频': 'Online video', '视频链接': 'Video URL', '插入 Emoji': 'Insert emoji', 'Markdown 语法检查': 'Markdown syntax check', '应用专业格式': 'Apply professional formatting',
  '未保存的文件': 'Unsaved files', '未保存': 'Unsaved', '不保存的内容将无法恢复。': 'Changes you do not save cannot be recovered.', '不保存': "Don't save",
  '工作流': 'Workflows', 'GitHub Actions 工作流查看器与结构化编辑': 'GitHub Actions workflow viewer and structured editing', '在预览中渲染工作流图': 'Render workflow diagrams in preview', '保存时保留 YAML 格式': 'Preserve YAML formatting on save',
  '触发器': 'Triggers', '只读': 'Read-only', '复制 Mermaid': 'Copy Mermaid', '复制 SVG': 'Copy SVG', '导出 SVG': 'Export SVG', '放弃修改': 'Discard changes', '选择 job': 'Select job', '跳到源码': 'Jump to source',
};

// Phrase-level conversion is used for remaining Simplified Chinese labels so
// newly added UI does not silently fall back to Simplified Chinese in zh-TW.
const simplified = '后发里为么与云专业东丝两严丧个丰临丽举义乌乐习书买乱争于亏亚产亲亿仅从仓仪们价众优会伞伟传伤体余作佣使侧侨侦侩侬侮信修俭倍债倾储儿兑党兰关兴养兽内册写军冲决况冻净准几击划刘则刚创删别制刷券刹剂剑剧劝办务动励劲劳势勋包区医华单卖卫却厂厅历压厌县参双变叙叠叶号叹同听启员周命和响团园图国围固圆圣场坚坛块坞执基埙域堆处备复头夸夺奖妇娱婴学实审宪宫宽宾对导将层属岁岛岭岸币师帐带帧干并广庄庆庐库应庙废开异弃张强归录彻征径忆怀态总恋恶恼悦惊惨惯愤愿慑懂戏战户才扫扬扰抚抛护报担拟拥择挂挚挟挥挣损换据接控提插揽搜摄摆摇撤播撰操擎改放敌数斋斩断无旧时显晓晕暂术机杀杂权条来杨杰极构枞枢查标栈树样档桥检楼概构欢步残段毁毕毙气汉汤沟没汤洁测济浏浓涂涛润涨渐渔湾湿满滑滚滞滩潇潜澜灯灵灾点炼热爱爷物状独狮狱猎猪献环现琐电画畅疗监盖盘看着矿码研破确碍礼离种积称移税穷窗竞笔等简管类粘红约级纪纯纲纳纵纷纸纹纺线组细终经绑结绕绘给统继续维综绿网编缘缴缺罗置署美群习翻老考联聊职肯胜胁胶脸脱腻腾舆般艰艺节苏范荐药获莹营落蓝藏虑虚虫虽补表装见观规觉览解言誉誉计订认讨让训议讯记讲许论设访证评识诉诊词译试诗诚话询详语误说请读课调谈谢负贡败货质购费资赋赏赞赶趋跃车转软轻载较辑输辖达迁过运近还进远连迟迷选递通造速遇道遥邮邻郑采里重量金鉴针钟钢钥钱链锁销错键镇长门闪闭问间闲闻间阅队阳阴阵阶际陆陈限险随隐难雪零静面页顶项顺预领频题颜风飞饭饮马验验验驱高鲜鸟鸡黑齐齿龙';
const traditional = '後發裡為麼與雲專業東絲兩嚴喪個豐臨麗舉義烏樂習書買亂爭於虧亞產親億僅從倉儀們價眾優會傘偉傳傷體餘作傭使側僑偵俠侶侮信修儉倍債傾儲兒兌黨蘭關興養獸內冊寫軍衝決況凍淨準幾擊劃劉則剛創刪別製刷券刹劑劍劇勸辦務動勵勁勞勢勳包區醫華單賣衛卻廠廳歷壓厭縣參雙變敘疊葉號嘆同聽啟員周命和響團園圖國圍固圓聖場堅壇塊壙執基埡域堆處備複頭誇奪獎婦娛嬰學實審憲宮寬賓對導將層屬歲島嶺岸幣師帳帶幀乾並廣莊慶廬庫應廟廢開異棄張強歸錄徹徵徑憶懷態總戀惡惱悅驚慘慣憤願懼懂戲戰戶才掃揚擾撫拋護報擔擬擁擇掛摯挟揮掙損換據接控提插攬搜攝擺搖撤播撰操擎改放敵數齋斬斷無舊時顯曉暈暫術機殺雜權條來楊傑極構枒樞查標棧樹樣檔橋檢樓概構歡步殘段毀畢斃氣漢湯溝沒湯潔測濟瀏濃塗濤潤漲漸漁灣濕滿滑滾滯灘瀟潛瀾燈靈災點鍊熱愛爺物狀獨獅獄獵豬獻環現瑣電畫暢療監蓋盤看著礦碼研破確礙禮離種積稱移稅窮窗競筆等簡管類黏紅約級紀純綱納縱紛紙紋紡線組細終經綁結繞繪給統繼續維綜綠網編緣繳缺羅置署美群習翻老考聯聊職肯勝脅膠臉脫膩騰輿般艱藝節蘇範薦藥獲瑩營落藍藏慮虛蟲雖補表裝見觀規覺覽解言譽譽計訂認討讓訓議訊記講許論設訪證評識訴診詞譯試詩誠話詢詳語誤說請讀課調談謝負貢敗貨質購費資賦賞贊趕趨躍車轉軟輕載較輯輸轄達遷過運近還進遠連遲迷選遞通造速遇道遙郵鄰鄭採裡重量金鑑針鐘鋼鑰錢鏈鎖銷錯鍵鎮長門閃閉問間閒聞間閱隊陽陰陣階際陸陳限險隨隱難雪零靜面頁頂項順預領頻題顏風飛飯飲馬驗驗驗驅高鮮鳥雞黑齊齒龍';
const traditionalMap = new Map(Array.from(simplified, (char, index) => [char, Array.from(traditional)[index] || char]));
const supplementalSimplified = '夹台哔帮弹扩栏榄横浅础硅签紧织络绝绪缩苹视该贴赖轮边这适释钮须顾顿额';
const supplementalTraditional = '夾臺嗶幫彈擴欄欖橫淺礎矽簽緊織絡絕緒縮蘋視該貼賴輪邊這適釋鈕須顧頓額';
Array.from(supplementalSimplified).forEach((char, index) => {
  traditionalMap.set(char, Array.from(supplementalTraditional)[index] || char);
});

function toTraditional(value: string) {
  return Array.from(value, char => traditionalMap.get(char) || char).join('');
}

export function translateUiText(value: string, language: AppLanguage): string {
  const direct = entries[value];
  if (direct) return direct[language];
  if (language === 'en') return englishEntries[value] || value;
  if (language === 'zh-TW') return toTraditional(value);
  return value;
}

export function t(value: string, language: AppLanguage): string {
  return translateUiText(value, language);
}
