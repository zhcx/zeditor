// 工作台导航与按钮布局的共享逻辑。

interface OpenDocument {
  id: string;
  title: string;
  path: string | null;
}

export function filterOpenDocuments<T extends OpenDocument>(documents: T[], query: string): T[] {
  const normalize = (text: string) => text.toLocaleLowerCase().replace(/\\/g, '/');
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  return documents.filter(document => {
    const text = normalize(`${document.title} ${document.path || ''}`);
    return terms.every(term => text.includes(term));
  });
}

export function getAdjacentTabId(ids: string[], currentId: string, key: string): string | null {
  const index = ids.indexOf(currentId);
  if (index < 0) return null;
  if (key === 'Home') return ids[0];
  if (key === 'End') return ids[ids.length - 1];
  if (key === 'ArrowLeft') return ids[(index - 1 + ids.length) % ids.length];
  if (key === 'ArrowRight') return ids[(index + 1) % ids.length];
  return null;
}

export function fitToolbarButtons(widths: number[], availableWidth: number, overflowWidth: number): number {
  if (widths.reduce((sum, width) => sum + width, 0) <= availableWidth) return widths.length;
  const budget = Math.max(0, availableWidth - overflowWidth);
  let used = 0;
  let count = 0;
  for (const width of widths) {
    if (used + width > budget) break;
    used += width;
    count += 1;
  }
  return count;
}
