import { readZip } from './zip';

/** One fact of a crew's memory, as the OMPI export carries it. */
export interface MemoryFact {
  topic: string;
  key: string;
  value: string;
  /** The role (agent) that learned it; empty when the export records no writer. */
  learnedBy: string;
  /** When the crew learned it (ISO 8601). */
  learnedAt: string;
  /** The discussion thread it was learned in, when the export names one. */
  thread: string;
}

/** What the export says about itself. */
export interface ExportManifest {
  protocolVersion: string;
  exportedAt: string;
  /** "snapshot" when every fact was exported, "selection" when some were left out. */
  selection: string;
  skipped: number;
}

export interface ParsedExport {
  manifest: ExportManifest;
  facts: MemoryFact[];
}

const MANIFEST = 'manifest.json';
const MEMORIES = 'memories/';

type Json = Record<string, unknown>;

function object(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseJson(file: string, data: Buffer): Json {
  try {
    return object(JSON.parse(data.toString('utf8')));
  } catch {
    throw new Error(`The file ${file} in the memory export is not valid JSON.`);
  }
}

function manifestOf(data: Buffer): ExportManifest {
  const m = parseJson(MANIFEST, data);
  const ext = object(m['x-kubemoot']);
  return {
    protocolVersion: text(m.protocol_version),
    exportedAt: text(m.exported_at),
    selection: text(m.selection),
    skipped: typeof ext.skipped === 'number' ? ext.skipped : 0,
  };
}

/** The writer: the first provenance entry that names an id. */
function writerOf(memory: Json): string {
  const provenance = Array.isArray(memory.provenance) ? memory.provenance : [];
  for (const entry of provenance) {
    const id = text(object(entry).id);
    if (id) return id;
  }
  return '';
}

function factOf(file: string, data: Buffer): MemoryFact {
  const memory = parseJson(file, data);
  const ext = object(memory['x-kubemoot']);
  const topic = text(ext.topic);
  const key = text(ext.key);
  if (!topic && !key) throw new Error(`The file ${file} in the memory export names no topic or key.`);
  return {
    topic,
    key,
    value: text(memory.body),
    learnedBy: writerOf(memory),
    learnedAt: text(memory.created_at),
    thread: text(ext.learnedInThread),
  };
}

/** Reads the zip a crew's memory export is: a manifest and one memory object per fact under memories/. */
export function parseExport(zip: Buffer): ParsedExport {
  const files = readZip(zip);
  const manifest = files.get(MANIFEST);
  if (!manifest) throw new Error('The memory export has no manifest.json, so it is not an OMPI export.');
  const facts = [...files.entries()].filter(([name]) => name.startsWith(MEMORIES) && name.endsWith('.json')).map(([name, data]) => factOf(name, data));
  return { manifest: manifestOf(manifest), facts };
}

/** One entry the export left out. Only the reason is kept: the key can be an opaque id, and the fact's text is never in the report. */
export interface LeftOutEntry {
  key: string;
  reason: string;
}

export interface SelectionReport {
  memories: number;
  leftOut: LeftOutEntry[];
}

/** Reads the selection report (`report=true`); null when the body is not one. */
export function parseReport(body: string): SelectionReport | null {
  let data: Json;
  try {
    data = object(JSON.parse(body));
  } catch {
    return null;
  }
  if (typeof data.memories !== 'number' || !Array.isArray(data.leftOut)) return null;
  const leftOut = data.leftOut.map((e) => object(e)).filter((e) => typeof e.reason === 'string').map((e) => ({ key: text(e.key), reason: text(e.reason) }));
  return { memories: data.memories, leftOut };
}

/** The left-out entries as reasons with counts, most frequent first. The entries' keys are not carried. */
export function leftOutByReason(report: SelectionReport | undefined): { reason: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const e of report?.leftOut ?? []) counts.set(e.reason, (counts.get(e.reason) ?? 0) + 1);
  return [...counts.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

export interface TopicGroup {
  topic: string;
  facts: MemoryFact[];
}

/** Facts grouped by topic, topics and keys in name order. */
export function groupByTopic(facts: MemoryFact[]): TopicGroup[] {
  const groups = new Map<string, MemoryFact[]>();
  for (const f of facts) groups.set(f.topic, [...(groups.get(f.topic) ?? []), f]);
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([topic, list]) => ({ topic, facts: [...list].sort((a, b) => a.key.localeCompare(b.key)) }));
}
