import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '../../stores/appStore';
import { useAIStore } from '../../stores/aiStore';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { TablePicker } from '../Editor/TablePicker';
import { ToolbarMenu, type ToolbarMenuItem } from './ToolbarMenu';
import { formatMarkdown, type MarkdownFormatResult } from '../../utils/markdownFormatter';
import {
  formatMediaEmbed,
  mediaDialogFilters,
  mediaKindOfSource,
  videoPlatformEmbed,
} from '../../utils/media';
import { insertMediaFromPath } from '../../services/mediaAssets';
import { insertImageFromPath } from '../../services/imageAssets';
import { imageDialogFilters } from '../../utils/imageSyntax';
import { insertTable as buildTableInsert } from '../../utils/markdownTable';
import { stripInlineFormatting } from '../../utils/inlineFormatting';

type ToolbarIconName = 'link' | 'image' | 'video' | 'table' | 'folder' | 'chat' | 'proofread' | 'sparkle' | 'palette' | 'rewrite' | 'translate' | 'summary' | 'outline';

interface ToolbarButton {
  label?: string;
  icon?: ToolbarIconName;
  title: string;
  /** 直接执行的动作；与 menu 二选一。 */
  action?: () => void | Promise<void>;
  /** 同类命令收进下拉菜单，点击按钮展开。 */
  menu?: ToolbarMenuItem[];
  /** 表格选择器的锚点按钮：弹层按它的位置定位。 */
  picker?: boolean;
}

interface ToolbarProps {
  variant?: 'pinned' | 'floating';
}

interface ToolbarGroup {
  title: string;
  buttons: ToolbarButton[];
}

function ToolbarGlyph({ name }: { name: ToolbarIconName }) {
  if (name === 'link') return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6.2 9.8 3.6-3.6M5.1 11.9l-1 .9a2.7 2.7 0 0 1-3.8-3.8l2.3-2.3a2.7 2.7 0 0 1 3.8 0M10.9 4.1l1-.9A2.7 2.7 0 0 1 15.7 7l-2.3 2.3a2.7 2.7 0 0 1-3.8 0" /></svg>;
  if (name === 'image') return <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1" /><circle cx="5" cy="6" r="1.2" /><path d="m2.5 12 3.6-3.4 2.2 2 2.2-2.4 3 3" /></svg>;
  if (name === 'video') return <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="3" width="13" height="10" rx="1.5" /><path d="m6.5 6 4 2-4 2z" /></svg>;
  if (name === 'table') return <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2" width="13" height="12" rx=".5" /><path d="M1.5 6h13M1.5 10h13M6 2v12m4-12v12" /></svg>;
  if (name === 'folder') return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4h5l1.2 1.5h6.8v7.8h-13z" /></svg>;
  if (name === 'chat') return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2.5h12v8H7l-3.5 3v-3H2z" /><path d="M5 6.5h6" /></svg>;
  if (name === 'proofread') return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8.2 6 11.5 13.5 4" /></svg>;
  if (name === 'sparkle') return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m8 1.5 1 3.5 3.5 1L9 7l-1 3.5L7 7 3.5 6 7 5zM12.5 10l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5z" /></svg>;
  if (name === 'palette') return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5a6.4 6.4 0 0 0 0 12.8h1.2a1.4 1.4 0 0 0 0-2.8H8.5a1.3 1.3 0 0 1 0-2.6H12A2.5 2.5 0 0 0 14.5 6C13.8 3.4 11.2 1.5 8 1.5Z" /><circle cx="4.5" cy="6.3" r=".7" /><circle cx="6.4" cy="3.9" r=".7" /><circle cx="9.4" cy="3.8" r=".7" /></svg>;
  if (name === 'rewrite') return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3.5h7M3 6.5h5M2.5 13.5l.7-3.2L11.5 2l2.5 2.5-8.3 8.3z" /></svg>;
  if (name === 'translate') return <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" /><path d="M1.8 8h12.4M8 1.8c1.6 1.7 2.4 3.7 2.4 6.2S9.6 12.5 8 14.2C6.4 12.5 5.6 10.5 5.6 8S6.4 3.5 8 1.8Z" /></svg>;
  if (name === 'summary') return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 1.8h7l3 3v9.4H3zM10 1.8v3h3M5.2 8h5.6M5.2 10.5h5.6" /></svg>;
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2.5h10M4.5 6h7M6 9.5h4M8 9.5v4" /></svg>;
}

export function ImageOptionsModal({ onClose, onInsert }: { onClose: () => void; onInsert: (url: string, alt?: string) => void }) {
  const [mode, setMode] = useState<'link' | 'upload' | 'local' | null>(null);
  const [imageUrl, setImageUrl] = useState('');
  const [altText, setAltText] = useState('');
  const { setUploadStatus, settings, setSettingsOpen, setSettingsTab } = useAppStore();

  const handleUpload = async () => {
    try {
      const service = settings.image_hosting.active_service;
      if (!service) {
        setUploadStatus('error', 0, '请先启用并配置图床服务');
        setSettingsTab('image');
        setSettingsOpen(true);
        onClose();
        return;
      }
      const selected = await open({
        multiple: false,
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
      });
      if (selected) {
        setUploadStatus('uploading', 0, '正在上传图片...');
        setMode('upload');

        const result = await invoke<string>('upload_image', {
          filePath: selected,
          service,
          settings,
        });

        setUploadStatus('success', 100, '上传成功');
        onInsert(result, altText || '图片');
        onClose();
      }
    } catch (error) {
      setUploadStatus('error', 0, String(error));
    }
  };

  const handleLocalImage = async () => {
    try {
      const selected = await open({ multiple: false, filters: imageDialogFilters() });
      if (!selected) return;
      setMode('local');
      // 复制到文档同级的 .assets 目录，文档移动后素材不会失效，也不依赖图床配置。
      await insertImageFromPath(selected, altText.trim() || undefined);
      onClose();
    } catch (error) {
      setUploadStatus('error', 0, String(error));
    }
  };

  const handleLinkInsert = () => {
    if (imageUrl.trim()) {
      onInsert(imageUrl.trim(), altText.trim() || '图片');
      onClose();
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content image-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>插入图片</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {!mode ? (
            <div className="image-options">
              <button className="image-option-btn" onClick={() => void handleLocalImage()}>
                <span className="option-icon"><ToolbarGlyph name="image" /></span>
                <span className="option-text">本地图片</span>
                <span className="option-desc">复制到文档同级的 .assets 目录，离线可看</span>
              </button>
              <button className="image-option-btn" onClick={() => setMode('link')}>
                <span className="option-icon"><ToolbarGlyph name="link" /></span>
                <span className="option-text">输入图片链接</span>
                <span className="option-desc">从网络URL插入图片</span>
              </button>
              <button className="image-option-btn" onClick={handleUpload}>
                <span className="option-icon"><ToolbarGlyph name="folder" /></span>
                <span className="option-text">本地图片上传</span>
                <span className="option-desc">选择本地图片上传到图床</span>
              </button>
            </div>
          ) : mode === 'link' ? (
            <div className="link-form">
              <div className="form-field">
                <label>图片链接</label>
                <input
                  type="text"
                  value={imageUrl}
                  onChange={e => setImageUrl(e.target.value)}
                  placeholder="https://example.com/image.png"
                />
              </div>
              <div className="form-field">
                <label>替代文本</label>
                <input
                  type="text"
                  value={altText}
                  onChange={e => setAltText(e.target.value)}
                  placeholder="图片描述"
                />
              </div>
              <div className="form-actions">
                <button className="cancel-btn" onClick={() => setMode(null)}>返回</button>
                <button className="save-btn" onClick={handleLinkInsert} disabled={!imageUrl.trim()}>插入</button>
              </div>
            </div>
          ) : mode === 'local' ? (
            <div className="link-form">
              <p className="image-local-hint">正在把图片复制到文档同级的 .assets 目录…</p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function MediaInsertModal({ onClose, onInsertSyntax }: { onClose: () => void; onInsertSyntax: (markdown: string) => void }) {
  const [step, setStep] = useState<'choose' | 'link'>('choose');
  const [url, setUrl] = useState('');
  const [importing, setImporting] = useState(false);
  const trimmed = url.trim();
  const linkKind = mediaKindOfSource(trimmed);
  const linkSupported = linkKind !== null || videoPlatformEmbed(trimmed) !== null;

  const handleLocalFiles = async () => {
    try {
      const selected = await open({ multiple: true, filters: mediaDialogFilters('auto') });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      setImporting(true);
      for (const path of paths) {
        await insertMediaFromPath(path);
      }
      onClose();
    } finally {
      setImporting(false);
    }
  };

  const handleLinkInsert = () => {
    onInsertSyntax(formatMediaEmbed({ kind: linkKind === 'audio' ? 'audio' : 'video', src: trimmed }));
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content video-insert-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2>插入媒体</h2>
          <button className="modal-close" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="modal-body">
          {step === 'choose' ? (
            <div className="image-options">
              <button className="image-option-btn" disabled={importing} onClick={() => void handleLocalFiles()}>
                <span className="option-icon"><ToolbarGlyph name="folder" /></span>
                <span className="option-text">{importing ? '正在导入…' : '本地视频 / 音频'}</span>
                <span className="option-desc">复制到文档同级的 .assets 目录，离线也能播放</span>
              </button>
              <button className="image-option-btn" disabled={importing} onClick={() => setStep('link')}>
                <span className="option-icon"><ToolbarGlyph name="video" /></span>
                <span className="option-text">在线媒体链接</span>
                <span className="option-desc">支持 B站、YouTube、Vimeo，以及 mp4 / mp3 直链</span>
              </button>
            </div>
          ) : (
            <div className="link-form">
              <div className="form-field">
                <label>媒体链接</label>
                <input autoFocus type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="粘贴 B站、YouTube、Vimeo 链接，或 mp4 / mp3 直链" />
                <small>在线地址需要网络才能播放；离线素材请返回上一步选择本地文件。</small>
              </div>
              <div className="form-actions">
                <button className="cancel-btn" onClick={() => setStep('choose')}>返回</button>
                <button className="save-btn" disabled={!linkSupported} onClick={handleLinkInsert}>插入媒体</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const EMOJI_GROUPS = [
  { label: '表情', values: ['😀', '😃', '😄', '😁', '😂', '🥹', '😊', '😍', '🥰', '😘', '😎', '🤔', '😴', '😭', '😤', '😱'] },
  { label: '手势', values: ['👍', '👎', '👏', '🙌', '🙏', '🤝', '👌', '✌️', '🤞', '💪', '👋', '👉', '👀'] },
  { label: '符号', values: ['❤️', '🧡', '💛', '💚', '💙', '💜', '✅', '❌', '⚠️', '❗', '❓', '💯', '✨', '🔥'] },
  { label: '写作', values: ['💡', '📝', '📌', '📎', '📚', '🔍', '📊', '🎯', '🚀', '🎉', '🏆', '⏳', '🔔', '🧭'] },
];

function EmojiPicker({ favorites, onClose, onInsert }: { favorites: string[]; onClose: () => void; onInsert: (emoji: string) => void }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content emoji-picker-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2>插入 Emoji</h2>
          <button className="modal-close" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="modal-body emoji-picker-body">
          {favorites.length > 0 && (
            <section><div className="emoji-section-title">常用表情 <small>可在“设置 → 编辑器”中修改</small></div><div className="emoji-grid">{favorites.map((emoji) => <button key={emoji} onClick={() => { onInsert(emoji); onClose(); }}>{emoji}</button>)}</div></section>
          )}
          {EMOJI_GROUPS.map((group) => (
            <section key={group.label}><div className="emoji-section-title">{group.label}</div><div className="emoji-grid">{group.values.map((emoji) => <button key={emoji} onClick={() => { onInsert(emoji); onClose(); }}>{emoji}</button>)}</div></section>
          ))}
        </div>
      </div>
    </div>
  );
}

function MarkdownFormatModal({ result, onClose, onApply }: { result: MarkdownFormatResult; onClose: () => void; onApply: () => void }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content markdown-format-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header"><h2>Markdown 语法检查</h2><button className="modal-close" onClick={onClose} aria-label="关闭">×</button></div>
        <div className="modal-body">
          <div className={`markdown-format-summary ${result.issues.length ? 'has-issues' : 'is-clean'}`}>
            <strong>{result.issues.length ? `发现 ${result.issues.length} 类可规范项` : 'Markdown 格式已经很规范'}</strong>
            <span>格式化只调整标记、空格与空行，不改写正文内容。</span>
          </div>
          {result.issues.length > 0 && <ul className="markdown-format-issues">{result.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
          <div className="form-actions"><button className="cancel-btn" onClick={onClose}>取消</button><button className="save-btn" disabled={!result.changed} onClick={onApply}>应用专业格式</button></div>
        </div>
      </div>
    </div>
  );
}

export function Toolbar({ variant = 'pinned' }: ToolbarProps) {
  const { editorView, setContent, content, settings } = useAppStore();
  const [showImageModal, setShowImageModal] = useState(false);
  const [showMediaModal, setShowMediaModal] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showFormatModal, setShowFormatModal] = useState(false);
  const [showTablePicker, setShowTablePicker] = useState(false);
  const tablePickerButtonRef = useRef<HTMLButtonElement>(null);
  const toolbarWheelDeltaRef = useRef(0);
  const toolbarWheelFrameRef = useRef<number | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const toolbarScrollAreaRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  const [directButtonCount, setDirectButtonCount] = useState(8);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [overflowPosition, setOverflowPosition] = useState({ left: 0, top: 0, above: false });
  const wrapSelection = (before: string, after: string) => {
    if (!editorView) {
      setContent(content + before + after);
      return;
    }

    const selection = editorView.state.selection.main;
    const selectedText = editorView.state.sliceDoc(selection.from, selection.to);

    if (selectedText) {
      const transaction = editorView.state.update({
        changes: {
          from: selection.from,
          to: selection.to,
          insert: before + selectedText + after,
        },
        selection: { anchor: selection.from + before.length, head: selection.from + before.length + selectedText.length },
      });
      editorView.dispatch(transaction);
    } else {
      const transaction = editorView.state.update({
        changes: {
          from: selection.from,
          to: selection.from,
          insert: before + after,
        },
        selection: { anchor: selection.from + before.length },
      });
      editorView.dispatch(transaction);
    }
    editorView.focus();
  };

  const insertAtCursor = (text: string, cursorOffset?: number) => {
    if (!editorView) {
      setContent(content + text);
      return;
    }

    const selection = editorView.state.selection.main;
    const transaction = editorView.state.update({
      changes: {
        from: selection.from,
        to: selection.to,
        insert: text,
      },
      selection: { anchor: selection.from + (cursorOffset ?? text.length) },
    });
    editorView.dispatch(transaction);
    editorView.focus();
  };

  const insertBlock = (prefix: string, suffix: string = '\n') => {
    if (!editorView) {
      setContent(content + prefix + suffix);
      return;
    }

    const selection = editorView.state.selection.main;
    const line = editorView.state.doc.lineAt(selection.from);
    const atLineStart = selection.from === line.from;
    const insertText = atLineStart ? prefix + suffix : '\n' + prefix + suffix;
    const insertPos = atLineStart ? line.from : selection.to;
    const cursorOffset = prefix.length;

    const transaction = editorView.state.update({
      changes: {
        from: insertPos,
        to: insertPos,
        insert: insertText,
      },
      selection: { anchor: insertPos + cursorOffset },
    });
    editorView.dispatch(transaction);
    editorView.focus();
  };

  const insertImage = (url: string, alt?: string) => {
    const imageMarkdown = `![${alt || '图片'}](${url})`;
    insertAtCursor(imageMarkdown);
  };

  const insertTable = (rows: number, columns: number) => {
    // 与斜杠命令、菜单入口共用同一份表格模板，光标落在表头第一个单元格。
    const { text, cursor } = buildTableInsert(rows, columns);
    insertAtCursor(`\n${text}\n`, cursor + 1);
    setShowTablePicker(false);
  };

  const insertMedia = (markdown: string) => insertAtCursor(`\n${markdown}\n`);

  const runEditorCommand = (command: 'undo' | 'redo') => {
    if (!editorView) return;
    editorView[command]();
    editorView.focus();
  };

  const clearInlineFormatting = () => {
    if (!editorView) return;
    const selection = editorView.state.selection.main;
    if (selection.empty) return;

    const selected = editorView.state.sliceDoc(selection.from, selection.to);
    const plainText = stripInlineFormatting(selected);

    if (plainText === selected) return;
    editorView.dispatch({
      changes: { from: selection.from, to: selection.to, insert: plainText },
      selection: { anchor: selection.from, head: selection.from + plainText.length },
    });
    editorView.focus();
  };

  const outdentSelection = () => {
    if (!editorView) return;
    const selection = editorView.state.selection.main;
    const document = editorView.state.doc;
    const start = document.lineAt(selection.from).from;
    const end = document.lineAt(selection.to).to;
    const source = editorView.state.sliceDoc(start, end);
    const outdented = source.replace(/^(?: {1,2}|\t)/gm, '');
    if (outdented === source) return;
    editorView.dispatch({ changes: { from: start, to: end, insert: outdented } });
    editorView.focus();
  };

  // 同类命令收进下拉菜单：直接按钮只保留最高频的动作，其余按主题归组。
  const toolbarGroups: ToolbarGroup[] = [
    {
      title: '格式',
      buttons: [
        { label: 'B', title: '加粗 (Ctrl+B)', action: () => wrapSelection('**', '**') },
        { label: 'I', title: '斜体 (Ctrl+I)', action: () => wrapSelection('*', '*') },
        { label: 'S', title: '删除线', action: () => wrapSelection('~~', '~~') },
        {
          label: '样式',
          title: '更多行内样式',
          menu: [
            { label: '高亮', action: () => wrapSelection('==', '==') },
            { label: '下划线', action: () => wrapSelection('<u>', '</u>') },
            { label: '上标', action: () => wrapSelection('<sup>', '</sup>') },
            { label: '下标', action: () => wrapSelection('<sub>', '</sub>') },
          ],
        },
        {
          label: '标题',
          title: '插入标题（H1 - H6）',
          menu: [
            { label: '一级标题', action: () => insertBlock('# ') },
            { label: '二级标题', action: () => insertBlock('## ') },
            { label: '三级标题', action: () => insertBlock('### ') },
            { label: '四级标题', action: () => insertBlock('#### ') },
            { label: '五级标题', action: () => insertBlock('##### ') },
            { label: '六级标题', action: () => insertBlock('###### ') },
          ],
        },
        {
          label: '列表',
          title: '列表与缩进',
          menu: [
            { label: '无序列表', action: () => insertBlock('- ') },
            { label: '有序列表', action: () => insertBlock('1. ') },
            { label: '任务列表', action: () => insertBlock('- [ ] ') },
            { label: '增加缩进', action: () => insertAtCursor('  ') },
          ],
        },
      ],
    },
    {
      title: '编辑',
      buttons: [
        { label: '↶', title: '撤销 (Ctrl+Z)', action: () => runEditorCommand('undo') },
        { label: '↷', title: '重做 (Ctrl+Y)', action: () => runEditorCommand('redo') },
        {
          label: '编辑',
          title: '缩进与文本整理',
          menu: [
            { label: '减少缩进', action: outdentSelection },
            { label: '清除行内格式', action: clearInlineFormatting },
            { label: '检查并格式化 Markdown', action: () => setShowFormatModal(true) },
          ],
        },
      ],
    },
    {
      title: '插入',
      buttons: [
        // 表格只有一个入口：点击打开尺寸选择器，拖动选行列或直接用默认 3 × 3。
        { icon: 'table', picker: true, title: '插入表格（拖动选择行列）', action: () => setShowTablePicker((visible) => !visible) },
        {
          label: '插入',
          title: '插入内容块',
          menu: [
            { label: '链接', action: () => wrapSelection('[', '](url)') },
            { label: '图片', action: () => setShowImageModal(true) },
            { label: '视频 / 音频', action: () => setShowMediaModal(true) },
            { label: 'Emoji', action: () => setShowEmojiPicker(true) },
            { label: '代码块', action: () => insertAtCursor('\n```\ncode\n```\n', 5) },
            { label: '引用', action: () => insertBlock('> ') },
            { label: '分割线', action: () => insertAtCursor('\n---\n') },
            { label: '目录', action: () => insertAtCursor('\n[TOC]\n') },
            { label: '可折叠内容', action: () => insertAtCursor('\n<details>\n<summary>展开查看</summary>\n\n内容\n\n</details>\n', 32) },
            { label: '注释', action: () => insertAtCursor('<!-- 注释 -->', 5) },
            { label: '分页符', action: () => insertAtCursor('\n<div style="page-break-after: always;"></div>\n') },
          ],
        },
        {
          label: '公式',
          title: '公式与脚注',
          menu: [
            { label: '行内公式', action: () => wrapSelection('$', '$') },
            { label: '公式块', action: () => insertBlock('$$\n', '\n$$\n') },
            { label: '脚注', action: () => wrapSelection('[^', ']()') },
          ],
        },
        {
          label: '图表',
          title: 'Mermaid 图表',
          menu: [
            { label: 'Mermaid 流程图', action: () => insertAtCursor('\n```mermaid\nflowchart LR\n  A[开始] --> B{判断}\n  B -->|是| C[执行]\n  B -->|否| D[结束]\n```\n', 24) },
            { label: 'Mermaid 时序图', action: () => insertAtCursor('\n```mermaid\nsequenceDiagram\n  participant 用户\n  participant 服务\n  用户->>服务: 请求\n  服务-->>用户: 响应\n```\n', 28) },
            { label: 'Mermaid 甘特图', action: () => insertAtCursor('\n```mermaid\ngantt\n  title 项目计划\n  dateFormat YYYY-MM-DD\n  section 开发\n  功能开发 :a1, 2026-01-01, 7d\n  测试 :a2, after a1, 3d\n```\n', 22) },
          ],
        },
      ],
    },
  ];

  const toolbarButtons = toolbarGroups.flatMap((group) => group.buttons.map((button) => ({ ...button, group: group.title })));
  const toolbarStructureKey = toolbarButtons.map((button) => `${button.group}:${button.title}`).join('|');
  const visibleButtons = toolbarButtons.slice(0, directButtonCount);
  const overflowButtons = toolbarButtons.slice(directButtonCount);

  useLayoutEffect(() => {
    const element = toolbarScrollAreaRef.current;
    if (!element) return;
    const buttonGroups = toolbarStructureKey.split('|').map((item) => item.split(':', 1)[0]);
    const updateVisibleButtons = () => {
      const available = element.clientWidth;
      const buttonWidth = 34;
      const separatorWidth = 15;
      let used = 0;
      let nextCount = 0;
      buttonGroups.forEach((group, index) => {
        const separator = index > 0 && group !== buttonGroups[index - 1] ? separatorWidth : 0;
        if (used + buttonWidth + separator <= available) {
          used += buttonWidth + separator;
          nextCount += 1;
        }
      });
      setDirectButtonCount(Math.max(1, Math.min(buttonGroups.length, nextCount)));
    };
    updateVisibleButtons();
    const observer = new ResizeObserver(updateVisibleButtons);
    observer.observe(element);
    return () => observer.disconnect();
  }, [toolbarStructureKey, variant]);

  useEffect(() => {
    if (!overflowOpen) return;
    const updateOverflowPosition = () => {
      const rect = moreButtonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const menuWidth = 240;
      const estimatedHeight = Math.min(420, Math.max(160, overflowButtons.length * 34 + 10));
      const roomAbove = rect.top - 10;
      const roomBelow = window.innerHeight - rect.bottom - 10;
      const above = variant === 'floating' && (roomAbove >= Math.min(estimatedHeight, 240) || roomAbove > roomBelow);
      setOverflowPosition({
        left: Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8)),
        top: above ? Math.max(8, rect.top - estimatedHeight - 6) : rect.bottom + 6,
        above,
      });
    };
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!toolbarRef.current?.contains(target) && !overflowMenuRef.current?.contains(target)) setOverflowOpen(false);
    };
    updateOverflowPosition();
    window.addEventListener('resize', updateOverflowPosition);
    window.addEventListener('scroll', updateOverflowPosition, true);
    window.addEventListener('pointerdown', closeOnOutsidePointer, true);
    return () => {
      window.removeEventListener('resize', updateOverflowPosition);
      window.removeEventListener('scroll', updateOverflowPosition, true);
      window.removeEventListener('pointerdown', closeOnOutsidePointer, true);
    };
  }, [overflowButtons.length, overflowOpen, variant]);

  useEffect(() => {
    return () => {
      if (toolbarWheelFrameRef.current !== null) {
        cancelAnimationFrame(toolbarWheelFrameRef.current);
      }
    };
  }, []);

  const handleToolbarWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const container = event.currentTarget;
    const maxScrollLeft = container.scrollWidth - container.clientWidth;
    const canScroll = maxScrollLeft > 0;
    if (!canScroll) return;

    const rawDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (rawDelta === 0) return;

    const deltaUnit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? container.clientWidth : 1;
    const delta = rawDelta * deltaUnit;
    const canMove = delta < 0 ? container.scrollLeft > 0 : container.scrollLeft < maxScrollLeft;
    if (!canMove) return;

    event.preventDefault();
    toolbarWheelDeltaRef.current += delta;

    if (toolbarWheelFrameRef.current !== null) return;

    toolbarWheelFrameRef.current = requestAnimationFrame(() => {
      const nextScrollLeft = container.scrollLeft + toolbarWheelDeltaRef.current;
      container.scrollLeft = Math.max(0, Math.min(maxScrollLeft, nextScrollLeft));
      toolbarWheelDeltaRef.current = 0;
      toolbarWheelFrameRef.current = null;
    });
  };

  const renderButton = (btn: ToolbarButton) => (
    btn.menu ? (
      <ToolbarMenu key={btn.title} label={btn.label ?? btn.title} title={btn.title} items={btn.menu} />
    ) : (
      <button
        key={btn.title}
        ref={btn.picker ? tablePickerButtonRef : undefined}
        className="toolbar-btn"
        title={btn.title}
        aria-label={btn.title}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void btn.action?.()}
      >
        {btn.icon ? <ToolbarGlyph name={btn.icon} /> : btn.label}
      </button>
    )
  );

  return (
    <div ref={toolbarRef} className={`toolbar toolbar-${variant}`}>
      <div ref={toolbarScrollAreaRef} className="toolbar-scroll-area" onWheel={handleToolbarWheel}>
        <div className="toolbar-left">
          {visibleButtons.map((btn, index) => (
            <span className="toolbar-item" key={btn.title}>
              {index > 0 && btn.group !== visibleButtons[index - 1].group && <span className="toolbar-separator" aria-hidden="true">|</span>}
              {renderButton(btn)}
            </span>
          ))}
        </div>
      </div>
      {overflowButtons.length > 0 && (
        <div className="toolbar-overflow">
          <button
            ref={moreButtonRef}
            type="button"
            className="toolbar-btn toolbar-more-btn"
            aria-label="更多编辑命令"
            title="更多编辑命令"
            aria-expanded={overflowOpen}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setOverflowOpen((open) => !open)}
          >•••</button>
        </div>
      )}
      {overflowOpen && createPortal(
        <div
          ref={overflowMenuRef}
          className={`toolbar-overflow-menu is-${variant} ${overflowPosition.above ? 'opens-above' : ''}`}
          style={{ left: overflowPosition.left, top: overflowPosition.top }}
          role="menu"
          onMouseDown={(event) => event.preventDefault()}
        >
          {overflowButtons.map((btn) => (
            btn.menu ? (
              <div key={btn.title} className="toolbar-overflow-menu-row">{renderButton(btn)}</div>
            ) : (
              <button key={btn.title} type="button" role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => { void btn.action?.(); setOverflowOpen(false); }}>
                <span>{btn.icon ? <ToolbarGlyph name={btn.icon} /> : btn.label}</span>{btn.title}
              </button>
            )
          ))}
        </div>,
        document.body,
      )}
      {showImageModal && (
        <ImageOptionsModal
          onClose={() => setShowImageModal(false)}
          onInsert={insertImage}
        />
      )}
      {showMediaModal && <MediaInsertModal onClose={() => setShowMediaModal(false)} onInsertSyntax={insertMedia} />}
      {showEmojiPicker && <EmojiPicker favorites={settings.editor.favorite_emojis} onClose={() => setShowEmojiPicker(false)} onInsert={insertAtCursor} />}
      {showFormatModal && (
        <MarkdownFormatModal
          result={formatMarkdown(content)}
          onClose={() => setShowFormatModal(false)}
          onApply={() => {
            const result = formatMarkdown(content);
            setContent(result.content);
            setShowFormatModal(false);
            useAIStore.getState().setStatus('success', `Markdown 格式化完成：处理 ${result.issues.length} 类问题`);
          }}
        />
      )}
      {showTablePicker && (
        <TablePicker
          anchorRef={tablePickerButtonRef}
          onInsert={insertTable}
          onInsertDefault={() => insertTable(3, 3)}
          onClose={() => setShowTablePicker(false)}
        />
      )}
    </div>
  );
}
