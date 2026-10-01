import { CREW_LABEL, toAgent, type AgentInfo } from '../crew/details';
import { listCrews, type CrewSummary } from '../k8s/crews';
import { KubeError, type KubeTransport } from '../k8s/request';
import { listKind, type KubemootKind } from '../source/live';
import { failedReason, type CrewReadiness } from '../loop/ready';
import { unreachableReason } from '../views/errors';

/**
 * Whether a crew can take a question now, and if not, why, in a few words for the chat
 * input: not ready, in an error state, or out of reach.
 */
export type CrewAvailability = { state: 'ready' } | { state: 'not-ready' | 'error' | 'unreachable'; reason: string };

/** A crew's availability from its Crew, its agents, and whether its discussion gateway has a running endpoint. */
export function availabilityOf(r: CrewReadiness & { gateway?: boolean }): CrewAvailability {
  if (!r.crew) return { state: 'not-ready', reason: 'The crew is not deployed here any more' };
  const error = failedReason(r.crew, r.agents);
  if (error) return { state: 'error', reason: `The crew is in an error state: ${error}` };
  const notReady = notReadyReason(r.crew, r.agents);
  if (notReady) return { state: 'not-ready', reason: `The crew is not ready: ${notReady}` };
  if (r.gateway === false) return { state: 'unreachable', reason: "Can't reach the crew's discussion gateway" };
  return { state: 'ready' };
}

/** Why a crew that has not failed cannot answer yet; `agents` is undefined when they could not be read. */
function notReadyReason(crew: CrewSummary, agents?: AgentInfo[]): string | undefined {
  if (!crew.ready) return crew.message ?? `phase ${crew.phase}`;
  if (agents?.length === 0) return 'it has no agents yet';
  return agents && !agents.some((a) => a.ready) ? 'no agent is ready yet' : undefined;
}

/** The availability of a crew whose cluster could not be read. */
export function unreachable(err: unknown): CrewAvailability {
  return { state: 'unreachable', reason: unreachableReason(err) };
}

/**
 * Reads a crew's availability from the cluster: its Crew, its Agents, and the endpoints
 * of its discussion gateway Service (`<crew>-discussion`). An account that may not read
 * Agents or Endpoints is judged on what it can read.
 */
export async function readAvailability(client: KubeTransport, kinds: Map<string, KubemootKind>, namespace: string, crew: string): Promise<CrewAvailability> {
  try {
    const found = (await listCrews(client, [namespace])).find((c) => c.name === crew);
    const [agents, gateway] = await Promise.all([agentsOf(client, kinds, namespace, crew), gatewayUp(client, namespace, crew)]);
    return availabilityOf({ crew: found, agents, gateway });
  } catch (err) {
    return unreachable(err);
  }
}

async function agentsOf(client: KubeTransport, kinds: Map<string, KubemootKind>, namespace: string, crew: string): Promise<AgentInfo[] | undefined> {
  const kind = kinds.get('Agent');
  if (!kind) return undefined;
  try {
    return (await listKind(client, kind, namespace)).filter((a) => a.metadata.labels?.[CREW_LABEL] === crew).map(toAgent);
  } catch {
    return undefined;
  }
}

interface Endpoints {
  subsets?: { addresses?: unknown[] }[];
}

/** True when the gateway Service has a ready address; undefined when the account may not tell. */
async function gatewayUp(client: KubeTransport, namespace: string, crew: string): Promise<boolean | undefined> {
  try {
    const service = `${crew}-discussion`;
    const body = JSON.parse(await client.request('GET', `/api/v1/namespaces/${encodeURIComponent(namespace)}/endpoints/${encodeURIComponent(service)}`)) as Endpoints;
    return (body.subsets ?? []).some((s) => (s.addresses ?? []).length > 0);
  } catch (err) {
    return err instanceof KubeError && err.status === 404 ? false : undefined;
  }
}
