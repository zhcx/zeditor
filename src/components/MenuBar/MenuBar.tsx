import { useState, useRef, useEffect, useCallback, lazy, Suspense } from 'react';
import { useAppStore } from '../../stores/appStore';
import { t, LANGUAGE_OPTIONS } from '../../i18n';
import { open as openDialog, save, message } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-shell';
import MarkdownIt from 'markdown-it';
import hljs from '../../utils/highlight';
import { applyExportTemplate, loadExportTemplate } from '../Export/exportTemplates';
import { sanitizeRenderedHtml } from '../../utils/safeHtml';
import { resolveSaveBaseName } from '../../utils/saveName';
import type { TableAction } from '../../utils/markdownTable';
import { THEMES, resolveThemePreference } from '../../themes/apply';

// 导出对话框与语法手册只在对应菜单项打开时才需要，按需加载以缩小入口 chunk。
const PdfExportDialog = lazy(() => import('../Export/PdfExportDialog').then(m => ({ default: m.PdfExportDialog })));
const ImageExportDialog = lazy(() => import('../Export/ImageExportDialog').then(m => ({ default: m.ImageExportDialog })));
const WeChatExportDialog = lazy(() => import('../Export/WeChatExportDialog').then(m => ({ default: m.WeChatExportDialog })));
const MarkdownSyntaxGuide = lazy(() => import('../Help/MarkdownSyntaxGuide').then(m => ({ default: m.MarkdownSyntaxGuide })));
import {
  CONVERTIBLE_DOCUMENT_EXTENSIONS,
  OPENABLE_FILE_EXTENSIONS,
} from '../../utils/documentFormats';

interface MenuItem {
  label: string;
  action?: () => void;
  shortcut?: string;
  divider?: boolean;
  children?: MenuItem[];
  /** 单选型菜单项的当前选中态，渲染为前置 ✓ 标记。 */
  checked?: boolean;
}

interface MenuGroup {
  label: string;
  variant?: 'app';
  items: MenuItem[];
}

interface UpdateInfo {
  has_update: boolean;
  current_version: string;
  latest_version: string;
  download_url: string;
  asset_download_url: string;
  asset_name: string;
  asset_size: number;
  auto_install_supported: boolean;
  release_notes: string;
  published_at: string;
}

interface RecentFolderEntry {
  path: string;
  title: string;
  last_opened: number;
}

interface DownloadProgress {
  downloaded: number;
  total: number;
  progress: number;
}

interface HelpModalProps {
  type: 'shortcuts' | 'syntax' | 'about' | 'update';
  updateInfo?: UpdateInfo | null;
  updateError?: string | null;
  downloadProgress?: DownloadProgress | null;
  downloadDone?: boolean;
  onDownloadAndInstall?: () => void;
  onClose: () => void;
}

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  breaks: true,
  highlight: (str: string, lang: string) => {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return '<pre class="hljs"><code>' + hljs.highlight(str, { language: lang, ignoreIllegals: true }).value + '</code></pre>';
      } catch {
        // Fall back to escaped code below.
      }
    }
    return '<pre class="hljs"><code>' + md.utils.escapeHtml(str) + '</code></pre>';
  },
});

const APP_NAME = 'Zeditor';

// F11 全屏切换：桌面端切换 Tauri 窗口全屏，Web 构建回退到浏览器全屏 API。
async function toggleAppFullscreen() {
  if ('__TAURI_INTERNALS__' in window) {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const appWindow = getCurrentWindow();
    await appWindow.setFullscreen(!(await appWindow.isFullscreen()));
    return;
  }
  if (document.fullscreenElement) {
    await document.exitFullscreen();
    return;
  }
  await document.documentElement.requestFullscreen();
}

function HelpModal({ type, updateInfo, updateError, downloadProgress, downloadDone, onDownloadAndInstall, onClose }: HelpModalProps) {
  const content = {
    shortcuts: {
      title: '快捷键说明',
      body: `
**文件操作**
- Ctrl+N - 新建文件
- Ctrl+O - 打开文件
- Ctrl+S - 保存文件
- Ctrl+Shift+S - 另存为

**编辑操作**
- Ctrl+Z - 撤销
- Ctrl+Y - 重做
- Ctrl+X - 剪切
- Ctrl+C - 复制
- Ctrl+V - 粘贴
- Ctrl+A - 全选

**格式化**
- Ctrl+B - 加粗
- Ctrl+I - 斜体
- Ctrl+K - 插入链接

**插入与表格**
- Ctrl+Shift+T - 插入 3 × 3 表格
- Ctrl+Shift+I - 插入图片
- 表格内 Tab - 跳到下一个单元格（末行时自动加一行）
- 表格内 Shift+Tab - 跳到上一个单元格
- 表格内方向键 - 在单元格之间移动
- 表格内 Enter - 在当前行下方新增一行

**智能 Tab 导航**
- 括号、引号内按 Tab - 跳到闭合符号之后（嵌套时每次只跳出一层）
- 行内格式内按 Tab - 跳到格式标记之后
- 链接内按 Tab - 在链接文字与地址之间移动，最后跳出链接
- 支持中日韩括号与弯引号；代码块内自动停用，避免误跳出

**视图**
- F11 - 全屏切换
      `
    },
    syntax: {
      title: 'Markdown 语法入门与速查',
      body: `
**标题**
# 一级标题
## 二级标题
### 三级标题

**文本样式**
**粗体** 或 __粗体__
*斜体* 或 _斜体_
~~删除线~~

**列表**
- 无序列表项
1. 有序列表项

**链接和图片**
[链接文本](URL)
![图片描述](URL)

**代码**
行内代码: \`code\`

代码块:
\`\`\`
code block
\`\`\`

**引用**
> 引用内容

**数学公式**
行内: $E=mc^2$
块: $$E=mc^2$$

**Mermaid 图表**
\`\`\`mermaid
graph TD
  A --> B
\`\`\`
      `
    },
    about: {
      title: '关于 Zeditor',
      body: `
**Zeditor v0.5.6**

一款现代化的 Markdown 编辑器

**功能特点**
- Monaco 编辑器 / GitHub 风格 Markdown 实时预览
- 沉浸阅读 / 沉浸写作 / AI Chatbox
- 多标签页编辑，可调节布局
- 数学公式（KaTeX）、Mermaid 图表、代码高亮
- 多主题：12 套主题（6 浅色 + 6 深色，含 VS Code / Gruvbox / Nord / Dracula / Solarized 等）
- 文件夹浏览、最近文档、拖拽打开
- 多图床支持：Cloudinary、PicGo、S3、本地存储
- AI 智能助手：对话面板、校对、重写、翻译、摘要、大纲
- AI 思维链展示与思考模式（DeepSeek / 硅基流动）
- 支持 OpenAI、DeepSeek、Anthropic、自定义 OpenAI 兼容服务
- HTML / PDF / Word 导出
- GitHub Release 自动检查更新

**本版本更新**
- **Agent 交互响应性能优化**：用户输入到首个反馈显著加快——隔离工作区准备与 CLI 探测并行、仓库全量文件哈希分片并行，耗时步骤前即时显示进展提示；流式输出按帧合并渲染、Markdown 按节奏追赶，长回答期间输入框保持流畅
- **窄窗口 Agent 工具栏换行**：「+ / @引用 / 审批 / 模型 / 推理强度 / 发送」以可读最小宽度换行，不再因控件被挤扁而文字重叠
- **侧栏默认宽度修正**：新会话默认宽度 220px → 250px，资源管理器标题完整可见
- **主题子菜单溢出修复**：视图 → 主题列表靠近视口底部时自动向上翻转，12 套主题不再被裁切

**技术栈**
Tauri 2.0 + React 18 + TypeScript + Monaco Editor + markdown-it

**开发者**
[七月](https://github.com/zhcx)

**项目地址**
https://github.com/zhcx/zeditor
      `
    },
    update: {
      title: '检查更新',
      body: ''
    }
  };

  const { title } = content[type];

  useEffect(() => {
    if (type !== 'about') return undefined;
    const links = document.querySelectorAll<HTMLAnchorElement>('.help-content a');
    const handleLinkClick = (event: Event) => {
      const link = event.currentTarget as HTMLAnchorElement;
      const url = link.href;
      if (!url) return;
      event.preventDefault();
      if ('__TAURI_INTERNALS__' in window) {
        void open(url).catch(() => window.open(url, '_blank', 'noopener,noreferrer'));
      } else {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    };
    links.forEach((link) => link.addEventListener('click', handleLinkClick));
    return () => links.forEach((link) => link.removeEventListener('click', handleLinkClick));
  }, [type]);

  const formatDate = (dateStr: string) => {
    if (!dateStr) return '';
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString('zh-CN');
    } catch {
      return dateStr;
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const getInstallerType = (fileName: string) => {
    const lower = fileName.toLowerCase();
    if (lower.endsWith('.exe')) return 'Windows 安装程序（推荐）';
    if (lower.endsWith('.msi')) return 'Windows MSI 安装包';
    return '安装包';
  };

  const getInstallerSummary = (fileName: string) => {
    const lower = fileName.toLowerCase();
    if (lower.endsWith('.exe')) {
      return '下载完成后会自动启动安装程序。安装前请保存当前文档，应用会退出以便完成更新。';
    }
    if (lower.endsWith('.msi')) {
      return '适合需要使用 Windows Installer 或企业分发场景的安装包。';
    }
    return '可从 GitHub Release 页面手动下载并安装。';
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className={`modal-content${type === 'syntax' ? ' markdown-syntax-modal' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="modal-close" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="modal-body">
          {type === 'update' ? (
            updateError ? (
              <div className="update-modal-content">
                <div className="update-badge current">检查更新失败</div>
                <p className="update-installer-summary">{updateError}</p>
                <div className="update-actions">
                  <button className="update-cancel-btn" onClick={() => open('https://github.com/zhcx/zeditor/releases')}>前往 GitHub Release</button>
                  <button className="update-cancel-btn" onClick={onClose}>关闭</button>
                </div>
              </div>
            ) : updateInfo ? (
              <div className="update-modal-content">
                {updateInfo.has_update ? (
                  <>
                    <div className="update-badge new">发现新版本</div>
                    <div className="update-version-info">
                      <p>当前版本: <span className="version-old">v{updateInfo.current_version}</span></p>
                      <p>最新版本: <span className="version-new">v{updateInfo.latest_version}</span></p>
                      <p className="update-date">发布日期: {formatDate(updateInfo.published_at)}</p>
                    </div>
                    <div className="update-notes">
                      <h4>更新内容</h4>
                      <div
                        className="update-notes-content"
                        dangerouslySetInnerHTML={{ __html: sanitizeRenderedHtml(md.render(updateInfo.release_notes || '暂无更新说明')) }}
                      />
                    </div>
                    <div className="update-installer-info">
                      <h4>安装包简介</h4>
                      {updateInfo.asset_download_url ? (
                        <>
                          <p><span>文件名</span><strong>{updateInfo.asset_name}</strong></p>
                          <p><span>类型</span>{getInstallerType(updateInfo.asset_name)}</p>
                          <p><span>大小</span>{formatSize(updateInfo.asset_size)}</p>
                          <p className="update-installer-summary">{updateInfo.auto_install_supported ? getInstallerSummary(updateInfo.asset_name) : '该平台可直接下载对应安装包；下载完成后请按系统提示完成安装。'}</p>
                        </>
                      ) : (
                        <p className="update-installer-summary">
                          本次 Release 暂未提供可自动安装的 Windows 安装包，可前往 GitHub Release 页面手动查看下载项。
                        </p>
                      )}
                    </div>
                    {downloadProgress ? (
                      <div className="update-download-progress">
                        <div className="update-progress-bar">
                          <div
                            className="update-progress-fill"
                            style={{ width: `${downloadProgress!.progress}%` }}
                          />
                        </div>
                        <p className="update-progress-text">
                          {downloadDone
                            ? '下载完成，启动安装程序…'
                            : `正在下载 ${formatSize(downloadProgress!.downloaded)} / ${formatSize(downloadProgress!.total)} (${downloadProgress!.progress}%)`}
                        </p>
                      </div>
                    ) : (
                      <div className="update-actions">
                        <button className="update-download-btn" onClick={() => {
                          if (!updateInfo.asset_download_url) { void open(updateInfo.download_url); return; }
                          if (updateInfo.auto_install_supported) { onDownloadAndInstall?.(); return; }
                          void open(updateInfo.asset_download_url);
                        }}>
                          {!updateInfo.asset_download_url ? '前往下载' : updateInfo.auto_install_supported ? '下载并安装' : '下载安装包'}
                        </button>
                        {updateInfo.asset_download_url && (
                          <button className="update-cancel-btn" onClick={onClose}>
                            稍后提醒
                          </button>
                        )}
                        {!updateInfo.asset_download_url && (
                          <button className="update-cancel-btn" onClick={() => open(updateInfo.download_url)}>
                            前往 GitHub Release
                          </button>
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="update-badge current">已是最新版本</div>
                    <div className="update-version-info">
                      <p>当前版本: <span className="version-current">v{updateInfo.current_version}</span></p>
                    </div>
                    <div className="update-actions">
                      <button className="update-cancel-btn" onClick={onClose}>关闭</button>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className="update-checking">
                <span className="update-spinner"></span>
                正在检查更新...
              </div>
            )
          ) : type === 'syntax' ? (
            <Suspense fallback={null}>
              <MarkdownSyntaxGuide />
            </Suspense>
          ) : (
            <div
              className="help-content"
              dangerouslySetInnerHTML={{ __html: sanitizeRenderedHtml(md.render(content[type].body)) }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export function MenuBar() {
  const {
    content,
    settings,
    setSettings,
    setSettingsOpen,
    addTab,
    openFile,
    convertDocument,
    saveTab,
    getActiveTab
  } = useAppStore();
  const mode = useAppStore((state) => state.mode);
  // 主题偏好解析与 themes/apply 的 resolveThemePreference 同规则，用于菜单当前态勾选。
  const resolvedTheme = resolveThemePreference(settings.appearance.theme);
  const language = settings.appearance.language;

  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // 最近打开的工作区文件夹（Rust recent_folders.json，文件菜单数据源）。
  const [recentFolders, setRecentFolders] = useState<RecentFolderEntry[]>([]);

  const refreshRecentFolders = useCallback(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    invoke<RecentFolderEntry[]>('get_recent_folders')
      .then((list) => {
        const sorted = [...list].sort((a, b) => b.last_opened - a.last_opened).slice(0, 10);
        setRecentFolders(sorted);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshRecentFolders();
    const handler = () => refreshRecentFolders();
    window.addEventListener('zeditor-recent-folders-changed', handler);
    return () => window.removeEventListener('zeditor-recent-folders-changed', handler);
  }, [refreshRecentFolders]);
  const [helpModal, setHelpModal] = useState<'shortcuts' | 'syntax' | 'about' | 'update' | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [pdfExportOpen, setPdfExportOpen] = useState(false);
  const [imageExportOpen, setImageExportOpen] = useState(false);
  const [weChatExportOpen, setWeChatExportOpen] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const [downloadDone, setDownloadDone] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const menubarRef = useRef<HTMLDivElement>(null);
  const mouseOverMenuRef = useRef(false);
  // 菜单收回的意图判定定时器：鼠标短暂移出（斜向移向下拉、经过
  // 间隙）不应立即收回，350ms 内回到菜单区域则取消关闭。
  const menuCloseTimerRef = useRef<number | null>(null);
  const MENU_CLOSE_DELAY_MS = 350;

  const cancelMenuClose = () => {
    if (menuCloseTimerRef.current !== null) {
      window.clearTimeout(menuCloseTimerRef.current);
      menuCloseTimerRef.current = null;
    }
  };

  useEffect(() => cancelMenuClose, []);

  const handleNewFile = () => {
    addTab();
    setActiveMenu(null);
  };

  const handleCheckUpdates = async () => {
    setHelpModal('update');
    setUpdateInfo(null);
    setUpdateError(null);
    setDownloadError(null);
    try {
      const info = await invoke<UpdateInfo>('check_for_updates');
      setUpdateInfo(info);
    } catch (error) {
      console.error('检查更新失败:', error);
      setUpdateError(`无法检查更新：${String(error)}`);
    }
  };

  const handleDownloadAndInstall = async () => {
    if (!updateInfo?.asset_download_url) return;
    setDownloadError(null);
    setDownloadProgress({ downloaded: 0, total: updateInfo.asset_size, progress: 0 });
    setDownloadDone(false);

    // Set up progress listener
    const unlistenProgress = await listen<DownloadProgress>('update-download-progress', (event) => {
      setDownloadProgress(event.payload);
    });

    try {
      const installerPath = await invoke<string>('download_and_install_update', {
        downloadUrl: updateInfo.asset_download_url,
        fileName: updateInfo.asset_name,
        assetSize: updateInfo.asset_size,
      });
      setDownloadDone(true);
      window.dispatchEvent(new CustomEvent('zeditor-install-update', {detail: installerPath}));
    } catch (error) {
      console.error('下载更新失败:', error);
      setDownloadError(`下载或启动安装程序失败：${String(error)}`);
      setDownloadProgress(null);
    } finally {
      unlistenProgress();
    }
  };

  const handleOpenFile = async () => {
    try {
      const selected = await openDialog({
        filters: [{ name: '可编辑文本与可转换文档', extensions: OPENABLE_FILE_EXTENSIONS }],
        multiple: true,
      });
      if (selected) {
        const files = Array.isArray(selected) ? selected : [selected];
        for (const file of files) {
          await openFile(file as string);
        }
      }
    } catch (error) {
      console.error('Failed to open file:', error);
    }
    setActiveMenu(null);
  };

  const handleConvertDocument = async () => {
    try {
      const selected = await openDialog({
        filters: [{
          name: 'Documents',
          extensions: [...CONVERTIBLE_DOCUMENT_EXTENSIONS],
        }],
        multiple: true,
      });
      if (selected) {
        for (const file of Array.isArray(selected) ? selected : [selected]) {
          await convertDocument(file as string);
        }
      }
    } catch (error) {
      console.error('Document conversion failed:', error);
      window.alert(`文档转换失败：${String(error)}`);
    }
    setActiveMenu(null);
    setMenuOpen(false);
  };

  const handleSaveFile = async () => {
    const tab = getActiveTab();
    if (tab?.path) {
      try {
        await saveTab(tab.id, tab.path);
      } catch (error) {
        await message(`保存失败：${String(error)}`, { title: '无法保存文件', kind: 'error' });
      }
    } else {
      await handleSaveAs();
    }
    setActiveMenu(null);
  };

  const handleSaveAs = async () => {
    const targetTab = getActiveTab();
    if (!targetTab) return;
    try {
      // 尚无文件路径的未命名文档先请求 AI 文件名建议（未启用 AI 时立即回退）。
      let suggestedBaseName: string | null = null;
      if (!targetTab.path) {
        const activeTab = targetTab;
        if (activeTab) {
          suggestedBaseName = await resolveSaveBaseName(activeTab.title, activeTab.content);
        }
      }
      const selected = await save({
        filters: [{ name: 'Markdown', extensions: ['md'] }],
        defaultPath: targetTab.path || `${suggestedBaseName || 'untitled'}.md`,
      });
      if (selected) {
        await saveTab(targetTab.id, selected as string);
      }
    } catch (error) {
      await message(`保存失败：${String(error)}`, {title:'无法保存文件',kind:'error'});
    }
    setActiveMenu(null);
  };

  // 文件与视图快捷键：菜单与「帮助 → 快捷键说明」标注的 Ctrl/Cmd+N/O/S、
  // Ctrl/Cmd+Shift+S、F11。应用使用 WebView 内自绘菜单栏，Tauri 原生菜单
  // 未注册加速键，因此这里统一补上 window 级监听。ref 持有最新处理器，
  // 避免监听器随每次渲染重复注册。
  const fileShortcutRef = useRef({
    newFile: handleNewFile,
    openFile: handleOpenFile,
    saveFile: handleSaveFile,
    saveAs: handleSaveAs,
  });
  useEffect(() => {
    fileShortcutRef.current = {
      newFile: handleNewFile,
      openFile: handleOpenFile,
      saveFile: handleSaveFile,
      saveAs: handleSaveAs,
    };
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === 'F11') {
        event.preventDefault();
        void toggleAppFullscreen();
        return;
      }
      const primary = event.ctrlKey || event.metaKey;
      if (!primary || event.altKey) return;
      const key = event.key.toLowerCase();
      const handlers = fileShortcutRef.current;
      if (event.shiftKey) {
        if (key === 's') {
          event.preventDefault();
          void handlers.saveAs();
        }
        return;
      }
      if (key === 'n') {
        event.preventDefault();
        handlers.newFile();
      } else if (key === 'o') {
        event.preventDefault();
        void handlers.openFile();
      } else if (key === 's') {
        event.preventDefault();
        void handlers.saveFile();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // 子菜单高度估算（每项最小 32px + 间距，再加面板内边距），
  // 用于判断向下弹出是否会超出视口底部。
  const estimateSubmenuHeight = (itemCount: number) => itemCount * 34 + 24;

  // 鼠标进入子菜单触发行时测量视口：下方放不下且上方足够时，
  // 给子菜单加 submenu-up 类改为向上弹出（如「视图 → 主题」共 12 项）。
  const handleSubmenuEnter = (wrapper: HTMLDivElement, itemCount: number) => {
    const dropdown = wrapper.querySelector<HTMLElement>('.submenu-dropdown');
    if (!dropdown) return;
    const rect = wrapper.getBoundingClientRect();
    const height = estimateSubmenuHeight(itemCount);
    const overflowBelow = rect.bottom + height - 8 > window.innerHeight;
    const fitsAbove = rect.bottom + 8 >= height;
    dropdown.classList.toggle('submenu-up', overflowBelow && fitsAbove);
  };

  const getExportFilename = (format: string) => {
    const activeTab = getActiveTab();
    if (activeTab) {
      const title = activeTab.path
        ? activeTab.path.split(/[\\/]/).pop()?.replace(/\.md$/i, '') || activeTab.title
        : activeTab.title;
      return title + '.' + format;
    }
    return 'document.' + format;
  };

  // Render markdown to HTML using the same markdown-it as the preview
  const renderMarkdown = (text: string): string => {
    return sanitizeRenderedHtml(md.render(text));
  };

  const handleExport = async (format: 'pdf' | 'html' | 'word') => {
    try {
      const activeTab = getActiveTab();
      const filePath = activeTab?.path || null;

      // Render markdown to HTML on the front-end using markdown-it
      const documentTitle = getActiveTab()?.title?.replace(/\.md$/i, '') || 'document';
      const htmlBody = applyExportTemplate(renderMarkdown(content), documentTitle, loadExportTemplate());

      if (format === 'html') {
        const defaultFilename = getExportFilename('html');
        const selected = await save({
          filters: [{ name: 'HTML', extensions: ['html'] }],
          defaultPath: defaultFilename,
        });
        if (selected) {
          const fullHtml = await invoke<string>('export_html', {
            htmlBody,
            settings: settings.export,
            filePath
          });
          await invoke('save_file_content', { path: selected, content: fullHtml });
        }
      } else if (format === 'word') {
        const defaultFilename = getExportFilename('doc');
        const selected = await save({
          filters: [{ name: 'Word', extensions: ['doc'] }],
          defaultPath: defaultFilename,
        });
        if (selected) {
          const wordDocument = await invoke<string>('export_word', {
            htmlBody,
            settings: settings.export,
            filePath
          });
          await invoke('save_file_content', { path: selected, content: wordDocument });
        }
      } else if (format === 'pdf') {
        // 使用新的直接 PDF 导出功能
        const defaultFilename = getExportFilename('pdf');
        const selected = await save({
          filters: [{ name: 'PDF', extensions: ['pdf'] }],
          defaultPath: defaultFilename,
        });
        if (selected) {
          await invoke<string>('export_pdf_direct', {
            htmlBody,
            outputPath: selected,
            settings: settings.export,
            options: null,
            filePath
          });
        }
      }
    } catch (error) {
      console.error('Failed to export:', error);
    }
    setActiveMenu(null);
    setMenuOpen(false);
  };

  useEffect(() => {
    const handleExportRequest = (event: Event) => {
      const format = (event as CustomEvent<{ format?: 'pdf' | 'html' | 'word' }>).detail?.format;
      if (format) void handleExport(format);
    };
    window.addEventListener('zeditor-export-request', handleExportRequest);
    return () => window.removeEventListener('zeditor-export-request', handleExportRequest);
  });

  const closeMenus = () => {
    setActiveMenu(null);
    setMenuOpen(false);
  };

  // 表格与图片的实际操作在编辑器里执行：菜单只负责把请求派发过去。
  const requestTableAction = (action: TableAction) => {
    window.dispatchEvent(new CustomEvent('zeditor-table-action', { detail: { action } }));
    closeMenus();
  };
  const requestInsert = (kind: 'table' | 'image' | 'markmap') => {
    window.dispatchEvent(new CustomEvent(`zeditor-insert-${kind}`));
    closeMenus();
  };

  const openRecentFolder = (path: string) => {
    setActiveMenu(null);
    setMenuOpen(false);
    window.dispatchEvent(new CustomEvent('zeditor-open-folder', { detail: { path } }));
  };

  // 文件菜单「最近的文件夹」：与 VMark 的「最近的工作区」对齐，最多 10 条，
  // 按最后打开时间排序；数据源是 Rust 端 recent_folders.json。
  const recentFolderMenuItems: MenuItem[] = recentFolders.length > 0
    ? [
        ...recentFolders.map((folder) => ({
          label: folder.title || folder.path.split(/[\\/]/).filter(Boolean).pop() || folder.path,
          action: () => openRecentFolder(folder.path),
        })),
        { divider: true, label: '' },
        {
          label: t('清除最近文件夹', language),
          action: () => {
            setActiveMenu(null);
            setMenuOpen(false);
            if ('__TAURI_INTERNALS__' in window) {
              void invoke('clear_recent_folders').then(() => setRecentFolders([])).catch(() => undefined);
            }
          },
        },
      ]
    : [{ label: t('（暂无最近文件夹）', language), action: () => undefined }];

  const menus: MenuGroup[] = [
    {
      label: APP_NAME,
      variant: 'app',
      items: [
        { label: t('快捷键说明', language), action: () => setHelpModal('shortcuts') },
        { label: t('Markdown 语法', language), action: () => setHelpModal('syntax') },
        { divider: true, label: '' },
        { label: t('检查更新', language), action: handleCheckUpdates },
        { divider: true, label: '' },
        { label: t('关于 Zeditor', language), action: () => setHelpModal('about') },
      ],
    },
    {
      label: t('文件', language),
      items: [
        { label: t('新建', language), action: handleNewFile, shortcut: 'Ctrl+N' },
        { label: t('打开', language), action: handleOpenFile, shortcut: 'Ctrl+O' },
        { label: t('导入并转换文档…', language), action: handleConvertDocument },
        ...('__TAURI_INTERNALS__' in window ? [{ label: t('最近的文件夹', language), children: recentFolderMenuItems } satisfies MenuItem] : []),
        { label: t('保存', language), action: handleSaveFile, shortcut: 'Ctrl+S' },
        { label: t('另存为', language), action: handleSaveAs, shortcut: 'Ctrl+Shift+S' },
        { divider: true, label: '' },
        {
          label: t('导出', language),
          children: [
            { label: t('导出为 HTML', language), action: () => handleExport('html') },
            { label: t('导出为 PDF...', language), action: () => { setPdfExportOpen(true); setActiveMenu(null); setMenuOpen(false); } },
            { label: t('导出为 Word', language), action: () => handleExport('word') },
          ],
        },
        { label: t('导出为 HTML', language), action: () => handleExport('html') },
        { label: t('导出为 PDF...', language), action: () => { setPdfExportOpen(true); setActiveMenu(null); } },
      ],
    },
    {
      label: t('功能', language),
      items: [
        { label: t('撤销', language), action: () => document.execCommand('undo'), shortcut: 'Ctrl+Z' },
        { label: t('重做', language), action: () => document.execCommand('redo'), shortcut: 'Ctrl+Y' },
        { divider: true, label: '' },
        { label: t('剪切', language), action: () => document.execCommand('cut'), shortcut: 'Ctrl+X' },
        { label: t('复制', language), action: () => document.execCommand('copy'), shortcut: 'Ctrl+C' },
        { label: t('粘贴', language), action: () => document.execCommand('paste'), shortcut: 'Ctrl+V' },
        { divider: true, label: '' },
        { label: t('插入图片…', language), action: () => requestInsert('image'), shortcut: 'Ctrl+Shift+I' },
        { label: t('插入表格', language), action: () => requestInsert('table'), shortcut: 'Ctrl+Shift+T' },
        { label: t('插入思维导图', language), action: () => requestInsert('markmap') },
        { label: t('AI 指令面板', language), action: () => { setActiveMenu(null); window.dispatchEvent(new CustomEvent('zeditor-ai-palette')); }, shortcut: 'Ctrl+J' },
        { label: t('检查链接', language), action: () => { setActiveMenu(null); window.dispatchEvent(new CustomEvent('zeditor-check-links')); }, shortcut: 'Ctrl+Alt+V' },
        {
          label: t('表格操作', language),
          children: [
            { label: t('上方插入行', language), action: () => requestTableAction('row-above') },
            { label: t('下方插入行', language), action: () => requestTableAction('row-below') },
            { label: t('删除当前行', language), action: () => requestTableAction('row-delete') },
            { label: t('左侧插入列', language), action: () => requestTableAction('column-left') },
            { label: t('右侧插入列', language), action: () => requestTableAction('column-right') },
            { label: t('删除当前列', language), action: () => requestTableAction('column-delete') },
            { label: t('当前列左对齐', language), action: () => requestTableAction('align-left') },
            { label: t('当前列居中', language), action: () => requestTableAction('align-center') },
            { label: t('当前列右对齐', language), action: () => requestTableAction('align-right') },
            { label: t('整理表格格式', language), action: () => requestTableAction('format') },
            { label: t('删除整张表格', language), action: () => requestTableAction('table-delete') },
          ],
        },
        { divider: true, label: '' },
        { label: t('全选', language), action: () => document.execCommand('selectAll'), shortcut: 'Ctrl+A' },
        { divider: true, label: '' },
        { label: t('分屏模式', language), checked: mode === 'split', action: () => useAppStore.getState().setMode('split') },
        { label: t('沉浸阅读', language), checked: mode === 'immersive', action: () => useAppStore.getState().setMode('immersive') },
        { label: t('沉浸写作', language), checked: mode === 'zen', action: () => useAppStore.getState().setMode('zen') },
        { label: t('演示模式', language), action: () => { window.dispatchEvent(new CustomEvent('zeditor-presentation-request')); } },
        { divider: true, label: '' },
        {
          label: t('主题', language),
          children: THEMES.map((theme) => ({
            label: `${theme.label}（${theme.labelEn}）`,
            checked: resolvedTheme === theme.id,
            action: () => {
              setSettings({ ...settings, appearance: { ...settings.appearance, theme: theme.id } });
            },
          })),
        },
        {
          label: t('语言', language),
          children: LANGUAGE_OPTIONS.map((option) => ({
            label: option.nativeLabel,
            checked: language === option.value,
            action: () => {
              setSettings({ ...settings, appearance: { ...settings.appearance, language: option.value } });
            },
          })),
        },
        { divider: true, label: '' },
        { label: t('设置', language), action: () => setSettingsOpen(true) },
      ],
    },
  ];

  const fileMenu = menus[1];
  const exportMenu = fileMenu.items.find((item) => item.children)?.children;
  exportMenu?.push({ label: '导出公众号排版 HTML...', action: () => { setWeChatExportOpen(true); setActiveMenu(null); setMenuOpen(false); } });
  exportMenu?.push({ label: '导出为图片...', action: () => { setImageExportOpen(true); setActiveMenu(null); setMenuOpen(false); } });

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menubarRef.current && !menubarRef.current.contains(event.target as Node)) {
        setActiveMenu(null);
        setMenuOpen(false);
        mouseOverMenuRef.current = false;
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const shouldHideLegacyExportItem = (item: MenuItem) => {
    return !item.children && !item.divider && (item.label === '导出为 HTML' || item.label === '导出为 PDF...');
  };

  return (
    <>
      <div className="menubar" ref={menubarRef}
        onMouseEnter={() => { mouseOverMenuRef.current = true; cancelMenuClose(); }}
        onMouseLeave={() => {
          mouseOverMenuRef.current = false;
          cancelMenuClose();
          menuCloseTimerRef.current = window.setTimeout(() => {
            menuCloseTimerRef.current = null;
            if (!mouseOverMenuRef.current) {
              setActiveMenu(null);
              setMenuOpen(false);
            }
          }, MENU_CLOSE_DELAY_MS);
        }}
      >
        {menus.map((menu) => {
          const isAppMenu = menu.variant === 'app';

          // 所有菜单项点击后统一收起菜单：历史实现里各 action 自行关闭，
          // 模式切换等项遗漏了关闭步骤，导致点击后菜单悬浮不消失。
          const runMenuItem = (item: MenuItem) => {
            item.action?.();
            setActiveMenu(null);
            setMenuOpen(false);
          };

          const renderOptionLabel = (item: MenuItem) => (
            <span className="menu-option-label">
              <span className="menu-check" aria-hidden="true">{item.checked ? '✓' : ''}</span>
              <span>{item.label}</span>
            </span>
          );

          return (
            <div key={menu.label} className="menu-item"
              onMouseEnter={() => { if (menuOpen) setActiveMenu(menu.label); }}
            >
              <button
                className={
                  'menu-trigger' +
                  (activeMenu === menu.label ? ' active' : '') +
                  (isAppMenu ? ' app-menu-trigger' : '')
                }
                onClick={() => {
                  if (activeMenu === menu.label && menuOpen) {
                    setActiveMenu(null);
                    setMenuOpen(false);
                  } else {
                    setActiveMenu(menu.label);
                    setMenuOpen(true);
                  }
                }}
                aria-label={isAppMenu ? `${APP_NAME} 菜单` : undefined}
                title={isAppMenu ? APP_NAME : undefined}
              >
                {isAppMenu ? (
                  <>
                    <span className="titlebar-icon" aria-hidden="true">M</span>
                    <span className="titlebar-app-name">{APP_NAME}</span>
                  </>
                ) : (
                  menu.label
                )}
              </button>
              {menuOpen && activeMenu === menu.label && (
                <div className="menu-dropdown">
                  {menu.items.filter(item => !shouldHideLegacyExportItem(item)).map((item, index) => (
                    item.divider ? (
                      <div key={index} className="menu-divider" />
                    ) : item.children ? (
                      <div
                        key={index}
                        className="menu-option-wrapper"
                        onMouseEnter={(event) => handleSubmenuEnter(event.currentTarget, item.children?.length ?? 0)}
                      >
                        <button className="menu-option submenu-trigger" type="button">
                          {renderOptionLabel(item)}
                          <span className="submenu-arrow">›</span>
                        </button>
                        <div className="submenu-dropdown">
                          <div className="submenu-scroll">
                            {item.children.map((child, childIndex) => (
                              child.divider ? (
                                <div key={childIndex} className="menu-divider" />
                              ) : (
                                <button
                                  key={childIndex}
                                  className={'menu-option' + (child.checked ? ' is-checked' : '')}
                                  onClick={() => runMenuItem(child)}
                                  aria-checked={child.checked ?? undefined}
                                >
                                  {renderOptionLabel(child)}
                                  {child.shortcut && <span className="shortcut">{child.shortcut}</span>}
                                </button>
                              )
                            ))}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <button
                        key={index}
                        className={'menu-option' + (item.checked ? ' is-checked' : '')}
                        onClick={() => runMenuItem(item)}
                        aria-checked={item.checked ?? undefined}
                      >
                        {renderOptionLabel(item)}
                        {item.shortcut && <span className="shortcut">{item.shortcut}</span>}
                      </button>
                    )
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {helpModal && (
        <HelpModal
          type={helpModal}
          updateInfo={helpModal === 'update' ? updateInfo : undefined}
          updateError={helpModal === 'update' ? updateError : undefined}
          downloadProgress={helpModal === 'update' ? downloadProgress : null}
          downloadDone={helpModal === 'update' ? downloadDone : false}
          onDownloadAndInstall={helpModal === 'update' ? handleDownloadAndInstall : undefined}
          onClose={() => setHelpModal(null)}
        />
      )}
      {downloadError && helpModal === 'update' && <div className="update-toast-error" role="alert">{downloadError}</div>}
      {pdfExportOpen && (
        <Suspense fallback={null}>
          <PdfExportDialog
            content={content}
            filePath={getActiveTab()?.path || null}
            onClose={() => setPdfExportOpen(false)}
          />
        </Suspense>
      )}
      {imageExportOpen && (
        <Suspense fallback={null}>
          <ImageExportDialog content={content} onClose={() => setImageExportOpen(false)} />
        </Suspense>
      )}
      {weChatExportOpen && (
        <Suspense fallback={null}>
          <WeChatExportDialog content={content} title={getActiveTab()?.title?.replace(/\.md$/i, '') || 'Zeditor 文章'} onClose={() => setWeChatExportOpen(false)} />
        </Suspense>
      )}
    </>
  );
}
