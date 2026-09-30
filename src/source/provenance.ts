import type { CrewSummary } from '../k8s/crews';
import { ANNOTATIONS, channelOf, type Channel } from './deployments';

/** The Flux object that applies a crew: a HelmRelease (helm-controller) or a Kustomization (kustomize-controller). */
export interface FluxOwner {
  kind: 'HelmRelease' | 'Kustomization';
  name: string;
  namespace: string;
}

/** Where a live crew came from, read only from the labels and annotations on its Crew. */
export interface Provenance {
  channel: Channel;
  /** The chart name, from helm.sh/chart. */
  chart?: string;
  /** The chart version, from helm.sh/chart or kubemoot.ai/crew-version. */
  chartVersion?: string;
  /** app.kubernetes.io/version. */
  appVersion?: string;
  /** The Helm release, from meta.helm.sh/release-name and release-namespace. */
  release?: string;
  releaseNamespace?: string;
  managedBy?: string;
  flux?: FluxOwner;
  /** What a CrewForge deploy recorded. */
  source?: string;
  revision?: string;
  owner?: string;
  deployedAt?: string;
}

const HELM_CHART = /^(.+?)-(v?\d+\.\d+\.\d+.*)$/;

/** Splits helm.sh/chart ("homelab-pilot-crew-0.45.1-rc.0") into its name and version. */
export function splitChart(label?: string): { chart?: string; version?: string } {
  if (!label) return {};
  const m = HELM_CHART.exec(label);
  return m ? { chart: m[1], version: m[2] } : { chart: label };
}

export function fluxOwnerOf(labels: Record<string, string>): FluxOwner | undefined {
  const helm = labels['helm.toolkit.fluxcd.io/name'];
  if (helm) return { kind: 'HelmRelease', name: helm, namespace: labels['helm.toolkit.fluxcd.io/namespace'] ?? '' };
  const kustomization = labels['kustomize.toolkit.fluxcd.io/name'];
  if (kustomization) return { kind: 'Kustomization', name: kustomization, namespace: labels['kustomize.toolkit.fluxcd.io/namespace'] ?? '' };
  return undefined;
}

export function provenanceOf(crew: CrewSummary): Provenance {
  const labels = crew.labels ?? {};
  const annotations = crew.annotations ?? {};
  const { chart, version } = splitChart(labels['helm.sh/chart']);
  return {
    channel: channelOf(crew),
    chart,
    chartVersion: version ?? labels['kubemoot.ai/crew-version']?.replace(/_/g, '+'),
    appVersion: labels['app.kubernetes.io/version'],
    release: annotations['meta.helm.sh/release-name'],
    releaseNamespace: annotations['meta.helm.sh/release-namespace'],
    managedBy: labels['app.kubernetes.io/managed-by'],
    flux: fluxOwnerOf(labels),
    source: annotations[ANNOTATIONS.source],
    revision: annotations[ANNOTATIONS.revision],
    owner: annotations[ANNOTATIONS.owner],
    deployedAt: annotations[ANNOTATIONS.deployedAt],
  };
}

/** One fact about where a crew came from: a label for the tree and its value. */
export interface ProvenanceFact {
  label: string;
  value: string;
  /** Set on the fact that names a Flux object, so its YAML can be opened. */
  flux?: FluxOwner;
}

/** The facts worth showing, in reading order; the channel always comes first. */
export function provenanceFacts(p: Provenance): ProvenanceFact[] {
  const facts: ProvenanceFact[] = [{ label: 'Channel', value: channelText(p) }];
  const add = (label: string, value?: string) => value && facts.push({ label, value });
  add('Chart', [p.chart, p.chartVersion].filter(Boolean).join(' ') || undefined);
  add('App version', p.appVersion);
  add('Helm release', p.release && (p.releaseNamespace ? `${p.releaseNamespace}/${p.release}` : p.release));
  if (p.flux) facts.push({ label: `Flux ${p.flux.kind}`, value: `${p.flux.namespace}/${p.flux.name}`, flux: p.flux });
  add('Source', p.source);
  add('Revision', p.revision);
  add('Deployed by', p.owner);
  add('Deployed at', p.deployedAt);
  return facts;
}

const CHANNEL_TEXT: Record<Channel, string> = {
  flux: 'GitOps (Flux)',
  helm: 'Helm',
  bundle: 'kubectl apply (bundle)',
};

function channelText(p: Provenance): string {
  if (p.channel === 'bundle' && p.managedBy && p.managedBy !== 'Helm') return `managed by ${p.managedBy}`;
  return CHANNEL_TEXT[p.channel];
}
