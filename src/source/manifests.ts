import { dump, loadAll } from 'js-yaml';

/** A Kubernetes object as it appears in a manifest file or comes back from the API server. */
export interface Manifest {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export const KUBEMOOT_GROUP = 'kubemoot.ai';

/** Parses a multi-document YAML text into the objects that have a kind and a name; skips empty documents. */
export function parseManifests(text: string): Manifest[] {
  return loadAll(text).filter(isManifest);
}

function isManifest(doc: unknown): doc is Manifest {
  if (!doc || typeof doc !== 'object') return false;
  const m = doc as Partial<Manifest>;
  return typeof m.apiVersion === 'string' && typeof m.kind === 'string' && typeof m.metadata?.name === 'string';
}

/** True for the Kubemoot custom resources CrewForge renders, compares, and applies. */
export function isKubemoot(m: Manifest): boolean {
  return m.apiVersion.split('/')[0] === KUBEMOOT_GROUP;
}

/** The one Crew in a set of manifests, or undefined. */
export function crewOf(manifests: Manifest[]): Manifest | undefined {
  return manifests.find((m) => m.kind === 'Crew' && isKubemoot(m));
}

/** A stable identity for an object within one namespace. */
export function objectKey(m: Pick<Manifest, 'kind' | 'metadata'>): string {
  return `${m.kind}/${m.metadata.name}`;
}

/** YAML for showing an object in an editor: server bookkeeping removed, keys in a readable order. */
export function toYaml(m: Manifest): string {
  return dump(presentable(m), { lineWidth: 120, noRefs: true });
}

const SERVER_METADATA = ['managedFields', 'resourceVersion', 'uid', 'generation', 'creationTimestamp'];

function presentable(m: Manifest): Manifest {
  const metadata = { ...m.metadata };
  for (const field of SERVER_METADATA) delete metadata[field];
  const annotations = { ...(metadata.annotations ?? {}) };
  delete annotations['kubectl.kubernetes.io/last-applied-configuration'];
  if (Object.keys(annotations).length) metadata.annotations = annotations;
  else delete metadata.annotations;
  return { ...m, metadata };
}
