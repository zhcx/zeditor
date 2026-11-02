import type { PersistentWorkspaceMode, WorkspaceMode } from './workspaceMode.ts';

// Conservative starting points; benchmark the actual application before tuning.
export const LARGE_DOCUMENT_LIMITS = { bytes: 512 * 1024, blocks: 1200, tableCells: 2000 } as const;
export type LargeDocumentReason = 'size' | 'blocks' | 'tables';
export interface LargeDocumentAssessment {
  bytes: number;
  estimatedBlocks: number;
  estimatedTableCells: number;
  reasons: LargeDocumentReason[];
  recommended: boolean;
}
export interface DocumentPerformance {
  assessment: LargeDocumentAssessment;
  lightweight: boolean;
}

/** Cheap line scan; intentionally estimates rather than parsing Markdown into a DOM. */
export function assessLargeDocument(source: string, originalBytes?: number): LargeDocumentAssessment {
  const bytes = originalBytes !== undefined && Number.isFinite(originalBytes) && originalBytes >= 0
    ? originalBytes : new TextEncoder().encode(source).byteLength;
  let estimatedBlocks = 0;
  let estimatedTableCells = 0;
  let fence: { marker: string; length: number } | null = null;
  let previousBlank = true;
  let previousTableHeader = 0;
  let insideTable = false;
  let start = 0;
  while (start < source.length) {
    let end = start;
    while (end < source.length && source[end] !== '\n' && source[end] !== '\r') end++;
    const line = source.slice(start, end);
    start = end + (source[end] === '\r' && source[end + 1] === '\n' ? 2 : 1);
    const fenceMatch = line.match(/^\s*(?:>\s*)*(?:(?:[-+*]|\d+[.)])\s+)?(`{3,}|~{3,})/);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence.marker && fenceMatch[1].length >= fence.length && /^\s*$/.test(line.slice(fenceMatch[0].length))) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = { marker: fenceMatch[1][0], length: fenceMatch[1].length };
      estimatedBlocks++; previousBlank = false; insideTable = false; previousTableHeader = 0; continue;
    }
    const blank = !line.trim();
    if (!blank && (previousBlank || /^\s*(?:#{1,6}\s|>|[-+*]\s|\d+[.)]\s)/.test(line))) estimatedBlocks++;
    previousBlank = blank;
    const tableLine = line.replace(/^\s*(?:>\s*)+/, '');
    const pipes = (tableLine.match(/\|/g) ?? []).length;
    const cells = Math.max(1, pipes - (tableLine.trimStart().startsWith('|') ? 1 : 0) - (tableLine.trimEnd().endsWith('|') ? 1 : 0) + 1);
    const delimiter = pipes > 0 && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(tableLine);
    if (delimiter && previousTableHeader > 0) {
      insideTable = true;
      estimatedTableCells += previousTableHeader;
    } else if (insideTable && pipes > 0 && !blank) {
      estimatedTableCells += cells;
    } else {
      insideTable = false;
    }
    previousTableHeader = pipes > 0 && !delimiter ? cells : 0;
  }
  const reasons: LargeDocumentReason[] = [];
  if (bytes >= LARGE_DOCUMENT_LIMITS.bytes) reasons.push('size');
  if (estimatedBlocks >= LARGE_DOCUMENT_LIMITS.blocks) reasons.push('blocks');
  if (estimatedTableCells >= LARGE_DOCUMENT_LIMITS.tableCells) reasons.push('tables');
  return { bytes, estimatedBlocks, estimatedTableCells, reasons, recommended: reasons.length > 0 };
}

export function modeForDocument(current: WorkspaceMode, preferred: PersistentWorkspaceMode | undefined, lightweight: boolean): WorkspaceMode {
  if (lightweight) return 'source';
  return current === 'source' ? (preferred ?? 'split') : current;
}
