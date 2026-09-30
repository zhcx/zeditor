import { invoke } from '@tauri-apps/api/core';
import { collectLocalLinkTargets, type LinkCheckTargetKind } from '../utils/linkCheck';

/** Rust check_link_targets 返回的单个目标状态。 */
export type LinkTargetStatus = 'file' | 'dir' | 'missing' | 'error';

/** 一个「文件缺失」的链接检查结果（偏移为文档 UTF-16 单位）。 */
export interface MissingLinkFinding {
  kind: LinkCheckTargetKind;
  /** 解析后的本地路径（相对文档目录或绝对路径）。 */
  path: string;
  from: number;
  to: number;
  /** 源码中的完整语法片段，用于报告展示。 */
  raw: string;
}

const isTauriRuntime = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/**
 * 批量探测本地路径状态：唯一路径去重后一次 invoke（对齐 VMark 的去重策略）。
 * 探测异常（权限被拒等）由下一层归为 error，按跳过处理。
 */
export async function checkLocalLinkTargets(
  documentPath: string,
  paths: string[],
): Promise<Map<string, LinkTargetStatus>> {
  const statuses = new Map<string, LinkTargetStatus>();
  if (!isTauriRuntime()) return statuses;
  const unique = [...new Set(paths)].filter(Boolean);
  if (unique.length === 0) return statuses;
  const values = await invoke<string[]>('check_link_targets', { documentPath, targets: unique });
  unique.forEach((path, index) => {
    const status = values[index];
    statuses.set(path, status === 'file' || status === 'dir' || status === 'missing' ? status : 'error');
  });
  return statuses;
}

/**
 * 检查文档中的本地链接与图片目标，返回「文件不存在」的位置列表。
 * - 未保存的文档没有基准目录，直接返回空结果（对齐 VMark：未命名文档跳过）
 * - 运行时错误按「沉默优于错误」跳过，不误报缺失
 * - 外部 URL、片段与网络路径已在解析层过滤
 */
export async function findMissingLocalLinks(
  documentPath: string | null,
  content: string,
  baseOffset = 0,
): Promise<MissingLinkFinding[]> {
  if (!documentPath || !content.trim() || !isTauriRuntime()) return [];
  const targets = collectLocalLinkTargets(content);
  if (targets.length === 0) return [];
  let statuses: Map<string, LinkTargetStatus>;
  try {
    statuses = await checkLocalLinkTargets(documentPath, targets.map((target) => target.path));
  } catch {
    // 探测失败整体跳过：链接检查是校对链路的辅助能力，不应让它打断校对。
    return [];
  }
  return targets
    .filter((target) => statuses.get(target.path) === 'missing')
    .map((target) => ({
      kind: target.kind,
      path: target.path,
      from: target.from + baseOffset,
      to: target.to + baseOffset,
      raw: target.raw,
    }));
}
