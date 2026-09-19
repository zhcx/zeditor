/**
 * htmlToMarkdown — 纯前端 HTML → Markdown 转换器
 *
 * 基于正则解析，无需 DOMParser，可同时在浏览器与 Node.js 环境运行。
 * 用于用户从剪贴板粘贴 HTML 时，将其转为干净的 Markdown 插入 Monaco 编辑器。
 */

// ─── 辅助工具 ───────────────────────────────────────────────

/** 解码常见 HTML 实体 */
export function decodeEntities(html: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  // 一次解码，保留转义后的实体文本；数值实体支持完整 Unicode。
  return html.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, key: string) => {
    if (!key.startsWith('#')) return named[key.toLowerCase()] ?? entity;
    const value = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
      ? String.fromCodePoint(value) : '\uFFFD';
  });
}

/** 压缩连续空白为单个空格 */
export function collapseWhitespace(text: string): string {
  return text.replace(/[ \t]+/g, ' ');
}

/** 移除首尾空行，保留结构性换行 */
function trimLines(text: string): string {
  return text.replace(/^\n+/, '').replace(/\n+$/, '');
}

/** 提取 HTML 标签的属性值 */
export function getAttr(tag: string, attr: string): string {
  const re = new RegExp(`(?:^|\\s)${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = tag.match(re);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : '';
}

// ─── 主转换逻辑 ─────────────────────────────────────────────

/**
 * 将 HTML 字符串转换为 Markdown。
 *
 * @param html - 原始 HTML 字符串
 * @returns 转换后的 Markdown 文本
 */
export function htmlToMarkdown(html: string): string {
  let md = html.replace(/\r\n?/g, '\n');

  // 代码块与行内代码先抽取为占位符（私有区字符，正文几乎不可能出现），
  // 避免代码内的 < > & 被后续规则误处理。
  const codeSlots: string[] = [];
  let slotPrefix = '\uE000';
  while (md.includes(slotPrefix)) slotPrefix += '\uE000';
  const storeCode = (markdown: string) => `${slotPrefix}${codeSlots.push(markdown) - 1}\uE001`;
  const fenceFor = (code: string) => '`'.repeat(Math.max(3, ...Array.from(code.matchAll(/`+/g), m => m[0].length + 1)));

  // 移除 script / style 标签及其内容
  md = md.replace(/<script[\s\S]*?<\/script>/gi, '');
  md = md.replace(/<style[\s\S]*?<\/style>/gi, '');

  // 移除 HTML 注释
  md = md.replace(/<!--[\s\S]*?-->/g, '');

  // 代码块: <pre><code>
  md = md.replace(/<pre[^>]*>\s*<code(?:\s+[^>]*)?>([^]*?)<\/code>\s*<\/pre>/gi, (_, code) => {
    // 尝试从 class 中提取语言
    const langMatch = _.match(/class\s*=\s*["'][^"']*(?:language-|lang-)(\w+)/i);
    const lang = langMatch ? langMatch[1] : '';
    const decoded = decodeEntities(code.replace(/<br\s*\/?>/gi, '\n').replace(/<[a-zA-Z/!][^>]*>/g, '')).replace(/^\n|\n$/g, '');
    const fence = fenceFor(decoded);
    return `\n\n${storeCode(`${fence}${lang}\n${decoded}\n${fence}`)}\n\n`;
  });

  // <pre> 无 <code> 包裹
  md = md.replace(/<pre[^>]*>([^]*?)<\/pre>/gi, (_, code) => {
    const decoded = decodeEntities(code.replace(/<br\s*\/?>/gi, '\n').replace(/<[a-zA-Z/!][^>]*>/g, '')).replace(/^\n|\n$/g, '');
    const fence = fenceFor(decoded);
    return `\n\n${storeCode(`${fence}\n${decoded}\n${fence}`)}\n\n`;
  });

  // 内联 <code>
  md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, code) => {
    const decoded = decodeEntities(code.replace(/<br\s*\/?>/gi, '\n').replace(/<[a-zA-Z/!][^>]*>/g, '')).replace(/\n/g, ' ');
    const delimiter = '`'.repeat(Math.max(1, ...Array.from(decoded.matchAll(/`+/g), m => m[0].length + 1)));
    const pad = /^`|`$/.test(decoded) || (/^ .* $/.test(decoded) && decoded.trim()) ? ' ' : '';
    return storeCode(`${delimiter}${pad}${decoded}${pad}${delimiter}`);
  });

  // <br> → 换行
  md = md.replace(/<br\s*\/?>/gi, '\n');

  // <hr> → ---
  md = md.replace(/<hr\s*\/?>/gi, '\n\n---\n\n');

  // 粗体: <strong>, <b>
  md = md.replace(/<(?:strong|b)(?:\s[^>]*)?>(\s*)([\s\S]*?)(\s*)<\/(?:strong|b)>/gi,
    (_, pre, content, post) => `${pre}**${content.trim()}**${post}`);

  // 斜体: <em>, <i>
  md = md.replace(/<(?:em|i)(?:\s[^>]*)?>(\s*)([\s\S]*?)(\s*)<\/(?:em|i)>/gi,
    (_, pre, content, post) => `${pre}*${content.trim()}*${post}`);

  // 删除线: <del>, <s>, <strike>
  md = md.replace(/<(?:del|s|strike)(?:\s[^>]*)?>(\s*)([\s\S]*?)(\s*)<\/(?:del|s|strike)>/gi,
    (_, pre, content, post) => `${pre}~~${content.trim()}~~${post}`);

  // 图片 (在链接之前处理，防止嵌套图片链接被错误匹配)
  md = md.replace(/<img\s+([^>]*)>/gi, (_, attrs) => {
    const alt = getAttr(attrs, 'alt');
    const src = getAttr(attrs, 'src');
    return `![${alt}](${src})`;
  });

  // 链接
  md = md.replace(/<a\s+([^>]*)>([\s\S]*?)<\/a>/gi, (_, attrs, inner) => {
    const href = getAttr(attrs, 'href');
    const text = inner.replace(/<[a-zA-Z/!][^>]*>/g, '').trim();
    return href ? `[${text}](${href})` : text;
  });

  // 表格处理
  md = convertTables(md);

  // 标题: h1-h6
  for (let i = 1; i <= 6; i++) {
    const hashes = '#'.repeat(i);
    const re = new RegExp(`<h${i}[^>]*>([\\s\\S]*?)<\\/h${i}>`, 'gi');
    md = md.replace(re, (_, content) => {
      const text = content.replace(/<[a-zA-Z/!][^>]*>/g, '').trim();
      return `\n\n${hashes} ${text}\n\n`;
    });
  }

  // 引用块: <blockquote>（支持嵌套，从内向外多次处理）
  let prevMd = '';
  while (prevMd !== md) {
    prevMd = md;
    md = md.replace(/<blockquote\b[^>]*>((?:(?!<blockquote\b)[\s\S])*?)<\/blockquote>/gi, (_, content) => {
      const inner = trimLines(content.replace(/<\/?p\b[^>]*>/gi, '\n\n').replace(/<[a-zA-Z/!][^>]*>/g, '').trim());
      const lines = inner.split('\n').map((l: string) => `> ${l.trim()}`);
      return `\n\n${lines.join('\n')}\n\n`;
    });
  }

  // 列表处理 (支持嵌套)
  md = convertLists(md);

  // 段落: <p>
  md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, content) => {
    const text = collapseWhitespace(content.trim());
    return `\n\n${text}\n\n`;
  });

  // <div> / <section> / <article> 等块级元素，当作段落处理
  md = md.replace(/<\/?(div|section|article|header|footer|main|aside|nav|figure|figcaption)[^>]*>/gi, '\n');

  // 移除所有剩余 HTML 标签（仅匹配真正的标签，避免吃掉正文里的 "<"）
  md = md.replace(/<[a-zA-Z/!][^>]*>/g, '');

  // 解码实体
  md = decodeEntities(md);

  // 先清理外围空行，再还原代码，保留代码内部空白。
  md = md.replace(/\n{3,}/g, '\n\n').trim();
  md = md.replace(new RegExp(`${slotPrefix}(\\d+)\uE001`, 'g'), (_, index) => codeSlots[Number(index)] ?? '');
  md += '\n';

  return md;
}

// ─── 剪贴板判定 ─────────────────────────────────────────────

/** 可映射为 Markdown 语义的标签，用于判断剪贴板 HTML 是否值得转换。 */
const RICH_HTML_TAGS = /<(p|div|h[1-6]|ul|ol|li|table|thead|tbody|tr|td|th|blockquote|pre|code|strong|b|em|i|del|s|a|img|br|hr)\b/i;

/**
 * 判断剪贴板中的 HTML 是否应该转换为 Markdown 再插入。
 *
 * 仅当以下条件同时满足时返回 true：
 * 1. HTML 含有可映射为 Markdown 语义的标签；
 * 2. 纯文本不是 HTML 源码（用户复制的是代码而非富文本）；
 * 3. 转换结果与纯文本不同（避免无意义地拦截原生粘贴）。
 */
export function shouldConvertHtmlToMarkdown(html: string, plainText: string): boolean {
  const trimmed = html.trim();
  if (!trimmed || !RICH_HTML_TAGS.test(trimmed)) return false;
  if (/^\s*<[a-z!/]/i.test(plainText)) return false;

  const markdown = htmlToMarkdown(trimmed);
  if (!markdown.trim()) return false;

  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
  return normalize(markdown) !== normalize(plainText);
}

// ─── 列表转换 ───────────────────────────────────────────────

function convertLists(html: string): string {
  let result = html;
  // 反复处理，以支持嵌套列表（从最内层开始）
  let prev = '';
  while (prev !== result) {
    prev = result;
    // 无序列表
    result = result.replace(/<ul\b[^>]*>((?:(?!<(?:ul|ol)\b)[\s\S])*?)<\/ul>/gi, (_, inner) =>
      '\n' + convertListItems(inner, 'ul') + '\n');
    // 有序列表
    result = result.replace(/<ol\b[^>]*>((?:(?!<(?:ul|ol)\b)[\s\S])*?)<\/ol>/gi, (_, inner) =>
      '\n' + convertListItems(inner, 'ol') + '\n');
  }
  return result;
}

function convertListItems(html: string, listType: 'ul' | 'ol'): string {
  const items: string[] = [];
  let index = 1;

  // 匹配 <li> 标签及其内容
  const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let match;
  while ((match = liRegex.exec(html)) !== null) {
    let content = match[1].trim();

    // 检测任务列表
    const checkboxMatch = content.match(
      /^\s*<input\s+[^>]*type\s*=\s*["']checkbox["'][^>]*>/i
    );
    let taskPrefix = '';
    if (checkboxMatch) {
      const isChecked = /checked/i.test(checkboxMatch[0]);
      taskPrefix = isChecked ? '[x] ' : '[ ] ';
      content = content.replace(checkboxMatch[0], '').trim();
    }

    // 处理嵌套列表：检测内容中是否有子列表，将其缩进
    const nestedListMatch = content.match(/\n((?:[ \t]*(?:-|\d+\.) .*\n?)+)$/);
    let mainText = content.replace(/<[a-zA-Z/!][^>]*>/g, '').trim();
    let nestedText = '';

    if (nestedListMatch) {
      nestedText = nestedListMatch[1]
        .split('\n')
        .filter((l: string) => l.trim())
        .map((l: string) => `${listType === 'ol' ? ' '.repeat(String(index).length + 2) : '  '}${l}`)
        .join('\n');
      mainText = mainText.replace(nestedListMatch[0], '').trim();
    }

    const prefix = listType === 'ol' ? `${index}. ` : '- ';
    const line = `${prefix}${taskPrefix}${collapseWhitespace(mainText)}`;
    items.push(line);
    if (nestedText) items.push(nestedText);
    index++;
  }

  return items.join('\n');
}

// ─── 表格转换 ───────────────────────────────────────────────

function convertTables(html: string): string {
  return html.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, tableInner) => {
    const rows: string[][] = [];
    const aligns: ('left' | 'center' | 'right' | 'none')[] = [];
    let isHeader: boolean;
    let headerRowCount = 0;

    // 解析 thead / tbody 或直接的 tr
    const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let trMatch;

    // 检测当前位置是否在 <thead> 中
    const theadMatch = tableInner.match(/<thead[^>]*>([\s\S]*?)<\/thead>/i);

    while ((trMatch = trRegex.exec(tableInner)) !== null) {
      const rowHtml = trMatch[1];
      const cells: string[] = [];

      // 判断当前行是否在 thead 中
      const rowStart = trMatch.index;
      if (theadMatch) {
        const theadStart = tableInner.indexOf(theadMatch[0]);
        const theadEnd = theadStart + theadMatch[0].length;
        isHeader = rowStart >= theadStart && rowStart < theadEnd;
      } else {
        // 没有 thead 时，第一行含 <th> 则视为表头
        isHeader = /<th[\s>]/i.test(rowHtml) && headerRowCount === 0;
      }

      const cellRegex = /<(?:th|td)([^>]*)>([\s\S]*?)<\/(?:th|td)>/gi;
      let cellMatch;
      let colIdx = 0;
      while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
        const attrs = cellMatch[1];
        const cellContent = cellMatch[2].replace(/<[a-zA-Z/!][^>]*>/g, '').trim();
        cells.push(collapseWhitespace(cellContent).replace(/\|/g, '\\|').replace(/\n+/g, '&lt;br&gt;'));

        // 从表头行提取对齐方式
        if (isHeader) {
          const style = getAttr(attrs, 'style');
          const alignAttr = getAttr(attrs, 'align');
          let align: 'left' | 'center' | 'right' | 'none' = 'none';
          if (/text-align:\s*center/i.test(style) || alignAttr === 'center') align = 'center';
          else if (/text-align:\s*right/i.test(style) || alignAttr === 'right') align = 'right';
          else if (/text-align:\s*left/i.test(style) || alignAttr === 'left') align = 'left';
          aligns[colIdx] = align;
        }
        colIdx++;
      }

      if (cells.length > 0) {
        rows.push(cells);
        if (isHeader) headerRowCount++;
      }
    }

    if (rows.length === 0) return '';

    // 确保对齐数组长度匹配列数
    const colCount = Math.max(...rows.map(r => r.length));
    while (aligns.length < colCount) aligns.push('none');

    // 生成 Markdown 表格
    const lines: string[] = [];
    const [headerRow, ...bodyRows] = rows;

    // 表头行
    lines.push(`| ${padCells(headerRow, colCount).join(' | ')} |`);

    // 分隔行
    const separators = aligns.map(a => {
      switch (a) {
        case 'left': return ':---';
        case 'center': return ':---:';
        case 'right': return '---:';
        default: return '---';
      }
    });
    lines.push(`| ${separators.join(' | ')} |`);

    // 数据行
    for (const row of bodyRows) {
      lines.push(`| ${padCells(row, colCount).join(' | ')} |`);
    }

    return `\n\n${lines.join('\n')}\n\n`;
  });
}

/** 将行的单元格数补齐到列数 */
function padCells(cells: string[], colCount: number): string[] {
  const result = [...cells];
  while (result.length < colCount) result.push('');
  return result;
}
