import { CORE_SCHEMA, dump, loadAll, mergeTag } from 'js-yaml';
import { toKyaml } from './kyaml';

/** YAML 1.2 plus merge keys (<<), which kubectl and Helm resolve in manifests. */
const MANIFEST_SCHEMA = CORE_SCHEMA.withTags(mergeTag);

/** How CrewForge writes an object it shows: block YAML, or KYAML as `kubectl get -o kyaml` prints it. */
export type YamlFormat = 'yaml' | 'kyaml';

/** YAML as CrewForge shows objects in an editor: long lines kept, no anchors; or one KYAML document. */
export function dumpYaml(value: unknown, format: YamlFormat = 'yaml'): string {
  return format === 'kyaml' ? toKyaml(value) : dump(value, { lineWidth: 120, noRefs: true });
}

/** Joins documents into one stream; KYAML documents open with their own `---`. */
export function joinDocuments(documents: string[], format: YamlFormat = 'yaml'): string {
  return documents.join(format === 'kyaml' ? '' : '---\n');
}

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
  return loadAll(text, { schema: MANIFEST_SCHEMA }).filter(isManifest);
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

/** A stable identity for an object within one namespace: `Kind/name`. */
export function keyOf(kind: string, name: string): string {
  return `${kind}/${name}`;
}

export function objectKey(m: Pick<Manifest, 'kind' | 'metadata'>): string {
  return keyOf(m.kind, m.metadata.name);
}

/** kubectl's copy of the object as last applied, which is noise in any view of it. */
export const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration';

/** YAML of a live object as the API server holds it, less managedFields and kubectl's last-applied copy of the object. */
export function toLiveYaml(m: Manifest, format: YamlFormat = 'yaml'): string {
  return dumpYaml(stripMetadata(m, ['managedFields']), format);
}

/** A copy of the object without the named metadata fields and kubectl's last-applied annotation; an emptied annotation map goes too. */
function stripMetadata(m: Manifest, fields: string[]): Manifest {
  const metadata = { ...m.metadata };
  for (const field of fields) delete metadata[field];
  const annotations = { ...metadata.annotations };
  delete annotations[LAST_APPLIED];
  if (Object.keys(annotations).length) metadata.annotations = annotations;
  else delete metadata.annotations;
  return { ...m, metadata };
}
