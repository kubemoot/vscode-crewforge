import { blockEnd, documentsOf, findKey, indentOf, isContent, isKind, valueOf, type Span } from '../source/yamlLines';

/** The fields CrewForge follows from one object to another by name. */
export type RefField = 'promptRefs' | 'crewRef';

/** The kind of object a field names. */
export type RefTarget = 'PromptModule' | 'Crew';

export const TARGET_OF: Record<RefField, RefTarget> = { promptRefs: 'PromptModule', crewRef: 'Crew' };

/** A run of characters on one line, `start` to `end` (exclusive), both 0-based. */
export interface TextSpan {
  line: number;
  start: number;
  end: number;
}

/** A name in a reference field. */
export interface RefSite extends TextSpan {
  field: RefField;
  name: string;
}

/** The name an object is declared with. */
export interface DeclSite extends TextSpan {
  kind: RefTarget;
  name: string;
}

const NAME = String.raw`[A-Za-z0-9][\w.-]*`;
const NAME_ONLY = new RegExp(`^${NAME}$`);
const FLOW_LIST = /^(\s*)promptRefs:\s*\[(.*)\]\s*(?:#.*)?$/;
const BLOCK_KEY = /^(\s*)promptRefs:\s*(?:#.*)?$/;
const BLOCK_ITEM = new RegExp(String.raw`^(\s*)-\s*(["']?)(${NAME})\2\s*(?:#.*)?$`);
const CREW_REF = new RegExp(String.raw`^\s*crewRef:\s*(["']?)(${NAME})\1\s*(?:#.*)?$`);
const BLOCK_SCALAR = /:\s*[|>][-+0-9]*\s*(?:#.*)?$/;

/**
 * The names in the reference fields of a YAML or Helm template text. It reads lines, not
 * a parsed document, because a template with `{{ }}` is not YAML a parser could load. A
 * name made with a template action is left out (only the render knows it), and so is
 * anything inside a block scalar such as a prompt's content.
 */
export function refSites(text: string): RefSite[] {
  const lines = text.split(/\r?\n/);
  const found: RefSite[] = [];
  let scalarIndent = -1;
  lines.forEach((line, i) => {
    if (scalarIndent >= 0 && (!isContent(line) || indentOf(line) > scalarIndent)) return;
    scalarIndent = -1;
    if (BLOCK_SCALAR.test(line)) scalarIndent = indentOf(line.replace(/^(\s*)-\s+/, '$1  '));
    found.push(...sitesOnLine(lines, i));
  });
  return found;
}

/** The reference names that start on line `i`: a flow list, a crewRef, or the items of a block list. */
function sitesOnLine(lines: string[], i: number): RefSite[] {
  const line = lines[i];
  const flow = FLOW_LIST.exec(line);
  if (flow) return flowItems(line, i, flow[2]);
  const crew = CREW_REF.exec(line);
  if (crew) return [{ field: 'crewRef', name: crew[2], line: i, ...nameColumns(line, crew[2], line.indexOf('crewRef:') + 'crewRef:'.length) }];
  const key = BLOCK_KEY.exec(line);
  return key ? blockItems(lines, i, key[1].length) : [];
}

/** Where `name` is on `line`, looking from column `from`. */
function nameColumns(line: string, name: string, from: number): { start: number; end: number } {
  const start = line.indexOf(name, from);
  return { start, end: start + name.length };
}

function flowItems(line: string, i: number, list: string): RefSite[] {
  const base = line.indexOf('[') + 1;
  const sites: RefSite[] = [];
  let at = 0;
  for (const raw of list.split(',')) {
    const name = unquoted(raw.trim());
    const start = base + at + raw.indexOf(name);
    at += raw.length + 1;
    if (NAME_ONLY.test(name)) sites.push({ field: 'promptRefs', name, line: i, start, end: start + name.length });
  }
  return sites;
}

function blockItems(lines: string[], keyLine: number, keyIndent: number): RefSite[] {
  const end = blockEnd(lines, keyLine, keyIndent, lines.length);
  const sites: RefSite[] = [];
  for (let i = keyLine + 1; i < end; i++) {
    const item = BLOCK_ITEM.exec(lines[i]);
    if (item) sites.push({ field: 'promptRefs', name: item[3], line: i, ...nameColumns(lines[i], item[3], item[1].length + 1) });
  }
  return sites;
}

/** The PromptModules and Crews a text declares, with where each name is written. Names made with template actions are left out. */
export function declSites(text: string): DeclSite[] {
  const lines = text.split(/\r?\n/);
  const found: DeclSite[] = [];
  for (const doc of documentsOf(lines)) {
    for (const kind of ['PromptModule', 'Crew'] as const) {
      const site = isKind(lines, doc, kind) ? nameSite(lines, doc, kind) : undefined;
      if (site) found.push(site);
    }
  }
  return found;
}

/** A value without its trailing ` # comment`. */
function withoutComment(value: string): string {
  const at = value.indexOf(' #');
  return (at < 0 ? value : value.slice(0, at)).trim();
}

const unquoted = (value: string): string => value.replace(/^(["'])(.*)\1$/, '$2');

/** The `metadata.name` of the object in `doc`. */
function nameSite(lines: string[], doc: Span, kind: RefTarget): DeclSite | undefined {
  const meta = findKey(lines, doc, 0, 'metadata');
  if (meta < 0) return undefined;
  const end = blockEnd(lines, meta, 0, doc.end);
  const indent = lines.slice(meta + 1, end).filter(isContent).map(indentOf)[0];
  const at = indent === undefined ? -1 : findKey(lines, { start: meta + 1, end }, indent, 'name');
  const value = at < 0 ? undefined : unquoted(withoutComment(valueOf(lines[at], indent, 'name') ?? ''));
  if (!value || !NAME_ONLY.test(value)) return undefined;
  return { kind, name: value, line: at, ...nameColumns(lines[at], value, lines[at].indexOf('name:') + 5) };
}

/** The site, among `sites`, that the position is on or at the end of. */
export function siteAt<T extends TextSpan>(sites: T[], line: number, character: number): T | undefined {
  return sites.find((s) => s.line === line && character >= s.start && character <= s.end);
}

/** The reference name a completion at the position would fill: its field and the span typed so far. */
export interface CompletionSite {
  field: RefField;
  line: number;
  start: number;
  end: number;
}

const FLOW_OPEN = /^\s*promptRefs:\s*\[([^\]]*)$/;
const NAME_TYPED = /^\s*["']?([\w.-]*)$/;
const ITEM_TYPED = /^(\s*)-\s*["']?([\w.-]*)$/;
const CREW_TYPED = /^\s*crewRef:\s*["']?([\w.-]*)$/;

/** Whether a name is being typed at the position, in a promptRefs list or after crewRef. */
export function completionAt(text: string, line: number, character: number): CompletionSite | undefined {
  const lines = text.split(/\r?\n/);
  const before = (lines[line] ?? '').slice(0, character);
  const flow = FLOW_OPEN.exec(before);
  const typedInList = flow && NAME_TYPED.exec(flow[1].slice(flow[1].lastIndexOf(',') + 1));
  if (typedInList) return site('promptRefs', line, character, typedInList[1]);
  const crew = CREW_TYPED.exec(before);
  if (crew) return site('crewRef', line, character, crew[1]);
  const item = ITEM_TYPED.exec(before);
  return item && underPromptRefs(lines, line, item[1].length) ? site('promptRefs', line, character, item[2]) : undefined;
}

function site(field: RefField, line: number, character: number, typed: string): CompletionSite {
  return { field, line, start: character - typed.length, end: character };
}

/** Whether the list item at `line` belongs to a `promptRefs:` key: the nearest key above it, less indented or equal. */
function underPromptRefs(lines: string[], line: number, itemIndent: number): boolean {
  for (let i = line - 1; i >= 0; i--) {
    if (!isContent(lines[i])) continue;
    if (lines[i].trimStart().startsWith('-') && indentOf(lines[i]) >= itemIndent) continue;
    return BLOCK_KEY.test(lines[i]) && indentOf(lines[i]) <= itemIndent;
  }
  return false;
}

/** The object a name under the cursor refers to or declares: the field that names it and the name. */
export function nameAt(text: string, line: number, character: number): { field: RefField; name: string } | undefined {
  const used = siteAt(refSites(text), line, character);
  if (used) return { field: used.field, name: used.name };
  const declared = siteAt(declSites(text), line, character);
  if (!declared) return undefined;
  return { field: declared.kind === 'Crew' ? 'crewRef' : 'promptRefs', name: declared.name };
}
