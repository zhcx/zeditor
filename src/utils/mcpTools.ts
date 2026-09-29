/**
 * MCP 工具执行的纯函数：文档 revision 令牌与路径范围校验。
 * 保持零依赖，便于 node:test 直接加载。
 */

/** revision 令牌 = 长度 + FNV-1a 哈希十六进制；document_write 据此做 STALE 检测。 */
export function computeDocumentRevision(content: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${content.length}:${(hash >>> 0).toString(16)}`;
}

const normalizePath = (path: string): string => {
  const unified = path.replace(/\//g, '\\');
  const trimmed = unified.endsWith('\\') && unified.length > 3 ? unified.slice(0, -1) : unified;
  return trimmed.toLowerCase();
};

/**
 * 判断 filePath 是否位于允许范围内（已打开的工作区根 / 已打开文档所在目录）。
 * 对齐 VMark 的路径范围约束：范围外的 open / save_as 以 INVALID_PATH 拒绝。
 */
export function isPathWithinScope(filePath: string, scopeRoots: string[]): boolean {
  const target = normalizePath(filePath);
  if (!target || target.startsWith('web://')) return false;
  return scopeRoots.some((root) => {
    const normalizedRoot = normalizePath(root);
    if (!normalizedRoot) return false;
    // 盘符根（c:\）的子路径直接以根开头；普通根需加分隔符防止 notes2 误匹配 notes。
    const prefix = normalizedRoot.endsWith('\\') ? normalizedRoot : `${normalizedRoot}\\`;
    return target === normalizedRoot || target.startsWith(prefix);
  });
}

/** 结构化错误信封（领域错误，与 VMark 的错误形态对齐）。 */
export function mcpError(code: string, message: string, extra?: Record<string, unknown>): Record<string, unknown> {
  return { error: code, message, ...extra };
}
