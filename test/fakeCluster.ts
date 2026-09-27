import { KubeError, type KubeTransport } from '../src/k8s/request';
import type { Manifest } from '../src/source/manifests';

const GROUP = '/apis/kubemoot.ai/v1alpha1';

export const KINDS: Record<string, string> = {
  Crew: 'crews',
  Agent: 'agents',
  PromptModule: 'promptmodules',
  Model: 'models',
  CrewFitness: 'crewfitnesses',
};

/**
 * An in-memory API server for the Kubemoot group: discovery, list and get per
 * namespace, and cluster-wide Crew lists. Records every call.
 */
export class FakeCluster implements KubeTransport {
  calls: { method: string; path: string; body?: unknown }[] = [];
  objects: Manifest[] = [];
  /** Namespaces that exist; reading any other answers 404. */
  namespaces = new Set<string>();
  /** Paths that answer with this error instead. */
  failures = new Map<string, Error>();

  add(...objects: Manifest[]): this {
    this.objects.push(...objects);
    return this;
  }

  async request(method: string, path: string, body?: unknown): Promise<string> {
    this.calls.push({ method, path, body });
    const failure = this.failures.get(path);
    if (failure) throw failure;
    if (method === 'GET') return JSON.stringify(this.get(path));
    if (method === 'PATCH') return '{}';
    throw new Error(`FakeCluster: unexpected ${method} ${path}`);
  }

  stream(): Promise<void> {
    return Promise.reject(new Error('FakeCluster does not stream'));
  }

  private get(path: string): unknown {
    if (path === GROUP) return { resources: discovery() };
    const namespace = /^\/api\/v1\/namespaces\/([^/]+)$/.exec(path)?.[1];
    if (namespace) {
      if (!this.namespaces.has(namespace)) throw new KubeError(`namespaces "${namespace}" not found`, 404);
      return { metadata: { name: namespace } };
    }
    if (path === `${GROUP}/crews`) return { items: this.objects.filter((o) => o.kind === 'Crew') };
    const m = /^\/apis\/kubemoot\.ai\/v1alpha1\/namespaces\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/.exec(path);
    if (!m) throw new Error(`FakeCluster: no route for GET ${path}`);
    const [, ns, plural, name] = m;
    const items = this.objects.filter((o) => KINDS[o.kind] === plural && o.metadata.namespace === ns);
    if (name === undefined) return { items: items.map(({ kind: _kind, apiVersion: _api, ...rest }) => rest) };
    const found = items.find((o) => o.metadata.name === decodeURIComponent(name));
    if (!found) throw Object.assign(new Error(`${plural} "${name}" not found`), { status: 404 });
    return found;
  }
}

function discovery() {
  return Object.entries(KINDS).flatMap(([kind, plural]) => [
    { name: plural, kind, namespaced: true },
    { name: `${plural}/status`, kind, namespaced: true },
  ]);
}

/** A Kubemoot object for tests. */
export function obj(kind: string, name: string, namespace: string, spec: Record<string, unknown> = {}, labels: Record<string, string> = {}): Manifest {
  return { apiVersion: 'kubemoot.ai/v1alpha1', kind, metadata: { name, namespace, labels }, spec };
}
