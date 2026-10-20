/** Keep complex blocks out of the first paint while filling text batches quickly. */
export function nextBlockRenderBudget(blocks: ReadonlyArray<{ kind: string }>, rendered: number, budget?: number): number {
  // Preserve the small initial paint, then reduce repeated whole-list React
  // reconciliation/layout passes as a long document fills. Keep each batch bounded.
  const limit = budget ?? Math.min(480, Math.max(120, Math.floor(rendered / 8)));
  let end = rendered;
  let cost = 0;
  while (end < blocks.length) {
    const kind = blocks[end].kind;
    const next = kind === 'table' ? (rendered === 0 ? 8 : 4) : kind === 'fence' || kind === 'html' ? (rendered === 0 ? 4 : 2) : 1;
    if (end > rendered && cost + next > limit) break;
    cost += next;
    end += 1;
  }
  return end;
}
