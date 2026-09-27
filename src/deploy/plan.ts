import type { CrewSummary } from '../k8s/crews';
import { ANNOTATIONS, channelOf, type Channel } from '../source/deployments';
import type { CrewSource } from '../source/discover';
import type { SourceIdentity } from '../source/identity';

/** One way to deploy into a namespace, and why it is unavailable when it is. */
export interface ChannelOption {
  channel: Channel;
  enabled: boolean;
  reason?: string;
}

/** What CrewForge knows about the target namespace before deploying. */
export interface TargetState {
  namespace: string;
  /** False when the namespace does not exist; undefined when the account may not read it. */
  exists?: boolean;
  /** The Crews already in the namespace. */
  crews: CrewSummary[];
}

/** The Crew of this name already in the target namespace, if any. */
export function existingCrew(target: TargetState, crewName: string): CrewSummary | undefined {
  return target.crews.find((c) => c.name === crewName);
}

const NOT_FLUX = 'Flux does not manage this crew here; a HelmRelease in your GitOps repository would';

/**
 * The deploy channels for a source into a namespace. A crew already there keeps the
 * channel it came through: Flux-managed crews change only through git, a Helm release
 * only through Helm, a bundle only through kubectl, so two channels never fight over
 * the same objects.
 */
export function channelOptions(source: CrewSource, crewName: string, target: TargetState): ChannelOption[] {
  const existing = existingCrew(target, crewName);
  const helmSource = source.kind === 'helm' ? undefined : 'the source is plain manifests, not a Helm chart';
  if (!existing) {
    return [option('helm', helmSource), option('bundle'), option('flux', NOT_FLUX)];
  }
  const current = channelOf(existing);
  const held = (by: string) => `${by} owns ${crewName} in ${target.namespace}; remove it first to switch`;
  if (current === 'flux') {
    const managed = `Flux manages ${crewName} in ${target.namespace}; change it through git`;
    return [option('flux'), option('helm', managed), option('bundle', managed)];
  }
  if (current === 'helm') return [option('helm', helmSource), option('bundle', held('a Helm release')), option('flux', NOT_FLUX)];
  return [option('bundle'), option('helm', helmSource ?? held('a bundle applied with kubectl')), option('flux', NOT_FLUX)];
}

function option(channel: Channel, reason?: string): ChannelOption {
  return reason ? { channel, enabled: false, reason } : { channel, enabled: true };
}

/**
 * What a developer must confirm before deploying: replacing a crew that came from
 * another source or belongs to someone else, a crew CrewForge did not deploy, or a
 * namespace that already holds other crews.
 */
export function ownershipWarnings(identity: SourceIdentity, crewName: string, target: TargetState): string[] {
  const warnings: string[] = [];
  const existing = existingCrew(target, crewName);
  if (existing) warnings.push(...replaceWarnings(identity, existing, target.namespace));
  const others = target.crews.filter((c) => c.name !== crewName).map((c) => c.name);
  if (others.length) warnings.push(`${target.namespace} already holds ${others.length === 1 ? 'the crew' : 'the crews'} ${others.join(', ')}.`);
  return warnings;
}

function replaceWarnings(identity: SourceIdentity, existing: CrewSummary, namespace: string): string[] {
  const annotations = existing.annotations ?? {};
  const source = annotations[ANNOTATIONS.source];
  const owner = annotations[ANNOTATIONS.owner];
  const where = `${existing.name} in ${namespace}`;
  if (!source) return [`${where} was not deployed by CrewForge; its source is unknown and this deploy replaces it.`];
  const warnings: string[] = [];
  if (source !== identity.id) warnings.push(`${where} came from ${source}, not from ${identity.id}.`);
  if (owner && identity.owner && owner !== identity.owner) warnings.push(`${where} was deployed by ${owner}.`);
  return warnings;
}
