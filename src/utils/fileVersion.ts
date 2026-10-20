export interface FileVersion {
  size: number;
  sha256: string;
}

export function fileVersionsMatch(expected: FileVersion | null | undefined, current: FileVersion | null | undefined): boolean {
  if (!expected || !current) return expected == null && current == null;
  return expected.size === current.size && expected.sha256 === current.sha256;
}
