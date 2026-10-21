import { dump, load } from 'js-yaml';
import { abilityOfLabel, CAPABILITY_PREFIX, isSize, LEGACY_LATENCY_LABEL, SIZE_LABEL, sizeOfLatencyClass, type Size } from '../crew/sizes';
import { DEFAULT_ARCHETYPE } from '../crew/related';
import { objectOf, specOf, text } from '../crew/values';
import type { Manifest } from './manifests';
import { blockEnd, documentsOf, editLines, findKey, indentOf, isContent, isHelmLine, isKind, valueOf, type Span } from './yamlLines';

/**
 * A crew's scheduling needs for one discussion phase, as its CrewSchedulingPolicy states
 * them: the abilities a model must have, the size it would rather have, and how much it
 * favors the model the cluster measured faster. The cluster's model catalog supplies the
 * models; the crew names none.
 */
export interface PhaseNeeds {
  /** Required abilities: each a `capability/<name>: "true"` label in the rule's require. */
  capabilities: string[];
  /** The preferred size class: a weighted prefer term on `kubemoot.ai/size`. */
  size?: Size;
  /** 0 to 100 points for the model measured faster; 0 turns it off. */
  preferFaster: number;
}

type Rule = Record<string, unknown>;

/** The phases whose models consent-3 schedules: the specialists' mulling, and their quick triage. */
const CONSENT_PHASES = ['mulling', 'triage'];

/** The weight a size preference gets when the rule has none to keep. */
const SIZE_WEIGHT = 100;

/** A policy's rules, as objects. */
export const rulesOf = (policy: Manifest): Rule[] => (Array.isArray(specOf(policy).rules) ? (specOf(policy).rules as unknown[]).map(objectOf) : []);

/** The phases a needs edit offers: those the rules name, then the ones the default archetype schedules models for. */
export function phasesOf(policy: Manifest): string[] {
  const named = rulesOf(policy)
    .map((r) => text(r.phase))
    .filter((p): p is string => p !== undefined);
  const archetype = text(specOf(policy).archetypeRef) ?? DEFAULT_ARCHETYPE;
  return [...new Set([...named, ...(archetype === DEFAULT_ARCHETYPE ? CONSENT_PHASES : [])])];
}

/** The rule for a phase, if the policy has one. */
export const ruleFor = (policy: Manifest, phase: string): Rule | undefined => rulesOf(policy).find((r) => r.phase === phase);

const matchLabelsOf = (rule: Rule): Record<string, unknown> => objectOf(objectOf(rule.require).matchLabels);

/** A prefer term that says only "this size": one label, kubemoot.ai/size or the retired latencyClass, and nothing else. */
function isSizeTerm(term: unknown): boolean {
  const t = objectOf(term);
  const selector = objectOf(t.selector);
  const keys = Object.keys(objectOf(selector.matchLabels));
  const expressions = Array.isArray(t.expressions) ? t.expressions.length : 0;
  return Object.keys(selector).length === 1 && keys.length === 1 && [SIZE_LABEL, LEGACY_LATENCY_LABEL].includes(keys[0]) && expressions === 0;
}

/** The size a size term prefers; the retired latencyClass read as the size it stood for. */
function sizeOfTerm(term: unknown): Size | undefined {
  const labels = objectOf(objectOf(objectOf(term).selector).matchLabels);
  const size = labels[SIZE_LABEL];
  return isSize(size) ? size : sizeOfLatencyClass(labels[LEGACY_LATENCY_LABEL]);
}

const preferOf = (rule: Rule): unknown[] => (Array.isArray(rule.prefer) ? rule.prefer : []);

/** What a rule states about the needs a needs edit changes; no rule states none. */
export function needsOf(rule: Rule | undefined): PhaseNeeds {
  if (!rule) return { capabilities: [], preferFaster: 0 };
  const capabilities = Object.entries(matchLabelsOf(rule))
    .map(([k, v]) => abilityOfLabel(k, v))
    .filter((a): a is string => a !== undefined);
  const term = preferOf(rule).find(isSizeTerm);
  const faster = typeof rule.preferFaster === 'number' ? rule.preferFaster : 0;
  return { capabilities, size: term === undefined ? undefined : sizeOfTerm(term), preferFaster: faster };
}

/** The needs in a few words, for the list of phases. */
export function describeNeeds(needs: PhaseNeeds): string {
  const parts = [
    needs.capabilities.length ? `requires ${needs.capabilities.join(', ')}` : undefined,
    needs.size && `prefers ${needs.size}`,
    needs.preferFaster > 0 ? `preferFaster ${needs.preferFaster}` : undefined,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'states no needs';
}

/** Sets a field, or removes it when there is nothing to say; a field already there keeps its place. */
function setOrDrop(rule: Rule, key: string, value: unknown): void {
  if (value === undefined) delete rule[key];
  else rule[key] = value;
}

/** The rule's require with these abilities as its capability labels; every other part of it as it was. */
function requireWith(require: unknown, capabilities: string[]): Record<string, unknown> | undefined {
  const out = { ...objectOf(require) };
  const kept = Object.entries(objectOf(out.matchLabels)).filter(([k, v]) => abilityOfLabel(k, v) === undefined);
  const labels = Object.fromEntries([...kept, ...capabilities.map((c) => [`${CAPABILITY_PREFIX}${c}`, 'true'])]);
  setOrDrop(out, 'matchLabels', Object.keys(labels).length ? labels : undefined);
  return Object.keys(out).length ? out : undefined;
}

/** The rule's prefer list with this size as its one size term, where the old one stood and with its weight; the other terms as they were. */
function preferWith(prefer: unknown[], size: Size | undefined): unknown[] | undefined {
  const at = prefer.findIndex(isSizeTerm);
  const out = prefer.filter((t) => !isSizeTerm(t));
  if (size) {
    const weight = at < 0 ? SIZE_WEIGHT : (objectOf(prefer[at]).weight ?? SIZE_WEIGHT);
    out.splice(at < 0 ? out.length : at, 0, { weight, selector: { matchLabels: { [SIZE_LABEL]: size } } });
  }
  return out.length ? out : undefined;
}

/** A rule that states these needs; what else it says (other labels, expressions, preferences) stays. */
export function withNeeds(rule: Rule, needs: PhaseNeeds): Rule {
  const out: Rule = { ...rule };
  setOrDrop(out, 'require', requireWith(rule.require, needs.capabilities));
  setOrDrop(out, 'prefer', preferWith(preferOf(rule), needs.size));
  setOrDrop(out, 'preferFaster', needs.preferFaster > 0 ? needs.preferFaster : undefined);
  return out;
}

/** The new text and the line the phase's rule starts on, or why the file is left to a person. */
export type NeedsEdit = { text: string; line: number } | { refuse: string };

/** Why a file is left to a person, as the edit reports it. */
class Refusal extends Error {}

const pad = (n: number) => ' '.repeat(n);

/** The document that holds the policy: the one around `at` when it is a CrewSchedulingPolicy, else the first that is. */
function policyDocument(lines: string[], at: number): Span {
  const docs = documentsOf(lines).filter((d) => isKind(lines, d, 'CrewSchedulingPolicy'));
  const doc = docs.find((d) => at >= d.start && at < d.end) ?? docs[0];
  if (!doc) throw new Refusal('the file no longer holds a CrewSchedulingPolicy; refresh Crew Sources');
  return doc;
}

/** Where the rules list is: its `rules:` line, its items' lines, their indent, and the file's indent step. */
interface RulesBlock {
  /** The `rules:` line, or -1 when the spec has none and one is added at `end`. */
  key: number;
  end: number;
  itemIndent: number;
  /** How far the file indents a mapping under its key, as the spec's keys sit under `spec:`. */
  step: number;
  /** Where each item starts. */
  items: number[];
  /** The `rules:` line as it should read, when it changes (from `rules: []`). */
  keyLine?: string;
}

/** The spec of the policy, which must be a block mapping that no Helm action wraps a part of. */
function specSpan(lines: string[], doc: Span): Span {
  const spec = findKey(lines, doc, 0, 'spec');
  if (spec < 0 || valueOf(lines[spec], 0, 'spec') !== '') throw new Refusal('its spec is not a block mapping');
  const end = blockEnd(lines, spec, 0, doc.end);
  if (lines.slice(spec + 1, end).some(isHelmLine) || lines.slice(end, nextTopLevel(lines, end, doc.end)).some((l) => isHelmLine(l) && indentOf(l) > 0)) {
    throw new Refusal('Helm actions wrap parts of its spec; change it in the chart by hand');
  }
  return { start: spec + 1, end };
}

/** The first line at or after `from` that is a top-level key, or `limit`: what follows a block, such as an indented {{- toYaml }} that writes into it, ends there. */
function nextTopLevel(lines: string[], from: number, limit: number): number {
  for (let i = from; i < limit; i++) if (isContent(lines[i]) && indentOf(lines[i]) === 0) return i;
  return limit;
}

/** The spec's rules list. */
function rulesBlock(lines: string[], doc: Span): RulesBlock {
  const spec = specSpan(lines, doc);
  const first = lines.findIndex((l, i) => i >= spec.start && i < spec.end && isContent(l));
  const step = first < 0 ? 2 : Math.max(2, indentOf(lines[first]));
  const key = findKey(lines, spec, step, 'rules');
  if (key < 0) return { key: -1, end: spec.end, itemIndent: 2 * step, step, items: [] };
  const form = rulesForm(valueOf(lines[key], step, 'rules') ?? '');
  if (form === 'flow') throw new Refusal('its rules are written as a flow list');
  if (form === 'empty') return { key, end: key + 1, itemIndent: 2 * step, step, items: [], keyLine: `${pad(step)}rules:` };
  const end = blockEnd(lines, key, step, spec.end);
  const itemIndent = itemIndentIn(lines, key, end);
  return { key, end, itemIndent, step, items: itemStarts(lines, { start: key + 1, end }, itemIndent) };
}

/** The lines in a span where a list item at this indent starts. */
function itemStarts(lines: string[], span: Span, indent: number): number[] {
  const starts: number[] = [];
  for (let i = span.start; i < span.end; i++) if (isContent(lines[i]) && indentOf(lines[i]) === indent && lines[i].trimStart().startsWith('-')) starts.push(i);
  return starts;
}

/** How the value after `rules:` holds the list: below it, as an empty flow list, or as a flow list with items. */
function rulesForm(value: string): 'block' | 'empty' | 'flow' {
  const hash = value.indexOf('#');
  const bare = (hash < 0 ? value : value.slice(0, hash)).trim();
  if (bare === '') return 'block';
  return bare === '[]' ? 'empty' : 'flow';
}

/** The indent of the first item under the `rules:` line, or two deeper than it when there is none. */
function itemIndentIn(lines: string[], key: number, end: number): number {
  const first = lines.findIndex((l, i) => i > key && i < end && isContent(l));
  return first < 0 ? indentOf(lines[key]) + 2 : indentOf(lines[first]);
}

/** One item of the rules list: its lines without the comments that lead the next one, the comments inside it, and the rule it holds. */
interface Item extends Span {
  rule: Rule;
  comments: string[];
}

const isComment = (line: string) => line.trimStart().startsWith('#');

/** The items of the rules list, parsed. */
function itemsOf(lines: string[], block: RulesBlock): Item[] {
  if (lines.slice(block.key + 1, block.end).some((l) => l.includes('{{'))) throw new Refusal('its rules hold template actions; change them in the chart by hand');
  return block.items.map((start, n) => {
    let end = block.items[n + 1] ?? block.end;
    while (end > start + 1 && !isContent(lines[end - 1])) end--;
    const body = lines.slice(start, end);
    const rule = parseItem(body, block.itemIndent);
    if (!rule) throw new Refusal(`the rule on line ${start + 1} is not one CrewForge can read`);
    return { start, end, rule, comments: body.filter(isComment).map((c) => pad(block.itemIndent) + c.trimStart()) };
  });
}

/** The rule one list item holds, read as YAML with the item's indent taken off; undefined when it is not one rule. */
function parseItem(lines: string[], indent: number): Rule | undefined {
  try {
    const value = load(lines.map((l) => l.slice(Math.min(indent, indentOf(l)))).join('\n'));
    return Array.isArray(value) && value.length === 1 ? objectOf(value[0]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A rule as list-item lines at the items' indent. Inside the rule the keys nest by two
 * spaces whatever the file's own step is: js-yaml widens "- " to its indent, which no
 * hand-written file does, so a file that nests by four reads two inside the edited rule.
 */
const ruleLines = (rule: Rule, indent: number): string[] =>
  dump([rule], { lineWidth: -1, quoteStyle: 'double' })
    .trimEnd()
    .split('\n')
    .map((l) => pad(indent) + l);

/** The lines with the phase's rule rewritten, or added at the end of the rules; and the line the rule starts on. */
function editRules(lines: string[], at: number, phase: string, needs: PhaseNeeds): { lines: string[]; line: number } {
  const block = rulesBlock(lines, policyDocument(lines, at));
  const item = itemsOf(lines, block).find((i) => i.rule.phase === phase);
  const rule = ruleLines(withNeeds(item?.rule ?? { phase }, needs), block.itemIndent);
  const out = [...lines];
  if (item) {
    out.splice(item.start, item.end - item.start, ...item.comments, ...rule);
    return { lines: out, line: item.start + item.comments.length };
  }
  const header = block.key < 0 ? [`${pad(block.step)}rules:`] : [];
  out.splice(block.end, 0, ...header, ...rule);
  if (block.keyLine) out[block.key] = block.keyLine;
  return { lines: out, line: block.end + header.length };
}

/**
 * Writes a phase's needs into the text of the file that holds the crew's
 * CrewSchedulingPolicy, line by line, so the rest of the file (comments, other rules,
 * Helm actions outside the spec) stays as it is. The phase's rule is rewritten, keeping
 * what it says beside these needs, or added at the end of the rules. A comment on a line
 * of its own inside that rule moves above it; a comment at the end of one of its lines is
 * not kept. `at` is the line the policy starts on. A policy whose spec a Helm action
 * wraps, whose rules a template writes, or whose rules are a flow list is left to a person.
 */
export function setPhaseNeeds(source: string, at: number, phase: string, needs: PhaseNeeds): NeedsEdit {
  let line = 0;
  try {
    const text = editLines(source, (lines) => {
      const edited = editRules(lines, at, phase, needs);
      line = edited.line;
      return edited.lines;
    });
    return { text: text ?? source, line };
  } catch (err) {
    if (err instanceof Refusal) return { refuse: err.message };
    throw err;
  }
}
