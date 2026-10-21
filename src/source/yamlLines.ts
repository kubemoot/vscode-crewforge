/**
 * Reading and changing YAML files line by line, so what CrewForge does not change
 * (comments, order, Helm actions) stays as it is. A Helm template is not YAML a parser
 * could load, so the edits that touch source files find keys, blocks, and documents by
 * their lines and indents.
 */

/** Lines [start, end) of a file. */
export interface Span {
  start: number;
  end: number;
}

export const indentOf = (line: string): number => line.length - line.trimStart().length;

/** A Helm action line, such as {{- if .Values.x }} or {{- end }}. */
export const isHelmLine = (line: string): boolean => line.trimStart().startsWith('{{');

/** A line that holds YAML: not blank, not a comment, and not a Helm action line. */
export const isContent = (line: string): boolean => {
  const trimmed = line.trimStart();
  return trimmed !== '' && !trimmed.startsWith('#') && !isHelmLine(line);
};

const escapeKey = (key: string) => key.replaceAll(/[.*+?^${}()|[\]\\/]/g, String.raw`\$&`);

/** The value part of a `key: value` line at `indent` for `key`, quoted or not; undefined for any other line. */
export function valueOf(line: string, indent: number, key: string): string | undefined {
  if (indentOf(line) !== indent) return undefined;
  const m = new RegExp(String.raw`^\s*(["']?)${escapeKey(key)}\1\s*:(.*)$`).exec(line);
  return m ? m[2].trim() : undefined;
}

/** The index of the line in [start, end) that holds `key` at `indent`, or -1. */
export function findKey(lines: string[], span: Span, indent: number, key: string): number {
  for (let i = span.start; i < span.end; i++) if (valueOf(lines[i], indent, key) !== undefined) return i;
  return -1;
}

/**
 * Where the block under the line at `owner` ends: past its last content line indented
 * deeper than `ownerIndent`, or a list item at that indent, which YAML lets a key's
 * sequence start at.
 */
export function blockEnd(lines: string[], owner: number, ownerIndent: number, limit: number): number {
  let end = owner + 1;
  for (let i = owner + 1; i < limit; i++) {
    if (!isContent(lines[i])) continue;
    const indent = indentOf(lines[i]);
    if (indent < ownerIndent || (indent === ownerIndent && !lines[i].trimStart().startsWith('-'))) break;
    end = i + 1;
  }
  return end;
}

/** The documents of a multi-document file, split at its `---` lines. */
export function documentsOf(lines: string[]): Span[] {
  const docs: Span[] = [];
  let start = 0;
  lines.forEach((l, i) => {
    if (!l.startsWith('---')) return;
    docs.push({ start, end: i });
    start = i + 1;
  });
  docs.push({ start, end: lines.length });
  return docs;
}

/** Whether a document declares `kind: <kind>`. */
export function isKind(lines: string[], doc: Span, kind: string): boolean {
  const pattern = new RegExp(String.raw`^kind:\s*["']?${escapeKey(kind)}["']?\s*(#.*)?$`);
  return lines.slice(doc.start, doc.end).some((l) => pattern.test(l));
}

/** The first document of a kind, or undefined. */
export const findDocument = (lines: string[], kind: string): Span | undefined => documentsOf(lines).find((d) => isKind(lines, d, kind));

/** Runs an edit over a file's lines, keeping its line endings; undefined when the edit declines. */
export function editLines(text: string, edit: (lines: string[]) => string[] | undefined): string | undefined {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const out = edit(text.split(/\r?\n/));
  return out?.join(eol);
}
