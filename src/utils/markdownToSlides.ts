/**
 * 将 Markdown 内容按顶层 `---`（水平线）拆分为幻灯片。
 *
 * - 代码块（``` / ~~~）内部的 `---` 不会被识别为分割符；
 * - 文档开头的 YAML frontmatter（`---` 块中含有 `key: value` 行）会被整体移除；
 *   若开头的 `---` 块不含 YAML 字段，则按普通幻灯片分割符处理。
 */
export function splitMarkdownToSlides(markdown: string): string[] {
  const lines = markdown.split('\n');
  const slides: string[] = [];
  let current: string[] = [];
  let fence = '';

  for (let i = findFrontmatterEnd(lines); i < lines.length; i++) {
    const line = lines[i];

    // 检测代码围栏的开启与关闭
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0]; // '`' 或 '~'
      const len = fenceMatch[1].length;
      if (!fence && (marker !== '`' || !fenceMatch[2].includes('`'))) {
        fence = marker.repeat(len);
      } else if (marker === fence[0] && len >= fence.length && !fenceMatch[2].trim()) {
        fence = '';
      }
      current.push(line);
      continue;
    }

    // 顶层水平线分割符：不在代码块内，且匹配 `---` 或更多短横线
    if (!fence && /^---+\s*$/.test(line)) {
      slides.push(current.join('\n'));
      current = [];
      continue;
    }

    current.push(line);
  }

  // 最后一个片段
  slides.push(current.join('\n'));

  return slides;
}

/**
 * 返回 YAML frontmatter 结束后的行号；没有 frontmatter 时返回 0。
 *
 * 仅当首行是 `---`，且到下一个 `---` 之间存在 `key: value` 形式的行时才判定为
 * frontmatter——否则首行的 `---` 只是普通的幻灯片分割符。
 */
function findFrontmatterEnd(lines: string[]): number {
  if (!/^---\s*$/.test(lines[0] ?? '')) return 0;

  for (let i = 1; i < lines.length; i++) {
    if (!/^---\s*$/.test(lines[i])) continue;
    const body = lines.slice(1, i);
    const hasYamlField = body.some((line) => /^[A-Za-z_][\w-]*\s*:/.test(line));
    return hasYamlField ? i + 1 : 0;
  }

  return 0;
}

/**
 * 判断 Markdown 内容是否包含至少两张（非空）幻灯片。
 */
export function isSlideCompatible(markdown: string): boolean {
  return splitMarkdownToSlides(markdown).filter((slide) => slide.trim()).length >= 2;
}
