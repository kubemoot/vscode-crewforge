import type { KubeTransport } from '../k8s/request';
import { byName } from './describe';
import { namesOf, strings, text } from './values';
import { byCodeUnits, LINE_BREAK } from '../text';
import { clusterPath, isOwned, listKind, objectPath, type KubemootKind } from '../source/live';
import { KUBEMOOT_GROUP, type Manifest } from '../source/manifests';
import { errorText } from '../views/errors';
import { readDeployedScenarios, type DeployedScenario } from '../fitness/deployed';
import { CREW_LABEL, liveOwn, relatedOf, SYSTEM_NAMESPACE, type RelatedGroups } from './related';

export { CREW_LABEL } from './related';

/** The order the operator gives a PromptModule or Skill that sets none (the CRD default). */
const DEFAULT_ORDER = 100;

export interface AgentInfo {
  name: string;
  /** spec.discussRole: coordinator, tooler, researcher, analyst, or another word. */
  role?: string;
  /** spec.capabilities: what the agent asks the scheduler for; never a model name. */
  capabilities: string[];
  ready: boolean;
  phase?: string;
  description?: string;
  promptRefs: string[];
  object: Manifest;
}

export type PromptForm = 'ADL' | 'prose';

export interface PromptModuleInfo {
  name: string;
  order: number;
  form?: PromptForm;
  /** The crew's agents that compose it, in name order. */
  usedBy: string[];
  /** Absent when an agent names a module that does not exist. */
  object?: Manifest;
  /** True when an agent outside the crew composes it too. */
  shared: boolean;
}

export interface SkillInfo {
  name: string;
  order: number;
  description?: string;
  ready?: boolean;
  object: Manifest;
}

export interface McpServerInfo {
  name: string;
  ready?: boolean;
  toolCount?: number;
  /** Why it counts as the crew's: named by an agent or skill, or installed with the crew. */
  reason: string;
  /** Absent when an agent or skill names a server that does not exist. */
  object?: Manifest;
}

export interface ToolInfo {
  name: string;
  agents: string[];
  /** The crew's MCPServer that lists it among its tools, when one does. */
  server?: string;
  /** What the tool does, as its server reports it. */
  description?: string;
}

/** A live crew and the Kubemoot objects it is made of. */
export interface CrewDetails {
  crew: Manifest;
  agents: AgentInfo[];
  skills: SkillInfo[];
  promptModules: PromptModuleInfo[];
  mcpServers: McpServerInfo[];
  tools: ToolInfo[];
  /** The MootArchetype of the crew's CrewSchedulingPolicy, when it has one. */
  archetype?: string;
  /** Models and providers, RAG sources, MCP infrastructure, policies, notifications, fitness, and the operator's defaults. */
  related: RelatedGroups;
  /** The MCPGateway the agents call tools through: the first in the namespace by name, as the operator wires it. */
  gateway?: Manifest;
  /** Kinds that could not be read, such as a PromptModule list the account may not see. */
  problems: string[];
  /** The fitness scenarios deployed with the crew, from its scenario ConfigMaps. */
  scenarios?: DeployedScenario[];
  /** True when the workspace source's scenarios differ from the deployed ones; unknown without a source. */
  scenariosChanged?: boolean;
}

type Obj = Manifest & { spec?: Record<string, unknown>; status?: Record<string, unknown> };

/**
 * The statement keywords of ADL as the Kubemoot guide "Write agents and ADL" lists them,
 * plus DEFER, which crews use for synthesis rules. THEN is left out: it continues a WHEN.
 */
const ADL_KEYWORD = /^(DESCRIPTION|DEFINE|WHEN|ALWAYS|NEVER|ASSERT|FOREACH|DEFER)\b/;

/**
 * ADL when any line opens with an ADL keyword after its indent, prose otherwise; a
 * heuristic, since a module may mix the two. Each line is read once, in linear time.
 */
export function promptForm(content: string): PromptForm {
  return content.split(LINE_BREAK).some((line) => ADL_KEYWORD.test(line.trimStart())) ? 'ADL' : 'prose';
}

const order = (o: Obj): number => (typeof o.spec?.order === 'number' ? o.spec.order : DEFAULT_ORDER);
const byOrder = <T extends { name: string; order: number }>(a: T, b: T) => a.order - b.order || byName(a, b);

/** The names in spec.mcpServers[] of an Agent or Skill. */
export function serverRefs(o: Obj): string[] {
  return namesOf(o.spec?.mcpServers);
}

function readyCondition(o: Obj): boolean | undefined {
  const conditions = o.status?.conditions;
  if (!Array.isArray(conditions)) return undefined;
  const ready = conditions.find((c: { type?: string }) => c?.type === 'Ready') as { status?: string } | undefined;
  return ready ? ready.status === 'True' : undefined;
}

export function toAgent(o: Obj): AgentInfo {
  return {
    name: o.metadata.name,
    role: text(o.spec?.discussRole),
    capabilities: strings(o.spec?.capabilities),
    ready: o.status?.ready === true,
    phase: text(o.status?.phase),
    description: text(o.spec?.description),
    promptRefs: strings(o.spec?.promptRefs),
    object: o,
  };
}

export function toSkill(o: Obj): SkillInfo {
  return { name: o.metadata.name, order: order(o), description: text(o.spec?.description), ready: readyCondition(o), object: o };
}

/** The PromptModules the crew's agents compose, in the order the operator composes them, with names that resolve to nothing kept as missing. */
export function promptModulesOf(agents: AgentInfo[], modules: Obj[], sharedRefs: Set<string> = new Set()): PromptModuleInfo[] {
  const users = new Map<string, string[]>();
  for (const agent of agents) for (const ref of agent.promptRefs) users.set(ref, [...(users.get(ref) ?? []), agent.name]);
  const found = new Map(modules.map((m) => [m.metadata.name, m]));
  return [...users.entries()].map(([name, usedBy]) => toPromptModule(name, usedBy.toSorted(byCodeUnits), found.get(name), sharedRefs.has(name))).sort(byOrder);
}

/** One PromptModule as the trees show it; `object` is absent when the module does not exist. */
export function toPromptModule(name: string, usedBy: string[], object: Obj | undefined, shared = false): PromptModuleInfo {
  const content = text(object?.spec?.content);
  const form = content === undefined ? undefined : promptForm(content);
  return { name, order: object ? order(object) : DEFAULT_ORDER, form, usedBy, object, shared };
}

/**
 * The MCPServers that serve the crew: those its agents or skills name, and those installed
 * with it (the crew's label, or the Crew's own Helm release).
 */
export function mcpServersOf(crew: Manifest, members: Obj[], servers: Obj[], registered: string[] = []): McpServerInfo[] {
  const named = new Set(members.flatMap(serverRefs));
  const release = crew.metadata.labels?.['app.kubernetes.io/instance'];
  const viaGateway = new Set(registered);
  const result = new Map<string, McpServerInfo>();
  for (const server of servers) {
    const reason = serverReason(server, crew.metadata.name, named, release) ?? (viaGateway.has(server.metadata.name) ? "registered with the agents' gateway" : undefined);
    if (reason) result.set(server.metadata.name, { name: server.metadata.name, ...serverStatus(server), reason, object: server });
  }
  for (const name of named) if (!result.has(name)) result.set(name, { name, reason: 'named by an agent or skill, but not found' });
  return [...result.values()].sort(byName);
}

function serverReason(server: Obj, crew: string, named: Set<string>, release?: string): string | undefined {
  const labels = server.metadata.labels ?? {};
  if (named.has(server.metadata.name)) return 'named by an agent or skill';
  if (labels[CREW_LABEL] === crew) return 'labeled for this crew';
  if (release && labels['app.kubernetes.io/instance'] === release) return `installed with release ${release}`;
  return undefined;
}

function serverStatus(server: Obj): Pick<McpServerInfo, 'ready' | 'toolCount'> {
  const tools = server.status?.tools;
  return { ready: typeof server.status?.ready === 'boolean' ? server.status.ready : undefined, toolCount: Array.isArray(tools) ? tools.length : undefined };
}

/**
 * The MCP tools the crew's agents may call (spec.enabledTools), each with the agents that
 * enable it and, when one of the crew's MCPServers lists it, that server and its description.
 */
export function toolsOf(agents: Obj[], servers: McpServerInfo[] = []): ToolInfo[] {
  const tools = new Map<string, string[]>();
  for (const agent of agents) for (const tool of strings(agent.spec?.enabledTools)) tools.set(tool, [...(tools.get(tool) ?? []), agent.metadata.name]);
  const offered = serverTools(servers);
  return [...tools.entries()].map(([name, users]) => ({ name, agents: users.toSorted(byCodeUnits), ...offered.get(name) })).sort(byName);
}

/** Each tool the servers report in their status, with the first server (by name) that offers it. */
function serverTools(servers: McpServerInfo[]): Map<string, { server: string; description?: string }> {
  const offered = new Map<string, { server: string; description?: string }>();
  for (const s of servers) {
    const tools = (s.object as Obj | undefined)?.status?.tools;
    for (const t of Array.isArray(tools) ? (tools as { name?: unknown; description?: unknown }[]) : []) {
      if (typeof t?.name === 'string' && !offered.has(t.name)) offered.set(t.name, { server: s.name, description: text(t.description) });
    }
  }
  return offered;
}

export function archetypeOf(crew: string, policies: Obj[]): string | undefined {
  const policy = policies.find((p) => p.spec?.crewRef === crew);
  return text(policy?.spec?.archetypeRef);
}

interface Listed {
  items: Obj[];
  problem?: string;
}

/** Lists a kind the cluster may not serve or the account may not read; either yields no items, and a read failure is reported. */
async function listOptional(client: KubeTransport, kinds: Map<string, KubemootKind>, kind: string, namespace: string): Promise<Listed> {
  const k = kinds.get(kind);
  if (!k?.namespaced) return { items: [] };
  try {
    return { items: (await listKind(client, k, namespace)) as Obj[] };
  } catch (err) {
    return { items: [], problem: `${kind}: ${errorText(err)}` };
  }
}

/** Lists a cluster-scoped kind; a kind the cluster does not serve yields nothing, a read failure a problem. */
async function listClusterKind(client: KubeTransport, kinds: Map<string, KubemootKind>, kind: string): Promise<Listed> {
  const k = kinds.get(kind);
  if (!k || k.namespaced) return { items: [] };
  try {
    const body = JSON.parse(await client.request('GET', clusterPath(k))) as { items?: Obj[] };
    return { items: (body.items ?? []).map((o) => ({ ...o, apiVersion: o.apiVersion ?? `${KUBEMOOT_GROUP}/v1alpha1`, kind })) };
  } catch (err) {
    return { items: [], problem: `${kind}: ${errorText(err)}` };
  }
}

const MEMBER_KINDS = ['Agent', 'Skill', 'PromptModule', 'MCPServer', 'CrewSchedulingPolicy'] as const;

/** The kinds in the crew's namespace whose objects the crew may use beyond its members. */
const NAMESPACE_KINDS = ['Model', 'ModelProvider', 'EmbeddingModel', 'RAGSource', 'MCPGateway', 'MCPQualityPolicy', 'MCPCatalog', 'MCPServerReport', 'NotificationSink', 'CrewFitness', 'CrewFitnessSuite'] as const;

/** Cluster-scoped kinds a crew uses: its archetype and the operator's defaults. */
const CLUSTER_KINDS = ['MootArchetype', 'KubemootConfig'] as const;

/**
 * Reads every kind a crew may use. A failure to read a kind in the crew's namespace is a
 * problem to show; one outside it (the system namespace's ModelProviders, cluster-scoped
 * kinds) only makes those objects unknown, since a namespace account may not see them.
 */
async function readPool(client: KubeTransport, kinds: Map<string, KubemootKind>, namespace: string): Promise<{ pool: Map<string, Obj[]>; problems: string[]; unreadable: Set<string> }> {
  const system = namespace === SYSTEM_NAMESPACE ? Promise.resolve<Listed>({ items: [] }) : listOptional(client, kinds, 'ModelProvider', SYSTEM_NAMESPACE);
  const [local, providers, cluster] = await Promise.all([
    Promise.all(NAMESPACE_KINDS.map((k) => listOptional(client, kinds, k, namespace))),
    system,
    Promise.all(CLUSTER_KINDS.map((k) => listClusterKind(client, kinds, k))),
  ]);
  const pool = new Map<string, Obj[]>(NAMESPACE_KINDS.map((k, i) => [k, local[i].items]));
  pool.set('ModelProvider', [...(pool.get('ModelProvider') ?? []), ...providers.items]);
  for (const [i, k] of CLUSTER_KINDS.entries()) pool.set(k, cluster[i].items);
  const unreadable = new Set<string>();
  if (providers.problem) unreadable.add('ModelProvider');
  for (const [i, k] of CLUSTER_KINDS.entries()) if (cluster[i].problem) unreadable.add(k);
  return { pool, problems: local.map((l) => l.problem).filter((p): p is string => p !== undefined), unreadable };
}

/** Why a named object of a kind is not listed: missing, or not readable by this account. */
export function missingText(unreadable: Set<string>): (kind: string) => string {
  return (kind) => (unreadable.has(kind) ? 'this account cannot read it' : 'not found');
}

/** Reads a live Crew and the objects that make it up. The Crew itself must be readable; every other kind is best effort. */
export async function loadCrewDetails(client: KubeTransport, kinds: Map<string, KubemootKind>, namespace: string, name: string): Promise<CrewDetails> {
  const crewKind = kinds.get('Crew') ?? { kind: 'Crew', plural: 'crews', namespaced: true };
  const raw = JSON.parse(await client.request('GET', objectPath(crewKind, namespace, name))) as Obj;
  const crew: Obj = { ...raw, apiVersion: raw.apiVersion ?? `${KUBEMOOT_GROUP}/v1alpha1`, kind: raw.kind ?? 'Crew' };
  const [members, extra, deployed] = await Promise.all([
    Promise.all(MEMBER_KINDS.map((k) => listOptional(client, kinds, k, namespace))),
    readPool(client, kinds, namespace),
    readDeployedScenarios(client, namespace, name).then(
      (scenarios) => ({ scenarios, problem: undefined }),
      (err: unknown) => ({ scenarios: [], problem: `fitness scenario ConfigMaps: ${errorText(err)}` }),
    ),
  ]);
  const [agents, skills, modules, servers, policies] = members;
  const member = (o: Obj) => o.metadata.labels?.[CREW_LABEL] === name;
  const agentObjects = agents.items.filter(member);
  const skillObjects = skills.items.filter(member);
  const agentInfos = agentObjects.map(toAgent).sort(byName);
  const sharedRefs = new Set(agents.items.filter((o) => !member(o)).flatMap((o) => strings(o.spec?.promptRefs)));
  const gateway = (extra.pool.get('MCPGateway') ?? []).toSorted((a, b) => byCodeUnits(a.metadata.name, b.metadata.name))[0];
  const mcpServers = mcpServersOf(crew, [...agentObjects, ...skillObjects], servers.items, strings(gateway?.status?.mcpServers));
  extra.pool.set('CrewSchedulingPolicy', policies.items);
  return {
    crew,
    agents: agentInfos,
    skills: skillObjects.map(toSkill).sort(byOrder),
    promptModules: promptModulesOf(agentInfos, modules.items, sharedRefs),
    mcpServers,
    tools: toolsOf(agentObjects, mcpServers),
    archetype: archetypeOf(name, policies.items),
    related: relatedOf({ crew: name, namespace, agents: agentObjects, skills: skillObjects, servers: mcpServers.map((s) => s.name), pool: extra.pool, own: liveOwn(crew), missing: missingText(extra.unreadable) }),
    gateway,
    problems: [...members.map((l) => l.problem), ...extra.problems, deployed.problem].filter((p): p is string => p !== undefined),
    scenarios: deployed.scenarios,
  };
}

/** The Crew, then its Agents, PromptModules, and Skills: the objects that define the crew's behavior. */
export function bundleObjects(details: CrewDetails): Manifest[] {
  const modules = details.promptModules.map((m) => m.object).filter((o): o is Manifest => o !== undefined);
  return [details.crew, ...details.agents.map((a) => a.object), ...modules, ...details.skills.map((s) => s.object)];
}

/**
 * What removing a crew without its source deletes: its Agents, Skills, and the
 * PromptModules only its agents compose (only Agents name PromptModules), then the Crew. Objects a controller owns are
 * left for their owner; MCPServers are left because other crews may use them.
 */
export function removableObjects(details: CrewDetails): Manifest[] {
  const modules = details.promptModules.filter((m) => !m.shared).map((m) => m.object);
  const members = [...details.agents.map((a) => a.object), ...details.skills.map((s) => s.object), ...modules];
  return [...members.filter((o): o is Manifest => o !== undefined && !isOwned(o)), details.crew];
}
