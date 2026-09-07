export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
  file?: File;
  directoryHandle?: FileSystemDirectoryHandle;
}

export interface WorkspaceFolderTree {
  path: string;
  tree: FileNode[];
}

export const replaceNodeChildren = (nodes: FileNode[], path: string, children: FileNode[]): FileNode[] => nodes.map(node => {
  if (node.path === path) return { ...node, children };
  return node.children ? { ...node, children: replaceNodeChildren(node.children, path, children) } : node;
});

// 把旧树中已经懒加载的子目录内容合并到新树，避免浅层刷新把已展开的二级、
// 三级目录清空成"空文件夹"。read_folder 对目录总是返回空 children，只有用户
// 展开目录时才会通过 toggleFolder 懒加载填充；自动刷新/整体刷新若直接整体替换
// folder.tree，会丢失这些已加载的 children。此函数按 path 递归匹配旧树：新树中
// 目录节点的 children 为空（浅层读取的结果）时，若旧树里该目录已加载过内容，
// 则保留旧内容；只有从未加载过的目录才使用新的空 children。
export const mergeLoadedChildren = (oldNodes: FileNode[], newNodes: FileNode[]): FileNode[] => newNodes.map(newNode => {
  if (!newNode.isDirectory) return newNode;
  const oldNode = oldNodes.find(node => node.path === newNode.path);
  const loadedChildren = oldNode?.children;
  const incomingChildren = newNode.children ?? [];
  // 浅层刷新对目录总是给空 children；若旧树已加载该目录内容，直接保留旧内容
  // 而不做合并（旧内容本身已包含更深层的加载状态）。
  if (!incomingChildren.length && loadedChildren?.length) {
    return { ...newNode, children: loadedChildren };
  }
  return { ...newNode, children: mergeLoadedChildren(loadedChildren ?? [], incomingChildren) };
});

// 刷新指定路径的目录内容，但保留该路径下已经懒加载的子目录 children。
// 与 replaceNodeChildren 的区别：新 children 来自 read_folder（目录 children
// 恒为空），若直接整体替换会清空已展开的更深层目录；这里把目标路径的旧 children
// 与新内容合并，仅刷新顶层增删，不丢已加载的子目录。
export const replaceNodeChildrenMerged = (nodes: FileNode[], path: string, newChildren: FileNode[]): FileNode[] => nodes.map(node => {
  if (node.path === path) return { ...node, children: mergeLoadedChildren(node.children ?? [], newChildren) };
  return node.children ? { ...node, children: replaceNodeChildrenMerged(node.children, path, newChildren) } : node;
});

/** Apply a shallow filesystem refresh without discarding lazily loaded descendants. */
export const refreshWorkspaceFolderTree = <T extends WorkspaceFolderTree>(
  folders: T[],
  folderPath: string,
  newChildren: FileNode[],
): T[] => folders.map(folder => {
  const isRoot = folder.path === folderPath;
  const isNested = folderPath.startsWith(folder.path + '/') || folderPath.startsWith(folder.path + '\\');
  if (!isRoot && !isNested) return folder;
  return {
    ...folder,
    tree: isRoot
      ? mergeLoadedChildren(folder.tree, newChildren)
      : replaceNodeChildrenMerged(folder.tree, folderPath, newChildren),
  };
});
