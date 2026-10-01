import { namesOf, specOf } from '../crew/values';
import type { Manifest } from './manifests';
import { kubemootObjects } from './positions';

/** How removing an object changes its file: the whole file to the trash, a new text without its document, or a refusal that says why. */
export type RemovalPlan = { trash: true } | { trash: false; text: string } | { refuse: string };

const OPENS = /\{\{-?\s*(?:if|range|with|define|block)\b/g;
const ENDS = /\{\{-?\s*end\b/g;

/** A document of a multi-document file: its lines, from start (inclusive) to end (exclusive). */
interface Segment {
  start: number;
  end: number;
}

function segmentsOf(lines: string[]): Segment[] {
  const segments: Segment[] = [];
  let start = 0;
  lines.forEach((l, i) => {
    if (!l.startsWith('---')) return;
    segments.push({ start, end: i });
    start = i + 1;
  });
  segments.push({ start, end: lines.length });
  return segments;
}

/** Whether a document says anything: a line that is not blank, a comment, or a template comment. */
const hasContent = (lines: string[]): boolean => lines.some((l) => l.trim() !== '' && !l.trim().startsWith('#') && !/^\{\{-?\s*\/\*.*\*\/\s*-?\}\}$/.test(l.trim()));

/** Whether a document's template blocks close inside it, so it can be taken out whole. */
const balanced = (text: string): boolean => (text.match(OPENS) ?? []).length === (text.match(ENDS) ?? []).length;

/**
 * Plans removing the document of `kind` `name` from a YAML or template file. A file that
 * holds only that object goes to the trash. An object whose name a template makes, or
 * whose document opens or closes a template block it shares with others, is refused: only
 * a person can say what removing it means.
 */
export function removalPlan(text: string, kind: string, name: string): RemovalPlan {
  const lines = text.split('\n');
  const segments = segmentsOf(lines);
  const body = (s: Segment) => lines.slice(s.start, s.end);
  const index = segments.findIndex((s) => kubemootObjects(body(s).join('\n')).some((p) => p.kind === kind && p.name === name));
  if (index < 0) return { refuse: missingReason(text, kind, name) };
  const target = segments[index];
  if (!balanced(body(target).join('\n'))) return { refuse: `${kind} ${name} sits inside a template block it shares with other objects; remove it by hand.` };
  const others = segments.filter((s, i) => i !== index && hasContent(body(s)));
  if (others.length === 0) return { trash: true };
  // Take the separator before the document with it, or the one after for the first document.
  const from = index > 0 ? target.start - 1 : target.start;
  const to = index > 0 ? target.end : target.end + 1;
  return { trash: false, text: [...lines.slice(0, from), ...lines.slice(to)].join('\n') };
}


const has = (value: unknown, name: string): boolean => Array.isArray(value) && value.includes(name);

/** Why an object is not found in its file: a template makes its name, or the file no longer holds it. */
function missingReason(text: string, kind: string, name: string): string {
  const templated = kubemootObjects(text).some((p) => p.kind === kind && p.name === undefined);
  return templated ? `a template makes ${kind} ${name} (its name is not written in the file); remove it from the chart's values or by hand.` : `the file no longer holds ${kind} ${name}; refresh Crew Sources.`;
}

/** For each kind, how another object names one of it. */
const REFERENCES: Record<string, (m: Manifest, name: string) => boolean> = {
  PromptModule: (m, name) => m.kind === 'Agent' && has(specOf(m).promptRefs, name),
  MCPServer: (m, name) => namesOf(specOf(m).mcpServers).includes(name),
  RAGSource: (m, name) => namesOf(specOf(m).ragSources).includes(name),
  EmbeddingModel: (m, name) => m.kind === 'RAGSource' && specOf(m).embeddingModelRef === name,
  MCPQualityPolicy: (m, name) => specOf(m).qualityPolicyRef === name,
  MCPCatalog: (m, name) => m.kind === 'MCPGateway' && has(specOf(m).catalogRefs, name),
};

/** The objects of a source that name `kind` `name`, as "Agent k8s", so removing it can say what still points at it. */
export function referrersOf(objects: Manifest[], kind: string, name: string): string[] {
  const refers = REFERENCES[kind];
  return refers ? objects.filter((m) => refers(m, name)).map((m) => `${m.kind} ${m.metadata.name}`) : [];
}
