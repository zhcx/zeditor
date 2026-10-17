/** Resize from the measured starting width, preserving the pointer's grab offset. */
export function resizeFromPointer(initial: number, startX: number, clientX: number, direction: number, min: number, max: number): number {
  return Math.max(Math.min(min, max), Math.min(max, initial + (clientX - startX) * direction));
}

/** Fit displayed widths without overwriting the user's preferred widths. */
export function fitPanelWidths(available: number, widths: number[], minimumDocument: number): number[] {
  const total = widths.reduce((sum, width) => sum + Math.max(0, width), 0);
  const factor = total > 0 ? Math.min(1, Math.max(0, available - minimumDocument) / total) : 1;
  return widths.map(width => Math.max(0, width) * factor);
}
