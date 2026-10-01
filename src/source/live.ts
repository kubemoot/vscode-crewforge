import { checkName } from '../k8s/paths';
import type { KubeTransport } from '../k8s/request';
import { isKubemoot, KUBEMOOT_GROUP, objectKey, type Manifest } from './manifests';

const GROUP_VERSION_PATH = `/apis/${KUBEMOOT_GROUP}/v1alpha1`;

/** A Kubemoot kind the API server serves, and the plural its paths use. */
export interface KubemootKind {
  kind: string;
  plural: string;
  namespaced: boolean;
}

/** Asks the API server which Kubemoot kinds it serves (subresources left out). */
export async function discoverKinds(client: KubeTransport): Promise<Map<string, KubemootKind>> {
  const body = JSON.parse(await client.request('GET', GROUP_VERSION_PATH)) as { resources?: { name: string; kind: string; namespaced: boolean }[] };
  const kinds = new Map<string, KubemootKind>();
  for (const r of body.resources ?? []) {
    if (!r.name.includes('/')) kinds.set(r.kind, { kind: r.kind, plural: r.name, namespaced: r.namespaced });
  }
  return kinds;
}

/** The API path of one namespaced Kubemoot object, or of its collection when name is omitted. */
export function objectPath(kind: KubemootKind, namespace: string, name?: string): string {
  const collection = `${GROUP_VERSION_PATH}/namespaces/${checkName('namespace', namespace)}/${kind.plural}`;
  return name === undefined ? collection : `${collection}/${encodeURIComponent(name)}`;
}

/**
 * The live objects that belong to a crew deployment: every object of the rendered
 * Kubemoot kinds in the namespace that the source renders by name, or that carries the
 * crew's label and no owner (an owned object is made by a controller, such as the
 * operator's resume RAGSource, not by the source).
 */
export async function liveObjects(client: KubeTransport, kinds: Map<string, KubemootKind>, namespace: string, rendered: Manifest[], crew: string): Promise<Manifest[]> {
  const wanted = rendered.filter(isKubemoot);
  const names = new Set(wanted.map(objectKey));
  const kindNames = [...new Set(wanted.map((m) => m.kind))].filter((k) => kinds.get(k)?.namespaced);
  const lists = await Promise.all(kindNames.map((k) => listKind(client, kinds.get(k) as KubemootKind, namespace)));
  return lists.flat().filter((m) => names.has(objectKey(m)) || madeForCrew(m, crew));
}

/** True when the object carries the crew's label and no controller made it: a crew's own object, as a source or a deploy writes it. */
export function madeForCrew(m: Manifest, crew: string): boolean {
  return m.metadata.labels?.['kubemoot.ai/crew'] === crew && !isOwned(m);
}

/** True when a controller owns the object (it has ownerReferences), so its owner, not a source, makes it. */
export function isOwned(m: Manifest): boolean {
  const owners = m.metadata.ownerReferences;
  return Array.isArray(owners) && owners.length > 0;
}

/** Every object of one Kubemoot kind in a namespace, with its kind and apiVersion filled in. */
export async function listKind(client: KubeTransport, kind: KubemootKind, namespace: string): Promise<Manifest[]> {
  const body = JSON.parse(await client.request('GET', objectPath(kind, namespace))) as { items?: Manifest[] };
  return (body.items ?? []).map((m) => ({ ...m, apiVersion: m.apiVersion ?? `${KUBEMOOT_GROUP}/v1alpha1`, kind: kind.kind }));
}

/**
 * Every live object of a crew without a source to say which: its Crew, and the objects of
 * any namespaced Kubemoot kind made for it. A kind that cannot be read is left out, since
 * this lists everything for a person to look at; liveObjects, which feeds the drift,
 * fails instead, so a comparison is never made on a partial list.
 */
export async function crewObjects(client: KubeTransport, kinds: Map<string, KubemootKind>, namespace: string, crew: string): Promise<Manifest[]> {
  const namespaced = [...kinds.values()].filter((k) => k.namespaced);
  const lists = await Promise.all(namespaced.map((k) => listKind(client, k, namespace).catch((): Manifest[] => [])));
  const ofCrew = (m: Manifest) => (m.kind === 'Crew' && m.metadata.name === crew) || madeForCrew(m, crew);
  return lists.flat().filter(ofCrew).sort((a, b) => a.kind.localeCompare(b.kind) || a.metadata.name.localeCompare(b.metadata.name));
}
