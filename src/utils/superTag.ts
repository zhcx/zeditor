import { parseFrontmatter } from './documentAnalysis.ts';

export interface SuperTagSourceFile {
  path: string;
  content: string;
}

export interface SuperTagRecord {
  path: string;
  title: string;
  className: string;
  fields: Record<string, unknown>;
}

export interface SuperTagGroup {
  className: string;
  records: SuperTagRecord[];
}

function fileName(path: string) {
  return path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || path;
}

export function groupSuperTagRecords(files: SuperTagSourceFile[]): SuperTagGroup[] {
  const groups = new Map<string, SuperTagRecord[]>();
  for (const file of files) {
    const frontmatter = parseFrontmatter(file.content);
    const classField = frontmatter.fields.find((field) => field.key === 'class');
    const className = typeof frontmatter.values.class === 'string' ? frontmatter.values.class.trim() : '';
    if (!className || !classField || frontmatter.diagnostics.some((diagnostic) => diagnostic.message.includes('class'))) continue;
    const record: SuperTagRecord = {
      path: file.path,
      title: typeof frontmatter.values.title === 'string' && frontmatter.values.title.trim()
        ? frontmatter.values.title
        : fileName(file.path),
      className,
      fields: frontmatter.values,
    };
    groups.set(className, [...(groups.get(className) || []), record]);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([className, records]) => ({
      className,
      records: records.sort((left, right) => left.path.localeCompare(right.path)),
    }));
}
