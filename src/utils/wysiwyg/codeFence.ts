/**
 * 围栏代码块的解析与拼装。
 *
 * 编辑时只改围栏内容与信息串，围栏字符（```` ``` ```` / `~~~`）、长度与缩进沿用原样，
 * 避免把用户手写的 `~~~` 悄悄换成 ``` ``` ```；内容里出现更长的围栏时自动加长。
 */

interface FenceParts {
  indent: string;
  marker: string;
  language: string;
  lines: string[];
}

function parseFence(source: string): FenceParts | null {
  const lines = source.split('\n');
  const opening = lines[0]?.match(/^([ \t]*)(`{3,}|~{3,})[ \t]*([^\s`]*)[^\n]*$/);
  if (!opening) return null;
  const [, indent, marker, language] = opening;
  const closingIndex = lines.length > 1 ? lines.length - 1 : -1;
  const closing = closingIndex > 0 && /^[ \t]*(?:`{3,}|~{3,})[ \t]*$/.test(lines[closingIndex] ?? '');
  const body = lines.slice(1, closing ? closingIndex : undefined);
  return { indent, marker, language: language ?? '', lines: body };
}

export function extractFenceMarker(source: string): string {
  return parseFence(source)?.marker ?? '```';
}

export function extractFenceLanguage(source: string): string {
  return parseFence(source)?.language ?? '';
}

/**
 * 完整的信息串（围栏标记之后的全部内容）。
 *
 * 围栏信息串除语言外还可能带属性，例如 ```` ```js title="示例" ```` 或 ```` ```js {1,3} ````；
 * 只取第一个词再回写会把它们丢掉，所以回写时以完整信息串为准。
 */
export function extractFenceInfo(source: string): string {
  const opening = source.split('\n')[0] ?? '';
  const match = opening.match(/^[ \t]*(?:`{3,}|~{3,})[ \t]*([^\n]*)$/);
  return (match?.[1] ?? '').trim();
}

/** 切换语言时只替换信息串的第一个词，保留 `title=`、行高亮等其余属性。 */
export function withFenceLanguage(info: string, language: string): string {
  const tokens = info.split(/[ \t]+/).filter(Boolean);
  if (tokens.length === 0) return language;
  if (!language) return tokens.slice(1).join(' ');
  return [language, ...tokens.slice(1)].join(' ');
}

/** 代码内容：去掉围栏行与每行共同的缩进。 */
export function extractFenceCode(source: string): string {
  const parts = parseFence(source);
  if (!parts) return source;
  const { indent, lines } = parts;
  const stripped = indent.length > 0
    ? lines.map(line => line.startsWith(indent) ? line.slice(indent.length) : line.replace(/^[ \t]{1,2}/, ''))
    : lines;
  return stripped.join('\n').replace(/\n+$/, '');
}

export interface FormatFenceOptions {
  marker?: string;
  indent?: string;
  /** 完整信息串（优先于 `language`）；缺省时退化为 `language`。 */
  info?: string;
}

/** 内容里出现不短于当前围栏的反引号或波浪号序列时，把围栏加长一位。 */
function safeMarker(content: string, marker: string): string {
  const char = marker[0];
  const runs = Array.from(content.matchAll(char === '`' ? /`+/g : /~+/g), match => match[0].length);
  const longest = runs.length > 0 ? Math.max(...runs) : 0;
  return longest >= marker.length ? char.repeat(longest + 1) : marker;
}

/** 用代码内容与语言重新拼出围栏；`indent` 会逐行加在内容前（调用方传未缩进的代码）。 */
export function formatFence(code: string, language: string, options: FormatFenceOptions = {}): string {
  const baseMarker = options.marker ?? '```';
  const indent = options.indent ?? '';
  const marker = safeMarker(code, baseMarker);
  const info = options.info ?? language;
  const body = code.replace(/\n+$/, '').split('\n').map(line => `${indent}${line}`).join('\n');
  return `${indent}${marker}${info}\n${body}\n${indent}${marker}`;
}
