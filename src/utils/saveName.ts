function cleanLocalName(text: string): string {
  let name = text
    .replace(/^\s*(?:>\s*|[-+*]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)*/, '')
    .replace(/!?\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\p{Cc}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '');
  name = Array.from(name).slice(0, 60).join('').replace(/[. ]+$/, '');
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `笔记-${name}`;
  return name;
}

/** 本地生成保存窗口的默认文件名；不等待网络，也不扫描整篇大文稿。 */
export function resolveSaveBaseName(title: string, content: string): string {
  if (title && title !== '未命名') return title.replace(/\.md$/i, '');
  const lines = content.slice(0, 8192).replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  let start = 0;
  if (lines[0]?.trim() === '---') {
    const closing = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)\s*$/.test(line));
    if (closing > 0 && lines.slice(1, closing).some(line => /^[\w-]+\s*:/.test(line))) start = closing + 1;
  }
  let firstText = '';
  let fence: string | null = null;
  for (const line of lines.slice(start)) {
    if (fence) {
      const closing = line.trim();
      if (closing.startsWith(fence[0]) && closing.length >= fence.length && /^ {0,3}(?:`+|~+)[ \t]*$/.test(line)) fence = null;
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (opening) { fence = opening[1]; continue; }
    if (!line.trim() || /^(?:-{3,}|\*{3,}|_{3,}|={3,})$/.test(line.trim())) continue;
    const heading = /^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/.exec(line);
    const name = cleanLocalName(heading?.[1] ?? line);
    if (heading && name) return name;
    if (!firstText && name) firstText = name;
  }
  return firstText || '未命名';
}
