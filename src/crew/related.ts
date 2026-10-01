import { byCodeUnits } from '../text';
import { SUITE_LABEL } from '../fitness/fitness';
import { isOwned } from '../source/live';
import { namesOf, strings, text } from './values';
import type { Manifest } from '../source/manifests';

/** The label the operator reads to find a crew's Agents and Skills. */
export const CREW_LABEL = 'kubemoot.ai/crew';
const INSTANCE_LABEL = 'app.kubernetes.io/instance';

/** The archetype a CrewSchedulingPolicy runs when it names none (the CRD default). */
export const DEFAULT_ARCHETYPE = 'consent-3';

/** The namespace the operator looks in for a ModelProvider after the crew's own. */
export const SYSTEM_NAMESPACE = 'kubemoot';

export type Obj = Manifest & { spec?: Record<string, unknown>; status?: Record<string, unknown> };

/** The groups of objects a crew uses beyond its Agents, PromptModules, Skills, MCPServers, and tools. */
export type RelatedGroup = 'models' | 'rag' | 'mcp' | 'policies' | 'notifications' | 'fitness' | 'operator';

/** One Kubemoot object a crew declares or uses, and why it is listed. */
export interface Related {
  kind: string;
  name: string;
  /** Absent for a cluster-scoped kind. */
  namespace?: string;
  /** Absent when something names it and it cannot be found (or read). */
  object?: Obj;
  /** Who owns it when it is not the crew's own, such as "namespace kubemoot"; absent for the crew's own objects. */
  sharedBy?: string;
  /** Why it is listed, in a few words. */
  reason: string;
}

export type RelatedGroups = Record<RelatedGroup, Related[]>;

/**
 * Where relations are looked up. `pool` holds every object of each kind that was read:
 * the crew's namespace (and the system namespace, for ModelProviders) for a live crew,
 * the rendered objects for a source. `own` says whether an object is the crew's own.
 * `missing` says why a named object is not there.
 */
export interface RelationInput {
  crew: string;
  namespace: string;
  agents: Obj[];
  skills: Obj[];
  /** The MCPServer names the crew uses, to find their reports. */
  servers: string[];
  pool: Map<string, Obj[]>;
  own: (o: Obj) => boolean;
  missing: (kind: string) => string;
}



/** Who owns an object that is not the crew's own: its crew, its Helm release, or where it lives. */
export function ownerOf(o: Obj): string {
  const labels = o.metadata.labels ?? {};
  if (labels[CREW_LABEL]) return `crew ${labels[CREW_LABEL]}`;
  if (labels[INSTANCE_LABEL]) return `release ${labels[INSTANCE_LABEL]}`;
  return o.metadata.namespace ? `namespace ${o.metadata.namespace}` : 'the cluster';
}

/**
 * Whether a live object is the crew's own: it carries the crew's label, or the label of
 * the crew's Helm release, and no controller made it.
 */
export function liveOwn(crew: Manifest): (o: Obj) => boolean {
  const release = crew.metadata.labels?.[INSTANCE_LABEL];
  return (o) => {
    if (isOwned(o)) return false;
    const labels = o.metadata.labels ?? {};
    return labels[CREW_LABEL] === crew.metadata.name || (release !== undefined && labels[INSTANCE_LABEL] === release);
  };
}

const byName = (a: Related, b: Related) => byCodeUnits(a.name, b.name);

/** A listed object, shared when it is not the crew's own. */
function found(o: Obj, input: RelationInput, reason: string): Related {
  const own = input.own(o) && o.metadata.namespace === input.namespace;
  return { kind: o.kind, name: o.metadata.name, namespace: o.metadata.namespace, object: o, sharedBy: own ? undefined : ownerOf(o), reason };
}

/** The objects of a kind that are named, then the crew's own others, each once; a name with no object is kept as missing. */
function collect(input: RelationInput, kind: string, named: Map<string, string>, ownReason: string, namespace = input.namespace): Related[] {
  const all = input.pool.get(kind) ?? [];
  const result = new Map<string, Related>();
  for (const [name, reason] of named) {
    const o = all.find((x) => x.metadata.name === name && (x.metadata.namespace === namespace || x.metadata.namespace === undefined));
    result.set(name, o ? found(o, input, reason) : { kind, name, namespace, reason: `${reason}; ${input.missing(kind)}` });
  }
  for (const o of all) if (!result.has(o.metadata.name) && input.own(o)) result.set(o.metadata.name, found(o, input, ownReason));
  return [...result.values()].sort(byName);
}

const named = (names: string[], reason: string) => new Map(names.map((n) => [n, reason]));

/**
 * The Models the scheduler may bind the crew's agents to (every Model in the namespace,
 * since it lists them there), then the ModelProviders they name, looked up in the crew's
 * namespace and then the system namespace, as the operator does.
 */
export function modelsOf(input: RelationInput): Related[] {
  const models = (input.pool.get('Model') ?? []).filter((m) => m.metadata.namespace === input.namespace);
  const modelItems = models.map((m) => found(m, input, input.own(m) ? 'declared for this crew' : 'in the namespace, so the scheduler may bind it')).sort(byName);
  const providerNames = [...new Set(models.map((m) => text(m.spec?.providerRef)).filter((p): p is string => p !== undefined))].sort(byCodeUnits);
  return [...modelItems, ...providerNames.map((name) => providerOf(input, name))];
}

function providerOf(input: RelationInput, name: string): Related {
  const all = input.pool.get('ModelProvider') ?? [];
  const reason = 'a Model runs on it';
  const o = [input.namespace, SYSTEM_NAMESPACE].map((ns) => all.find((p) => p.metadata.name === name && p.metadata.namespace === ns)).find(Boolean);
  if (o) return found(o, input, reason);
  return { kind: 'ModelProvider', name, reason: `${reason}; ${input.missing('ModelProvider')}`, sharedBy: 'the cluster' };
}

/** The RAGSources the agents and skills name or were matched to, and the crew's own; then the EmbeddingModels they embed with. */
export function ragOf(input: RelationInput): Related[] {
  const refs = new Map<string, string>();
  const add = (names: string[], reason: string) => {
    for (const n of names) if (!refs.has(n)) refs.set(n, reason);
  };
  for (const a of input.agents) add(namesOf(a.spec?.ragSources), `named by ${a.metadata.name}`);
  for (const a of input.agents) add(namesOf(a.status?.autoDiscoveredRAGSources), `matched to ${a.metadata.name} by its keywords`);
  for (const s of input.skills) add(namesOf(s.spec?.ragSources), `named by skill ${s.metadata.name}`);
  const sources = collect(input, 'RAGSource', refs, 'declared for this crew');
  const embedding = sources.map((s) => text(s.object?.spec?.embeddingModelRef)).filter((e): e is string => e !== undefined);
  return [...sources, ...collect(input, 'EmbeddingModel', named([...new Set(embedding)], 'a RAG source embeds with it'), 'declared for this crew')];
}

/**
 * The MCP infrastructure the crew's servers sit behind: the namespace's MCPGateways (the
 * agents use the first by name, as the operator wires them), the MCPQualityPolicies and
 * MCPCatalogs a gateway or catalog names, and the reports on the crew's servers.
 */
export function mcpInfraOf(input: RelationInput): Related[] {
  const gateways = (input.pool.get('MCPGateway') ?? []).filter((g) => g.metadata.namespace === input.namespace).sort((a, b) => byCodeUnits(a.metadata.name, b.metadata.name));
  const gatewayItems = gateways.map((g, i) => found(g, input, i === 0 ? "the agents' gateway" : 'another gateway in the namespace'));
  const catalogs = collect(input, 'MCPCatalog', named(gateways.flatMap((g) => strings(g.spec?.catalogRefs)), 'a gateway reads it'), 'declared for this crew');
  const policyRefs = [...gateways, ...catalogs.map((c) => c.object).filter((o): o is Obj => o !== undefined)].map((o) => text(o.spec?.qualityPolicyRef)).filter((p): p is string => p !== undefined);
  const policies = collect(input, 'MCPQualityPolicy', named([...new Set(policyRefs)], 'a gateway or catalog applies it'), 'declared for this crew');
  const servers = new Set(input.servers);
  const reports = (input.pool.get('MCPServerReport') ?? []).filter((r) => servers.has(text(r.spec?.serverName) ?? '')).map((r) => found(r, input, 'reports on a server the crew uses'));
  return [...gatewayItems, ...policies, ...catalogs, ...reports.sort(byName)];
}

/** The crew's CrewSchedulingPolicies (by crewRef), then the MootArchetypes they run. */
export function policiesOf(input: RelationInput): Related[] {
  const csps = (input.pool.get('CrewSchedulingPolicy') ?? []).filter((p) => p.spec?.crewRef === input.crew && p.metadata.namespace === input.namespace);
  const items = csps.map((p) => ({ ...found(p, input, 'its crewRef names this crew'), sharedBy: undefined })).sort(byName);
  const archetypes = [...new Set(csps.map((p) => text(p.spec?.archetypeRef) ?? DEFAULT_ARCHETYPE))].sort(byCodeUnits);
  return [...items, ...archetypes.map((name) => archetypeOf(input, name))];
}

function archetypeOf(input: RelationInput, name: string): Related {
  const o = (input.pool.get('MootArchetype') ?? []).find((a) => a.metadata.name === name);
  const reason = 'the scheduling policy runs it';
  return o ? { kind: 'MootArchetype', name, object: o, sharedBy: 'the cluster', reason } : { kind: 'MootArchetype', name, sharedBy: 'the cluster', reason: `${reason}; ${input.missing('MootArchetype')}` };
}

/** The NotificationSinks in the namespace that fire for the crew's agents: those with no agent filter, or one naming an agent of the crew. */
export function notificationsOf(input: RelationInput): Related[] {
  const agents = new Set(input.agents.map((a) => a.metadata.name));
  const sinks = (input.pool.get('NotificationSink') ?? []).filter((s) => s.metadata.namespace === input.namespace);
  return sinks
    .map((s) => ({ s, filter: strings(s.spec?.agents) }))
    .filter(({ s, filter }) => filter.length === 0 || filter.some((a) => agents.has(a)) || input.own(s))
    .map(({ s, filter }) => found(s, input, sinkReason(filter, agents)))
    .sort(byName);
}

/** Why a sink is listed: it fires for every agent, for some of the crew's, or is the crew's own and names other agents. */
function sinkReason(filter: string[], agents: Set<string>): string {
  if (filter.length === 0) return 'fires for every agent in the namespace';
  return filter.some((a) => agents.has(a)) ? 'fires for agents of this crew' : 'declared for this crew; its filter names other agents';
}

/** The fitness suites and fitness runs whose crewRef names the crew; runs a suite made (labeled or owned by it) are left to the suite. */
export function fitnessOf(input: RelationInput): Related[] {
  const madeBySuite = (f: Obj) => isOwned(f) || f.metadata.labels?.[SUITE_LABEL] !== undefined;
  const ofCrew = (kind: string) => (input.pool.get(kind) ?? []).filter((f) => f.spec?.crewRef === input.crew && f.metadata.namespace === input.namespace && !madeBySuite(f));
  const items = [...ofCrew('CrewFitnessSuite'), ...ofCrew('CrewFitness')].map((f) => ({ ...found(f, input, 'its crewRef names this crew'), sharedBy: undefined }));
  return items.sort((a, b) => byCodeUnits(a.kind, b.kind) || byName(a, b));
}

/** The KubemootConfig: the operator's defaults, which every crew runs with. */
export function operatorOf(input: RelationInput): Related[] {
  return (input.pool.get('KubemootConfig') ?? []).map((c) => ({ kind: c.kind, name: c.metadata.name, object: c, sharedBy: 'the Kubemoot operator', reason: 'the defaults every crew runs with' }));
}

/** Every group of related objects. */
export function relatedOf(input: RelationInput): RelatedGroups {
  return {
    models: modelsOf(input),
    rag: ragOf(input),
    mcp: mcpInfraOf(input),
    policies: policiesOf(input),
    notifications: notificationsOf(input),
    fitness: fitnessOf(input),
    operator: operatorOf(input),
  };
}

/** No related objects at all. */
export function noRelated(): RelatedGroups {
  return { models: [], rag: [], mcp: [], policies: [], notifications: [], fitness: [], operator: [] };
}
