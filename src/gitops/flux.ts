import type { CrewSummary } from '../k8s/crews';
import { checkName } from '../k8s/paths';
import type { KubeTransport } from '../k8s/request';

/** The Flux HelmRelease that manages a crew. */
export interface HelmReleaseRef {
  name: string;
  namespace: string;
}

/** What Flux reports about a HelmRelease. */
export interface FluxState {
  ref: HelmReleaseRef;
  /** The Ready condition: 'True', 'False', or 'Unknown' while reconciling. */
  ready: string;
  message: string;
  /** Whether Flux has acted on the latest spec. */
  current: boolean;
  suspended: boolean;
  /** The chart version Flux last attempted. */
  revision?: string;
  /** Inline values; valuesFrom (ConfigMaps, Secrets) are not read. */
  values: Record<string, unknown>;
  hasValuesFrom: boolean;
}

/** The HelmRelease named by the labels Flux's helm-controller puts on what it installs. */
export function helmReleaseRef(crew: CrewSummary): HelmReleaseRef | undefined {
  const labels = crew.labels ?? {};
  const name = labels['helm.toolkit.fluxcd.io/name'];
  const namespace = labels['helm.toolkit.fluxcd.io/namespace'];
  return name && namespace ? { name, namespace } : undefined;
}

interface HelmReleaseObject {
  metadata?: { generation?: number };
  spec?: { suspend?: boolean; values?: Record<string, unknown>; valuesFrom?: unknown[] };
  status?: { observedGeneration?: number; lastAttemptedRevision?: string; conditions?: { type: string; status: string; message?: string }[] };
}

export async function readHelmRelease(client: KubeTransport, ref: HelmReleaseRef): Promise<FluxState> {
  const path = `/apis/helm.toolkit.fluxcd.io/v2/namespaces/${checkName('namespace', ref.namespace)}/helmreleases/${encodeURIComponent(ref.name)}`;
  return toFluxState(ref, JSON.parse(await client.request('GET', path)) as HelmReleaseObject);
}

export function toFluxState(ref: HelmReleaseRef, hr: HelmReleaseObject): FluxState {
  const spec = hr.spec ?? {};
  const status = hr.status ?? {};
  return {
    ref,
    ...readiness(status.conditions ?? []),
    current: status.observedGeneration === hr.metadata?.generation,
    suspended: spec.suspend === true,
    revision: status.lastAttemptedRevision,
    values: spec.values ?? {},
    hasValuesFrom: (spec.valuesFrom ?? []).length > 0,
  };
}

function readiness(conditions: { type: string; status: string; message?: string }[]): Pick<FluxState, 'ready' | 'message'> {
  const ready = conditions.find((c) => c.type === 'Ready');
  if (!ready) return { ready: 'Unknown', message: 'Flux has not reported on this release yet' };
  return { ready: ready.status, message: ready.message ?? '' };
}

/** One line on how Flux stands with the release. */
export function fluxSummary(state: FluxState): string {
  if (state.suspended) return 'Flux suspended';
  const at = state.revision ? ` at ${state.revision}` : '';
  if (state.ready === 'True' && state.current) return `Flux ready${at}`;
  if (state.ready === 'False') return `Flux failed: ${state.message}`;
  return 'Flux reconciling';
}

/** Where a rollout stands, from the release Flux started at and what it reports now. */
export type RolloutState = 'waiting' | 'reconciling' | 'done' | 'failed' | 'suspended';

export function rolloutState(start: FluxState, now: FluxState, crewReady: boolean): RolloutState {
  if (now.suspended) return 'suspended';
  if (now.revision === start.revision) return 'waiting';
  if (now.ready === 'False' && now.current) return 'failed';
  if (now.ready === 'True' && now.current && crewReady) return 'done';
  return 'reconciling';
}
