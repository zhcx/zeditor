/** Keep complex blocks out of the first paint while filling text batches quickly. */
export function nextBlockRenderBudget(blocks: ReadonlyArray<{ kind: string }>, rendered: number, budget = 120): number {
  let end = rendered;
  let cost = 0;
  while (end < blocks.length) {
    const kind = blocks[end].kind;
    const next = kind === 'table' ? (rendered === 0 ? 8 : 4) : kind === 'fence' || kind === 'html' ? (rendered === 0 ? 4 : 2) : 1;
    if (end > rendered && cost + next > budget) break;
    cost += next;
    end += 1;
  }
  return end;
}
