/** Native OOXML export. Keep the conversion independent of the DOM and Tauri. */
import {
  AlignmentType, BorderStyle, Document, ExternalHyperlink, Footer, FootnoteReferenceRun,
  Header, HeadingLevel, ImageRun, LevelFormat, PageBreak, PageNumber, Packer, Paragraph,
  Table, TableCell, TableOfContents, TableRow, TextRun, WidthType,
  type IParagraphOptions, type IRunOptions, type ParagraphChild,
} from 'docx';
import type Token from 'markdown-it/lib/token.mjs';
import { markdownRenderer } from './markdownPipeline.ts';
import { parseFootnoteDefinitions } from './footnotes.ts';
import { findMediaEmbeds, isPlatformPageUrl, mediaKindOfSource } from './media.ts';

export interface DocxImage {
  data: Uint8Array;
  type: 'png' | 'jpg' | 'gif' | 'bmp';
  width: number;
  height: number;
}

export interface DocxExportOptions {
  title: string;
  font?: string;
  margin?: number;
  lineHeight?: number;
  cover?: boolean;
  toc?: boolean;
  headerFooter?: boolean;
  titleNumbering?: boolean;
  watermark?: string;
  customCss?: string;
  /** Resolves only actual image tokens, never links or arbitrary HTML attributes. */
  loadImage?: (source: string) => Promise<DocxImage>;
  /**
   * Renders fenced diagrams (Mermaid / Markmap / SVG / workflow) as PNG.
   * Returning null keeps the fence as source code (plain YAML, unknown shape).
   */
  loadDiagram?: (language: string, source: string) => Promise<DocxImage | null>;
  /** When false, workflow YAML stays as source while other diagram fences still render. */
  workflowViewerEnabled?: boolean;
}

/** Fences that always represent a diagram, regardless of loadDiagram support. */
const DIAGRAM_FENCE_LANGUAGES = new Set(['mermaid', 'markmap', 'svg', 'github-actions', 'githubactions']);
/** YAML fences may be workflows; only the renderer can tell. */
const WORKFLOW_FENCE_LANGUAGES = new Set(['yaml', 'yml', 'github-actions-workflow']);

const headings = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
const unescapeHtml = (text: string) => text.replace(/&(?:amp|quot|apos|lt|gt|#39|#(\d+)|#x([\da-f]+));/gi,
  (entity, dec, hex) => {
    if (dec || hex) {
      const point = parseInt(dec || hex, dec ? 10 : 16);
      return point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    }
    return ({ '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&#39;': "'" })[entity.toLowerCase()] || entity;
  });
const textOfHtml = (html: string) => unescapeHtml(html.replace(/<[^>]*>/g, ''));

export async function createDocx(source: string, options: DocxExportOptions): Promise<{ base64: string; warnings: string[] }> {
  const warnings = new Set<string>();
  if (findMediaEmbeds(source).length) warnings.add('音视频和平台播放器保留标题及来源地址，Word 文档不包含可播放的媒体对象。');
  const definitions = parseFootnoteDefinitions(source);
  // Protect TeX from Markdown escaping/emphasis. The fallback must preserve the
  // author's exact delimiters/backslashes, including \( ... \) and \[ ... \].
  const formulas: string[] = [];
  let formulaMarker = 'ZEDITORDOCXFORMULA';
  while (source.includes(formulaMarker)) formulaMarker += 'X';
  const mask = (formula: string) => { formulas.push(formula); return `${formulaMarker}${formulas.length - 1}END`; };
  const protectMath = (value: string) => value.split(/(`{3,}[^\n]*\n[\s\S]*?\n`{3,}[^\n]*|~{3,}[^\n]*\n[\s\S]*?\n~{3,}[^\n]*|`+[^`\n]*`+)/g).map((part, index) => {
    if (index % 2) return part;
    return part.replace(/(^|\n)\$\$\s*[\s\S]*?\s*\$\$(?=\n|$)/g, (value, prefix) => prefix + mask(value.slice(prefix.length)))
      .replace(/(^|\n)\\\[\s*[\s\S]*?\s*\\\](?=\n|$)/g, (value, prefix) => prefix + mask(value.slice(prefix.length)))
      .replace(/\\\(.+?\\\)/g, value => mask(value))
      .replace(/(^|[^\\$])\$([^$\n]+?)\$(?!\$)/g, (value, prefix) => prefix + mask(value.slice(prefix.length)));
  }).join('');
  const restoreMath = (value: string) => value.replace(new RegExp(`${formulaMarker}(\\d+)END`, 'g'), (_, id) => formulas[Number(id)]);
  const tokens = markdownRenderer.parse(protectMath(source), { zeditorFootnotes: definitions });
  const footnoteIds = new Map([...definitions.keys()].map((key, index) => [key, index + 1]));
  const footnoteTokens = new Map([...definitions].map(([name, definition]) => [name,
    markdownRenderer.parse(protectMath(definition.content), { zeditorFootnotes: new Map() }),
  ]));
  const imageCache = new Map<string, { image: DocxImage } | { error: unknown }>();
  const imageSources = new Set<string>();
  const collectImages = (items: Token[]) => {
    for (let index = 0; index < items.length; index += 1) {
      const token = items[index];
      if (token.meta?.footnoteDefinitionPrefix) {
        while (index < items.length && items[index].type !== 'paragraph_close') index += 1;
      } else if (token.type === 'image') {
        const src = restoreMath(token.attrGet('src') ?? '');
        if (!mediaKindOfSource(src) && !isPlatformPageUrl(src)) imageSources.add(src);
      } else if (token.children) collectImages(token.children);
    }
  };
  collectImages(tokens);
  for (const items of footnoteTokens.values()) collectImages(items);
  if (options.loadImage) {
    const sources = [...imageSources];
    let nextImage = 0;
    // Settle failures here so an early failed image cannot produce an unhandled
    // rejection while an earlier token is still loading. OOXML is emitted later
    // in token order, independent of the order in which the workers finish.
    await Promise.all(Array.from({ length: Math.min(4, sources.length) }, async () => {
      while (nextImage < sources.length) {
        const src = sources[nextImage++];
        try { imageCache.set(src, { image: await options.loadImage!(src) }); }
        catch (error) { imageCache.set(src, { error }); }
      }
    }));
  }
  const numbering: { reference: string; levels: { level: number; format: typeof LevelFormat.DECIMAL | typeof LevelFormat.BULLET; text: string; start?: number; alignment: typeof AlignmentType.LEFT; style: { paragraph: { indent: { left: number; hanging: number } } } }[] }[] = [];
  const availableWidth = Math.max(96, (210 - 2 * (options.margin ?? 20)) * 96 / 25.4);

  const inline = async (children: Token[], inherited: IRunOptions = {}): Promise<ParagraphChild[]> => {
    const result: ParagraphChild[] = [];
    let style: IRunOptions = { ...inherited };
    const stack: IRunOptions[] = [];
    for (let index = 0; index < children.length; index += 1) {
      const token = children[index];
      if (['strong_open', 'em_open', 's_open'].includes(token.type)) {
        stack.push(style);
        style = { ...style, ...(token.type === 'strong_open' ? { bold: true } : token.type === 'em_open' ? { italics: true } : { strike: true }) };
      } else if (['strong_close', 'em_close', 's_close'].includes(token.type)) {
        style = stack.pop() ?? inherited;
      } else if (token.type === 'link_open') {
        let end = index + 1;
        while (end < children.length && children[end].type !== 'link_close') end += 1;
        const label = await inline(children.slice(index + 1, end), { ...style, style: 'Hyperlink' });
        const href = token.attrGet('href') ?? '';
        if (/^(https?:|mailto:)/i.test(href)) result.push(new ExternalHyperlink({ link: href, children: label }));
        else {
          result.push(...label, new TextRun({ ...style, text: ` (${href})` }));
          warnings.add('本地链接和文内锚点保留为文字及目标地址，请在 Word 中按需重新设置跳转。');
        }
        index = end;
      } else if (token.type === 'image') {
        const src = restoreMath(token.attrGet('src') ?? '');
        if (mediaKindOfSource(src) || isPlatformPageUrl(src)) {
          const label = new TextRun({ ...style, text: `［媒体］${token.content || src}` });
          if (/^https?:\/\//i.test(src)) result.push(new ExternalHyperlink({ link: src, children: [label] }));
          else result.push(label, new TextRun({ ...style, text: ` (${src})` }));
          continue;
        }
        if (!options.loadImage) throw new Error(`无法读取图片“${src}”：未配置图片读取器。`);
        let image: DocxImage;
        try {
          const loaded = imageCache.get(src)!;
          if ('error' in loaded) throw loaded.error;
          image = loaded.image;
        }
        catch (error) { throw new Error(`无法导出图片“${src}”：${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
        if (!image.data.length || !Number.isFinite(image.width) || image.width <= 0 || !Number.isFinite(image.height) || image.height <= 0) throw new Error(`图片“${src}”的内容或尺寸无效。`);
        const width = Number(token.attrGet('width'));
        const height = Number(token.attrGet('height'));
        const requestedWidth = width || (height ? image.width * height / image.height : image.width);
        const requestedHeight = height || image.height * requestedWidth / image.width;
        const scale = Math.min(1, availableWidth / requestedWidth, 850 / requestedHeight);
        result.push(new ImageRun({ type: image.type, data: image.data,
          transformation: { width: requestedWidth * scale, height: requestedHeight * scale },
          altText: { name: token.content || '图片', description: token.content || '图片', title: token.attrGet('title') || token.content || '图片' },
        }));
      } else if (token.type === 'softbreak' || token.type === 'hardbreak') {
        result.push(new TextRun({ ...style, break: 1 }));
      } else if (token.type === 'html_inline') {
        const footnote = /data-footnote-name="([^"]*)"/.exec(token.content);
        if (footnote) {
          const name = unescapeHtml(footnote[1]);
          const id = footnoteIds.get(name);
          if (id) result.push(new FootnoteReferenceRun(id));
          else {
            result.push(new TextRun({ ...style, text: `[^${name}]` }));
            warnings.add(`脚注“${name}”没有定义，保留引用原文。`);
          }
        } else if (token.content.includes('task-list-item-checkbox')) {
          result.push(new TextRun({ ...style, text: /\bchecked(?:[\s=>])/.test(token.content) ? '☑ ' : '☐ ' }));
        } else if (/^<br\b/i.test(token.content)) result.push(new TextRun({ ...style, break: 1 }));
        else {
          if (token.content.includes('wiki-link')) warnings.add('Wiki 链接仅保留显示文字，Word 中不提供笔记库跳转。');
          if (!token.content.includes('wiki-link') && /<[^>]+>/.test(token.content)) warnings.add('原始 HTML 仅保留可读文字；CSS、交互组件和嵌入媒体不转换为 Word 对象。');
          const text = restoreMath(textOfHtml(token.content));
          if (text) result.push(new TextRun({ ...style, text }));
        }
      } else if (token.type === 'code_inline') {
        result.push(new TextRun({ ...style, text: token.content, font: 'Consolas', shading: { fill: 'F1F3F5' } }));
      } else if (token.type === 'text') {
        if (/\$[^$]+\$|\\\(|\\\[/.test(token.content)) warnings.add('数学公式保留为可编辑的 TeX 原文，尚未转换为 Word 公式。');
        result.push(new TextRun({ ...style, text: restoreMath(token.content) }));
      }
    }
    return result;
  };

  const headingNumbers = [0, 0, 0, 0, 0, 0];
  const blocks = async (items: Token[], isFootnote = false): Promise<(Paragraph | Table)[]> => {
    const output: (Paragraph | Table)[] = [];
    const lists: { reference: string; level: number; pending: boolean }[] = [];
    let quoteDepth = 0;
    let cursor = 0;
    while (cursor < items.length) {
      const token = items[cursor];
      if (token.type === 'blockquote_open') quoteDepth += 1;
      else if (token.type === 'blockquote_close') quoteDepth = Math.max(0, quoteDepth - 1);
      else if (token.type === 'bullet_list_open' || token.type === 'ordered_list_open') {
        const level = Math.min(lists.length, 8);
        const reference = `list-${numbering.length}`;
        const ordered = token.type === 'ordered_list_open';
        numbering.push({ reference, levels: Array.from({ length: 9 }, (_, index) => ({ level: index,
          format: ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET,
          text: ordered ? `%${index + 1}.` : ['•', '◦', '▪'][index % 3],
          start: Number(token.attrGet('start')) || 1, alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720 * (index + 1), hanging: 260 } } },
        })) });
        lists.push({ reference, level, pending: false });
      } else if (token.type === 'bullet_list_close' || token.type === 'ordered_list_close') lists.pop();
      else if (token.type === 'list_item_open') { if (lists.length) lists[lists.length - 1].pending = true; }
      else if (token.type === 'heading_open' || token.type === 'paragraph_open') {
        const heading = token.type === 'heading_open' ? Number(token.tag.slice(1)) : 0;
        const children: ParagraphChild[] = [];
        let end = cursor + 1;
        while (end < items.length && items[end].type !== (heading ? 'heading_close' : 'paragraph_close')) {
          const next = items[end];
          if (next.type === 'inline' && next.meta?.footnoteDefinitionPrefix) {
            // The shared parser keeps definitions editable in the preview. In Word
            // their content lives exclusively in word/footnotes.xml.
            while (end < items.length && items[end].type !== 'paragraph_close') end += 1;
            break;
          }
          if (next.type === 'inline') children.push(...await inline(next.children ?? []));
          end += 1;
        }
        if (children.length) {
          if (heading && options.titleNumbering && !isFootnote) {
            headingNumbers[heading - 1] += 1;
            headingNumbers.fill(0, heading);
            children.unshift(new TextRun(`${headingNumbers.slice(0, heading).join('.')} `));
          }
          const list = lists[lists.length - 1];
          const properties: IParagraphOptions = {
            children, ...(heading ? { heading: headings[heading - 1] } : {}),
            ...(list?.pending ? { numbering: { reference: list.reference, level: list.level } } : list ? { indent: { left: 720 * (list.level + 1) } } : {}),
            ...(quoteDepth ? { indent: { left: quoteDepth * 360 }, border: { left: { color: 'CCCCCC', style: BorderStyle.SINGLE, size: 12, space: 8 } } } : {}),
          };
          output.push(new Paragraph(properties));
          if (list) list.pending = false;
        }
        cursor = end;
      } else if (token.type === 'fence' || token.type === 'code_block') {
        const language = token.info.trim().split(/\s/)[0];
        const explicitDiagram = DIAGRAM_FENCE_LANGUAGES.has(language);
        const workflowFence = WORKFLOW_FENCE_LANGUAGES.has(language)
          || language === 'github-actions'
          || language === 'githubactions';
        const workflowDisabled = options.workflowViewerEnabled === false && workflowFence;
        if ((explicitDiagram || WORKFLOW_FENCE_LANGUAGES.has(language)) && !workflowDisabled) {
          let diagram: DocxImage | null = null;
          let reportedFailure = false;
          if (options.loadDiagram) {
            try {
              diagram = await options.loadDiagram(language, token.content);
            } catch (error) {
              reportedFailure = true;
              warnings.add(`“${language}”图表无法转换为图片，已保留源码：${error instanceof Error ? error.message : String(error)}`);
            }
          } else if (explicitDiagram) {
            reportedFailure = true;
            warnings.add('Mermaid、Markmap、SVG 和工作流图以带语言标记的源码导出；如需图形，请先插入对应图片。');
          }
          if (diagram) {
            const scale = Math.min(1, availableWidth / diagram.width, 850 / diagram.height);
            output.push(new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [new ImageRun({
                type: diagram.type, data: diagram.data,
                transformation: { width: diagram.width * scale, height: diagram.height * scale },
                altText: { name: `${language} 图表`, description: `${language} 图表`, title: `${language} 图表` },
              })],
            }));
            cursor += 1;
            continue;
          }
          if (explicitDiagram && !reportedFailure) {
            // The renderer returned null for an explicit diagram fence: keep source
            // visible and explain the degradation instead of silently dropping it.
            warnings.add('图表未能转换为图片，已保留源码。');
          }
          output.push(new Paragraph({ children: [new TextRun({ text: `［${language} 源码］`, italics: true })] }));
        }
        for (const line of token.content.replace(/\n$/, '').split('\n')) output.push(new Paragraph({
          children: [new TextRun({ text: restoreMath(line) || ' ', font: 'Consolas', size: 19 })],
          spacing: { before: 0, after: 0, line: 276 }, shading: { fill: 'F1F3F5' },
        }));
      } else if (token.type === 'table_open') {
        const rows: TableRow[] = [];
        let cells: TableCell[] = [];
        let end = cursor + 1;
        while (end < items.length && items[end].type !== 'table_close') {
          const next = items[end];
          if (next.type === 'tr_open') cells = [];
          else if (next.type === 'tr_close') rows.push(new TableRow({ children: cells, tableHeader: rows.length === 0 }));
          else if (next.type === 'th_open' || next.type === 'td_open') {
            const content = items[end + 1];
            const align = next.attrGet('style') || '';
            cells.push(new TableCell({ children: [new Paragraph({
              children: content?.type === 'inline' ? await inline(content.children ?? [], { bold: next.type === 'th_open' }) : [],
              alignment: align.includes('center') ? AlignmentType.CENTER : align.includes('right') ? AlignmentType.RIGHT : AlignmentType.LEFT,
            })], ...(next.type === 'th_open' ? { shading: { fill: 'E9EDF2' } } : {}) }));
          }
          end += 1;
        }
        if (rows.length) output.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
        cursor = end;
      } else if (token.type === 'hr') output.push(new Paragraph({ border: { bottom: { color: 'CCCCCC', style: BorderStyle.SINGLE, size: 6 } } }));
      else if (token.type === 'html_block') {
        warnings.add('原始 HTML 仅保留可读文字；CSS、交互组件和嵌入媒体不转换为 Word 对象。');
        output.push(new Paragraph(restoreMath(textOfHtml(token.content))));
      }
      cursor += 1;
    }
    return output;
  };

  const children: (Paragraph | Table | TableOfContents)[] = [];
  if (options.cover) children.push(new Paragraph({ text: options.title, heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }), new Paragraph({ children: [new PageBreak()] }));
  if (options.toc) children.push(new TableOfContents('目录', { hyperlink: true, headingStyleRange: '1-3' }), new Paragraph({ children: [new PageBreak()] }));
  children.push(...await blocks(tokens));
  if (!children.length) children.push(new Paragraph(''));
  const footnotes: Record<string, { children: Paragraph[] }> = {};
  for (const [name, definition] of definitions) {
    // Native footnotes accept paragraphs; a table is represented as readable text.
    const parts = await blocks(footnoteTokens.get(name)!, true);
    if (parts.some(part => part instanceof Table)) warnings.add('脚注内的表格保留为原始文字。');
    footnotes[footnoteIds.get(name)!] = { children: parts.some(part => part instanceof Table) ? [new Paragraph(definition.content)] : parts as Paragraph[] };
  }
  if (options.customCss) warnings.add('Word 使用原生样式，不应用自定义 CSS。');
  if (options.watermark) warnings.add('水印以页眉文字保留，未使用网页旋转水印效果。');
  const font = (options.font || 'Microsoft YaHei').split(',')[0].trim().replace(/^['"]|['"]$/g, '');
  const margin = Math.round(Math.min(50, Math.max(5, options.margin ?? 20)) * 1440 / 25.4);
  const document = new Document({
    creator: 'Zeditor', title: options.title, features: { updateFields: true }, footnotes,
    styles: { default: { document: { run: { font: { ascii: font, hAnsi: font, eastAsia: font, cs: font }, size: 24 }, paragraph: { spacing: { after: 120, line: Math.round(240 * (options.lineHeight || 1.7)) } } } } },
    numbering: { config: numbering },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: margin, bottom: margin, left: margin, right: margin } } },
      ...(options.headerFooter || options.watermark ? { headers: { default: new Header({ children: [new Paragraph(options.watermark ? `${options.title} | ${options.watermark}` : options.title)] }) } } : {}),
      ...(options.headerFooter ? { footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun('第 '), new TextRun({ children: [PageNumber.CURRENT] }), new TextRun(' 页 / 共 '), new TextRun({ children: [PageNumber.TOTAL_PAGES] }), new TextRun(' 页')] })] }) } } : {}),
      children,
    }],
  });
  if (formulas.length) warnings.add('数学公式保留为可编辑的 TeX 原文，尚未转换为 Word 公式。');
  return { base64: await Packer.toBase64String(document), warnings: [...warnings] };
}
