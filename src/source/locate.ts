import type { Manifest } from './manifests';
import { kubemootObjects, type ObjectPosition } from './positions';
import type { Rendered } from './render';

/** A rendered object, the file it came from, and the line (0-based) where it starts there. */
export interface Located {
  manifest: Manifest;
  file?: string;
  line: number;
}

/**
 * Finds where each rendered object starts in its source file. An object whose name is
 * literal in the file is matched by kind and name; one whose name is a template
 * expression takes the next unmatched object of its kind in that file. An object whose
 * file cannot be read, or has no matching object, starts at the top of the file.
 */
export async function locate(rendered: Rendered[], readText: (file: string) => Promise<string>): Promise<Located[]> {
  const files = [...new Set(rendered.map((r) => r.file).filter((f): f is string => f !== undefined))];
  const positions = new Map(await Promise.all(files.map(async (f) => [f, await positionsIn(f, readText)] as const)));
  const used = new Map<string, Set<number>>();
  return rendered.map(({ manifest, file }) => {
    if (!file) return { manifest, line: 0 };
    const taken = used.get(file) ?? new Set<number>();
    used.set(file, taken);
    return { manifest, file, line: place(positions.get(file) ?? [], taken, manifest) };
  });
}

async function positionsIn(file: string, readText: (file: string) => Promise<string>): Promise<ObjectPosition[]> {
  try {
    return kubemootObjects(await readText(file));
  } catch {
    return [];
  }
}

/** The line of the best free position for an object, marking it taken; 0 when none fits. */
function place(positions: ObjectPosition[], taken: Set<number>, m: Manifest): number {
  const free = (p: ObjectPosition, i: number) => !taken.has(i) && p.kind === m.kind;
  let index = positions.findIndex((p, i) => free(p, i) && p.name === m.metadata.name);
  if (index < 0) index = positions.findIndex((p, i) => free(p, i) && p.name === undefined);
  if (index < 0) return positions.find((p) => p.kind === m.kind)?.line ?? 0;
  taken.add(index);
  return positions[index].line;
}

/**
 * The line of the deepest key of `keys` found under the object that starts at `start`:
 * each key is looked for below the previous one, indented deeper. Array indexes are
 * skipped, since a list item has no key of its own. Where nothing is found the object's
 * own line is the answer.
 */
export function keyLine(text: string, start: number, keys: string[]): number {
  const lines = text.split('\n');
  let line = start;
  let indent = -1;
  for (const key of keys.filter((k) => !/^\d+$/.test(k))) {
    const found = findKey(lines, line + (indent < 0 ? 0 : 1), indent, key);
    if (!found) break;
    ({ line, indent } = found);
  }
  return line;
}

function findKey(lines: string[], from: number, parentIndent: number, key: string): { line: number; indent: number } | undefined {
  const pattern = new RegExp(`^(\\s*(?:- )?)${escapeRegExp(key)}:`);
  for (let i = from; i < lines.length; i++) {
    if (i > from && /^---/.test(lines[i])) return undefined;
    const m = pattern.exec(lines[i]);
    if (m && m[1].length > parentIndent) return { line: i, indent: m[1].length };
  }
  return undefined;
}

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/** The line of `testRef: <name>` at or after `start`, for a fitness scenario; `start` when absent. */
export function scenarioLine(text: string, start: number, testRef: string): number {
  const lines = text.split('\n');
  const pattern = new RegExp(`testRef:\\s*["']?${escapeRegExp(testRef)}["']?\\s*$`);
  const at = lines.findIndex((l, i) => i >= start && pattern.test(l));
  return at < 0 ? start : at;
}
