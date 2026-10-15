import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ImageOptionsModal, Toolbar } from '../Toolbar/Toolbar';
import { SlashCommandMenu, type SlashMenuAnchor } from '../Editor/SlashCommandMenu';
import { TableToolbar } from '../Editor/TableToolbar';
import { filterSlashCommands, findSlashCommandTrigger, resolveSlashSelection, type SlashCommand, type SlashCommandTrigger } from '../../utils/slashCommands';
import { applyTableAction, alignmentAt, insertTable, navigateTableCell, parseTableAt, type TableAction } from '../../utils/markdownTable';
import { prepareMarkdownPaste } from '../../utils/markdownPaste';
import { lineAtOffset } from '../../utils/wysiwyg/textLines';
import { extractGenieTarget, slashAiGenie } from '../../utils/aiGenies';
import { useAppStore } from '../../stores/appStore';
import { useAIStore } from '../../stores/aiStore';
import type { WysiwygSession } from './wysiwygSession';

interface Props { session: WysiwygSession; surface: HTMLElement | null; version: number; pinned: boolean }
type SlashState = SlashCommandTrigger & { anchor: SlashMenuAnchor };

/** 复用源码编辑器的命令与工具栏，DOM 选区只负责提供位置。 */
export function WysiwygChrome({ session, surface, version, pinned }: Props) {
  const [slash, setSlash] = useState<SlashState | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectionBar, setSelectionBar] = useState<{ left: number; top: number; width: number; placement: 'above' | 'below' } | null>(null);
  const [tableBar, setTableBar] = useState<{ left: number; top: number; placement: 'above' | 'below'; alignment: 'left' | 'center' | 'right' | 'none'; columns: number } | null>(null);
  const [prompt, setPrompt] = useState<{ command: SlashCommand; anchor: SlashMenuAnchor } | null>(null);
  const [promptValue, setPromptValue] = useState('');
  const [imageOpen, setImageOpen] = useState(false);
  const imageSelection = useRef({ from: 0, to: 0 });
  const dismissed = useRef('');
  const previousQuery = useRef('');
  const draggingSelection = useRef(false);
  const commands = useMemo(() => filterSlashCommands(slash?.query ?? ''), [slash?.query]);
  const closeSlash = useCallback(() => {
    if (slash) dismissed.current = `${slash.from}:${slash.query}`;
    setSlash(null);
  }, [slash]);

  const refresh = useCallback(() => {
    const selection = surface?.ownerDocument.getSelection();
    const active = surface?.ownerDocument.activeElement;
    if (!surface || !selection?.rangeCount || !surface.contains(selection.anchorNode) || active?.matches('textarea,input')) {
      setSelectionBar(null); setTableBar(null); setSlash(null); return;
    }
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const bounds = surface.getBoundingClientRect();
    const width = Math.min(720, bounds.width - 24, window.innerWidth - 24);
    const element = range.startContainer.nodeType === 1 ? range.startContainer as Element : range.startContainer.parentElement;
    if (!range.collapsed && !element?.closest('td,th') && !draggingSelection.current && rect.height > 0) {
      const above = rect.top - bounds.top > 54;
      setSelectionBar({ left: Math.max(bounds.left + 8, Math.min(rect.left, bounds.right - width - 8)), top: above ? rect.top - 8 : rect.bottom + 8, width, placement: above ? 'above' : 'below' });
      setSlash(null); setTableBar(null); return;
    }
    setSelectionBar(null);
    const current = session.getSelectionOffsets();
    const source = session.getVisibleSource();
    const table = element?.closest('td,th') ? parseTableAt(source, current.from) : null;
    if (table) {
      const cellRect = element!.closest('td,th')!.getBoundingClientRect();
      setTableBar({ left: Math.max(8, Math.min(cellRect.left, window.innerWidth - 620)), top: Math.max(12, cellRect.top - 46), placement: 'above', alignment: alignmentAt(source, current.from) ?? 'none', columns: table.columns });
    } else setTableBar(null);
    const line = lineAtOffset(source, current.from);
    const trigger = range.collapsed && !table ? findSlashCommandTrigger(line.text, line.from, current.from) : null;
    if (!trigger || dismissed.current === `${trigger.from}:${trigger.query}`) { setSlash(null); return; }
    const caretRect = rect.height > 0 ? rect : element?.getBoundingClientRect();
    if (!caretRect) return;
    dismissed.current = '';
    if (previousQuery.current !== trigger.query) { previousQuery.current = trigger.query; setSelectedIndex(0); }
    setSlash({ ...trigger, anchor: { left: caretRect.left, top: caretRect.top, bottom: caretRect.bottom } });
  }, [session, surface]);

  useEffect(() => {
    if (!surface) return;
    let frame = 0;
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(refresh); };
    const pointerDown = () => { draggingSelection.current = true; setSelectionBar(null); };
    const pointerUp = () => { draggingSelection.current = false; schedule(); };
    document.addEventListener('selectionchange', schedule);
    surface.addEventListener('input', schedule);
    surface.addEventListener('keyup', schedule);
    surface.addEventListener('pointerdown', pointerDown);
    window.addEventListener('pointerup', pointerUp);
    surface.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('selectionchange', schedule);
      surface.removeEventListener('input', schedule);
      surface.removeEventListener('keyup', schedule);
      surface.removeEventListener('pointerdown', pointerDown);
      window.removeEventListener('pointerup', pointerUp);
      surface.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [surface, refresh]);
  useEffect(() => { const frame = requestAnimationFrame(refresh); return () => cancelAnimationFrame(frame); }, [version, refresh]);

  const runTableAction = useCallback((action: TableAction) => {
    const editor = useAppStore.getState().editorView;
    if (!editor) return;
    const selection = editor.getSelection();
    const edit = applyTableAction(editor.getValue(), selection.to, action);
    if (!edit) return;
    editor.replaceRange(edit.from, edit.to, edit.text, { from: edit.cursor, to: edit.cursorEnd });
    editor.focus();
  }, []);

  const runAI = useCallback((command: SlashCommand, instruction?: string) => {
    const editor = useAppStore.getState().editorView;
    const genie = slashAiGenie(command, instruction);
    if (!editor || !genie) return;
    const selection = editor.getSelection();
    if (!editor.getValue().trim() && (command.ai === 'ask' || command.ai === 'write')) {
      const tabId = useAppStore.getState().activeTabId;
      void useAIStore.getState().chatForEditor(instruction ?? '', '').then(answer => {
        if (answer && useAppStore.getState().activeTabId === tabId) editor.replaceRange(selection.from, selection.to, answer);
      });
      return;
    }
    const target = extractGenieTarget(editor, genie.scope === 'selection' && selection.empty ? 'block' : genie.scope);
    if (target) void useAIStore.getState().runGenie(genie, target);
    else useAIStore.getState().setStatus('error', '请先输入或选择需要处理的文字');
  }, []);

  const selectCommand = useCallback((command: SlashCommand) => {
    const editor = useAppStore.getState().editorView;
    if (!editor || !slash) return;
    const current = editor.getSelection();
    const line = editor.lineAt(current.from);
    const trigger = findSlashCommandTrigger(line.text, line.from, current.from) ?? slash;
    setSlash(null); dismissed.current = '';
    if (command.ai) {
      editor.replaceRange(trigger.from, trigger.to, '');
      if (command.needsPrompt) { setPrompt({ command, anchor: slash.anchor }); setPromptValue(''); }
      else runAI(command);
      return;
    }
    const { text, selectionStart = text.length, selectionEnd = selectionStart } = command.insertion;
    editor.replaceRange(trigger.from, trigger.to, text, { from: trigger.from + selectionStart, to: trigger.from + selectionEnd });
    editor.focus();
  }, [slash, runAI]);

  useEffect(() => {
    if (!surface) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && /^(f|h)$/i.test(event.key)) {
        event.preventDefault(); event.stopPropagation();
        window.dispatchEvent(new CustomEvent('zeditor-editor-find', { detail: { replace: event.key.toLowerCase() === 'h' } }));
        return;
      }
      if ((event.target as Element)?.matches('textarea,input')) return;
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && /^(t|i)$/i.test(event.key)) {
        event.preventDefault(); event.stopPropagation();
        if (event.key.toLowerCase() === 't') insertTableRequest();
        else insertImageRequest();
        return;
      }
      if (slash && ['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        if (event.key === 'Escape') { closeSlash(); return; }
        // 用最新源码重算候选：菜单刷新走 rAF，快速键入后立刻确认时状态可能滞后一帧；
        // 重算失败（光标已不在斜杠 token 内）时退回组件状态与既有候选。
        const liveTrigger = resolveSlashSelection(session.getVisibleSource(), session.getSelectionOffsets().from) ?? slash;
        const visible = filterSlashCommands(liveTrigger.query);
        // 与源码编辑器一致：Enter 与 Tab 都是「确认当前项」。
        if (event.key === 'Enter' || event.key === 'Tab') {
          const command = visible[Math.min(selectedIndex, visible.length - 1)];
          if (command) selectCommand(command);
          return;
        }
        setSelectedIndex(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % Math.max(1, visible.length));
        return;
      }
      if ((event.target as Element)?.closest('td,th') && (event.key === 'Tab' || event.key === 'Enter')) {
        event.preventDefault(); event.stopPropagation();
        session.flushWriteBack();
        const offset = session.getSelectionOffsets().to;
        const navigation = navigateTableCell(session.getSource(), offset, event.key === 'Tab' && event.shiftKey ? 'Shift+Tab' : event.key);
        if (navigation?.kind === 'insert-row') runTableAction('row-below');
        else if (navigation?.kind === 'move') { session.setSelectionOffsets(navigation.cursor, navigation.cursorEnd); session.focus(); }
      }
    };
    surface.addEventListener('keydown', keydown, true);
    const tableRequest = (event: Event) => runTableAction((event as CustomEvent<{ action: TableAction }>).detail.action);
    const insertTableRequest = () => {
      const editor = useAppStore.getState().editorView;
      if (!editor) return;
      const selection = editor.getSelection();
      const insertion = insertTable(3, 3);
      const text = prepareMarkdownPaste(insertion.text, editor.getValue(), selection.from, selection.to);
      const prefix = text.indexOf(insertion.text);
      editor.replaceRange(selection.from, selection.to, text, { from: selection.from + prefix + insertion.cursor, to: selection.from + prefix + insertion.cursorEnd });
    };
    const insertImageRequest = () => {
      const editor = useAppStore.getState().editorView;
      if (!editor) return;
      imageSelection.current = editor.getSelection();
      setImageOpen(true);
    };
    const insertMarkmapRequest = () => {
      const editor = useAppStore.getState().editorView;
      const command = filterSlashCommands('markmap').find(item => item.id === 'markmap');
      if (!editor || !command) return;
      const selection = editor.getSelection();
      const text = prepareMarkdownPaste(command.insertion.text, editor.getValue(), selection.from, selection.to);
      const offset = text.indexOf(command.insertion.text);
      editor.replaceRange(selection.from, selection.to, text, { from: selection.from + offset + (command.insertion.selectionStart ?? 0), to: selection.from + offset + (command.insertion.selectionEnd ?? 0) });
    };
    window.addEventListener('zeditor-table-action', tableRequest);
    window.addEventListener('zeditor-insert-table', insertTableRequest);
    window.addEventListener('zeditor-insert-image', insertImageRequest);
    window.addEventListener('zeditor-insert-markmap', insertMarkmapRequest);
    return () => { surface.removeEventListener('keydown', keydown, true); window.removeEventListener('zeditor-table-action', tableRequest); window.removeEventListener('zeditor-insert-table', insertTableRequest); window.removeEventListener('zeditor-insert-image', insertImageRequest); window.removeEventListener('zeditor-insert-markmap', insertMarkmapRequest); };
  }, [surface, slash, commands, selectedIndex, selectCommand, closeSlash, runTableAction, session]);

  return createPortal(<>
    {imageOpen && <ImageOptionsModal onClose={() => setImageOpen(false)} onInsert={(url, alt) => { const editor = useAppStore.getState().editorView; editor?.replaceRange(imageSelection.current.from, imageSelection.current.to, `![${alt ?? '图片'}](${url})`); setImageOpen(false); editor?.focus(); }} />}
    {selectionBar && !pinned && <div className="selection-toolbar" role="toolbar" aria-label="选中文字快捷栏" data-placement={selectionBar.placement} style={{ left: selectionBar.left, top: selectionBar.top, width: selectionBar.width }} onMouseDown={event => event.preventDefault()}><Toolbar variant="floating" /></div>}
    {tableBar && <TableToolbar {...tableBar} onAction={runTableAction} onClose={() => setTableBar(null)} />}
    {slash && <SlashCommandMenu anchor={slash.anchor} commands={commands} selectedIndex={Math.min(selectedIndex, Math.max(0, commands.length - 1))} query={slash.query} onSelect={selectCommand} onSelectedIndexChange={setSelectedIndex} onClose={closeSlash} />}
    {prompt && <form className="slash-ai-prompt" style={{ left: Math.max(12, Math.min(prompt.anchor.left, window.innerWidth - 392)), top: Math.min(prompt.anchor.bottom + 8, window.innerHeight - 180) }} onSubmit={event => { event.preventDefault(); runAI(prompt.command, promptValue); setPrompt(null); }}>
      <strong>{prompt.command.title}</strong><textarea autoFocus aria-label="AI 指令" value={promptValue} onChange={event => setPromptValue(event.target.value)} /><button type="submit">执行</button><button type="button" onClick={() => setPrompt(null)}>取消</button>
    </form>}
  </>, document.body);
}
