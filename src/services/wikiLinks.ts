/**
 * Wiki 链接（双向链接）的前端服务：解析目标笔记、打开并定位锚点。
 *
 * 解析顺序：
 * 1. 已打开的标签（按相对路径后缀或唯一的同名笔记）；
 * 2. Rust 的 `resolve_wiki_link`：文档目录 → 工作区根递归按文件名查找。
 *
 * 结果缓存 30 秒：预览每次渲染都会请求未解析状态，输入时不能反复扫盘。
 */
import { invoke } from '@tauri-apps/api/core';
import { useAppStore, type Tab } from '../stores/appStore';
import { readStoredStringArray } from '../utils/storage';
import { findBlockReferenceLine, findHeadingForWikiAnchor, parseWikiLink } from '../utils/wikiLinks';

const WORKSPACE_ROOTS_KEY = 'zeditor.workspace-roots';
const RESOLUTION_TTL = 30_000;
const RESOLUTION_LIMIT = 300;

interface ResolutionEntry {
  path: string | null;
  at: number;
}

const resolutionCache = new Map<string, ResolutionEntry>();

const isTauriRuntime = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** 工作区根：与 Sidebar 共用同一个持久化键（`zeditor.workspace-roots`）。 */
export function workspaceRoots(): string[] {
  return readStoredStringArray(WORKSPACE_ROOTS_KEY);
}

/** 笔记名：去掉目录与 `.md` / `.markdown` 扩展名。 */
export function wikiNoteName(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop()?.replace(/\.(md|markdown)$/i, '') ?? '';
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\.(md|markdown)$/i, '').toLocaleLowerCase();
}

/** 已打开的标签里匹配目标笔记；重名时只有唯一匹配才采用。 */
export function findOpenTabByWikiTarget(target: string): Tab | null {
  const tabs = useAppStore.getState().tabs.filter((tab): tab is Tab & { path: string } => Boolean(tab.path));
  const wanted = normalizePath(target);
  const byPath = tabs.find((tab) => {
    const path = normalizePath(tab.path);
    return path === wanted || path.endsWith(`/${wanted}`);
  });
  if (byPath) return byPath;

  const stem = wikiNoteName(target).toLocaleLowerCase();
  const sameName = tabs.filter(tab => wikiNoteName(tab.path).toLocaleLowerCase() === stem);
  return sameName.length === 1 ? sameName[0] : null;
}

function readCache(documentPath: string | null, target: string): string | null | undefined {
  const entry = resolutionCache.get(`${documentPath ?? ''}\u0000${target}`);
  if (!entry) return undefined;
  if (Date.now() - entry.at > RESOLUTION_TTL) {
    resolutionCache.delete(`${documentPath ?? ''}\u0000${target}`);
    return undefined;
  }
  return entry.path;
}

function writeCache(documentPath: string | null, target: string, path: string | null): void {
  if (resolutionCache.size >= RESOLUTION_LIMIT) {
    const oldest = resolutionCache.keys().next().value;
    if (oldest !== undefined) resolutionCache.delete(oldest);
  }
  resolutionCache.set(`${documentPath ?? ''}\u0000${target}`, { path, at: Date.now() });
}

/** 把 wiki 链接目标解析成绝对路径；空目标表示当前文档。 */
export async function resolveWikiTarget(target: string, documentPath: string | null): Promise<string | null> {
  const trimmed = target.trim();
  if (!trimmed) return documentPath;

  const opened = findOpenTabByWikiTarget(trimmed);
  if (opened) return opened.path;

  const cached = readCache(documentPath, trimmed);
  if (cached !== undefined) return cached;

  let resolved: string | null = null;
  if (isTauriRuntime()) {
    try {
      resolved = await invoke<string | null>('resolve_wiki_link', {
        documentPath: documentPath ?? '',
        target: trimmed,
        roots: workspaceRoots(),
      }) ?? null;
    } catch {
      resolved = null;
    }
  }
  writeCache(documentPath, trimmed, resolved);
  return resolved;
}

export interface OpenWikiLinkOptions {
  /** 当前文档路径（相对链接的解析基准）。 */
  documentPath?: string | null;
  /** 覆盖链接自带的 `#锚点`。 */
  anchor?: string | null;
}

/** 打开 wiki 链接指向的笔记，并定位到 `#标题` / `#^块id`。 */
export async function openWikiLink(raw: string, options: OpenWikiLinkOptions = {}): Promise<boolean> {
  const parts = parseWikiLink(raw);
  if (!parts) return false;

  const store = useAppStore.getState();
  const documentPath = options.documentPath ?? store.currentFile;
  const anchor = options.anchor ?? parts.anchor;
  const path = parts.target ? await resolveWikiTarget(parts.target, documentPath) : documentPath;
  if (!path) return false;

  if (useAppStore.getState().currentFile !== path) {
    try {
      await useAppStore.getState().openFile(path);
    } catch {
      return false;
    }
  }
  if (anchor) {
    await revealWikiAnchor(anchor);
  } else {
    useAppStore.getState().editorView?.focus();
  }
  return true;
}

/** 按 1 起的源码行号定位；文档刚打开时编辑器实例可能还没就绪，重试几帧。 */
export async function revealSourceLine(line: number): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const editor = useAppStore.getState().editorView;
    if (editor) {
      const info = editor.line(line);
      editor.setSelection(info.from);
      editor.revealOffset(info.from);
      editor.focus();
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function revealWikiAnchor(anchor: string): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const { content } = useAppStore.getState();
    const blockLine = anchor.startsWith('^') ? findBlockReferenceLine(content, anchor) : null;
    const heading = blockLine === null ? findHeadingForWikiAnchor(content, anchor) : null;
    const line = blockLine ?? heading?.line;
    if (line !== undefined && line !== null) {
      await revealSourceLine(line);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

/**
 * 批量解析链接目标，供渲染管线标记未解析链接。
 * 非 Tauri 环境（浏览器预览）没有磁盘访问能力，返回空表表示「不做判断」。
 */
export async function resolveWikiLinkTargets(
  documentPath: string | null,
  targets: readonly string[],
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  if (!isTauriRuntime()) return result;
  const unique = Array.from(new Set(targets.map(target => target.trim()).filter(Boolean)));
  await Promise.all(unique.map(async (target) => {
    result.set(target, await resolveWikiTarget(target, documentPath));
  }));
  return result;
}
