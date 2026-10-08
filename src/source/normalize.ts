import { dumpYaml, type Manifest, type YamlFormat } from './manifests';

/** The first line of a normalized document, saying what was left out. */
export const NORMALIZED_NOTE = '# Normalized: status and the metadata the cluster, Helm, Flux, the operator, and CrewForge add are left out; keys are sorted.';

/** Metadata the API server keeps for itself, and the operator's finalizers. */
const SERVER_FIELDS = ['managedFields', 'resourceVersion', 'uid', 'generation', 'creationTimestamp', 'finalizers', 'selfLink'];

/** Annotations Helm, kubectl (its last-applied copy among them), and CrewForge's own deploys add; none of them is in a source. */
const ADDED_ANNOTATIONS = [/^meta\.helm\.sh\//, /^kubectl\.kubernetes\.io\//, /^crewforge\.kubemoot\.ai\//];

/** Labels Flux, Helm, and chart builds stamp, which change with every release rather than with the crew. */
const ADDED_LABELS = [/^helm\.toolkit\.fluxcd\.io\//, /^kustomize\.toolkit\.fluxcd\.io\//, /^helm\.sh\/chart$/, /^app\.kubernetes\.io\/version$/, /^kubemoot\.ai\/crew-version$/];

/**
 * An object as the diff compares it: without `status`, without the metadata the API
 * server, Helm, Flux, the operator, and CrewForge add, and with every map's keys in
 * order, so the two sides line up and only what a person wrote can differ.
 */
export function normalizeForDiff(m: Manifest): Record<string, unknown> {
  const { metadata, ...rest } = m;
  delete rest.status;
  const cleaned: Record<string, unknown> = { ...metadata };
  for (const field of SERVER_FIELDS) delete cleaned[field];
  setOrDrop(cleaned, 'annotations', without(metadata.annotations, ADDED_ANNOTATIONS));
  setOrDrop(cleaned, 'labels', without(metadata.labels, ADDED_LABELS));
  return sortKeys({ ...rest, metadata: cleaned }) as Record<string, unknown>;
}

/** The normalized object as YAML or KYAML. */
export function normalizedYaml(m: Manifest, format: YamlFormat = 'yaml'): string {
  return dumpYaml(normalizeForDiff(m), format);
}

/** A copy with every object's keys in order; arrays keep their order, since it can matter. */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== 'object') return value;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
  return Object.fromEntries(entries.map(([k, v]) => [k, sortKeys(v)]));
}

function without(map: Record<string, string> | undefined, patterns: RegExp[]): Record<string, string> {
  return Object.fromEntries(Object.entries(map ?? {}).filter(([key]) => !patterns.some((p) => p.test(key))));
}

function setOrDrop(target: Record<string, unknown>, key: string, map: Record<string, string>): void {
  if (Object.keys(map).length) target[key] = map;
  else delete target[key];
}

/**
 * The line that warns when the chart version of the source differs from the one
 * deployed, such as "source 0.2.2, deployed 0.46.0-rc.0"; undefined when either is
 * unknown or they match.
 */
export function chartVersionBanner(source?: string, deployed?: string): string | undefined {
  if (!source || !deployed || source === deployed) return undefined;
  return `Chart version differs: source ${source}, deployed ${deployed}`;
}
