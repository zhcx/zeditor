/**
 * 近期记录（侧边栏「近期记录」分组 / 顶部搜索栏「近期文件」分组共用）。
 * 数据落在 localStorage，写入方是资源管理器侧边栏；这里只做读取与过滤，
 * 让两个入口展示同一份列表，避免各自复刻过滤规则导致不一致。
 */

export interface RecentHistoryEntry {
  /** 完整绝对路径。 */
  path: string;
  /** 显示名（文件名或文件夹名）。 */
  title: string;
  timestamp: number;
  type: 'file' | 'folder';
}

export const RECENT_HISTORY_KEY = 'zeditor.explorer-history';

/** 与侧边栏写入端保持一致的上限。 */
export const RECENT_HISTORY_LIMIT = 50;

/** 按保留天数过滤并截断的近期记录；解析失败时返回空列表。 */
export function readRecentHistory(retentionDays: number): RecentHistoryEntry[] {
  try {
    const stored = localStorage.getItem(RECENT_HISTORY_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored) as RecentHistoryEntry[];
    if (!Array.isArray(parsed)) return [];
    const retentionMs = Math.max(1, retentionDays) * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - retentionMs;
    return parsed
      .filter(entry => entry && typeof entry.path === 'string' && entry.timestamp > cutoff)
      .slice(0, RECENT_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

/** 取路径的父目录，用于在行尾显示灰色的归属目录。 */
export function parentDirectoryOf(path: string): string {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return separator > 0 ? path.slice(0, separator) : '';
}
