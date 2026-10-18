/**
 * Wiki 链接（双向链接）的前端服务：解析目标笔记、打开并定位锚点。
 *
 * 解析顺序：
 * 桌面端由 Rust 按文档目录 → 工作区根解析，再复用匹配的已打开标签。
 * 浏览器预览仅匹配已打开的标签。
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
const RESOLUTION_CONCURRENCY = 4;

interface ResolutionEntry {
  path: string | null;
  at: number;
}

const resolutionCache = new Map<string, ResolutionEntry>();
const pendingResolutions = new Map<string, Promise<string | null>>();
let navigationSequence = 0;

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
  const slash = value.replace(/\\/g, '/');
  const segments: string[] = [];
  for (const segment of slash.split('/')) {
    if (segment === '.') continue;
    if (segment === '..' && segments.length > 0 && segments.at(-1) !== '..') segments.pop();
    else segments.push(segment);
  }
  const normalized = segments.join('/');
  return /^(?:[a-z]:|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized;
}

/** 先按上下文解析路径，不能让其他目录的同名标签抢占本地目标。 */
export function findOpenTabByWikiTarget(target: string, documentPath = useAppStore.getState().currentFile): Tab | null {
  const tabs = useAppStore.getState().tabs.filter((tab): tab is Tab & { path: string } => Boolean(tab.path));
  const slash = target.trim().replace(/\\/g, '/');
  if (!slash) return null;
  const variants = /\.(md|markdown)$/i.test(slash) ? [slash] : [`${slash}.md`, `${slash}.markdown`];
  const documentDir = documentPath?.replace(/\\/g, '/').replace(/\/[^/]*$/, '');
  const bases = /^(?:[a-z]:\/|\/)/i.test(slash) ? [''] : [documentDir, ...workspaceRoots()].filter((base): base is string => Boolean(base));
  for (const base of bases) {
    for (const variant of variants) {
      const wanted = normalizePath(base ? `${base}/${variant}` : variant);
      const exact = tabs.find(tab => normalizePath(tab.path) === wanted);
      if (exact) return exact;
    }
  }
  // 浏览器预览无磁盘解析能力；仅无路径、且唯一的同名笔记可以兜底。
  if (!isTauriRuntime() && !slash.includes('/')) {
    const matches = tabs.filter(tab => variants.some(variant => normalizePath(tab.path).endsWith(`/${normalizePath(variant)}`)));
    if (matches.length === 1) return matches[0];
  }
  return null;
}

function readCache(key: string): string | null | undefined {
  const entry = resolutionCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > RESOLUTION_TTL) {
    resolutionCache.delete(key);
    return undefined;
  }
  return entry.path;
}

function writeCache(key: string, path: string | null): void {
  if (resolutionCache.size >= RESOLUTION_LIMIT) {
    const oldest = resolutionCache.keys().next().value;
    if (oldest !== undefined) resolutionCache.delete(oldest);
  }
  resolutionCache.set(key, { path, at: Date.now() });
}

/** 把 wiki 链接目标解析成绝对路径；空目标表示当前文档。 */
export async function resolveWikiTarget(target: string, documentPath: string | null): Promise<string | null> {
  const trimmed = target.trim();
  if (!trimmed) return documentPath;

  // 桌面端必须先询问磁盘：根目录已开的标签不能抢占尚未打开的同目录文件。
  const opened = !isTauriRuntime() ? findOpenTabByWikiTarget(trimmed, documentPath) : null;
  if (opened) return opened.path;

  const roots = workspaceRoots();
  const key = JSON.stringify([documentPath, trimmed, roots, useAppStore.getState().tabs.map(tab => tab.path)]);
  const cached = readCache(key);
  if (cached !== undefined) return cached;
  const pending = pendingResolutions.get(key);
  if (pending) return pending;
  if (!isTauriRuntime()) return null;
  const resolving = (async () => {
    try {
      const diskPath = await invoke<string | null>('resolve_wiki_link', {
        documentPath: documentPath ?? '',
        target: trimmed,
        roots,
      }) ?? null;
      const resolved = diskPath ? useAppStore.getState().tabs.find(tab => tab.path && normalizePath(tab.path) === normalizePath(diskPath))?.path ?? diskPath : null;
      writeCache(key, resolved);
      return resolved;
    } catch {
      return null;
    } finally {
      pendingResolutions.delete(key);
    }
  })();
  pendingResolutions.set(key, resolving);
  return resolving;
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
  const request = ++navigationSequence;
  const sourceTabId = store.activeTabId;
  const documentPath = options.documentPath ?? store.currentFile;
  const anchor = options.anchor ?? parts.anchor;
  const path = parts.target ? await resolveWikiTarget(parts.target, documentPath) : documentPath;
  if (!path || request !== navigationSequence || useAppStore.getState().activeTabId !== sourceTabId) return false;

  return openWikiDocument(path, anchor, request);
}

/** 反向链接和正向链接共用同一套导航竞争与就绪检查。 */
export function openWikiBacklink(path: string, line: number): Promise<boolean> {
  return openWikiDocument(path, line, ++navigationSequence);
}

async function openWikiDocument(path: string, location: string | number | null, request: number): Promise<boolean> {
  const sourceTabId = useAppStore.getState().activeTabId;
  if (useAppStore.getState().currentFile !== path) {
    try {
      await useAppStore.getState().openFile(path, undefined, () =>
        request !== navigationSequence || useAppStore.getState().activeTabId !== sourceTabId);
    } catch {
      return false;
    }
  }
  if (request !== navigationSequence || useAppStore.getState().currentFile !== path) return false;
  if (typeof location === 'number') {
    await revealSourceLine(location, path, request);
  } else if (location) {
    await revealWikiAnchor(location, path, request);
  } else {
    useAppStore.getState().editorView?.focus();
  }
  return true;
}

/** 按 1 起的源码行号定位；文档刚打开时编辑器实例可能还没就绪，重试几帧。 */
export async function revealSourceLine(line: number, path = useAppStore.getState().currentFile, request = navigationSequence): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const { editorView: editor, currentFile, content } = useAppStore.getState();
    if (request !== navigationSequence || currentFile !== path) return;
    if (editor && editor.getValue() === content) {
      const info = editor.line(line);
      editor.setSelection(info.from);
      editor.revealOffset(info.from);
      editor.focus();
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function revealWikiAnchor(anchor: string, path: string, request: number): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const { content, currentFile } = useAppStore.getState();
    if (request !== navigationSequence || currentFile !== path) return;
    const blockLine = anchor.startsWith('^') ? findBlockReferenceLine(content, anchor) : null;
    const heading = blockLine === null ? findHeadingForWikiAnchor(content, anchor) : null;
    const line = blockLine ?? heading?.line;
    if (line !== undefined && line !== null) {
      await revealSourceLine(line, path, request);
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
  let next = 0;
  // 未命中的目标需要递归扫盘；大文档不能一次启动数百个原生扫描任务。
  await Promise.all(Array.from({ length: Math.min(RESOLUTION_CONCURRENCY, unique.length) }, async () => {
    while (next < unique.length) {
      const target = unique[next++];
      result.set(target, await resolveWikiTarget(target, documentPath));
    }
  }));
  return result;
}
