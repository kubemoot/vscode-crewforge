/** Where a Kubemoot object starts in a YAML file, and its kind and name when they are literal. */
export interface ObjectPosition {
  line: number;
  kind: string;
  name?: string;
}

/**
 * Finds the Kubemoot objects in a multi-document YAML text by their apiVersion lines.
 * It scans lines rather than parsing, because a Helm template with `{{ }}` is not YAML
 * that parseManifests could load, and the lens needs positions in the file as written.
 * A name that is a Helm template expression is left out, since only the render knows it.
 */
export function kubemootObjects(text: string): ObjectPosition[] {
  const found: ObjectPosition[] = [];
  const documents = text.split(/^---.*$/m);
  let offset = 0;
  for (const doc of documents) {
    const lines = doc.split('\n');
    const start = lines.findIndex((l) => /^apiVersion:\s*kubemoot\.ai\//.test(l));
    const kind = lines.map((l) => /^kind:\s*(\w+)/.exec(l)?.[1]).find(Boolean);
    if (start >= 0 && kind) found.push({ line: offset + start, kind, name: literalName(lines) });
    offset += lines.length - 1;
  }
  return found;
}

function literalName(lines: string[]): string | undefined {
  const at = lines.findIndex((l) => /^metadata:\s*$/.test(l));
  if (at < 0) return undefined;
  const name = lines.slice(at + 1).map((l) => /^\s+name:\s*["']?([^"'\s]+)["']?\s*$/.exec(l)?.[1]).find(Boolean);
  return name && !name.includes('{{') ? name : undefined;
}
