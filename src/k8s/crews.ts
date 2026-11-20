import { CREWS_PATH, namespacedCrewsPath } from './paths';
import type { KubeTransport } from './request';

/** One entry of the operator's revision record in Crew status, newest first. */
export interface CrewRevision {
  revision?: string;
  source?: string;
  owner?: string;
  channel?: string;
  crewVersion?: string;
  deployedAt?: string;
  observedAt?: string;
}

/** What the Deployed Crews view shows for one Crew. */
export interface CrewSummary {
  name: string;
  namespace: string;
  ready: boolean;
  phase: string;
  message?: string;
  agents?: number;
  coordinator?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  /** The operator's record of what was deployed, newest first; absent on operators without it. */
  revisions?: CrewRevision[];
  /** metadata.creationTimestamp. */
  created?: string;
  description?: string;
  conditions?: CrewCondition[];
  /** metadata.generation, and the generation status.observedGeneration says the status describes; absent on operators without it. */
  generation?: number;
  observedGeneration?: number;
  /** The operator's last retention cleanup, from status.retention. */
  retention?: CrewRetentionStatus;
}

/** status.retention: the crew's last cleanup run. */
export interface CrewRetentionStatus {
  lastRunTime?: string;
  removed?: { conversations?: number; memory?: number; other?: number };
  error?: string;
}

/** One status condition, as metav1.Condition carries it. */
export interface CrewCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
}

interface CrewObject {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string>; creationTimestamp?: string; generation?: number };
  spec?: { description?: string };
  status?: {
    conditions?: CrewCondition[];
    ready?: boolean;
    phase?: string;
    message?: string;
    agentCount?: number;
    coordinatorRef?: string;
    revisions?: CrewRevision[];
    observedGeneration?: number;
    retention?: CrewRetentionStatus;
  };
}

/** Turns a CrewList body into summaries sorted by namespace then name. */
export function parseCrewList(body: string): CrewSummary[] {
  const parsed = JSON.parse(body) as { items?: CrewObject[] };
  const crews = (parsed.items ?? [])
    .filter((c) => c.metadata?.name && c.metadata?.namespace)
    .map(toSummary);
  return crews.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
}

function toSummary(c: CrewObject): CrewSummary {
  const status = c.status ?? {};
  return {
    name: c.metadata?.name ?? '',
    namespace: c.metadata?.namespace ?? '',
    ready: status.ready === true,
    phase: status.phase || 'Unknown',
    message: status.message || undefined,
    agents: status.agentCount,
    coordinator: status.coordinatorRef || undefined,
    ...marks(c),
    revisions: status.revisions,
    conditions: status.conditions,
    generation: c.metadata?.generation,
    observedGeneration: status.observedGeneration,
    retention: status.retention,
  };
}

function marks(c: CrewObject): Pick<CrewSummary, 'labels' | 'annotations' | 'created' | 'description'> {
  return { labels: c.metadata?.labels, annotations: c.metadata?.annotations, created: c.metadata?.creationTimestamp, description: c.spec?.description || undefined };
}

/** The Crews that could be read, and each namespace that could not be, with why. */
export interface CrewListing {
  crews: CrewSummary[];
  failed: { namespace: string; error: unknown }[];
  /** Where the Crews were read from, for a view to show: "namespace team-4", "all namespaces (team-4 had no crews)". */
  scope: string;
}

/** Which namespaces to list Crews in; `implicit` marks a default (the kubeconfig's namespace) that may be widened when it holds none. */
export interface NamespaceScope {
  namespaces: string[];
  implicit?: boolean;
}

/** Namespaces to list, or a scope that also says whether they are a default. */
export type Scope = string[] | NamespaceScope;

const scopeOf = (scope: Scope): NamespaceScope => (Array.isArray(scope) ? { namespaces: scope } : scope);

/** Every Crew the credentials can list, across namespaces: one call. */
async function listEverywhere(client: KubeTransport): Promise<CrewSummary[]> {
  return parseCrewList(await client.request('GET', CREWS_PATH));
}

const ALL = 'all namespaces';

/** The words that say which namespaces a listing covered. */
function describeScope(namespaces: string[]): string {
  if (namespaces.length === 0) return ALL;
  return `${namespaces.length === 1 ? 'namespace' : 'namespaces'} ${namespaces.join(', ')}`;
}

/** The whole cluster in place of an implicit namespace that showed nothing, or undefined when the cluster cannot be read either. */
async function widenFrom(client: KubeTransport, namespace: string, unreadable: boolean): Promise<CrewListing | undefined> {
  const crews = await listEverywhere(client).catch(() => undefined);
  return crews && { crews, failed: [], scope: `${ALL} (${namespace} ${unreadable ? 'could not be read' : 'had no crews'})` };
}

/**
 * Lists Crews. A namespace that cannot be read is reported beside the Crews of the others,
 * and the first failure is thrown only when every namespace failed. Without namespaces it
 * lists across the cluster. An implicit scope (the kubeconfig's namespace) that shows no
 * Crews, empty or unreadable, widens to the whole cluster when that can be read.
 */
export async function listCrewsEach(client: KubeTransport, given: Scope): Promise<CrewListing> {
  const { namespaces, implicit } = scopeOf(given);
  if (namespaces.length === 0) return { crews: await listEverywhere(client), failed: [], scope: ALL };
  const results = await Promise.allSettled(namespaces.map(async (ns) => parseCrewList(await client.request('GET', namespacedCrewsPath(ns)))));
  const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [{ namespace: namespaces[i], error: r.reason as unknown }] : []));
  const crews = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const widened = implicit && crews.length === 0 ? await widenFrom(client, namespaces[0], failed.length > 0) : undefined;
  if (widened) return widened;
  if (failed.length === namespaces.length) throw failed[0].error;
  return { crews, failed, scope: describeScope(namespaces) };
}

/** Lists Crews as listCrewsEach does, without saying which namespaces could not be read. */
export async function listCrews(client: KubeTransport, given: Scope): Promise<CrewSummary[]> {
  return (await listCrewsEach(client, given)).crews;
}
