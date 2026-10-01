import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { IGNORED_DIRS } from './ignored';
import { byCodeUnits, LINE_BREAK } from '../text';

/** Keys whose value names the crew or an object built on its name, beyond the reference keys. */
const NAME_KEYS = new Set(['name', 'crew', 'kubemoot.ai/crew', 'serviceAccountName']);

/**
 * True for a key whose value names the crew or an object built on its name: `name`, `crew`,
 * `kubemoot.ai/crew`, `serviceAccountName` (an MCPServer runs as `<crew>-kubernetes-mcp`), and
 * any reference key (`crewRef`, `promptRefs`, `coordinatorRef`).
 */
function isNameKey(key: string): boolean {
  if (NAME_KEYS.has(key)) return true;
  const suffix = key.endsWith('Refs') ? 'Refs' : 'Ref';
  return key.endsWith(suffix) && /^[A-Za-z]*$/.test(key.slice(0, -suffix.length));
}

/** A `key: value` line, in parts: `lead`, an optional list `dash`, the key `name` with its `quote`, the `gap`, and the `value`. */
interface KeyLine {
  line: string;
  lead: string;
  dash: string;
  quote: string;
  name: string;
  gap: string;
  value: string;
}

const SPACE = /\s/;
const KEY_CHAR = /[\w./-]/;
const isSpace = (ch: string) => SPACE.test(ch);
const isKeyChar = (ch: string) => KEY_CHAR.test(ch);

/** The index of the first character at or after `from` that `keep` rejects. */
function skip(line: string, from: number, keep: (ch: string) => boolean): number {
  let at = from;
  while (at < line.length && keep(line.charAt(at))) at++;
  return at;
}

/** Where the key starts: past a list item's dash and the whitespace after it, when the line has one. */
function pastDash(line: string, at: number): number {
  return line.charAt(at) === '-' && isSpace(line.charAt(at + 1)) ? skip(line, at + 1, isSpace) : at;
}

/**
 * Reads a `key: value` line: indent, an optional `- `, a key of word characters, dots,
 * slashes, and hyphens (quoted or not), a colon, and the rest of the line as the value.
 * One pass over the line, so the time is linear in its length.
 */
function parseKeyLine(line: string): KeyLine | undefined {
  const leadEnd = skip(line, 0, isSpace);
  const dashEnd = pastDash(line, leadEnd);
  const quote = line.charAt(dashEnd) === '"' || line.charAt(dashEnd) === "'" ? line.charAt(dashEnd) : '';
  const nameStart = dashEnd + quote.length;
  const nameEnd = skip(line, nameStart, isKeyChar);
  if (nameEnd === nameStart || !line.startsWith(`${quote}:`, nameEnd)) return undefined;
  const gapStart = nameEnd + quote.length + 1;
  const gapEnd = skip(line, gapStart, isSpace);
  const value = line.slice(gapEnd);
  if (LINE_BREAK.test(value)) return undefined;
  const name = line.slice(nameStart, nameEnd);
  return { line, lead: line.slice(0, leadEnd), dash: line.slice(leadEnd, dashEnd), quote, name, gap: line.slice(gapStart, gapEnd), value };
}

/** Reads a list item line (`  - value`) into its indent and its value, in linear time. */
function parseListItem(line: string): { lead: string; value: string } | undefined {
  const leadEnd = skip(line, 0, isSpace);
  const valueStart = pastDash(line, leadEnd);
  if (valueStart === leadEnd) return undefined;
  const value = line.slice(valueStart);
  return LINE_BREAK.test(value) ? undefined : { lead: line.slice(0, leadEnd), value };
}

const BLOCK_SCALAR = /^[|>][-+0-9]*\s*(#.*)?$/;

/** The crew name in one value token: the name itself, or a name built on it (`<crew>-coordinator`). */
function renameToken(token: string, from: string, to: string): string {
  if (token === from) return to;
  return token.startsWith(`${from}-`) ? `${to}${token.slice(from.length)}` : token;
}

/**
 * The crew name in a value: a plain or quoted scalar, or each item of a `[a, b]` list;
 * a trailing comment is kept as it is.
 */
function renameValue(value: string, from: string, to: string): string {
  const flow = /^\[(.*)\](\s*(?:#.*)?)$/.exec(value);
  if (flow) return `[${flow[1].split(',').map((item) => renameValue(item, from, to)).join(',')}]${flow[2]}`;
  const m = /^(\s*)(["']?)([^"'#\s]+)\2(\s*(?:#.*)?)$/.exec(value);
  return m ? `${m[1]}${m[2]}${renameToken(m[3], from, to)}${m[2]}${m[4]}` : value;
}

/** Where the walk through a file stands: inside a block scalar's text, or in a list under a name key. */
interface Walk {
  /** The indent of the key that opened a block scalar (`content: |`); deeper lines are its text. */
  blockIndent?: number;
  /** The indent of a name key with no value (`promptRefs:`); its list items name objects. */
  listIndent?: number;
}

const indentOf = (line: string) => line.length - line.trimStart().length;

/** True for a line of a block scalar's text: blank, or deeper than the key that opened it. */
function inBlock(line: string, walk: Walk): boolean {
  return walk.blockIndent !== undefined && (line.trim() === '' || indentOf(line) > walk.blockIndent);
}

/** A `key: value` line: renamed when the key holds a name; it may open a block scalar or a list of names. */
function renameKeyLine(key: KeyLine, from: string, to: string): [string, Walk] {
  const { line, lead, dash, quote, name, gap, value } = key;
  const at = lead.length + dash.length;
  if (BLOCK_SCALAR.test(value)) return [line, { blockIndent: at }];
  if (!isNameKey(name)) return [line, {}];
  if (value === '') return [line, { listIndent: at }];
  return [`${lead}${dash}${quote}${name}${quote}:${gap}${renameValue(value, from, to)}`, {}];
}

/** One line of the file, renamed where it holds a crew name, with the walk's state after it. */
function renameLine(line: string, walk: Walk, from: string, to: string): [string, Walk] {
  if (inBlock(line, walk)) return [line, walk];
  const key = parseKeyLine(line);
  if (key) return renameKeyLine(key, from, to);
  const item = parseListItem(line);
  if (item && BLOCK_SCALAR.test(item.value)) return [line, { blockIndent: indentOf(line) }];
  if (item && walk.listIndent !== undefined && indentOf(line) >= walk.listIndent) return [`${item.lead}- ${renameValue(item.value, from, to)}`, walk];
  const keeps = line.trim() === '' || line.trimStart().startsWith('#');
  return [line, keeps ? walk : {}];
}

/**
 * Renames a crew in the text of one of its YAML files: the values of name and reference
 * keys (`name`, `crew`, `kubemoot.ai/crew`, `crewRef`, `promptRefs`, ...) that are the
 * old name or built on it (`demo-coordinator` becomes `lab-coordinator`), including list
 * items under such a key. Other keys (`namespace`, `image`), prose, and the text of block
 * scalars (prompt content, test scripts) are left as they are. One pass, so a new name
 * that starts with the old one is not renamed twice.
 */
export function renameCrewText(text: string, from: string, to: string): string {
  let walk: Walk = {};
  return text
    .split('\n')
    .map((raw) => {
      // A CRLF file keeps its line endings; the walk reads each line without its \r.
      const cr = raw.endsWith('\r') ? '\r' : '';
      const [out, next] = renameLine(cr ? raw.slice(0, -1) : raw, walk, from, to);
      walk = next;
      return out + cr;
    })
    .join('\n');
}

/** The YAML files of a crew source, at any depth, leaving out dependencies, git's files, and the chart's own subcharts. */
export async function crewYamlFiles(root: string, top = root): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (e) => {
      const full = path.join(root, e.name);
      const skip = IGNORED_DIRS.includes(e.name) || full === path.join(top, 'charts');
      if (e.isDirectory()) return skip ? [] : crewYamlFiles(full, top);
      return /\.ya?ml$/.test(e.name) ? [full] : [];
    }),
  );
  return nested.flat().sort(byCodeUnits);
}

/**
 * Renames a crew throughout its source: every YAML file under `root`, and those in
 * `extra` folders (the fitness folder beside a source). Each file that changes is added
 * to `changed` as it is written, so a failure partway still says what was renamed.
 */
export async function renameCrewFiles(root: string, from: string, to: string, extra: string[] = [], changed: string[] = []): Promise<string[]> {
  const others = await Promise.all(extra.map((folder) => crewYamlFiles(folder).catch(() => [] as string[])));
  for (const file of [...(await crewYamlFiles(root)), ...others.flat()]) {
    const before = await fs.readFile(file, 'utf8');
    const after = renameCrewText(before, from, to);
    if (after === before) continue;
    await fs.writeFile(file, after, 'utf8');
    changed.push(file);
  }
  return changed;
}
