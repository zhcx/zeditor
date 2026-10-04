export function usesMacShortcuts(platform: string): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}

export function formatShortcut(shortcut: string, platform = typeof navigator === 'undefined' ? '' : navigator.platform): string {
  if (!usesMacShortcuts(platform)) return shortcut;
  return shortcut
    .replace(/Ctrl/gi, '⌘')
    .replace(/Shift/gi, '⇧')
    .replace(/Alt/gi, '⌥');
}
