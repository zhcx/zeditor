/** 设置滑块与 Ctrl+滚轮共享预览生命周期；结束前只局部布局，结束后精确折行。 */
export function createLineWidthPreview() {
  let frame = 0;
  let pending = 80;
  let targets: HTMLElement[] = [];
  let hosts: Array<{ element: HTMLElement; width: string }> = [];
  const begin = () => {
    if (targets.length) return;
    targets = Array.from(document.querySelectorAll<HTMLElement>('.monaco-document-card, .preview-document, .wysiwyg-document'));
    hosts = Array.from(document.querySelectorAll<HTMLElement>('.monaco-host'))
      .map(element => ({ element, width: element.style.width, measured: element.clientWidth }))
      .map(({ element, width, measured }) => { element.style.width = `${measured}px`; return { element, width }; });
    document.documentElement.dataset.lineWidthDragging = 'true';
  };
  const cancel = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    targets.forEach(target => target.style.removeProperty('--content-width'));
    hosts.forEach(({ element, width }) => { element.style.width = width; });
    targets = [];
    hosts = [];
    delete document.documentElement.dataset.lineWidthDragging;
  };
  return {
    begin,
    preview: (width: number) => {
      begin(); pending = width;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        targets.forEach(target => target.style.setProperty('--content-width', `${pending}%`));
      });
    },
    commit: (width: number) => {
      document.documentElement.style.setProperty('--content-width', `${width}%`);
      cancel();
    },
    cancel,
  };
}
