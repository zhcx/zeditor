/**
 * 编辑器右键菜单：源码对照（Monaco）与所见即所得共用一套。
 *
 * 只依赖 EditorController 接口（选区、替换、撤销重做、行读取）与 store，
 * 两种模式的菜单项与行为因此保持一致；样式沿用既有的 .editor-context-menu 系列。
 * 模式特有的链路通过回调交回宿主：插入图片（各自的图片插入链路）与
 * 粘贴兜底（Monaco 触发编辑器命令）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { useShallow } from 'zustand/react/shallow';
import MarkdownIt from 'markdown-it';
import { AppIcon } from '../Icons/AppIcon';
import type { IconName } from '../Icons/iconGeometry';
import { useAppStore } from '../../stores/appStore';
import { useAIStore } from '../../stores/aiStore';
import { sameDocument } from '../../utils/documentSafety';
import { formatShortcut } from '../../utils/platformShortcuts';
import { t } from '../../i18n';
import { sanitizeRenderedHtml } from '../../utils/safeHtml';
import { prepareMarkdownPaste } from '../../utils/markdownPaste';
import { applyTableAction, insertTable, type TableAction } from '../../utils/markdownTable';
import { stripInlineFormatting } from '../../utils/inlineFormatting';
import { applyHeadingLevel } from '../../utils/headingFormatting';

export interface EditorContextMenuState {
  x: number;
  y: number;
  submenuDirection: 'left' | 'right';
  hasSelection: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** 光标是否在 Markdown 表格内：表格子菜单据此启用。 */
  inTable: boolean;
}

const contextMenuMarkdown = new MarkdownIt({ html: true, breaks: true, linkify: true, typographer: true });

type ContextMenuIconName =
  | 'sparkles'
  | 'translate'
  | 'copy'
  | 'copyAs'
  | 'paste'
  | 'cut'
  | 'text'
  | 'format'
  | 'heading'
  | 'insert'
  | 'selectAll'
  | 'pdf'
  | 'document'
  | 'code'
  | 'image'
  | 'folder'
  | 'undo'
  | 'redo'
  | 'table'
  | 'select';

interface ContextSubmenuProps {
  label: string;
  icon: ContextMenuIconName;
  direction: 'left' | 'right';
  open: boolean;
  disabled?: boolean;
  onToggle: () => void;
  onHover: (open: boolean) => void;
  children: React.ReactNode;
}

/**
 * 右键菜单里的二级菜单：悬停或点击展开。
 * 弹层挂在 body 上，主菜单带 `overflow-y: auto` 会裁剪内联子菜单（还会挤出横向滚动条），
 * 因此位置按触发行的矩形实时测量，并按窗口剩余空间决定左右与上下方向。
 */
export function ContextSubmenu({ label, icon, direction, open, disabled, onToggle, onHover, children }: ContextSubmenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  // 弹层挂在 body 上，不再是触发行 DOM 的子节点：鼠标移入弹层时会先触发父级的
  // mouseleave，因此延迟收起来给指针留出跨越间隙的时间。
  const closeTimerRef = useRef<number | null>(null);
  const cancelClose = () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => onHover(false), 160);
  };
  useEffect(() => cancelClose, []);

  // useLayoutEffect 在浏览器绘制前完成测量，重新展开时不会闪出上一轮的位置。
  useLayoutEffect(() => {
    if (!open) return undefined;
    let frame = 0;
    const update = () => {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;
      const rect = trigger.getBoundingClientRect();
      const width = menu.offsetWidth || 178;
      const height = menu.offsetHeight || 220;
      const left = direction === 'left'
        ? Math.max(8, rect.left - width + 2)
        : Math.max(8, Math.min(rect.right - 2, window.innerWidth - width - 8));
      const top = Math.max(8, Math.min(rect.top - 6, window.innerHeight - height - 8));
      setPosition({ top, left });
    };

    update();
    frame = window.requestAnimationFrame(update);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, direction]);

  return (
    <div
      className="editor-context-menu-group"
      data-submenu-direction={direction}
      onMouseEnter={() => {
        cancelClose();
        onHover(true);
      }}
      onMouseLeave={scheduleClose}
    >
      <button
        ref={triggerRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onToggle}
      >
        <span className="editor-context-menu-icon"><ContextMenuIcon name={icon} /></span>
        <span className="editor-context-menu-label">{label}</span>
        <span className="editor-context-menu-chevron">›</span>
      </button>
      {open && !disabled && createPortal(
        <div
          ref={menuRef}
          className="editor-context-submenu"
          role="menu"
          aria-label={label}
          style={{
            top: position?.top ?? 0,
            left: position?.left ?? 0,
            visibility: position ? 'visible' : 'hidden',
          }}
          onMouseDown={(event) => {
            // 阻止默认行为让编辑器保持焦点，动作执行时选区仍然有效。
            event.preventDefault();
            event.stopPropagation();
          }}
          // 宿主用 pointerdown 关闭菜单时，子菜单挂在 body 上不在宿主根节点内：
          // 这里同样阻止冒泡，否则按下子菜单项时子菜单会先被卸载、click 收不到。
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          {children}
        </div>,
        document.body,
      )}
    </div>
  );
}

const ContextMenuIconNames = {"sparkles":"companion","translate":"languages","copy":"copy","copyAs":"copyAs","paste":"paste","cut":"cut","text":"font","format":"sliders","heading":"heading","insert":"plus","selectAll":"selectAll","pdf":"fileLabel","document":"fileText","code":"code","image":"image","folder":"folder","undo":"undo","redo":"redo","table":"table","select":"cursor"} as const satisfies Record<string, IconName>;

function ContextMenuIcon({ name }: { name: ContextMenuIconName }) {
  return <AppIcon name={ContextMenuIconNames[name]} label={name === 'pdf' ? 'PDF' : undefined} />;
}

export interface EditorContextMenuProps {
  state: EditorContextMenuState;
  onClose: () => void;
  /** 插入图片：各模式的图片链路不同（本地浏览 / 图床 / 附件），交回宿主打开自己的弹窗。 */
  onInsertImage: () => void;
  /** 剪贴板读取被宿主拒绝时的兜底（Monaco 用它触发编辑器内的粘贴命令）。 */
  onPasteFallback?: () => void;
}

export function EditorContextMenu({ state, onClose, onInsertImage, onPasteFallback }: EditorContextMenuProps) {
  // 控制器取自 store：两种编辑器都会把当前控制器写进 editorView，
  // 菜单因此不需要宿主传参（也避免宿主在渲染期读 ref）。
  const controller = useAppStore(store => store.editorView);
  const { rewriteSelection, translateText, setTranslationVisible, setStatus } = useAIStore(useShallow(ai => ({
    rewriteSelection: ai.rewriteSelection,
    translateText: ai.translateText,
    setTranslationVisible: ai.setTranslationVisible,
    setStatus: ai.setStatus,
  })));
  const language = useAppStore(store => store.settings.appearance.language);
  const currentFile = useAppStore(store => store.currentFile);
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpenSubmenu(null);
    onClose();
  }, [onClose]);

  // 点击菜单外部、窗口失焦或 Esc 关闭。
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', keydown);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', keydown);
    };
  }, [close]);

  // 位置由宿主按点击点给出；渲染后菜单可能比剩余空间还高，向上收进视口。
  // 直接改内联样式而不是 setState：effect 里同步 setState 会触发级联渲染
  //（react-hooks/set-state-in-effect），而这里只影响视觉位置。
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element) return;
    const maxTop = window.innerHeight - element.offsetHeight - 8;
    element.style.left = `${state.x}px`;
    element.style.top = `${Math.max(8, Math.min(state.y, maxTop))}px`;
  }, [state]);

  const runContextMenuAction = useCallback(async (action: 'undo' | 'redo' | 'cut' | 'copy' | 'copyHtml' | 'copyPlain' | 'paste' | 'selectAll') => {
    close();
    if (!controller) return;
    if (action === 'undo' || action === 'redo') {
      if (action === 'undo') controller.undo();
      else controller.redo();
    } else if (action === 'selectAll') {
      controller.setSelection(0, controller.getValue().length);
    } else if (action === 'paste') {
      try {
        const text = await navigator.clipboard.readText();
        const selection = controller.getSelection();
        controller.replaceRange(selection.from, selection.to, text, {
          from: selection.from + text.length,
          to: selection.from + text.length,
        });
      } catch {
        onPasteFallback?.();
      }
    } else {
      const selection = controller.getSelection();
      const selectedText = controller.getText(selection.from, selection.to);
      if (!selectedText) return;
      const clipboardText = action === 'copyPlain'
        ? selectedText
            .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            .replace(/^#{1,6}\s+/gm, '')
            .replace(/(?:\*\*|__|~~|`)/g, '')
        : action === 'copyHtml'
          ? sanitizeRenderedHtml(contextMenuMarkdown.render(selectedText))
          : selectedText;
      try {
        if (action === 'copyHtml' && typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
          await navigator.clipboard.write([new ClipboardItem({
            'text/html': new Blob([clipboardText], { type: 'text/html' }),
            'text/plain': new Blob([clipboardText], { type: 'text/plain' }),
          })]);
        } else {
          await navigator.clipboard.writeText(clipboardText);
        }
        if (action === 'cut') controller.replaceRange(selection.from, selection.to, '');
      } catch {
        // 剪贴板权限被宿主拒绝：保留选区，用户可改用快捷键。
      }
    }
    controller.focus();
  }, [close, controller, onPasteFallback]);

  const polishContextSelection = useCallback(async () => {
    close();
    if (!controller) return;
    const selection = controller.getSelection();
    const selectedText = controller.getText(selection.from, selection.to);
    if (!selectedText) return;
    setStatus('loading', '正在润色选中文本...');
    const snapshot = { activeTabId: useAppStore.getState().activeTabId, content: controller.getValue() };
    const polished = await rewriteSelection(selectedText);
    if (!sameDocument(snapshot, useAppStore.getState())) {
      setStatus('error', '文档已变化，请重新发起润色');
      return;
    }
    if (polished) controller.replaceRange(selection.from, selection.to, polished, { from: selection.from, to: selection.from + polished.length });
    controller.focus();
  }, [close, controller, rewriteSelection, setStatus]);

  const translateContextSelection = useCallback(async () => {
    close();
    if (!controller) return;
    const selection = controller.getSelection();
    const selectedText = controller.getText(selection.from, selection.to);
    if (!selectedText) return;
    const coords = controller.coordsAtPos(selection.from);
    const result = await translateText(selectedText);
    const separatorIndex = result.indexOf('|||');
    if (separatorIndex < 0) return;
    const original = result.slice(0, separatorIndex);
    const translated = result.slice(separatorIndex + 3);
    if (translated && translated !== selectedText) {
      setTranslationVisible(true, coords ? { x: coords.left, y: coords.bottom } : undefined, original, translated);
    }
    controller.focus();
  }, [close, controller, setTranslationVisible, translateText]);

  // 右键菜单里的格式化 / 插入动作：与浮动工具栏同源，但直接作用于当前选区。
  const runContextWrap = useCallback((before: string, after: string) => {
    close();
    if (!controller) return;
    const selection = controller.getSelection();
    const selected = controller.getText(selection.from, selection.to);
    const text = selected || '文本';
    const cursor = selection.from + before.length;
    controller.replaceRange(selection.from, selection.to, `${before}${text}${after}`, {
      from: cursor,
      to: cursor + text.length,
    });
    controller.focus();
  }, [close, controller]);

  const runContextInsert = useCallback((text: string, cursorOffset?: number) => {
    close();
    if (!controller) return;
    const selection = controller.getSelection();
    const cursor = selection.from + (cursorOffset ?? text.length);
    controller.replaceRange(selection.from, selection.to, text, { from: cursor, to: cursor });
    controller.focus();
  }, [close, controller]);

  const applyContextHeading = useCallback((level: number) => {
    close();
    if (!controller) return;
    applyHeadingLevel(controller, level);
  }, [close, controller]);

  const clearContextInlineFormatting = useCallback(() => {
    close();
    if (!controller) return;
    const selection = controller.getSelection();
    const selected = controller.getText(selection.from, selection.to);
    const plain = stripInlineFormatting(selected);
    if (plain === selected) return;
    controller.replaceRange(selection.from, selection.to, plain, {
      from: selection.from,
      to: selection.from + plain.length,
    });
    controller.focus();
  }, [close, controller]);

  const runContextTableAction = useCallback((action: TableAction) => {
    close();
    if (!controller) return;
    const selection = controller.getSelection();
    const edit = applyTableAction(controller.getValue(), selection.to, action);
    if (!edit) return;
    controller.replaceRange(edit.from, edit.to, edit.text, { from: edit.cursor, to: edit.cursorEnd });
    controller.focus();
  }, [close, controller]);

  const requestContextTable = useCallback(() => {
    close();
    if (!controller) return;
    const selection = controller.getSelection();
    const insertion = insertTable(3, 3);
    const text = prepareMarkdownPaste(insertion.text, controller.getValue(), selection.from, selection.to);
    const prefix = text.indexOf(insertion.text);
    controller.replaceRange(selection.from, selection.to, text, { from: selection.from + prefix + insertion.cursor, to: selection.from + prefix + insertion.cursorEnd });
    controller.focus();
  }, [close, controller]);

  const requestExport = useCallback((format: 'pdf' | 'word' | 'html') => {
    close();
    window.dispatchEvent(new CustomEvent('zeditor-export-request', { detail: { format } }));
  }, [close]);

  const revealCurrentFile = useCallback(async () => {
    close();
    if (!currentFile || currentFile.startsWith('web://')) return;
    await invoke('reveal_in_file_manager', { path: currentFile });
  }, [close, currentFile]);

  // 子菜单靠 hover 展开：点击只负责打开，不做 toggle——否则悬停已经展开时
  // 点一下会立刻收起（toggle 会把 hover 的结果翻回去）。
  const submenuHandlers = (id: string) => ({
    open: openSubmenu === id,
    onToggle: () => setOpenSubmenu(id),
    onHover: (open: boolean) => setOpenSubmenu((current) => (open ? id : current === id ? null : current)),
  });

  return (
    <div
      ref={menuRef}
      className="editor-context-menu"
      role="menu"
      aria-label={t('编辑器', language)}
      style={{ left: state.x, top: state.y }}
      onMouseDown={(event) => {
        // preventDefault 阻止焦点从编辑器移走，选中文字不会因为打开菜单而丢失高亮。
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <button type="button" role="menuitem" disabled={!state.hasSelection} onClick={() => void polishContextSelection()}>
        <span className="editor-context-menu-icon tone-accent"><ContextMenuIcon name="sparkles" /></span><span className="editor-context-menu-label">AI 润色</span>
      </button>
      <button type="button" role="menuitem" disabled={!state.hasSelection} onClick={() => void translateContextSelection()}>
        <span className="editor-context-menu-icon tone-blue"><ContextMenuIcon name="translate" /></span><span className="editor-context-menu-label">AI 翻译</span>
      </button>
      <div className="editor-context-menu-divider" role="separator" />
      <button type="button" role="menuitem" disabled={!state.canUndo} onClick={() => void runContextMenuAction('undo')}>
        <span className="editor-context-menu-icon"><ContextMenuIcon name="undo" /></span><span className="editor-context-menu-label">{t('撤销', language)}</span><kbd>{formatShortcut('Ctrl+Z')}</kbd>
      </button>
      <button type="button" role="menuitem" disabled={!state.canRedo} onClick={() => void runContextMenuAction('redo')}>
        <span className="editor-context-menu-icon"><ContextMenuIcon name="redo" /></span><span className="editor-context-menu-label">{t('重做', language)}</span><kbd>{formatShortcut('Ctrl+Y')}</kbd>
      </button>
      <button type="button" role="menuitem" disabled={!state.hasSelection} onClick={() => void runContextMenuAction('cut')}>
        <span className="editor-context-menu-icon"><ContextMenuIcon name="cut" /></span><span className="editor-context-menu-label">{t('剪切', language)}</span><kbd>{formatShortcut('Ctrl+X')}</kbd>
      </button>
      <button type="button" role="menuitem" disabled={!state.hasSelection} onClick={() => void runContextMenuAction('copy')}>
        <span className="editor-context-menu-icon tone-blue"><ContextMenuIcon name="copy" /></span><span className="editor-context-menu-label">{t('复制', language)}</span><kbd>{formatShortcut('Ctrl+C')}</kbd>
      </button>
      <ContextSubmenu label="复制为" icon="copyAs" direction={state.submenuDirection} disabled={!state.hasSelection} {...submenuHandlers('copyAs')}>
        <button type="button" role="menuitem" onClick={() => void runContextMenuAction('copyHtml')}><span>HTML</span></button>
        <button type="button" role="menuitem" onClick={() => void runContextMenuAction('copyPlain')}><span>纯文本</span></button>
      </ContextSubmenu>
      <button type="button" role="menuitem" onClick={() => void runContextMenuAction('paste')}>
        <span className="editor-context-menu-icon tone-green"><ContextMenuIcon name="paste" /></span><span className="editor-context-menu-label">{t('粘贴', language)}</span><kbd>{formatShortcut('Ctrl+V')}</kbd>
      </button>
      <button type="button" role="menuitem" onClick={() => void runContextMenuAction('paste')}>
        <span className="editor-context-menu-icon"><ContextMenuIcon name="text" /></span><span className="editor-context-menu-label">粘贴为纯文本</span><kbd>{formatShortcut('Ctrl+Shift+V')}</kbd>
      </button>
      <button type="button" role="menuitem" onClick={() => void runContextMenuAction('selectAll')}>
        <span className="editor-context-menu-icon"><ContextMenuIcon name="selectAll" /></span><span className="editor-context-menu-label">{t('全选', language)}</span><kbd>{formatShortcut('Ctrl+A')}</kbd>
      </button>

      <div className="editor-context-menu-divider" role="separator" />

      {/* 格式与标题：与浮动工具栏同源的动作，右键就能就地处理选中文字 */}
      <ContextSubmenu label="格式" icon="format" direction={state.submenuDirection} disabled={!state.hasSelection} {...submenuHandlers('format')}>
        <button type="button" role="menuitem" onClick={() => runContextWrap('**', '**')}><span>加粗</span></button>
        <button type="button" role="menuitem" onClick={() => runContextWrap('*', '*')}><span>斜体</span></button>
        <button type="button" role="menuitem" onClick={() => runContextWrap('~~', '~~')}><span>删除线</span></button>
        <button type="button" role="menuitem" onClick={() => runContextWrap('==', '==')}><span>高亮</span></button>
        <button type="button" role="menuitem" onClick={() => runContextWrap('<u>', '</u>')}><span>下划线</span></button>
        <button type="button" role="menuitem" onClick={() => runContextWrap('<sup>', '</sup>')}><span>上标</span></button>
        <button type="button" role="menuitem" onClick={() => runContextWrap('<sub>', '</sub>')}><span>下标</span></button>
        <button type="button" role="menuitem" onClick={() => runContextWrap('`', '`')}><span>行内代码</span></button>
        <div className="editor-context-menu-divider" role="separator" />
        <button type="button" role="menuitem" onClick={clearContextInlineFormatting}><span>清除行内格式</span></button>
      </ContextSubmenu>
      <ContextSubmenu label="标题" icon="heading" direction={state.submenuDirection} {...submenuHandlers('heading')}>
        {[1, 2, 3, 4, 5, 6].map((level) => (
          <button key={level} type="button" role="menuitem" onClick={() => applyContextHeading(level)}>
            <span>{level} 级标题</span>
          </button>
        ))}
      </ContextSubmenu>

      <div className="editor-context-menu-divider" role="separator" />

      {/* 插入与表格：按当前场景提供常用内容块与表格结构操作 */}
      <ContextSubmenu label="插入" icon="insert" direction={state.submenuDirection} {...submenuHandlers('insert')}>
        <button type="button" role="menuitem" onClick={() => runContextWrap('[', '](url)')}><span>链接</span></button>
        <button type="button" role="menuitem" onClick={() => { close(); onInsertImage(); }}><span>插入图片</span></button>
        <button type="button" role="menuitem" onClick={requestContextTable}><span>插入表格</span></button>
        <button type="button" role="menuitem" onClick={() => runContextInsert('\n```\ncode\n```\n', 5)}><span>代码块</span></button>
        <button type="button" role="menuitem" onClick={() => runContextInsert('> ')}><span>引用</span></button>
        <button type="button" role="menuitem" onClick={() => runContextInsert('\n---\n')}><span>分割线</span></button>
      </ContextSubmenu>
      {/* 表格：插入随时可用；行列与对齐操作要求光标位于表格内 */}
      <ContextSubmenu label="表格" icon="table" direction={state.submenuDirection} {...submenuHandlers('table')}>
        <button type="button" role="menuitem" onClick={requestContextTable}><span>插入 3 × 3 表格</span></button>
        <div className="editor-context-menu-divider" role="separator" />
        <button type="button" role="menuitem" disabled={!state.inTable} onClick={() => runContextTableAction('row-above')}><span>上方插入行</span></button>
        <button type="button" role="menuitem" disabled={!state.inTable} onClick={() => runContextTableAction('row-below')}><span>下方插入行</span></button>
        <button type="button" role="menuitem" disabled={!state.inTable} onClick={() => runContextTableAction('row-delete')}><span>删除当前行</span></button>
        <button type="button" role="menuitem" disabled={!state.inTable} onClick={() => runContextTableAction('column-left')}><span>左侧插入列</span></button>
        <button type="button" role="menuitem" disabled={!state.inTable} onClick={() => runContextTableAction('column-right')}><span>右侧插入列</span></button>
        <button type="button" role="menuitem" disabled={!state.inTable} onClick={() => runContextTableAction('column-delete')}><span>删除当前列</span></button>
        <div className="editor-context-menu-divider" role="separator" />
        <button type="button" role="menuitem" disabled={!state.inTable} onClick={() => runContextTableAction('align-left')}><span>当前列左对齐</span></button>
        <button type="button" role="menuitem" disabled={!state.inTable} onClick={() => runContextTableAction('align-center')}><span>当前列居中</span></button>
        <button type="button" role="menuitem" disabled={!state.inTable} onClick={() => runContextTableAction('align-right')}><span>当前列右对齐</span></button>
        <div className="editor-context-menu-divider" role="separator" />
        <button type="button" role="menuitem" disabled={!state.inTable} onClick={() => runContextTableAction('format')}><span>整理表格格式</span></button>
        <button type="button" role="menuitem" disabled={!state.inTable} onClick={() => runContextTableAction('table-delete')}><span>删除整张表格</span></button>
        {!state.inTable && <div className="editor-context-menu-hint">把光标放进表格即可使用行列与对齐操作</div>}
      </ContextSubmenu>

      <div className="editor-context-menu-divider" role="separator" />

      <button type="button" role="menuitem" onClick={() => requestExport('pdf')}>
        <span className="editor-context-menu-icon tone-red"><ContextMenuIcon name="pdf" /></span><span className="editor-context-menu-label">导出 PDF</span>
      </button>
      <button type="button" role="menuitem" onClick={() => requestExport('word')}>
        <span className="editor-context-menu-icon tone-blue"><ContextMenuIcon name="document" /></span><span className="editor-context-menu-label">导出 Word</span>
      </button>
      <button type="button" role="menuitem" onClick={() => requestExport('html')}>
        <span className="editor-context-menu-icon tone-blue"><ContextMenuIcon name="code" /></span><span className="editor-context-menu-label">导出 HTML</span>
      </button>
      <div className="editor-context-menu-divider" role="separator" />
      <button type="button" role="menuitem" disabled={!currentFile || currentFile.startsWith('web://')} onClick={() => void revealCurrentFile()}>
        <span className="editor-context-menu-icon tone-blue"><ContextMenuIcon name="folder" /></span><span className="editor-context-menu-label">在文件夹中显示</span>
      </button>
    </div>
  );
}
