import type { KubeTransport } from '../k8s/request';
import { byName, text } from './describe';
import { isOwned, listKind, objectPath, type KubemootKind } from '../source/live';
import { KUBEMOOT_GROUP, type Manifest } from '../source/manifests';
import { errorText } from '../views/errors';

/** The label the operator reads to find a crew's Agents and Skills. */
export const CREW_LABEL = 'kubemoot.ai/crew';

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
  /** Kinds that could not be read, such as a PromptModule list the account may not see. */
  problems: string[];
}

type Obj = Manifest & { spec?: Record<string, unknown>; status?: Record<string, unknown> };

/**
 * The statement keywords of ADL as the Kubemoot guide "Write agents and ADL" lists them,
 * plus DEFER, which crews use for synthesis rules. THEN is left out: it continues a WHEN.
 */
const ADL_LINE = /^\s*(DESCRIPTION|DEFINE|WHEN|ALWAYS|NEVER|ASSERT|FOREACH|DEFER)\b/m;

/** ADL when any line opens with an ADL keyword, prose otherwise; a heuristic, since a module may mix the two. */
export function promptForm(content: string): PromptForm {
  return ADL_LINE.test(content) ? 'ADL' : 'prose';
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
const order = (o: Obj): number => (typeof o.spec?.order === 'number' ? o.spec.order : DEFAULT_ORDER);
const byOrder = <T extends { name: string; order: number }>(a: T, b: T) => a.order - b.order || byName(a, b);

/** The names in spec.mcpServers[] of an Agent or Skill. */
export function serverRefs(o: Obj): string[] {
  const refs = o.spec?.mcpServers;
  return Array.isArray(refs) ? refs.map((r: { name?: unknown }) => r?.name).filter((n): n is string => typeof n === 'string') : [];
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
  return [...users.entries()].map(([name, usedBy]) => toPromptModule(name, usedBy.sort(), found.get(name), sharedRefs.has(name))).sort(byOrder);
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
export function mcpServersOf(crew: Manifest, members: Obj[], servers: Obj[]): McpServerInfo[] {
  const named = new Set(members.flatMap(serverRefs));
  const release = crew.metadata.labels?.['app.kubernetes.io/instance'];
  const result = new Map<string, McpServerInfo>();
  for (const server of servers) {
    const reason = serverReason(server, crew.metadata.name, named, release);
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

/** The MCP tools the crew's agents may call (spec.enabledTools), each with the agents that enable it. */
export function toolsOf(agents: Obj[]): ToolInfo[] {
  const tools = new Map<string, string[]>();
  for (const agent of agents) for (const tool of strings(agent.spec?.enabledTools)) tools.set(tool, [...(tools.get(tool) ?? []), agent.metadata.name]);
  return [...tools.entries()].map(([name, users]) => ({ name, agents: users.sort() })).sort(byName);
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

const MEMBER_KINDS = ['Agent', 'Skill', 'PromptModule', 'MCPServer', 'CrewSchedulingPolicy'] as const;

/** Reads a live Crew and the objects that make it up. The Crew itself must be readable; every other kind is best effort. */
export async function loadCrewDetails(client: KubeTransport, kinds: Map<string, KubemootKind>, namespace: string, name: string): Promise<CrewDetails> {
  const crewKind = kinds.get('Crew') ?? { kind: 'Crew', plural: 'crews', namespaced: true };
  const raw = JSON.parse(await client.request('GET', objectPath(crewKind, namespace, name))) as Obj;
  const crew: Obj = { ...raw, apiVersion: raw.apiVersion ?? `${KUBEMOOT_GROUP}/v1alpha1`, kind: raw.kind ?? 'Crew' };
  const [agents, skills, modules, servers, policies] = await Promise.all(MEMBER_KINDS.map((k) => listOptional(client, kinds, k, namespace)));
  const member = (o: Obj) => o.metadata.labels?.[CREW_LABEL] === name;
  const agentObjects = agents.items.filter(member);
  const skillObjects = skills.items.filter(member);
  const agentInfos = agentObjects.map(toAgent).sort(byName);
  const sharedRefs = new Set(agents.items.filter((o) => !member(o)).flatMap((o) => strings(o.spec?.promptRefs)));
  return {
    crew,
    agents: agentInfos,
    skills: skillObjects.map(toSkill).sort(byOrder),
    promptModules: promptModulesOf(agentInfos, modules.items, sharedRefs),
    mcpServers: mcpServersOf(crew, [...agentObjects, ...skillObjects], servers.items),
    tools: toolsOf(agentObjects),
    archetype: archetypeOf(name, policies.items),
    problems: [agents, skills, modules, servers, policies].map((l) => l.problem).filter((p): p is string => p !== undefined),
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
