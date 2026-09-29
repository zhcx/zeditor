/**
 * SVG 图形围栏（```svg）支持 — 参考 VMark 的 SVG 文档。
 *
 * - 图片嵌入 `![...](x.svg)` 走既有的 `<img>` 链路，不在此模块范围。
 * - ```svg 围栏像 Mermaid 一样二次渲染为内联图形：渲染前净化（移除 script
 *   与 on* 事件属性），渲染前验证（必须以 <svg 或 <?xml 开头、XML 结构良好、
 *   根元素是 <svg>），失败显示「无效 SVG」错误块。
 * - 交互（拖拽平移、Ctrl/Cmd + 滚轮缩放、双击或按钮重置）与 2 倍分辨率
 *   PNG 导出对齐 VMark 的 Mermaid 控件。
 *
 * 说明：本模块保持零静态依赖（sanitize 在使用时动态加载），便于 node:test
 * 直接加载（Node 的 TS 解析要求显式扩展名，跨模块相对导入会让测试加载失败，
 * 且 DOMPurify 依赖 DOM）。
 */

export const SVG_FENCE_LANGUAGE = 'svg';
const MIN_SCALE = 0.1;
const MAX_SCALE = 3;
const EXPORT_SCALE = 2;

/** 校验用的最小 XML 解析结果；浏览器侧由 DOMParser 实现，测试可注入桩。 */
export interface SvgXmlParseOutcome {
  ok: boolean;
  /** 文档根元素标签名（小写）；解析失败为空串。 */
  rootTag: string;
}

export type SvgXmlParser = (source: string) => SvgXmlParseOutcome;

/** 校验结果（扁平结构：项目未开启 strict，布尔判别联合的收窄不可靠）。 */
export interface SvgValidation {
  ok: boolean;
  /** 校验通过时的规范化源码；失败为空串。 */
  source: string;
  /** 校验失败时的原因；成功为空串。 */
  message: string;
}

export interface SvgFigureBuildResult {
  ok: boolean;
  html: string;
}

/** 判断围栏语言标记是否为 svg（markdown-it 会把语言名小写化）。 */
export function isSvgFenceLanguage(language: string | null | undefined): boolean {
  return (language || '').trim().toLowerCase() === SVG_FENCE_LANGUAGE;
}

/** 校验 SVG 源码：必须以 `<svg` 或 `<?xml` 开头，XML 结构良好且根元素是 `<svg>`。 */
export function validateSvgSource(source: string, parse: SvgXmlParser): SvgValidation {
  // 去掉 UTF-8 BOM 后判断：内容必须以 <svg 或 <?xml 声明开头。
  const trimmed = source.replace(/^\uFEFF/, '').trim();
  if (!trimmed) return { ok: false, source: '', message: '内容为空' };
  if (!/^<(svg|\?xml)[\s>]/i.test(trimmed)) {
    return { ok: false, source: '', message: '内容必须以 <svg> 或 <?xml 声明开头' };
  }
  const outcome = parse(trimmed);
  if (!outcome.ok) return { ok: false, source: '', message: 'XML 解析失败，请检查标签是否闭合' };
  if (outcome.rootTag !== 'svg') {
    return { ok: false, source: '', message: `根元素必须是 <svg>（当前为 <${outcome.rootTag || '未知'}>）` };
  }
  return { ok: true, source: trimmed, message: '' };
}

/** 浏览器侧 XML 解析器：DOMParser 按 image/svg+xml 解析并检查 parsererror。 */
export function createDomSvgParser(): SvgXmlParser {
  return (source) => {
    const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
    if (doc.getElementsByTagName('parsererror').length > 0) return { ok: false, rootTag: '' };
    return { ok: true, rootTag: (doc.documentElement?.tagName || '').toLowerCase() };
  };
}

const escapeHtmlText = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/**
 * 把 ```svg 围栏源码转成可插入预览的图形 HTML。
 * 渲染前经 sanitizeRenderedHtml 净化（DOMPurify 的 svg profile 已开启，会
 * 移除 script 与 on* 事件属性）；校验失败返回错误块 HTML。
 */
export async function buildSvgFigureHtml(source: string, parse: SvgXmlParser): Promise<SvgFigureBuildResult> {
  const validation = validateSvgSource(source, parse);
  if (!validation.ok) {
    return {
      ok: false,
      html: `<div class="svg-figure-error" role="alert"><strong>无效 SVG</strong><span>${escapeHtmlText(validation.message)}</span><pre>${escapeHtmlText(source)}</pre></div>`,
    };
  }
  const { sanitizeRenderedHtml } = await import('./safeHtml');
  const sanitized = sanitizeRenderedHtml(validation.source);
  return {
    ok: true,
    html: `<figure class="svg-figure"><figcaption><span>SVG 图形</span><span class="svg-figure-tools"><button type="button" data-svg-action="reset" title="重置平移与缩放">重置</button><button type="button" data-svg-action="export" title="导出 2 倍分辨率 PNG">导出 PNG</button></span></figcaption><div class="svg-figure-stage">${sanitized}</div></figure>`,
  };
}

interface SvgViewState {
  scale: number;
  tx: number;
  ty: number;
}

/**
 * 为渲染后的 .svg-figure 挂载交互：拖拽平移、Ctrl/Cmd + 滚轮缩放
 * （10%–300%）、双击或「重置」按钮复位、「导出 PNG」按当前主题背景
 * 导出 2 倍分辨率位图。
 */
export function attachSvgFigureInteractions(figure: HTMLElement): void {
  const stage = figure.querySelector<HTMLElement>('.svg-figure-stage');
  const svg = stage?.querySelector<SVGSVGElement>('svg');
  if (!stage || !svg) return;

  const state: SvgViewState = { scale: 1, tx: 0, ty: 0 };
  const apply = () => {
    svg.style.transformOrigin = '0 0';
    svg.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`;
  };
  const reset = () => {
    state.scale = 1;
    state.tx = 0;
    state.ty = 0;
    apply();
  };

  let drag: { pointerId: number; startX: number; startY: number; tx: number; ty: number } | null = null;
  stage.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, tx: state.tx, ty: state.ty };
    stage.setPointerCapture(event.pointerId);
    stage.classList.add('dragging');
  });
  stage.addEventListener('pointermove', (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    state.tx = drag.tx + (event.clientX - drag.startX);
    state.ty = drag.ty + (event.clientY - drag.startY);
    apply();
  });
  const endDrag = (event: PointerEvent) => {
    if (drag?.pointerId !== event.pointerId) return;
    drag = null;
    stage.classList.remove('dragging');
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);

  stage.addEventListener('wheel', (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
    state.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, state.scale * factor));
    apply();
  }, { passive: false });

  stage.addEventListener('dblclick', (event) => {
    event.preventDefault();
    reset();
  });

  figure.querySelector('[data-svg-action="reset"]')?.addEventListener('click', reset);
  figure.querySelector('[data-svg-action="export"]')?.addEventListener('click', () => {
    void exportSvgFigureAsPng(svg);
  });
}

/** 以 2 倍分辨率把 SVG 导出为 PNG，并按当前主题填充纯色背景（SVG 本身可能透明）。 */
export async function exportSvgFigureAsPng(svg: SVGSVGElement): Promise<void> {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.style.transform = '';

  // 尺寸：优先显式 width/height，其次 viewBox，最后退回元素实测值。
  const viewBox = clone.viewBox?.baseVal;
  let width = clone.width?.baseVal?.value || 0;
  let height = clone.height?.baseVal?.value || 0;
  if ((!width || !height) && viewBox?.width && viewBox?.height) {
    width = viewBox.width;
    height = viewBox.height;
  }
  if (!width || !height) {
    const rect = svg.getBoundingClientRect();
    width = rect.width || 300;
    height = rect.height || 150;
  }
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));

  const markup = new XMLSerializer().serializeToString(clone);
  const objectUrl = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('SVG 位图化失败'));
      image.src = objectUrl;
    });

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * EXPORT_SCALE);
    canvas.height = Math.round(height * EXPORT_SCALE);
    const context = canvas.getContext('2d');
    if (!context) return;
    const isDark = (document.documentElement.dataset.theme || '').endsWith('-dark');
    context.fillStyle = isDark ? '#1e1e1e' : '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) return;
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = 'svg-figure.png';
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(anchor.href), 10_000);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
