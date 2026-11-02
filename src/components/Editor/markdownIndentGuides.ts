import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import { markdownIndentGuides, type MarkdownIndentGuide } from '../../utils/markdownIndentGuides';

/** 独立于 Monaco 的代码缩进推测，按 Markdown 列表范围绘制视口内的参考线。 */
export function installMarkdownIndentGuides(editor: monaco.editor.IStandaloneCodeEditor, host: HTMLElement, enabled: () => boolean) {
  const layer = document.createElement('div');
  layer.className = 'markdown-indent-guides';
  layer.setAttribute('aria-hidden', 'true');
  // 切换模型会销毁 Monaco 的 view DOM，图层挂在稳定的宿主上。
  host.append(layer);
  let guides: MarkdownIndentGuide[] = [];
  let frame = 0;
  let parseTimer: ReturnType<typeof setTimeout> | null = null;
  const render = () => {
    frame = 0;
    const fragment = document.createDocumentFragment();
    if (enabled()) {
      const visible = editor.getVisibleRanges();
      const layout = editor.getLayoutInfo();
      const font = editor.getOption(monaco.editor.EditorOption.fontInfo);
      const caret = editor.getPosition()?.lineNumber ?? 1;
      for (const guide of guides) {
        for (const range of visible) {
          const first = Math.max(guide.startLine, range.startLineNumber);
          const last = Math.min(guide.endLine, range.endLineNumber);
          if (first > last) continue;
          const top = Math.max(0, editor.getTopForLineNumber(first) - editor.getScrollTop());
          const bottom = Math.min(layout.height, editor.getBottomForLineNumber(last) - editor.getScrollTop());
          if (bottom <= top) continue;
          const bar = document.createElement('div');
          bar.className = 'markdown-indent-guide' + (caret >= guide.startLine && caret <= guide.endLine ? ' is-active' : '');
          bar.dataset.depth = String(guide.depth);
          bar.style.left = `${layout.contentLeft + (guide.column - 1) * (font.spaceWidth + font.letterSpacing) - editor.getScrollLeft()}px`;
          bar.style.top = `${top}px`;
          bar.style.height = `${bottom - top}px`;
          fragment.append(bar);
        }
      }
    }
    layer.replaceChildren(fragment);
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(render); };
  const refresh = () => {
    if (parseTimer !== null) clearTimeout(parseTimer);
    parseTimer = null;
    const model = editor.getModel();
    guides = enabled() && model ? markdownIndentGuides(model.getValue(), model.getOptions().tabSize) : [];
    schedule();
  };
  const subscriptions = [
    editor.onDidChangeModel(refresh),
    editor.onDidChangeModelOptions(refresh),
    editor.onDidChangeModelContent(() => {
      if (parseTimer !== null) clearTimeout(parseTimer);
      parseTimer = setTimeout(refresh, 80);
    }),
    editor.onDidChangeCursorPosition(schedule),
    editor.onDidScrollChange(schedule),
    editor.onDidLayoutChange(schedule),
    editor.onDidChangeHiddenAreas(schedule),
    editor.onDidChangeConfiguration(schedule),
  ];
  refresh();
  return {
    refresh,
    dispose: () => {
      subscriptions.forEach(subscription => subscription.dispose());
      if (parseTimer !== null) clearTimeout(parseTimer);
      cancelAnimationFrame(frame);
      layer.remove();
    },
  };
}
