/** 按应用版本提取更新日志，避免“关于”页与发布记录分别维护。 */
export function getReleaseNotes(changelog: string, version: string): string | null {
  const headings = Array.from(changelog.matchAll(/^## (.+)\r?$/gm));
  const index = headings.findIndex(heading => /^v([^\s（(]+)/.exec(heading[1])?.[1] === version);
  if (index < 0) return null;
  const heading = headings[index];
  return changelog.slice(heading.index! + heading[0].length, headings[index + 1]?.index).trim() || null;
}
