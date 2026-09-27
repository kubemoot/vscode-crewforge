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

/** A revision without the marker CrewForge adds when the source had uncommitted edits. */
export function stripDirty(revision?: string): string | undefined {
  return revision?.replace(/-dirty$/, '');
}

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

/** The operator's revision record as tooltip lines, newest first. */
export function historyLines(d: Deployment, limit = 5): string[] {
  const revisions = d.crew.revisions ?? [];
  if (revisions.length === 0) return [];
  const lines = revisions.slice(0, limit).map((r) => {
    const what = r.revision ?? r.crewVersion ?? 'unknown';
    const who = [r.channel, r.owner].filter(Boolean).join(' by ');
    return `  ${what}${who ? ` via ${who}` : ''} (${r.deployedAt ?? r.observedAt ?? 'time unknown'})`;
  });
  return ['Deployed revisions:', ...lines];
}

/** When the operator saw a revision deployed, keyed by revision, for marking commits. */
export function deployedAtByRevision(d: Deployment): Map<string, string> {
  const seen = new Map<string, string>();
  for (const r of d.crew.revisions ?? []) {
    const hash = stripDirty(r.revision);
    if (hash && !seen.has(hash)) seen.set(hash, r.deployedAt ?? r.observedAt ?? '');
  }
  return seen;
}

/** The line under a deployment in the tree. */
export function deploymentDescription(d: Deployment, drift?: string, flux?: string): string {
  const parts = [flux ?? d.channel, d.crew.phase];
  if (drift) parts.push(drift);
  if (!d.linked) parts.push('same name, other source?');
  return parts.join(' · ');
}
