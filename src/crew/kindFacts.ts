import { byCodeUnits } from '../text';
import { abilityOfLabel, LEGACY_LATENCY_LABEL, SIZE_LABEL, sizeClassFor } from './sizes';
import { objectOf, strings, text } from './values';
import type { Obj, Related } from './related';

/** What a tree shows for one related object: a short line, the hover lines, an icon, and its readiness when the object says. */
export interface KindFacts {
  description: string;
  lines: string[];
  icon: string;
  ready?: boolean;
}

type Spec = Record<string, unknown>;

const num = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const obj = objectOf;
/** The parts that say something, joined by a middle dot. */
const line = (...parts: (string | undefined | false)[]): string => parts.filter(Boolean).join(' · ');
/** A string, number, or boolean as text; anything else (absent, or a structure) as undefined. */
const scalar = (value: unknown): string | undefined => (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined);
/** "1 agent", "2 agents". */
const count = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
/** "label: value" when there is a value. */
const fact = (label: string, value: unknown): string | undefined => {
  const shown = scalar(value);
  return shown === undefined || shown === '' ? undefined : `${label}: ${shown}`;
};

function readyOf(o: Obj): boolean | undefined {
  const ready = o.status?.ready;
  if (typeof ready === 'boolean') return ready;
  const condition = list(o.status?.conditions).map(obj).find((c) => c.type === 'Ready');
  return condition ? condition.status === 'True' : undefined;
}

/** The abilities of a Model: its capability labels, as the scheduler's selectors read them, and its spec.capabilities. */
export function modelCapabilities(o: Obj): string[] {
  const labeled = Object.entries(o.metadata.labels ?? {})
    .map(([k, v]) => abilityOfLabel(k, v))
    .filter((a): a is string => a !== undefined);
  return [...new Set([...labeled, ...strings(o.spec?.capabilities)])].sort(byCodeUnits);
}

/** A Model's context length: its spec override, else what the server reported, else its contextWindow label. */
export function contextLength(o: Obj): string | undefined {
  const value = num(o.spec?.contextLength) ?? num(obj(o.status?.modelInfo).contextLength) ?? o.metadata.labels?.contextWindow;
  return value === undefined ? undefined : String(value);
}

/** A crew-local Model's size class: its kubemoot.ai/size label, else derived from spec.parameters. */
export function modelSize(o: Obj): string | undefined {
  const label = o.metadata.labels?.[SIZE_LABEL];
  const parameters = text(o.spec?.parameters);
  if (label) return label;
  return parameters === undefined ? undefined : sizeClassFor(parameters);
}

/** How a Model's size reads in its one-line description: its class, else its retired latencyClass marked so. */
function sizeWord(size: string | undefined, legacy: string | undefined): string | undefined {
  if (size) return size;
  return legacy && `latencyClass ${legacy} (retired)`;
}

function model(o: Obj): KindFacts {
  const legacy = o.metadata.labels?.[LEGACY_LATENCY_LABEL];
  const size = modelSize(o);
  const caps = modelCapabilities(o);
  const ctx = contextLength(o);
  return {
    description: line(text(o.spec?.model), sizeWord(size, legacy), ctx && `${ctx} context`),
    lines: [
      fact('Model', o.spec?.model),
      fact('Server', o.spec?.serverRef),
      fact('Parameters', o.spec?.parameters),
      fact('Size', size),
      fact('latencyClass (retired; use size)', legacy),
      fact('Capabilities', caps.join(', ') || 'none labeled'),
      fact('Context length', ctx),
      fact('VRAM (MiB)', o.spec?.vramMib),
      fact('State', o.status?.state),
    ].filter((l): l is string => l !== undefined),
    icon: 'chip',
    ready: readyOf(o),
  };
}

/** One entry of a ModelServer's part of the model catalog, as a line: name, size, abilities, and whether the server has it. */
function catalogEntry(entry: unknown): string | undefined {
  const e = obj(entry);
  const name = text(e.name);
  if (!name) return undefined;
  return line(name, text(e.size) ?? 'size unknown', strings(e.capabilities).join(', '), e.present === false && 'not on the server yet');
}

/** A ModelServer's part of the model catalog (status.models), one line per model. */
export function catalogOf(o: Obj): string[] {
  return list(o.status?.models).map(catalogEntry).filter(defined);
}

function server(o: Obj): KindFacts {
  const scheduling = obj(o.spec?.scheduling);
  const catalog = catalogOf(o);
  return {
    description: line(text(o.spec?.type), text(o.spec?.endpoint), catalog.length > 0 && count(catalog.length, 'model')),
    lines: [
      fact('Type', o.spec?.type),
      fact('Endpoint', o.spec?.endpoint),
      fact('Weight', scheduling.weight),
      fact('Memory budget (MiB)', scheduling.memoryMiB),
      fact('Phase', o.status?.phase),
      ...(catalog.length > 0 ? ['Model catalog:', ...catalog.map((c) => `  ${c}`)] : []),
    ].filter(defined),
    icon: 'server',
    ready: readyOf(o),
  };
}

function embeddingModel(o: Obj): KindFacts {
  const dims = scalar(o.spec?.dimensions);
  return {
    description: line(text(o.spec?.model), dims !== undefined && `${dims} dimensions`),
    lines: [fact('Model', o.spec?.model), fact('Server', o.spec?.serverRef), fact('Dimensions', dims), fact('Batch size', o.spec?.batchSize), fact('State', o.status?.state)].filter(defined),
    icon: 'symbol-array',
    ready: readyOf(o),
  };
}

/** Where each RAGSource source type takes its documents from, by the field that holds that type's settings. */
const SOURCE_FIELDS: Record<string, [string, (s: Spec) => string | undefined]> = {
  git: ['git', (s) => line(text(s.url), text(s.branch), strings(s.paths).join(', '))],
  s3: ['s3', (s) => line(text(s.bucket), text(s.prefix))],
  url: ['url', (s) => strings(s.urls).join(', ')],
  document: ['document', (s) => strings(s.urls).join(', ')],
  'nats-kv': ['natsKV', (s) => line(text(s.bucket), text(s.key))],
  'mcp-registry': ['mcpRegistry', (s) => text(s.url)],
};

/** What a RAGSource indexes, in a few words: its source type and where the documents come from. */
export function indexes(spec: Spec | undefined): string {
  const source = obj(spec?.source);
  const type = text(source.type) ?? 'unknown source';
  const field = SOURCE_FIELDS[type];
  const where = field?.[1](obj(source[field[0]]));
  return where ? `${type}: ${where}` : type;
}

/** "512 characters, 50 overlap": how a RAGSource chunks its documents, with the CRD defaults where it sets none. */
export function chunkingText(spec: Spec | undefined): string {
  const chunking = obj(spec?.chunking);
  return `${scalar(chunking.chunkSize) ?? '512'} characters, ${scalar(chunking.chunkOverlap) ?? '50'} overlap`;
}

function ragSource(o: Obj): KindFacts {
  const stats = obj(o.status?.indexingStats);
  const last = text(stats.lastIndexed);
  const store = obj(o.spec?.vectorStore);
  return {
    description: line(indexes(o.spec), last ? `indexed ${last}` : 'not indexed yet'),
    lines: [
      `Indexes ${indexes(o.spec)}`,
      `Chunking: ${chunkingText(o.spec)}`,
      fact('Embedding model', o.spec?.embeddingModelRef),
      fact('Vector store', line(text(store.type), text(store.collection))),
      `Last indexed: ${last ?? 'not yet'}`,
      fact('Documents', stats.documentCount),
      fact('Phase', o.status?.phase),
    ].filter(defined),
    icon: 'book',
    ready: readyOf(o),
  };
}

function gateway(o: Obj): KindFacts {
  const servers = strings(o.status?.mcpServers);
  const implementation = text(o.spec?.implementation) ?? 'kubemoot';
  return {
    description: line(implementation, servers.length > 0 && count(servers.length, 'server')),
    lines: [
      "Routes the agents' tool calls to the MCP servers it registers.",
      fact('Implementation', implementation),
      fact('Port', gatewayPort(o)),
      fact('Servers', servers.join(', ')),
      fact('Quality policy', o.spec?.qualityPolicyRef),
      fact('Catalogs', strings(o.spec?.catalogRefs).join(', ')),
    ].filter(defined),
    icon: 'debug-disconnect',
    ready: readyOf(o),
  };
}

/** The port of a gateway's Service: its spec.port, else the CRD default. */
export function gatewayPort(o: Obj): number {
  return num(o.spec?.port) || 8080;
}

function qualityPolicy(o: Obj): KindFacts {
  const considering = obj(o.spec?.considering);
  const ai = considering.enabled === false ? 'off' : 'on';
  return {
    description: line(`${list(o.spec?.allowing).length} allowed`, `${list(o.spec?.blocking).length} blocked`, `AI review ${ai}`),
    lines: [
      'Governs which discovered MCP servers a gateway admits: allowed, blocked, tested, then judged by an agent.',
      `Allowing: ${list(o.spec?.allowing).length}, blocking: ${list(o.spec?.blocking).length}`,
      fact('AI review', ai),
      fact('Evaluator agent', considering.agentRef),
    ].filter(defined),
    icon: 'shield',
  };
}

function catalog(o: Obj): KindFacts {
  return {
    description: line(text(o.spec?.type), text(o.spec?.url)),
    lines: ['Discovers MCP servers for a gateway to consider.', fact('Type', o.spec?.type), fact('URL', o.spec?.url), fact('Queries', strings(o.spec?.queries).join(', ')), fact('Sync interval', o.spec?.syncInterval)].filter(defined),
    icon: 'library',
  };
}

function report(o: Obj): KindFacts {
  return {
    description: line(text(o.status?.verdict) ?? 'untested', text(o.spec?.serverName)),
    lines: ["The operator's trial record of an MCP server.", fact('Server', o.spec?.serverName), fact('Verdict', o.status?.verdict), fact('Pinned verdict', o.spec?.adminVerdict)].filter(defined),
    icon: 'checklist',
  };
}

function schedulingPolicy(o: Obj): KindFacts {
  const phases = list(o.spec?.rules).map((r) => text(obj(r).phase)).filter(defined);
  const bias = Object.entries(obj(o.spec?.qualityBias)).map(([k, v]) => `${k} ${scalar(v) ?? ''}`);
  const error = text(obj(o.status).validationError);
  return {
    description: line(`rules for ${phases.join(', ') || 'no phases'}`, error && 'invalid'),
    lines: [
      'Governs which Model each discussion phase runs on: required and preferred Model labels, and the speed or quality lean per capability.',
      fact('Archetype', o.spec?.archetypeRef ?? 'consent-3'),
      fact('Phases with rules', phases.join(', ')),
      fact('Quality bias', bias.join(', ')),
      fact('Validation error', error),
    ].filter(defined),
    icon: 'law',
    ready: error ? false : undefined,
  };
}

function archetype(o: Obj): KindFacts {
  const phases = list(o.spec?.phases).map((p) => text(obj(p).name)).filter(defined);
  return {
    description: phases.join(', '),
    lines: ['Governs how the coordinator runs a discussion: its phases and their order.', fact('Phases', phases.join(', ')), text(o.spec?.description)].filter(defined),
    icon: 'workflow',
  };
}

/** The host of a webhook URL; the rest of it may hold a secret topic or token. */
export function hostOf(url: unknown): string | undefined {
  try {
    return new URL(typeof url === 'string' ? url : '').host || undefined;
  } catch {
    return undefined;
  }
}

function sink(o: Obj): KindFacts {
  const webhook = obj(o.spec?.webhook);
  const agents = strings(o.spec?.agents);
  const channels = strings(o.spec?.channels);
  return {
    description: line(hostOf(webhook.url), agents.length ? count(agents.length, 'agent') : 'every agent'),
    lines: [
      'Governs where concern signals go: a webhook fired when an agent raises a concern.',
      fact('Webhook host', hostOf(webhook.url)),
      `Agents: ${agents.join(', ') || 'any'}`,
      `Channels: ${channels.join(', ') || 'any'}`,
      fact('Priority', o.spec?.priority),
      fact('Last fired', o.status?.lastFiredAt),
    ].filter(defined),
    icon: 'bell',
    ready: readyOf(o),
  };
}

function suite(o: Obj): KindFacts {
  const scripts = list(o.spec?.scripts).length;
  return {
    description: line(`${count(scripts, 'scenario')}, ${scalar(o.spec?.iterations) ?? '1'} each`, text(o.status?.phase)),
    lines: [text(o.spec?.description), `Scenarios: ${scripts}`, fact('Iterations', o.spec?.iterations), fact('Phase', o.status?.phase)].filter(defined),
    icon: 'beaker',
  };
}

function fitness(o: Obj): KindFacts {
  return {
    description: line(text(o.spec?.testRef), text(o.status?.phase)),
    lines: [fact('Scenario', o.spec?.testRef), fact('Phase', o.status?.phase)].filter(defined),
    icon: 'beaker',
  };
}

function config(o: Obj): KindFacts {
  return {
    description: 'operator defaults',
    lines: ['The images and defaults the operator gives every crew.', fact('Ready', o.status?.ready)].filter(defined),
    icon: 'settings-gear',
  };
}

const FACTS: Record<string, (o: Obj) => KindFacts> = {
  Model: model,
  ModelServer: server,
  EmbeddingModel: embeddingModel,
  RAGSource: ragSource,
  MCPGateway: gateway,
  MCPQualityPolicy: qualityPolicy,
  MCPCatalog: catalog,
  MCPServerReport: report,
  CrewSchedulingPolicy: schedulingPolicy,
  MootArchetype: archetype,
  NotificationSink: sink,
  CrewFitnessSuite: suite,
  CrewFitness: fitness,
  KubemootConfig: config,
};

function defined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

/** What a tree shows for a related object; one that is missing says why. */
export function factsOf(r: Related): KindFacts {
  if (!r.object) return { description: `${r.kind} · not found`, lines: [r.reason], icon: 'warning' };
  const describe = FACTS[r.kind];
  return describe ? describe(r.object) : { description: r.kind, lines: [], icon: 'symbol-misc' };
}
