import { CREWS_PATH, namespacedCrewsPath } from './paths';
import type { KubeTransport } from './request';

/** What the Crews view shows for one Crew. */
export interface CrewSummary {
  name: string;
  namespace: string;
  ready: boolean;
  phase: string;
  message?: string;
  agents?: number;
  coordinator?: string;
}

interface CrewObject {
  metadata?: { name?: string; namespace?: string };
  status?: {
    ready?: boolean;
    phase?: string;
    message?: string;
    agentCount?: number;
    coordinatorRef?: string;
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
  };
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
