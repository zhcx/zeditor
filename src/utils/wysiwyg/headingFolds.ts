/**
 * 所见即所得模式的标题折叠。
 *
 * 块模型里一个标题就是一个块，折叠一段就是隐藏「该标题之后、下一个同级或更高级
 * 标题之前」的块。工具是纯函数：折叠状态的键由标题级别、标题文字与该标题在
 * 同签名中的序号组成，因此改动正文其它位置时折叠不会漂到别的标题上。
 */
import type { WysiwygBlock } from './blocks.ts';

export interface HeadingFoldSection {
  /** 折叠状态的主键；标题文字被改写后视为另一个标题。 */
  key: string;
  level: number;
  title: string;
  /** 标题块自身的索引。 */
  index: number;
  /** 该分节最后一个块的索引（含）；没有可折叠内容时等于 index。 */
  lastIndex: number;
}

const HEADING_TEXT = /^ {0,3}(#{1,6})[ \t]+(.*)$/;

const isBlankParagraph = (block: WysiwygBlock) => block.kind === 'paragraph' && block.source.trim().length === 0;

/** 每行首行的标题级别与文字；解析不到标题时返回 null。 */
function headingOf(block: WysiwygBlock): { level: number; title: string } | null {
  if (block.kind !== 'heading') return null;
  const firstLine = block.source.split(/\r?\n/, 1)[0] ?? '';
  const match = HEADING_TEXT.exec(firstLine);
  if (!match) return null;
  return { level: match[1].length, title: match[2].replace(/[ \t]+#+[ \t]*$/, '').trim() };
}

export function findHeadingFoldSections(blocks: readonly WysiwygBlock[]): HeadingFoldSection[] {
  // lastNonBlank[i]：0..i 之间最后一个非空段落的索引。分节末尾的空段落属于
  // 块间间隙，留着会让折叠后多出几行空白；一次预扫描即可 O(1) 查询。
  const lastNonBlank: number[] = new Array(blocks.length);
  let lastContent = -1;
  for (let index = 0; index < blocks.length; index += 1) {
    if (!isBlankParagraph(blocks[index])) lastContent = index;
    lastNonBlank[index] = lastContent;
  }

  const sections: HeadingFoldSection[] = [];
  const occurrences = new Map<string, number>();
  // 用栈收束分节：遇到同级或更高级标题时，栈顶的分节在这里结束。
  // 原来的双重循环在标题很多的长文档上是 O(标题数²)，输入时每帧都要重算。
  const open: HeadingFoldSection[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const heading = headingOf(blocks[index]);
    if (!heading) continue;
    const signature = `${heading.level}:${heading.title}`;
    const occurrence = occurrences.get(signature) ?? 0;
    occurrences.set(signature, occurrence + 1);

    while (open.length > 0 && open[open.length - 1].level >= heading.level) {
      const closed = open.pop() as HeadingFoldSection;
      const last = lastNonBlank[index - 1] ?? -1;
      closed.lastIndex = Math.max(closed.index, last);
    }

    const section: HeadingFoldSection = {
      key: `${signature}#${occurrence}`,
      level: heading.level,
      title: heading.title,
      index,
      lastIndex: index,
    };
    open.push(section);
    sections.push(section);
  }

  const trailing = lastNonBlank[blocks.length - 1] ?? -1;
  for (const section of open) section.lastIndex = Math.max(section.index, trailing);

  return sections.filter(section => section.lastIndex > section.index);
}

/** 当前被折叠隐藏的块索引。 */
export function foldedBlockIndexes(
  sections: readonly HeadingFoldSection[],
  collapsedKeys: Iterable<string>,
): Set<number> {
  // 调用方传的就是 Set 时直接复用：每次输入都会重算隐藏块，没必要再复制一份。
  const collapsed = collapsedKeys instanceof Set ? collapsedKeys : new Set(collapsedKeys);
  const hidden = new Set<number>();
  if (collapsed.size === 0) return hidden;
  for (const section of sections) {
    if (!collapsed.has(section.key)) continue;
    for (let index = section.index + 1; index <= section.lastIndex; index += 1) hidden.add(index);
  }
  return hidden;
}
