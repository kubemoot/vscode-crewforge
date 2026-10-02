import { KubeError, type KubeTransport } from '../src/k8s/request';
import type { Manifest } from '../src/source/manifests';

const GROUP = '/apis/kubemoot.ai/v1alpha1';

export const KINDS: Record<string, string> = {
  Crew: 'crews',
  Agent: 'agents',
  PromptModule: 'promptmodules',
  Model: 'models',
  CrewFitness: 'crewfitnesses',
  CrewFitnessSuite: 'crewfitnesssuites',
  Skill: 'skills',
  MCPServer: 'mcpservers',
  CrewSchedulingPolicy: 'crewschedulingpolicies',
  ModelProvider: 'modelproviders',
  EmbeddingModel: 'embeddingmodels',
  RAGSource: 'ragsources',
  MCPGateway: 'mcpgateways',
  MCPQualityPolicy: 'mcpqualitypolicies',
  MCPCatalog: 'mcpcatalogs',
  MCPServerReport: 'mcpserverreports',
  NotificationSink: 'notificationsinks',
  MootArchetype: 'mootarchetypes',
  KubemootConfig: 'kubemootconfigs',
};

/** The kinds the operator serves cluster-scoped. */
export const CLUSTER_SCOPED = new Set(['MootArchetype', 'KubemootConfig']);

/**
 * An in-memory API server for the Kubemoot group: discovery, list, get, and delete per
 * namespace, and cluster-wide Crew lists. Records every call.
 */
export class FakeCluster implements KubeTransport {
  calls: { method: string; path: string; body?: unknown }[] = [];
  objects: Manifest[] = [];
  /** Namespaces that exist; reading any other answers 404. */
  namespaces = new Set<string>();
  /** Paths that answer with this error instead. */
  failures = new Map<string, Error>();
  /** Other GET paths and the body each answers with, such as a service proxy path. */
  bodies = new Map<string, string>();

  add(...objects: Manifest[]): this {
    this.objects.push(...objects);
    return this;
  }

  async request(method: string, path: string, body?: unknown): Promise<string> {
    this.calls.push({ method, path, body });
    const failure = this.failures.get(path);
    if (failure) throw failure;
    const body0 = this.bodies.get(path);
    if (method === 'GET' && body0 !== undefined) return body0;
    if (method === 'GET') return JSON.stringify(this.get(path));
    if (method === 'PATCH') return '{}';
    if (method === 'DELETE') return JSON.stringify(this.remove(path));
    if (method === 'POST') {
      const created = body as Manifest;
      this.objects.push({ ...created, kind: created.kind });
      return JSON.stringify(created);
    }
    throw new Error(`FakeCluster: unexpected ${method} ${path}`);
  }

  stream(): Promise<void> {
    return Promise.reject(new Error('FakeCluster does not stream'));
  }

  private remove(path: string): Manifest {
    const found = this.get(path) as Manifest;
    this.objects = this.objects.filter((o) => o !== found);
    return found;
  }

  /** A cluster-scoped object by its plural and name. */
  private clusterObject(plural: string, name: string): Manifest {
    const found = this.objects.find((o) => KINDS[o.kind] === plural && o.metadata.name === name);
    if (!found) throw new KubeError(`${plural} "${name}" not found`, 404);
    return found;
  }

  private get(path: string): unknown {
    if (path === GROUP) return { resources: discovery() };
    const namespace = /^\/api\/v1\/namespaces\/([^/]+)$/.exec(path)?.[1];
    if (namespace) {
      if (!this.namespaces.has(namespace)) throw new KubeError(`namespaces "${namespace}" not found`, 404);
      return { metadata: { name: namespace } };
    }
    const configMaps = /^\/api\/v1\/namespaces\/([^/]+)\/configmaps\?labelSelector=(.*)$/.exec(path);
    if (configMaps) return { items: this.labeled('ConfigMap', configMaps[1], decodeURIComponent(configMaps[2])) };
    const everywhere = /^\/apis\/kubemoot\.ai\/v1alpha1\/([a-z]+)$/.exec(path)?.[1];
    if (everywhere) return { items: this.objects.filter((o) => KINDS[o.kind] === everywhere) };
    const clusterObject = /^\/apis\/kubemoot\.ai\/v1alpha1\/([a-z]+)\/([^/]+)$/.exec(path);
    if (clusterObject) return this.clusterObject(clusterObject[1], decodeURIComponent(clusterObject[2]));
    const m = /^\/apis\/kubemoot\.ai\/v1alpha1\/namespaces\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/.exec(path);
    if (!m) throw new Error(`FakeCluster: no route for GET ${path}`);
    return this.namespaced(m[1], m[2], m[3]);
  }

  /** The objects of a kind in a namespace that carry every label of a `k=v,k=v` selector. */
  private labeled(kind: string, ns: string, selector: string): Manifest[] {
    const wanted = selector.split(',').map((pair) => pair.split('='));
    return this.objects.filter((o) => o.kind === kind && o.metadata.namespace === ns && wanted.every(([k, v]) => o.metadata.labels?.[k] === v));
  }

  /** A namespace's objects of a kind, or one of them by name. */
  private namespaced(ns: string, plural: string, name?: string): unknown {
    const items = this.objects.filter((o) => KINDS[o.kind] === plural && o.metadata.namespace === ns);
    if (name === undefined) return { items: items.map(({ kind: _kind, apiVersion: _api, ...rest }) => rest) };
    const found = items.find((o) => o.metadata.name === decodeURIComponent(name));
    if (!found) throw new KubeError(`${plural} "${name}" not found`, 404);
    return found;
  }
}

function discovery() {
  return Object.entries(KINDS).flatMap(([kind, plural]) => [
    { name: plural, kind, namespaced: !CLUSTER_SCOPED.has(kind) },
    { name: `${plural}/status`, kind, namespaced: !CLUSTER_SCOPED.has(kind) },
  ]);
}

/** A Kubemoot object for tests. */
export function obj(kind: string, name: string, namespace: string, spec: Record<string, unknown> = {}, labels: Record<string, string> = {}): Manifest {
  return { apiVersion: 'kubemoot.ai/v1alpha1', kind, metadata: { name, namespace, labels }, spec };
}

const ADL = 'DEFINE COMPONENT triage\nWHEN a question arrives\nTHEN answer it';
const PROSE = 'You are a helpful coordinator. When a question arrives, answer it.';

/**
 * A crew as a chart installs it: a Crew of release "lab" with a coordinator and a
 * tooler, their PromptModules (one ADL, one prose, one shared with another crew, one
 * missing), a Skill, MCPServers (one named, one from the release, one unrelated), a
 * CrewSchedulingPolicy, and an agent of another crew.
 */
export function seedCrew(cluster: FakeCluster, namespace = 'team-a'): FakeCluster {
  const release = { 'app.kubernetes.io/instance': 'lab', 'app.kubernetes.io/managed-by': 'Helm', 'helm.sh/chart': 'lab-crew-0.4.0' };
  const member = { 'kubemoot.ai/crew': 'lab-ops' };
  const crew = obj('Crew', 'lab-ops', namespace, { description: 'Answers lab questions' }, release);
  crew.metadata.annotations = { 'meta.helm.sh/release-name': 'lab', 'meta.helm.sh/release-namespace': namespace };
  crew.metadata.managedFields = [{ manager: 'helm' }];
  crew.status = { ready: true, phase: 'Ready', agentCount: 2 };
  const coordinator = obj('Agent', 'coordinator', namespace, { discussRole: 'coordinator', capabilities: ['reasoning'], promptRefs: ['rules', 'style'] }, member);
  coordinator.status = { ready: true, phase: 'Running' };
  const tooler = obj('Agent', 'k8s', namespace, { discussRole: 'tooler', capabilities: ['tool-calling', 'kubernetes'], promptRefs: ['rules', 'shared', 'gone'], enabledTools: ['pods_list', 'helm_list'], mcpServers: [{ name: 'kubernetes' }] }, member);
  tooler.status = { phase: 'Pending' };
  const other = obj('Agent', 'elsewhere', namespace, { promptRefs: ['shared'], enabledTools: ['nope'] }, { 'kubemoot.ai/crew': 'other' });
  const kube = obj('MCPServer', 'kubernetes', namespace, {});
  kube.status = { ready: true, tools: [{ name: 'pods_list' }, { name: 'helm_list' }] };
  return cluster.add(
    crew,
    coordinator,
    tooler,
    other,
    obj('PromptModule', 'rules', namespace, { order: 5, content: ADL }),
    obj('PromptModule', 'style', namespace, { content: PROSE }),
    obj('PromptModule', 'shared', namespace, { order: 50, content: PROSE }),
    obj('Skill', 'runbook', namespace, { description: 'Restart a pod', content: ADL, order: 10 }, member),
    kube,
    obj('MCPServer', 'web', namespace, {}, release),
    obj('MCPServer', 'unrelated', namespace, {}),
    obj('CrewSchedulingPolicy', 'lab-ops', namespace, { crewRef: 'lab-ops', archetypeRef: 'consent-3' }),
  );
}

/**
 * What a crew uses beyond its members, as a cluster holds it: a Model of the crew and one
 * of another crew, the ModelProvider they run on in the system namespace, a RAGSource the
 * coordinator names with its EmbeddingModel, the namespace's MCPGateway with a quality
 * policy, a NotificationSink, a fitness suite, the consent-3 archetype, and the
 * operator's KubemootConfig. The gateway's tool catalog answers through the service proxy.
 */
export function seedInfrastructure(cluster: FakeCluster, namespace = 'team-a'): FakeCluster {
  const release = { 'app.kubernetes.io/instance': 'lab' };
  const own = obj('Model', 'qwen-8b', namespace, { model: 'qwen3:8b', providerRef: 'ollama', vramMib: 5120 }, { ...release, latencyClass: 'low', contextWindow: '40960', 'capability/tool-calling': 'true' });
  own.status = { ready: true, state: 'Available' };
  const other = obj('Model', 'big', namespace, { model: 'qwen3:32b', providerRef: 'ollama', contextLength: 32768 }, { 'kubemoot.ai/crew': 'other', latencyClass: 'high' });
  const provider = obj('ModelProvider', 'ollama', 'kubemoot', { type: 'ollama', endpoint: 'http://ollama:11434', scheduling: { weight: 100 } });
  provider.status = { ready: true, phase: 'Ready' };
  const rag = obj('RAGSource', 'docs', namespace, { source: { type: 'git', git: { url: 'https://example.com/docs.git', branch: 'main', paths: ['docs/'] } }, embeddingModelRef: 'nomic', vectorStore: { type: 'pgvector', endpoint: 'pg:5432/v', collection: 'docs' }, chunking: { chunkSize: 800 } }, release);
  rag.status = { ready: true, phase: 'Ready', indexingStats: { lastIndexed: '2026-09-30T08:00:00Z', documentCount: 12 } };
  const gateway = obj('MCPGateway', 'lab-gateway', namespace, { implementation: 'kubemoot', qualityPolicyRef: 'lab-quality' }, release);
  gateway.status = { ready: true, mcpServers: ['kubernetes', 'helm-tools'] };
  const coordinator = cluster.objects.find((o) => o.kind === 'Agent' && o.metadata.name === 'coordinator' && o.metadata.namespace === namespace);
  if (coordinator) (coordinator.spec as Record<string, unknown>).ragSources = [{ name: 'docs' }];
  cluster.bodies.set(
    `/api/v1/namespaces/${namespace}/services/lab-gateway:8080/proxy/tools`,
    JSON.stringify({ count: 1, tools: [{ name: 'pods_list', description: 'List pods', inputSchema: { type: 'object', properties: { namespace: { type: 'string' } }, required: ['namespace'] }, serverName: 'kubernetes' }] }),
  );
  return cluster.add(
    own,
    other,
    provider,
    obj('EmbeddingModel', 'nomic', namespace, { model: 'nomic-embed-text', providerRef: 'ollama', dimensions: 768 }, release),
    rag,
    gateway,
    obj('MCPServer', 'helm-tools', namespace, {}),
    obj('MCPQualityPolicy', 'lab-quality', namespace, { allowing: [{}], considering: { enabled: true } }, release),
    obj('NotificationSink', 'pager', namespace, { webhook: { url: 'https://ntfy.example.com/secret-topic' } }),
    obj('CrewFitnessSuite', 'lab-ops-smoke', namespace, { crewRef: 'lab-ops', iterations: 1, scripts: [{ testRef: 'hello' }] }, { 'kubemoot.ai/crew': 'lab-ops' }),
    { apiVersion: 'kubemoot.ai/v1alpha1', kind: 'MootArchetype', metadata: { name: 'consent-3' }, spec: { phases: [{ name: 'triage' }, { name: 'mulling' }, { name: 'synthesis' }] } },
    { apiVersion: 'kubemoot.ai/v1alpha1', kind: 'KubemootConfig', metadata: { name: 'default' }, spec: {} },
  );
}
