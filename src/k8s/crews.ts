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
}

/** One status condition, as metav1.Condition carries it. */
export interface CrewCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
}

interface CrewObject {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string>; creationTimestamp?: string };
  spec?: { description?: string };
  status?: {
    conditions?: CrewCondition[];
    ready?: boolean;
    phase?: string;
    message?: string;
    agentCount?: number;
    coordinatorRef?: string;
    revisions?: CrewRevision[];
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
  };
}

function marks(c: CrewObject): Pick<CrewSummary, 'labels' | 'annotations' | 'created' | 'description'> {
  return { labels: c.metadata?.labels, annotations: c.metadata?.annotations, created: c.metadata?.creationTimestamp, description: c.spec?.description || undefined };
}

/** The Crews that could be read, and each namespace that could not be, with why. */
export interface CrewListing {
  crews: CrewSummary[];
  failed: { namespace: string; error: unknown }[];
}

/**
 * Lists Crews like listCrews, but a namespace that cannot be read is reported beside the
 * Crews of the others. When none can be read, that first failure is thrown.
 */
export async function listCrewsEach(client: KubeTransport, namespaces: string[]): Promise<CrewListing> {
  if (namespaces.length === 0) return { crews: await listCrews(client, namespaces), failed: [] };
  const results = await Promise.allSettled(namespaces.map(async (ns) => parseCrewList(await client.request('GET', namespacedCrewsPath(ns)))));
  const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [{ namespace: namespaces[i], error: r.reason as unknown }] : []));
  if (failed.length === namespaces.length) throw failed[0].error;
  return { crews: results.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])), failed };
}

/**
 * Lists Crews. With a namespace filter it asks each namespace, which works for accounts
 * that may read only their own namespaces; without one it lists across the cluster.
 */
export async function listCrews(client: KubeTransport, namespaces: string[]): Promise<CrewSummary[]> {
  if (namespaces.length === 0) return parseCrewList(await client.request('GET', CREWS_PATH));
  const lists = await Promise.all(namespaces.map(async (ns) => parseCrewList(await client.request('GET', namespacedCrewsPath(ns)))));
  return lists.flat();
}
