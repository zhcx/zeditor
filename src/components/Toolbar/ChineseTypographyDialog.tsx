import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import type { EditorController } from '../../types/editor';
import { DEFAULT_TYPOGRAPHY_RULES, formatChineseTypography, type TypographyRules } from '../../utils/chineseTypography';
import { AppIcon } from '../Icons/AppIcon';

interface Request {
  tabId: string | null;
  editor: EditorController;
  source: string;
  selection: { from: number; to: number };
}

const ruleOptions: { key: keyof TypographyRules; label: string; example: string }[] = [
  { key: 'spacing', label: '中英文和数字间距', example: '中文ABC → 中文 ABC' },
  { key: 'punctuation', label: '中文标点', example: '你好,世界 → 你好，世界' },
  { key: 'width', label: '全角字母和数字转半角', example: 'ＡＢＣ１２３ → ABC123' },
  { key: 'quotes', label: '中文引号', example: '"你好" → “你好”' },
];

/** Mounted at app level so a floating selection toolbar can disappear safely. */
export function ChineseTypographyDialog() {
  const [request, setRequest] = useState<Request | null>(null);
  const [rules, setRules] = useState<TypographyRules>({ ...DEFAULT_TYPOGRAPHY_RULES });
  const [scope, setScope] = useState<'selection' | 'document'>('document');
  const [error, setError] = useState('');

  useEffect(() => {
    const open = () => {
      const state = useAppStore.getState();
      const editor = state.editorView;
      if (!editor) return;
      const selection = editor.getSelection();
      const source = editor.getValue();
      setRequest({ tabId: state.activeTabId, editor, source, selection });
      setScope(selection.empty ? 'document' : 'selection');
      setError('');
    };
    window.addEventListener('zeditor-chinese-typography', open);
    return () => window.removeEventListener('zeditor-chinese-typography', open);
  }, []);

  useEffect(() => {
    if (!request) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setRequest(null); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [request]);

  const result = useMemo(() => request ? formatChineseTypography(request.source, rules, scope === 'selection' ? request.selection : undefined) : null, [request, rules, scope]);
  if (!request || !result) return null;
  const hasSelection = request.selection.from < request.selection.to;
  const from = scope === 'selection' ? request.selection.from : 0;
  const to = scope === 'selection' ? request.selection.to : request.source.length;
  const afterEnd = to + result.content.length - request.source.length;
  const before = request.source.slice(from, to);
  const after = result.content.slice(from, afterEnd);

  const apply = () => {
    const current = useAppStore.getState();
    if (current.activeTabId !== request.tabId || current.editorView !== request.editor || request.editor.getValue() !== request.source) {
      setError('文档或编辑模式已变化，请关闭后重新打开预览。');
      return;
    }
    request.editor.replaceRange(from, to, after, { from, to: from + after.length });
    setRequest(null);
    request.editor.focus();
  };

  return (
    <div className="modal-overlay" onClick={() => setRequest(null)}>
      <div className="modal-content chinese-typography-modal" role="dialog" aria-modal="true" aria-labelledby="chinese-typography-title" onClick={event => event.stopPropagation()}>
        <div className="modal-header"><h2 id="chinese-typography-title">中文排版</h2><button className="modal-close" onClick={() => setRequest(null)} aria-label="关闭"><AppIcon name="close" size={16} /></button></div>
        <div className="modal-body chinese-typography-body">
          <p>仅调整勾选的规则；代码、链接、公式和元数据等受保护内容会跳过。</p>
          <fieldset className="chinese-typography-scope"><legend>处理范围</legend>
            <label><input type="radio" name="typography-scope" autoFocus={hasSelection} checked={scope === 'selection'} disabled={!hasSelection} onChange={() => setScope('selection')} /> 当前选区</label>
            <label><input type="radio" name="typography-scope" autoFocus={!hasSelection} checked={scope === 'document'} onChange={() => setScope('document')} /> 全文</label>
          </fieldset>
          <fieldset className="chinese-typography-rules"><legend>排版规则</legend>
            {ruleOptions.map(({ key, label, example }) => <label key={key}><input type="checkbox" checked={rules[key]} onChange={event => setRules(current => ({ ...current, [key]: event.target.checked }))} /><span>{label}<small>{example}</small></span></label>)}
          </fieldset>
          <div className="chinese-typography-preview" aria-label="修改预览">
            <section><h3>修改前</h3><pre>{before || '（空）'}</pre></section>
            <section><h3>修改后</h3><pre>{after || '（空）'}</pre></section>
          </div>
          <p className="chinese-typography-status" role="status">{error || (result.changed ? '请检查预览，应用后可撤销。' : '当前规则和范围内没有需要修改的内容。')}</p>
          <div className="form-actions"><button className="cancel-btn" onClick={() => setRequest(null)}>取消</button><button className="save-btn" disabled={!result.changed} onClick={apply}>应用排版</button></div>
        </div>
      </div>
    </div>
  );
}
