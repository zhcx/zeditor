export interface TextStatistics {
  wordCount: number;
  totalCharacters: number;
}

const chineseCharacterPattern = /\p{Script=Han}/gu;
const englishWordPattern = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g;

export function calculateTextStatistics(content: string): TextStatistics {
  const chineseCharacters = content.match(chineseCharacterPattern)?.length ?? 0;
  const englishWords = content.match(englishWordPattern)?.length ?? 0;
  // UTF-16 代理对按一个字符统计，避免每次输入都创建与全文等大的字符数组。
  let totalCharacters = content.length;
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    if (code < 0xD800 || code > 0xDBFF) continue;
    const next = content.charCodeAt(index + 1);
    if (next >= 0xDC00 && next <= 0xDFFF) {
      totalCharacters -= 1;
      index += 1;
    }
  }

  return {
    wordCount: chineseCharacters + englishWords,
    totalCharacters,
  };
}

export function formatTextStatistics(content: string): string {
  const { wordCount, totalCharacters } = calculateTextStatistics(content);
  return `${wordCount} 字, ${totalCharacters} 字符`;
}
