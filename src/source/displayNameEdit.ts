import { DISPLAY_NAME_ANNOTATION, displayNameProblem } from '../crew/displayName';
import { blockEnd, editLines, findDocument, findKey, indentOf, isContent, isHelmLine, valueOf } from './yamlLines';

/**
 * Writes a crew's display name into the text of its source files, line by line, so the
 * rest of each file (comments, order, Helm actions) stays as it is: the Crew's
 * `metadata.annotations` in its manifest, and a chart's `annotations` in Chart.yaml.
 */

/**
 * The display name as a YAML double-quoted scalar: a JSON string is one, for one line of
 * whole characters, which a display name is (anything else is refused). In a file Helm
 * renders (`helm` true), text holding "{{" would open a Helm action, so it is written as
 * one instead: the same string literal, printed with quote, which gives the same scalar.
 */
export function displayNameScalar(value: string, helm: boolean): string {
  const problem = displayNameProblem(value);
  if (problem) throw new Error(`"${value}" cannot be a display name: ${problem}`);
  const quoted = JSON.stringify(value);
  return helm && value.includes('{{') ? `{{ ${quoted} | quote }}` : quoted;
}

/** Past the Helm action lines at `from`, such as the {{- end }} that closes a block, so an addition lands outside it. */
function pastHelmLines(lines: string[], from: number): number {
  let at = from;
  while (at < lines.length && isHelmLine(lines[at])) at++;
  return at;
}

/** The indent of the first content line in [start, end), or `fallback` when there is none. */
function childIndent(lines: string[], start: number, end: number, fallback: number): number {
  for (let i = start; i < end; i++) if (isContent(lines[i])) return indentOf(lines[i]);
  return fallback;
}

/** A mapping's entries: lines [start, end) whose keys sit at `indent`. */
interface Mapping {
  start: number;
  end: number;
  indent: number;
}

/**
 * Sets `annotations.<display-name>` in a mapping, adding `annotations` when it is missing.
 * Undefined when `annotations` holds a flow mapping with entries, which is left to a person.
 */
function setAnnotation(lines: string[], map: Mapping, scalar: string): string[] | undefined {
  const pad = (n: number) => ' '.repeat(n);
  const at = findKey(lines, map, map.indent, 'annotations');
  if (at < 0) {
    const end = pastHelmLines(lines, map.end);
    return [...lines.slice(0, end), `${pad(map.indent)}annotations:`, `${pad(map.indent + 2)}${DISPLAY_NAME_ANNOTATION}: ${scalar}`, ...lines.slice(end)];
  }
  const out = [...lines];
  const rest = valueOf(out[at], map.indent, 'annotations') ?? '';
  if (rest !== '' && !rest.startsWith('#')) {
    if (rest !== '{}') return undefined;
    out[at] = `${pad(map.indent)}annotations:`;
  }
  const end = blockEnd(out, at, map.indent, map.end);
  if (out.slice(at + 1, pastHelmLines(out, end)).some(isHelmLine)) return undefined;
  const indent = childIndent(out, at + 1, end, map.indent + 2);
  return setEntry(out, { start: at + 1, end, indent }, `${pad(indent)}${DISPLAY_NAME_ANNOTATION}: ${scalar}`);
}

/**
 * Replaces the display-name entry of an annotations block with `line`, or adds it first.
 * Undefined when the entry's value runs over more than one line, which is left to a person.
 */
function setEntry(lines: string[], block: Mapping, line: string): string[] | undefined {
  const existing = findKey(lines, block, block.indent, DISPLAY_NAME_ANNOTATION);
  if (existing < 0) {
    lines.splice(block.start, 0, line);
    return lines;
  }
  const value = valueOf(lines[existing], block.indent, DISPLAY_NAME_ANNOTATION) ?? '';
  if (/^[|>]/.test(value) || blockEnd(lines, existing, block.indent, block.end) > existing + 1) return undefined;
  lines[existing] = line;
  return lines;
}

/**
 * Sets the display name in the text of a file that holds the Crew; undefined when the file
 * has no Crew with a block `metadata`, or holds its annotations in a way left to a person.
 */
export function setCrewDisplayName(text: string, value: string, helm: boolean): string | undefined {
  return editLines(text, (lines) => {
    const doc = findDocument(lines, 'Crew');
    if (!doc) return undefined;
    const meta = findKey(lines, doc, 0, 'metadata');
    if (meta < 0 || valueOf(lines[meta], 0, 'metadata') !== '') return undefined;
    const end = blockEnd(lines, meta, 0, doc.end);
    return setAnnotation(lines, { start: meta + 1, end, indent: childIndent(lines, meta + 1, end, 2) }, displayNameScalar(value, helm));
  });
}

/** Sets the display name in a Chart.yaml's annotations; undefined when they are a flow mapping with entries. */
export function setChartDisplayName(text: string, value: string): string | undefined {
  return editLines(text, (lines) => setAnnotation(lines, { start: 0, end: blockEnd(lines, -1, -1, lines.length), indent: 0 }, displayNameScalar(value, false)));
}
