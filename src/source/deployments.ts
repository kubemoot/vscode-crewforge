import type { CrewSummary } from '../k8s/crews';

/** How a crew deployment is kept up to date. */
export type Channel = 'flux' | 'helm' | 'bundle';

/** Annotations CrewForge writes on the Crews it deploys; the operator mirrors them onto the namespace. */
export const ANNOTATIONS = {
  source: 'crewforge.kubemoot.ai/source',
  owner: 'crewforge.kubemoot.ai/owner',
  revision: 'crewforge.kubemoot.ai/revision',
  channel: 'crewforge.kubemoot.ai/channel',
  deployedAt: 'crewforge.kubemoot.ai/deployed-at',
} as const;

/** One live deployment of a crew source: a Crew of the source's name in some namespace. */
export interface Deployment {
  namespace: string;
  crew: CrewSummary;
  channel: Channel;
  /** The Helm release that installed it, when Helm or Flux did. */
  release?: string;
  owner?: string;
  revision?: string;
  /** True when the Crew names this source as its own; false when only the names match. */
  linked: boolean;
}

/** The channel a live Crew came through, read from the marks Flux, Helm, and CrewForge leave on it. */
export function channelOf(crew: CrewSummary): Channel {
  const labels = crew.labels ?? {};
  if (labels['helm.toolkit.fluxcd.io/name'] || labels['kustomize.toolkit.fluxcd.io/name']) return 'flux';
  if (labels['app.kubernetes.io/managed-by'] === 'Helm') return 'helm';
  const recorded = crew.annotations?.[ANNOTATIONS.channel];
  return recorded === 'flux' || recorded === 'helm' ? recorded : 'bundle';
}

/**
 * The deployments of a source: live Crews with the name the source renders. A source can
 * be deployed to many namespaces; each is its own deployment.
 */
export function deploymentsOf(sourceId: string, crewName: string, crews: CrewSummary[]): Deployment[] {
  return crews
    .filter((c) => c.name === crewName)
    .map((crew) => {
      const annotations = crew.annotations ?? {};
      return {
        namespace: crew.namespace,
        crew,
        channel: channelOf(crew),
        release: annotations['meta.helm.sh/release-name'],
        owner: annotations[ANNOTATIONS.owner],
        revision: annotations[ANNOTATIONS.revision],
        linked: annotations[ANNOTATIONS.source] === sourceId,
      };
    })
    .sort((a, b) => a.namespace.localeCompare(b.namespace));
}

/** The line under a deployment in the tree. */
export function deploymentDescription(d: Deployment, drift?: string): string {
  const parts = [d.channel, d.crew.phase];
  if (drift) parts.push(drift);
  if (!d.linked) parts.push('same name, other source?');
  return parts.join(' · ');
}
