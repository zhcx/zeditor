import { useEffect, useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import { createLineWidthWheelAccumulator, lineWidthAfterWheel, resolveEditorDisplay } from '../../utils/editorDisplay';
import { createLineWidthPreview } from '../../utils/lineWidthPreview';

/** 原生非 passive 监听器阻止 Ctrl+滚轮的默认页面缩放，仅接管编辑/预览表面。 */
export function LineWidthWheel() {
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const preview = createLineWidthPreview();
    let takeSteps = createLineWidthWheelAccumulator();
    let pending: number | null = null;
    let timer = 0;
    let hintTimer = 0;
    const commit = () => {
      window.clearTimeout(timer);
      timer = 0;
      takeSteps = createLineWidthWheelAccumulator();
      if (pending === null) return;
      const next = pending;
      pending = null;
      preview.commit(next);
      const s = useAppStore.getState();
      if (s.settings.editor.line_width !== next || s.settings.editor.readable_line_length === false) {
        void s.saveSettings({ ...s.settings, editor: { ...s.settings.editor, readable_line_length: true, line_width: next } });
      }
    };
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey || event.altKey || event.shiftKey || !event.deltaY) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest('.editor-container, .wysiwyg-surface, .preview-card')) return;
      if (useAppStore.getState().settingsOpen || target.closest('[role="menu"], [role="dialog"], .modal-overlay, .svg-figure-stage, .workflow-canvas-viewport')) return;
      event.preventDefault();
      event.stopPropagation();
      const display = resolveEditorDisplay(useAppStore.getState().settings.editor);
      const current = pending ?? (display.readableLineLength ? display.lineWidth : 100);
      const steps = takeSteps(event.deltaY, event.deltaMode);
      const next = lineWidthAfterWheel(current, steps);
      setWidth(next);
      window.clearTimeout(hintTimer);
      hintTimer = window.setTimeout(() => setWidth(null), 900);
      if (steps && next !== current) {
        pending = next;
        document.documentElement.dataset.readableLineWidth = 'on';
        preview.preview(next);
      }
      window.clearTimeout(timer);
      timer = window.setTimeout(commit, 180);
    };
    const keyup = (event: KeyboardEvent) => { if (event.key === 'Control') commit(); };
    window.addEventListener('wheel', wheel, { capture: true, passive: false });
    window.addEventListener('keyup', keyup);
    window.addEventListener('blur', commit);
    const unsubscribe = useAppStore.subscribe((state, before) => {
      if ((state.settingsOpen && !before.settingsOpen) || state.mode !== before.mode) commit();
    });
    return () => {
      unsubscribe();
      window.removeEventListener('wheel', wheel, true);
      window.removeEventListener('keyup', keyup);
      window.removeEventListener('blur', commit);
      window.clearTimeout(hintTimer);
      commit();
      preview.cancel();
    };
  }, []);
  return width === null ? null : <output className="line-width-hint" role="status" aria-live="polite">行宽 {width}%</output>;
}
