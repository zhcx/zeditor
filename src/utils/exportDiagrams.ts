/**
 * 导出管线里的图表二次渲染。
 *
 * 预览会在 DOM 写好后把 Mermaid / Markmap / SVG / GitHub Actions 工作流替换成图形，
 * 但这些增强只作用于预览。导出时若不重复这一步，HTML、PDF、长图、公众号和 Word
 * 里就只剩带语言标记的源码。本模块把同一批图形转成自包含的 SVG（或 PNG），
 * 供各导出出口共用；转换失败时抛出可读原因，调用方保留源码并向用户说明。
 */
import type { DocxImage } from './docxExport.ts';
import { sanitizeRenderedHtml } from './safeHtml.ts';
import { createDomSvgParser, validateSvgSource } from './svgFigure.ts';
import { hasWorkflowShape, WORKFLOW_FENCE_LANGUAGES } from './workflowShape.ts';
import {
  MARKMAP_BACKGROUND,
  applyMarkmapTheme,
  markmapColor,
  readMarkmapTheme,
  type MarkmapTheme,
} from './markmapSource.ts';

export type ExportDiagramKind = 'mermaid' | 'markmap' | 'svg' | 'workflow';

export type ExportDiagramMode = 'svg' | 'image';

export interface ExportEnhanceOptions {
  /** svg：内联矢量图，适合 HTML/PDF；image：PNG 数据地址，适合长图/公众号。 */
  mode: ExportDiagramMode;
  /** 主题 id（如 `vscode-dark`）：决定图表与工作流的明暗配色。 */
  theme?: string;
  /** image 模式的栅格底色；缺省跟随图表主题。 */
  background?: string;
  /** `settings.workflow.render_in_preview`：关闭后 YAML 围栏保持源码。 */
  workflowViewerEnabled?: boolean;
}

export interface ExportEnhanceResult {
  html: string;
  warnings: string[];
  /** 成功转换的图表数量（失败项保留源码并计入 warnings）。 */
  diagrams: number;
}

interface DiagramSvg {
  markup: string;
  width: number;
  height: number;
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const DIAGRAM_LANGUAGES = new Set<string>(['mermaid', 'markmap', 'svg', 'github-actions', 'githubactions']);
const WORKFLOW_LANGUAGES = new Set<string>([...WORKFLOW_FENCE_LANGUAGES, 'github-actions', 'githubactions']);

const CAPTIONS: Record<ExportDiagramKind, string> = {
  mermaid: 'Mermaid 图表',
  markmap: 'Markmap 思维导图',
  svg: 'SVG 图形',
  workflow: 'GitHub Actions 工作流',
};

/** 与预览一致的围栏识别：mermaid/markmap/svg，以及形态符合工作流的 YAML。 */
export function classifyDiagramFence(language: string | null | undefined, source: string): ExportDiagramKind | null {
  const normalized = (language ?? '').trim().toLowerCase();
  if (!normalized) return null;
  if (DIAGRAM_LANGUAGES.has(normalized)) {
    if (normalized === 'github-actions' || normalized === 'githubactions') {
      return hasWorkflowShape(source) ? 'workflow' : null;
    }
    return normalized as ExportDiagramKind;
  }
  if (WORKFLOW_LANGUAGES.has(normalized) && hasWorkflowShape(source)) return 'workflow';
  return null;
}

export function diagramCaption(kind: ExportDiagramKind): string {
  return CAPTIONS[kind];
}

function resolveTheme(theme?: string): MarkmapTheme {
  if (!theme) return readMarkmapTheme();
  return theme.endsWith('-dark') ? 'dark' : 'light';
}

function languageOf(block: Element): string {
  const className = Array.from(block.classList).find(name => name.startsWith('language-'));
  return className ? className.slice('language-'.length) : '';
}

function svgSize(svg: SVGSVGElement): { width: number; height: number } {
  const viewBox = (svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  const viewWidth = viewBox.length === 4 && Number.isFinite(viewBox[2]) && viewBox[2] > 0 ? viewBox[2] : 0;
  const viewHeight = viewBox.length === 4 && Number.isFinite(viewBox[3]) && viewBox[3] > 0 ? viewBox[3] : 0;
  const attrWidth = Number.parseFloat(svg.getAttribute('width') ?? '');
  const attrHeight = Number.parseFloat(svg.getAttribute('height') ?? '');
  const width = viewWidth || (Number.isFinite(attrWidth) && attrWidth > 0 ? attrWidth : 800);
  const height = viewHeight || (Number.isFinite(attrHeight) && attrHeight > 0 ? attrHeight : Math.round(width * 0.6));
  return { width, height };
}

/** 固定尺寸并可选填充底色：脱离应用后（浏览器、PDF、Word）仍保持可读。 */
function finalizeSvg(svg: SVGSVGElement, background?: string): DiagramSvg {
  const { width, height } = svgSize(svg);
  svg.setAttribute('xmlns', SVG_NAMESPACE);
  svg.setAttribute('width', String(Math.round(width)));
  svg.setAttribute('height', String(Math.round(height)));
  if (!svg.getAttribute('viewBox')) svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  // 导出页面有固定版心：宽图（例如 960px 的 Markmap）按容器收窄，保持比例。
  const existingStyle = svg.getAttribute('style');
  svg.setAttribute('style', `${existingStyle ? existingStyle.replace(/;\s*$/, '') + ';' : ''}max-width:100%;height:auto;`);
  if (background) {
    const rect = svg.ownerDocument.createElementNS(SVG_NAMESPACE, 'rect');
    rect.setAttribute('x', '0');
    rect.setAttribute('y', '0');
    rect.setAttribute('width', String(width));
    rect.setAttribute('height', String(height));
    rect.setAttribute('fill', background);
    svg.insertBefore(rect, svg.firstChild);
  }
  return { markup: new XMLSerializer().serializeToString(svg), width, height };
}

function parseSvg(markup: string): SVGSVGElement | null {
  const documentNode = new DOMParser().parseFromString(markup, 'image/svg+xml');
  if (documentNode.getElementsByTagName('parsererror').length > 0) return null;
  return documentNode.documentElement instanceof SVGSVGElement ? documentNode.documentElement : null;
}

let mermaidSequence = 0;

async function renderMermaidSvg(source: string, theme: MarkmapTheme): Promise<DiagramSvg> {
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({
    // 与预览一致：安全清洗会移除 foreignObject，改用 SVG 文字保留节点标签。
    htmlLabels: false,
    startOnLoad: false,
    securityLevel: 'strict',
    theme: theme === 'dark' ? 'dark' : 'neutral',
  });
  const { svg } = await mermaid.render(`zeditor-export-mermaid-${Date.now()}-${mermaidSequence++}`, source);
  const parsed = parseSvg(sanitizeRenderedHtml(svg));
  if (!parsed) throw new Error('生成的 SVG 无法解析。');
  return finalizeSvg(parsed);
}

type TransformerInstance = InstanceType<typeof import('markmap-lib').Transformer>;

interface MarkmapNodeLike {
  content?: string;
  children?: MarkmapNodeLike[];
}

/** 与 MarkmapViewer 相同：节点内容会进入 foreignObject，先按预览规则清洗。 */
function sanitizeMarkmapNode(node: MarkmapNodeLike): void {
  node.content = sanitizeRenderedHtml(String(node.content ?? ''));
  node.children?.forEach(sanitizeMarkmapNode);
}

let transformerInstance: TransformerInstance | null = null;

async function loadTransformer(): Promise<TransformerInstance> {
  if (!transformerInstance) {
    const { Transformer } = await import('markmap-lib');
    transformerInstance = new Transformer();
  }
  return transformerInstance;
}

async function renderMarkmapSvg(source: string, theme: MarkmapTheme): Promise<DiagramSvg> {
  const [{ Markmap }, transformer] = await Promise.all([import('markmap-view'), loadTransformer()]);
  const { root } = transformer.transform(source);
  if (!root || (!root.content && (root.children ?? []).length === 0)) {
    throw new Error('思维导图内容为空：请用 Markdown 标题（# / ## / ###）组织层级。');
  }
  sanitizeMarkmapNode(root);

  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:960px;height:720px;overflow:hidden;opacity:0;pointer-events:none;';
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('width', '960');
  svg.setAttribute('height', '720');
  host.append(svg);
  document.body.append(host);

  let instance: InstanceType<typeof import('markmap-view').Markmap> | null = null;
  try {
    applyMarkmapTheme(svg, theme);
    instance = Markmap.create(svg, {
      autoFit: true,
      duration: 0,
      pan: false,
      zoom: false,
      embedGlobalCSS: true,
      maxWidth: 360,
      color: markmapColor(theme),
    }, root);
    await instance.fit();
    return finalizeSvg(svg);
  } finally {
    instance?.destroy();
    host.remove();
  }
}

async function renderWorkflowSvg(source: string, theme: MarkmapTheme): Promise<DiagramSvg> {
  const [{ renderToStaticMarkup }, react, { WorkflowCanvas }, { parseWorkflow }, { buildWorkflowGraph }] = await Promise.all([
    import('react-dom/server'),
    import('react'),
    import('../components/WorkflowViewer/WorkflowCanvas'),
    import('./githubWorkflow.ts'),
    import('./workflowGraph.ts'),
  ]);
  const parsed = parseWorkflow(source);
  if (!parsed.model) throw new Error('无法从 YAML 解析出 jobs。');
  const graph = buildWorkflowGraph(parsed.model);
  const markup = renderToStaticMarkup(react.createElement(WorkflowCanvas, {
    graph,
    selectedJobId: null,
    onSelectJob: () => undefined,
    diagnostics: [],
    compact: true,
    paletteTheme: theme,
  }));
  const documentNode = new DOMParser().parseFromString(markup, 'text/html');
  const svg = documentNode.querySelector('svg.workflow-canvas-root');
  if (!(svg instanceof SVGSVGElement)) throw new Error('工作流画布未生成 SVG。');
  return finalizeSvg(svg, theme === 'dark' ? '#1b1f24' : '#ffffff');
}

async function renderSvgFence(source: string): Promise<DiagramSvg> {
  const validation = validateSvgSource(source, createDomSvgParser());
  if (!validation.ok) throw new Error(validation.message || 'SVG 源码无效。');
  const parsed = parseSvg(sanitizeRenderedHtml(validation.source));
  if (!parsed) throw new Error('净化后的 SVG 无法解析。');
  return finalizeSvg(parsed);
}

/** 渲染单个图表围栏为自包含 SVG；失败时抛出可读原因。 */
export async function renderDiagramSvg(
  kind: ExportDiagramKind,
  source: string,
  theme: MarkmapTheme,
): Promise<DiagramSvg> {
  if (kind === 'mermaid') return renderMermaidSvg(source, theme);
  if (kind === 'markmap') return renderMarkmapSvg(source, theme);
  if (kind === 'svg') return renderSvgFence(source);
  return renderWorkflowSvg(source, theme);
}

function base64Bytes(base64: string): Uint8Array {
  const binary = atob(base64);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 8192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  }
  return btoa(binary);
}

/** 把自包含 SVG 光栅化为 PNG，供 Word 与公众号等不支持脚本/外链的场景使用。 */
async function rasterizeSvg(svg: DiagramSvg, background: string): Promise<DocxImage> {
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.markup)}`;
  await image.decode();
  const scale = Math.min(2, 2400 / Math.max(svg.width, 1), 2400 / Math.max(svg.height, 1));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(svg.width * scale));
  canvas.height = Math.max(1, Math.round(svg.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建图表画布。');
  context.fillStyle = background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/png');
  return {
    data: base64Bytes(dataUrl.slice(dataUrl.indexOf(',') + 1)),
    type: 'png',
    width: Math.round(svg.width),
    height: Math.round(svg.height),
  };
}

function createDiagramFigure(kind: ExportDiagramKind, inner: string): HTMLElement {
  const figure = document.createElement('figure');
  figure.className = 'export-diagram';
  figure.dataset.exportDiagram = kind;
  figure.style.cssText = 'margin:18px 0;text-align:center;';
  const caption = document.createElement('figcaption');
  caption.textContent = diagramCaption(kind);
  caption.style.cssText = 'margin:4px 0 8px;font-size:12px;line-height:1.5;opacity:.72;';
  figure.append(caption);
  const holder = document.createElement('div');
  holder.style.cssText = kind === 'workflow' ? 'overflow:auto;max-width:100%;' : 'max-width:100%;';
  holder.innerHTML = inner;
  const content = holder.firstElementChild;
  if (content) figure.append(content);
  return figure;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 把渲染好的 Markdown HTML 里的图表围栏替换成图形。
 *
 * 只处理代码围栏，不触碰正文；同一段源码里多个图表按顺序渲染，失败的围栏保留
 * 原代码块并在 `warnings` 中说明，调用方负责把说明展示给用户。
 */
export async function enhanceExportHtml(html: string, options: ExportEnhanceOptions): Promise<ExportEnhanceResult> {
  const template = document.createElement('template');
  template.innerHTML = html;
  const warnings: string[] = [];
  let diagrams = 0;
  const theme = resolveTheme(options.theme);
  const background = options.background
    ?? (theme === 'dark' ? MARKMAP_BACKGROUND.dark : MARKMAP_BACKGROUND.light);

  for (const block of Array.from(template.content.querySelectorAll('pre > code'))) {
    const source = block.textContent ?? '';
    const kind = classifyDiagramFence(languageOf(block), source);
    if (!kind) continue;
    if (kind === 'workflow' && options.workflowViewerEnabled === false) continue;
    const pre = block.parentElement;
    if (!pre) continue;

    try {
      const svg = await renderDiagramSvg(kind, source, theme);
      let inner = svg.markup;
      if (options.mode === 'image') {
        try {
          const png = await rasterizeSvg(svg, background);
          inner = `<img src="data:image/png;base64,${bytesToBase64(png.data)}" alt="${diagramCaption(kind)}" width="${png.width}" height="${png.height}" style="max-width:100%;height:auto;" />`;
        } catch (error) {
          warnings.push(`${diagramCaption(kind)}转为位图失败，已改用内联 SVG：${messageOf(error)}`);
        }
      }
      pre.replaceWith(createDiagramFigure(kind, inner));
      diagrams += 1;
    } catch (error) {
      warnings.push(`${diagramCaption(kind)}未能转换，已保留源码：${messageOf(error)}`);
    }
  }

  return { html: template.innerHTML, warnings, diagrams };
}

/**
 * 供 Word 导出按围栏语言取图；普通 YAML 返回 null（继续按代码块导出）。
 * 失败时抛出可读原因，由 createDocx 决定保留源码并记录降级说明。
 */
export async function renderDiagramForDocx(
  language: string,
  source: string,
  options: { theme?: string; background?: string } = {},
): Promise<DocxImage | null> {
  const kind = classifyDiagramFence(language, source);
  if (!kind) return null;
  const theme = resolveTheme(options.theme);
  const svg = await renderDiagramSvg(kind, source, theme);
  return rasterizeSvg(svg, options.background ?? (theme === 'dark' ? MARKMAP_BACKGROUND.dark : MARKMAP_BACKGROUND.light));
}
