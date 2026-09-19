/** 只切换列表项开头的任务标记，保留缩进、引用层级及正文。 */
export function toggleTaskLine(line: string): string {
  return line.replace(/^([ \t]*(?:>[ \t]*)*(?:[-+*]|\d+[.)])[ \t]+)\[([ xX])\](?=\s|$)/,
    (_, prefix: string, state: string) => `${prefix}[${state === ' ' ? 'x' : ' '}]`);
}
