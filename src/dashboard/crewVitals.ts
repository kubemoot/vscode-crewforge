import { toAgent, type AgentInfo, type CrewDetails } from '../crew/details';
import { liveCounts, type GroupCount } from '../crew/groups';
import type { Declarations } from '../source/declared';
import { liveDeployment } from '../deploy/liveCrew';
import type { CrewSummary } from '../k8s/crews';
import type { ThreadStats } from '../kubemoot/dashboardApi';
import type { Deployment } from '../source/deployments';
import type { ResourceDrift } from '../source/drift';
import type { Located } from '../source/locate';
import { crewOf, isKubemoot, type Manifest } from '../source/manifests';
import { provenanceOf, type Provenance } from '../source/provenance';
import type { SourceEntry } from '../source/service';
import { errorText } from '../views/errors';
import type { DeploymentNode } from '../views/sourceTree';

/** Which crew a dashboard shows: a workspace source, a live crew, or both. */
export interface CrewTarget {
  entry?: SourceEntry;
  crew?: CrewSummary;
}

/** What CrewForge's saved conversations say about a crew. */
export interface ConversationStats {
  total: number;
  turns: number;
  /** The question of a turn running now in an open chat. */
  active?: string;
  /** The newest problems saved with turns: failed agents, gateway errors, timeouts. */
  errors: { at: string; text: string }[];
}

/** When a crew's Helm release was first installed and last upgraded, from `helm status`. */
export interface HelmInfo {
  firstDeployed?: string;
  lastDeployed?: string;
  revision?: number;
  status?: string;
}

export interface CrewVitals {
  name: string;
  description?: string;
  context: string;
  source?: SourceEntry;
  /** Where the crew's Crew starts in its source file. */
  sourceAt?: { file: string; line: number };
  deployment?: Deployment;
  deploymentError?: string;
  /** How each object of the source compares with the deployment, when both are known. */
  drift?: ResourceDrift[];
  /** Why the source could not be compared with the deployment. */
  driftError?: string;
  provenance?: Provenance;
  helm?: HelmInfo;
  agents: AgentInfo[];
  /** Whether the agents are the live ones or the ones the source declares. */
  agentsFrom: 'live' | 'source' | 'none';
  agentsError?: string;
  /** The Model objects the source declares: name and model. */
  models: { name: string; model?: string }[];
  /** How many objects each group holds: the live crew's, else what the source declares. */
  contents: GroupCount[];
  contentsFrom: 'live' | 'source' | 'none';
  conversations: ConversationStats;
  kubemoot?: ThreadStats | { unavailable: string };
  fitnessRunning: boolean;
}

/** Where a crew dashboard reads from; each is a read-only call. */
export interface VitalsDeps {
  context(): string;
  /** The deployment of a source Redeploy goes to (or the one it names), with a fresh read of the cluster. */
  deploymentOf(entry: SourceEntry): Promise<DeploymentNode | undefined>;
  liveCrew(namespace: string, name: string): Promise<CrewSummary | undefined>;
  located(entry: SourceEntry): Promise<Located[]>;
  liveDetails(crew: CrewSummary): Promise<CrewDetails>;
  /** What a source declares, by group; absent where no source can be read. */
  declarations?(entry: SourceEntry): Promise<Declarations>;
  helm(release: string, namespace: string): Promise<HelmInfo | undefined>;
  conversations(context: string, namespace: string, crew: string): Promise<ConversationStats>;
  kubemoot(namespace: string, crew: string): Promise<ThreadStats | { unavailable: string }>;
  fitnessRunning(namespace: string, crew: string): boolean;
}

const NO_CONVERSATIONS: ConversationStats = { total: 0, turns: 0, errors: [] };

/** Everything a crew dashboard shows, read now. A part that cannot be read says why instead of failing the page. */
export async function gatherVitals(target: CrewTarget, deps: VitalsDeps): Promise<CrewVitals> {
  const { deployment, deploymentError, drift, driftError } = await deploymentFor(target, deps);
  const declared = await declaredOf(target.entry, deps);
  const vitals: CrewVitals = {
    name: nameOf(target, deployment),
    description: deployment?.crew.description ?? declared.description ?? target.entry?.chart?.description,
    context: deps.context(),
    source: target.entry,
    sourceAt: declared.at,
    deployment,
    deploymentError,
    drift,
    driftError,
    provenance: deployment && provenanceOf(deployment.crew),
    agents: declared.agents,
    agentsFrom: declared.agents.length ? 'source' : 'none',
    models: declared.models,
    ...(await declaredContents(target.entry, deps)),
    conversations: NO_CONVERSATIONS,
    fitnessRunning: false,
  };
  return deployment ? withLive(vitals, deployment, deps) : vitals;
}

/** The crew's name: the one its source renders, else the live crew's, else the source folder's. */
function nameOf(target: CrewTarget, deployment?: Deployment): string {
  return target.entry?.crewName ?? deployment?.crew.name ?? target.crew?.name ?? target.entry?.source.label ?? '';
}

type Found = Pick<CrewVitals, 'deployment' | 'deploymentError' | 'drift' | 'driftError'>;

async function deploymentFor(target: CrewTarget, deps: VitalsDeps): Promise<Found> {
  try {
    if (target.entry?.crewName) {
      const node = await deps.deploymentOf(target.entry);
      return { deployment: node?.deployment, drift: node?.drift, driftError: node?.error };
    }
    if (!target.crew) return {};
    const crew = (await deps.liveCrew(target.crew.namespace, target.crew.name)) ?? target.crew;
    return { deployment: liveDeployment(crew) };
  } catch (err) {
    return { deployment: target.crew && liveDeployment(target.crew), deploymentError: errorText(err) };
  }
}

interface Declared {
  agents: AgentInfo[];
  models: { name: string; model?: string }[];
  description?: string;
  at?: { file: string; line: number };
}

/** What the source declares: its agents, its Models, its Crew's description and where the Crew starts. */
async function declaredOf(entry: SourceEntry | undefined, deps: VitalsDeps): Promise<Declared> {
  if (!entry?.crewName) return { agents: [], models: [] };
  let located: Located[];
  try {
    located = await deps.located(entry);
  } catch {
    return { agents: [], models: [] };
  }
  const objects = located.map((l) => l.manifest).filter(isKubemoot);
  const crew = crewOf(objects) as (Manifest & { spec?: { description?: unknown } }) | undefined;
  const crewAt = located.find((l) => l.manifest === crew);
  const ofKind = (kind: string) => objects.filter((m) => m.kind === kind) as (Manifest & { spec?: Record<string, unknown> })[];
  return {
    agents: ofKind('Agent').map(toAgent),
    models: ofKind('Model').map((m) => ({ name: m.metadata.name, model: typeof m.spec?.model === 'string' ? m.spec.model : undefined })),
    description: typeof crew?.spec?.description === 'string' ? crew.spec.description : undefined,
    at: crewAt?.file ? { file: crewAt.file, line: crewAt.line } : undefined,
  };
}

/** How many objects each group of a source declares; the deployment group counts its deployment, unknown here. */
async function declaredContents(entry: SourceEntry | undefined, deps: VitalsDeps): Promise<Pick<CrewVitals, 'contents' | 'contentsFrom'>> {
  if (!entry?.crewName || !deps.declarations) return { contents: [], contentsFrom: 'none' };
  try {
    const { sections } = await deps.declarations(entry);
    return { contents: sections.map((s) => ({ group: s.section, count: s.items.length })), contentsFrom: 'source' };
  } catch {
    return { contents: [], contentsFrom: 'none' };
  }
}

/** Adds what only the cluster knows: the live agents, the Helm release, conversations, discussions, and fitness. */
async function withLive(vitals: CrewVitals, deployment: Deployment, deps: VitalsDeps): Promise<CrewVitals> {
  const { crew, namespace } = deployment;
  const [agents, helm, conversations, kubemoot] = await Promise.all([
    liveAgents(crew, deps),
    helmOf(deployment, deps),
    deps.conversations(vitals.context, namespace, crew.name).catch(() => NO_CONVERSATIONS),
    deps.kubemoot(namespace, crew.name).catch((err: unknown) => ({ unavailable: errorText(err) })),
  ]);
  const live = 'details' in agents ? { agents: agents.details.agents, agentsFrom: 'live' as const, contents: liveCounts(agents.details), contentsFrom: 'live' as const } : { agentsError: agents.error };
  return { ...vitals, ...live, helm, conversations, kubemoot, fitnessRunning: deps.fitnessRunning(namespace, crew.name) };
}

async function liveAgents(crew: CrewSummary, deps: VitalsDeps): Promise<{ details: CrewDetails } | { error: string }> {
  try {
    return { details: await deps.liveDetails(crew) };
  } catch (err) {
    return { error: errorText(err) };
  }
}

async function helmOf(deployment: Deployment, deps: VitalsDeps): Promise<HelmInfo | undefined> {
  if (deployment.channel === 'bundle' || !deployment.release) return undefined;
  return deps.helm(deployment.release, deployment.namespace).catch(() => undefined);
}

/** Agents counted by discussion role, in name order of the role; an agent without one counts as "no role". */
export function agentsByRole(agents: AgentInfo[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const a of agents) counts.set(a.role ?? 'no role', (counts.get(a.role ?? 'no role') ?? 0) + 1);
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** Reads `helm status -o json` output into when the release was installed and last upgraded. */
export function parseHelmStatus(json: string): HelmInfo | undefined {
  try {
    const body = JSON.parse(json) as { version?: number; info?: { first_deployed?: string; last_deployed?: string; status?: string } };
    return { firstDeployed: body.info?.first_deployed, lastDeployed: body.info?.last_deployed, revision: body.version, status: body.info?.status };
  } catch {
    return undefined;
  }
}
