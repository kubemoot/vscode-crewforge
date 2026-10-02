import { beforeEach, describe, expect, it } from 'vitest';
import { loadCrewDetails, missingText, type CrewDetails } from '../src/crew/details';
import type { CrewSummary } from '../src/k8s/crews';
import { KubeError, type KubeClient } from '../src/k8s/request';
import { discoverKinds } from '../src/source/live';
import { memberItem, membersOf, relatedView, sectionItem, sectionsOf, type DetailNode } from '../src/views/crewDetailsTree';
import { CrewTreeProvider, type CrewNode } from '../src/views/crewTree';
import { LiveDocuments, livePath, liveUri, showToolDetails } from '../src/views/liveDocuments';
import { FakeCluster, obj, seedCrew, seedInfrastructure } from './fakeCluster';
import { recorded, resetFake, ThemeIcon, Uri } from './vscodeFake';

const NS = 'team-a';
const CATALOG = `/api/v1/namespaces/${NS}/services/lab-gateway:8080/proxy/tools`;
const summary: CrewSummary = { name: 'lab-ops', namespace: NS, ready: true, phase: 'Ready', labels: { 'app.kubernetes.io/instance': 'lab', 'app.kubernetes.io/managed-by': 'Helm', 'helm.sh/chart': 'lab-crew-0.4.0' } };

type Section = Extract<DetailNode, { kind: 'section' }>;
type Member = Extract<DetailNode, { kind: 'member' }>;

let cluster: FakeCluster;
beforeEach(() => {
  resetFake();
  cluster = seedInfrastructure(seedCrew(new FakeCluster()));
});

const details = async (): Promise<CrewDetails> => loadCrewDetails(cluster, await discoverKinds(cluster), NS, 'lab-ops');
const leaves = (d: CrewDetails, section: string) => membersOf((sectionsOf(summary, d) as Section[]).find((s) => s.section === section)!) as Member[];
const shown = (members: Member[]) => members.map((m) => `${m.view.label}|${m.view.description ?? ''}`);

describe('a live crew with its infrastructure', () => {
  it('reads every kind it may use: namespace kinds, the system namespace providers, and the cluster-scoped kinds', async () => {
    await details();
    const paths = cluster.calls.map((c) => c.path);
    expect(paths).toContain('/apis/kubemoot.ai/v1alpha1/namespaces/kubemoot/modelproviders');
    expect(paths).toContain('/apis/kubemoot.ai/v1alpha1/mootarchetypes');
    expect(paths).toContain('/apis/kubemoot.ai/v1alpha1/kubemootconfigs');
    expect(paths).toContain(`/apis/kubemoot.ai/v1alpha1/namespaces/${NS}/notificationsinks`);
    expect(cluster.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('shows its Models and the provider they run on, the shared ones marked with their owner', async () => {
    const d = await details();
    expect(shown(leaves(d, 'models'))).toEqual([
      'big|Model · shared · qwen3:32b · high tier · 32768 context',
      'qwen-8b|Model · qwen3:8b · low tier · 40960 context',
      'ollama|ModelProvider · shared · ollama · http://ollama:11434',
    ]);
    const [big, mine, provider] = leaves(d, 'models').map(memberItem);
    expect(big.contextValue).toBe('liveObject-shared');
    expect(big.tooltip).toContain('Shared: owned by crew other. CrewForge shows it read-only.');
    expect(mine).toMatchObject({ contextValue: 'liveObject', command: { command: 'crewforge.showLiveYaml' } });
    expect(mine.tooltip).toContain('Capabilities: tool-calling');
    expect((mine.iconPath as ThemeIcon).id).toBe('pass-filled');
    expect(provider.tooltip).toContain('ModelProvider kubemoot/ollama');
    expect(leaves(d, 'models')[2].view.ref).toEqual({ kind: 'ModelProvider', name: 'ollama', namespace: 'kubemoot' });
  });

  it('shows its RAG sources with the embedding model, its MCP infrastructure, policies, notifications, fitness, and the operator', async () => {
    const d = await details();
    expect(shown(leaves(d, 'rag'))).toEqual(['docs|RAGSource · git: https://example.com/docs.git · main · docs/ · indexed 2026-09-30T08:00:00Z', 'nomic|EmbeddingModel · nomic-embed-text · 768 dimensions']);
    expect(leaves(d, 'rag')[0].view.tooltip).toContain('Chunking: 800 characters, 50 overlap');
    expect(shown(leaves(d, 'mcp'))).toEqual(['helm-tools|', 'kubernetes|ready · 2 tools', 'web|', 'lab-gateway|MCPGateway · kubemoot · 2 servers', 'lab-quality|MCPQualityPolicy · 1 allowed · 0 blocked · AI review on']);
    expect(leaves(d, 'mcp')[0].view.tooltip).toContain("registered with the agents' gateway");
    expect(shown(leaves(d, 'policies'))).toEqual(['lab-ops|CrewSchedulingPolicy · rules for no phases', 'consent-3|MootArchetype · shared · triage, mulling, synthesis']);
    expect(leaves(d, 'policies')[1].view.ref).toEqual({ kind: 'MootArchetype', name: 'consent-3', namespace: '' });
    expect(shown(leaves(d, 'notifications'))).toEqual(['pager|NotificationSink · shared · ntfy.example.com · every agent']);
    expect(shown(leaves(d, 'fitness'))).toEqual(['lab-ops-smoke|CrewFitnessSuite · 1 scenario, 1 each']);
    expect(shown(leaves(d, 'deployment')).at(-1)).toBe('default|KubemootConfig · shared · operator defaults');
    expect(d.gateway?.metadata.name).toBe('lab-gateway');
    expect((sectionsOf(summary, d) as Section[]).map((s) => sectionItem(s).description)).toEqual(['1 of 2 ready', '4, 1 ADL', '1', '3', '2', '5', '2', '2', '1', '0 scenarios · 1 run', undefined]);
  });

  it('marks a named object that is missing, and one a namespace account cannot read', async () => {
    cluster.failures.set('/apis/kubemoot.ai/v1alpha1/namespaces/kubemoot/modelproviders', new KubeError('forbidden', 403));
    cluster.failures.set('/apis/kubemoot.ai/v1alpha1/mootarchetypes', new KubeError('forbidden', 403));
    const d = await details();
    expect(d.problems).toEqual([]);
    const provider = leaves(d, 'models')[2];
    expect(provider.view).toMatchObject({ description: 'ModelProvider · shared · ModelProvider · not found', icon: 'warning', ref: undefined });
    expect(provider.view.tooltip).toContain('a Model runs on it; this account cannot read it');
    expect(leaves(d, 'policies')[1].view.tooltip).toContain('the scheduling policy runs it; this account cannot read it');
    expect(missingText(new Set())('Model')).toBe('not found');
  });

  it("reports a namespace kind it cannot read, and reads no system namespace for a crew in it", async () => {
    cluster.failures.set(`/apis/kubemoot.ai/v1alpha1/namespaces/${NS}/ragsources`, new KubeError('ragsources is forbidden', 403));
    expect((await details()).problems).toEqual(['RAGSource: ragsources is forbidden']);
    const system = seedCrew(new FakeCluster(), 'kubemoot');
    await loadCrewDetails(system, await discoverKinds(system), 'kubemoot', 'lab-ops');
    expect(system.calls.filter((c) => c.path.endsWith('/namespaces/kubemoot/modelproviders'))).toHaveLength(1);
  });

  it('reads no cluster-scoped kind the cluster does not serve', async () => {
    const kinds = await discoverKinds(cluster);
    kinds.delete('MootArchetype');
    kinds.set('KubemootConfig', { kind: 'KubemootConfig', plural: 'kubemootconfigs', namespaced: true });
    const d = await loadCrewDetails(cluster, kinds, NS, 'lab-ops');
    expect(d.related.operator).toEqual([]);
    expect(cluster.calls.some((c) => c.path === '/apis/kubemoot.ai/v1alpha1/mootarchetypes')).toBe(false);
  });

  it('reads odd server tool lists and cluster lists without failing', async () => {
    const kube = cluster.objects.find((o) => o.kind === 'MCPServer' && o.metadata.name === 'kubernetes')!;
    kube.status = { ready: true, tools: [{ description: 'no name' }, null, { name: 'pods_list', description: 'List pods' }, { name: 'pods_list' }] };
    cluster.objects.find((o) => o.kind === 'MCPServer' && o.metadata.name === 'web')!.status = { tools: 'not a list' };
    cluster.bodies.set('/apis/kubemoot.ai/v1alpha1/kubemootconfigs', '{}');
    cluster.bodies.set('/apis/kubemoot.ai/v1alpha1/mootarchetypes', JSON.stringify({ items: [{ metadata: { name: 'consent-3' } }] }));
    const d = await details();
    expect(d.tools.find((t) => t.name === 'pods_list')).toMatchObject({ server: 'kubernetes', description: 'List pods' });
    expect(d.related.operator).toEqual([]);
    expect(d.related.policies[1].object).toMatchObject({ apiVersion: 'kubemoot.ai/v1alpha1', kind: 'MootArchetype' });
  });

  it('shows a related object without readiness in its own icon', () => {
    const view = relatedView({ kind: 'MCPCatalog', name: 'cat', namespace: NS, object: obj('MCPCatalog', 'cat', NS), reason: 'a gateway reads it' });
    expect(view).toMatchObject({ icon: 'library', shared: false, description: 'MCPCatalog' });
    expect(view.color).toBeUndefined();
  });
});

describe('the Tools group of a live crew', () => {
  const tree = () => Object.assign(new CrewTreeProvider(() => ({ source: '/k/config', context: 'lab', client: cluster as unknown as KubeClient })), { grouped: true });

  async function toolsSection(provider: CrewTreeProvider): Promise<CrewNode> {
    const [ns] = await provider.getChildren();
    const [crewNode] = await provider.getChildren(ns);
    return (await provider.getChildren(crewNode)).find((n) => n.kind === 'section' && n.section === 'tools')!;
  }

  it("reads the gateway's tool catalog once, through the service proxy, and shows where each tool comes from", async () => {
    cluster.bodies.set(CATALOG, cluster.bodies.get(CATALOG)!);
    const provider = tree();
    const section = await toolsSection(provider);
    const tools = (await provider.getChildren(section)) as Member[];
    await provider.getChildren(section);
    expect(cluster.calls.filter((c) => c.path === CATALOG)).toHaveLength(1);
    expect(shown(tools)).toEqual(['helm_list|from kubernetes · k8s', 'pods_list|from kubernetes · k8s']);
    const pods = provider.getTreeItem(tools[1]);
    expect(pods.tooltip).toBe('Tool pods_list\nFrom: MCPServer kubernetes\nList pods\nEnabled by: k8s\nInputs: namespace (required)');
    await showToolDetails(new LiveDocuments(), tools[1]);
    expect(recorded.shownDocuments).toEqual(['crewforge-live:/team-a/lab-ops/tools/pods_list.md (markdown)']);
  });

  it('says on each tool when the catalog cannot be read', async () => {
    cluster.failures.set(CATALOG, new KubeError('services "lab-gateway" is forbidden', 403));
    const provider = tree();
    const tools = (await provider.getChildren(await toolsSection(provider))) as Member[];
    expect(shown(tools)[0]).toBe('helm_list|from kubernetes · k8s · catalog unreadable');
    expect(String(provider.getTreeItem(tools[0]).tooltip)).toContain(`Cannot read the gateway's tool catalog: services "lab-gateway" is forbidden`);
  });

  it('warns about a tool no server of the crew offers', async () => {
    const k8s = cluster.objects.find((o) => o.kind === 'Agent' && o.metadata.name === 'k8s')!;
    (k8s.spec as { enabledTools: string[] }).enabledTools.push('ghost');
    const provider = tree();
    const tools = (await provider.getChildren(await toolsSection(provider))) as Member[];
    const ghost = tools.find((t) => t.view.label === 'ghost')!;
    expect(ghost.view).toMatchObject({ description: 'no server offers it · k8s', icon: 'warning', color: 'list.warningForeground' });
    expect(ghost.view.tooltip).toContain('No MCP server of this crew lists it.');
  });

  it('finds a group of a crew for revealing it, with the crew as its parent', async () => {
    const provider = tree();
    const node = await provider.sectionNode(summary, 'models');
    expect(node).toMatchObject({ kind: 'section', section: 'models' });
    expect(provider.getParent(node)).toEqual({ kind: 'crew', crew: summary });
    expect(provider.getTreeItem(node).id).toBe('section:team-a/lab-ops:models');
  });

  it('opens nothing for a node that is not a tool', async () => {
    const documents = new LiveDocuments();
    await showToolDetails(documents, undefined);
    await showToolDetails(documents, { kind: 'member', crew: summary, view: { label: 'x', tooltip: '', icon: 'tag' } } as Member);
    expect(recorded.shownDocuments).toEqual([]);
  });
});

describe('live documents of cluster-scoped objects and of text', () => {
  it('reads a cluster-scoped object by its cluster path, and names its document under cluster', async () => {
    const kinds = await discoverKinds(cluster);
    expect(livePath({ kind: 'MootArchetype', name: 'consent-3', namespace: '' }, kinds)).toBe('/apis/kubemoot.ai/v1alpha1/mootarchetypes/consent-3');
    expect(liveUri({ kind: 'object', ref: { kind: 'MootArchetype', name: 'consent-3', namespace: '' } }).toString()).toBe('crewforge-live:/cluster/MootArchetype/consent-3.yaml');
    const documents = new LiveDocuments(() => ({ source: '/k', context: 'lab', client: cluster as unknown as KubeClient }));
    await documents.show({ kind: 'object', ref: { kind: 'MootArchetype', name: 'consent-3', namespace: '' } });
    expect(await documents.provideTextDocumentContent(Uri.parse('crewforge-live:/cluster/MootArchetype/consent-3.yaml') as never)).toContain('name: consent-3');
  });

  it('shows a page of text as given, in its language', async () => {
    const documents = new LiveDocuments(() => {
      throw new Error('no cluster read for text');
    });
    await documents.show({ kind: 'text', path: '/n/c/tools/t.md', text: '# Tool t\n', language: 'markdown' });
    expect(await documents.provideTextDocumentContent(Uri.parse('crewforge-live:/n/c/tools/t.md') as never)).toBe('# Tool t\n');
  });
});
