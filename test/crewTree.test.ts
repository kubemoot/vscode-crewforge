import * as path from 'node:path';
import * as os from 'node:os';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { KubeClient } from '../src/k8s/request';
import { KubeError } from '../src/k8s/request';
import { crewContext, CrewTreeProvider, type CrewNode } from '../src/views/crewTree';
import { startFakeApi, type FakeApi } from './fakeApiServer';
import { FakeCluster, seedCrew } from './fakeCluster';
import { recorded, resetFake, ThemeIcon, TreeItem, TreeItemCollapsibleState } from './vscodeFake';

const onCluster = (cluster: FakeCluster) => new CrewTreeProvider(() => ({ source: '/k/config', context: 'lab', client: cluster as unknown as KubeClient }));

let api: FakeApi;
beforeAll(async () => (api = await startFakeApi()));
afterAll(() => api.close());
beforeEach(() => {
  resetFake();
  recorded.settings.set('crewforge.kubeconfig', api.kubeconfig);
});

describe('CrewTreeProvider', () => {
  it('finds a crew again for revealing it, with its namespace as parent and stable ids', async () => {
    const tree = onCluster(seedCrew(new FakeCluster()));
    const found = await tree.nodeFor('team-a', 'lab-ops');
    expect(found).toMatchObject({ kind: 'crew', crew: { name: 'lab-ops' } });
    expect(tree.getTreeItem(found!)).toMatchObject({ id: 'crew:team-a/lab-ops' });
    const parent = tree.getParent(found!);
    expect(parent).toMatchObject({ kind: 'namespace', group: { namespace: 'team-a' } });
    expect(tree.getTreeItem(parent!)).toMatchObject({ id: 'namespace:team-a' });
    expect(tree.getParent(parent!)).toBeUndefined();
    expect(tree.getParent({ kind: 'crew', crew: { name: 'x', namespace: 'gone', ready: true, phase: 'Ready' } })).toBeUndefined();
    expect(await tree.nodeFor('team-z', 'lab-ops')).toBeUndefined();
  });

  it('lists namespaces, then the crews in each, with their readiness', async () => {
    const tree = new CrewTreeProvider();
    const roots = await tree.getChildren();
    expect(roots.map((n) => n.kind === 'namespace' && n.group.namespace)).toEqual(['team-a', 'team-b']);
    const ns = tree.getTreeItem(roots[0]);
    expect(ns.label).toBe('team-a');
    expect(ns.collapsibleState).toBe(TreeItemCollapsibleState.Expanded);

    const crews = await tree.getChildren(roots[0]);
    const item = tree.getTreeItem(crews[0]);
    expect(item.label).toBe('lab-ops');
    expect(item.description).toBe('Ready, 2 agents');
    expect(item.contextValue).toBe('crew');
    expect((item.iconPath as ThemeIcon).id).toBe('pass-filled');
    expect(item.command?.command).toBe('crewforge.openCrewDashboard');

    const notReady = tree.getTreeItem((await tree.getChildren(roots[1]))[0]);
    expect((notReady.iconPath as ThemeIcon).id).toBe('circle-large-outline');
    expect(tree.known.map((c) => c.name)).toEqual(['lab-ops', 'quiz']);
    expect(tree.connection?.context).toBe('fake');
  });

  it('shows why when the cluster cannot be read', async () => {
    recorded.settings.set('crewforge.kubeconfig', path.join(os.tmpdir(), 'no-such-kubeconfig'));
    const tree = new CrewTreeProvider();
    const [node] = await tree.getChildren();
    expect(node.kind).toBe('message');
    const item = tree.getTreeItem(node);
    expect((item.iconPath as ThemeIcon).id).toBe('warning');
    expect(String(item.tooltip)).toMatch(/no-such-kubeconfig|ENOENT/);
    expect(tree.known).toEqual([]);
  });

  it('expands a crew into its sections, has no children below a leaf, and refresh notifies the view', async () => {
    const tree = onCluster(seedCrew(new FakeCluster()));
    const [ns] = await tree.getChildren();
    const [crewNode] = await tree.getChildren(ns);
    const crewItem = tree.getTreeItem(crewNode);
    expect(crewItem.collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
    expect(crewItem.description).toBe('Ready, 2 agents, v0.4.0');
    expect(crewItem.contextValue).toBe('crew');
    expect(String(crewItem.tooltip)).not.toContain('Archetype');

    const sections = await tree.getChildren(crewNode);
    expect(sections.map((n) => String(tree.getTreeItem(n).label))).toEqual(['Agents', 'Prompts', 'Skills', 'Models', 'RAG Sources', 'MCP Servers', 'Tools', 'Policies', 'Notifications', 'Fitness', 'Deployment']);
    expect(String(tree.getTreeItem(crewNode).tooltip)).toContain('Archetype: consent-3');
    const agents = await tree.getChildren(sections[0]);
    expect(agents.map((n) => tree.getTreeItem(n).label)).toEqual(['coordinator', 'k8s']);
    expect(await tree.getChildren(agents[0])).toEqual([]);

    let fired = 0;
    tree.onDidChangeTreeData(() => fired++);
    tree.refresh();
    expect(fired).toBe(1);
  });

  it('lists what it cannot read under the crew, and says why a crew cannot be read at all', async () => {
    const cluster = seedCrew(new FakeCluster());
    cluster.failures.set('/apis/kubemoot.ai/v1alpha1/namespaces/team-a/skills', new KubeError('skills is forbidden. Ask your admin.', 403));
    const tree = onCluster(cluster);
    const [ns] = await tree.getChildren();
    const [crewNode] = await tree.getChildren(ns);
    const children = await tree.getChildren(crewNode);
    const last = tree.getTreeItem(children.at(-1)!);
    expect(last.label).toBe('Cannot read Skill: skills is forbidden.');
    expect(last.tooltip).toBe('Skill: skills is forbidden. Ask your admin.');

    const gone: CrewNode = { kind: 'crew', crew: { name: 'gone', namespace: 'team-a', ready: false, phase: 'Unknown' } };
    const [message] = await tree.getChildren(gone);
    expect(message.kind).toBe('message');
    expect(String(tree.getTreeItem(message).tooltip)).toContain('not found');
  });

  it('fills the tooltip on hover with the archetype, and keeps it when the details cannot be read', async () => {
    const cluster = seedCrew(new FakeCluster());
    const tree = onCluster(cluster);
    const crew = { name: 'lab-ops', namespace: 'team-a', ready: true, phase: 'Ready' };
    const item = await tree.resolveTreeItem(new TreeItem('lab-ops', 1) as never, { kind: 'crew', crew });
    expect(String(item.tooltip)).toContain('Archetype: consent-3');
    const plain = new TreeItem('x', 0) as never;
    expect(await tree.resolveTreeItem(plain, { kind: 'message', text: 'x' })).toBe(plain);
    const missing = new TreeItem('gone', 1);
    missing.tooltip = 'kept';
    await tree.resolveTreeItem(missing as never, { kind: 'crew', crew: { ...crew, name: 'gone' } });
    expect(missing.tooltip).toBe('kept');
  });

  it('asks the API server which kinds it serves again after discovery fails', async () => {
    const cluster = seedCrew(new FakeCluster());
    cluster.failures.set('/apis/kubemoot.ai/v1alpha1', new Error('discovery down'));
    const tree = onCluster(cluster);
    const crew = { name: 'lab-ops', namespace: 'team-a', ready: true, phase: 'Ready' };
    await expect(tree.detailsOf(crew)).rejects.toThrow('discovery down');
    cluster.failures.clear();
    expect((await tree.detailsOf(crew)).agents).toHaveLength(2);
  });

  it('gives Flux-managed crews their own menu', () => {
    expect(crewContext({ name: 'x', namespace: 'n', ready: true, phase: 'Ready', labels: { 'helm.toolkit.fluxcd.io/name': 'x' } })).toBe('crew-flux');
    expect(crewContext({ name: 'x', namespace: 'n', ready: true, phase: 'Ready', labels: { 'app.kubernetes.io/managed-by': 'Helm' } })).toBe('crew');
  });

  it('asks only the namespaces in the filter setting', async () => {
    recorded.settings.set('crewforge.namespaces', ['team-a', ' ']);
    const tree = new CrewTreeProvider();
    const [node] = await tree.getChildren();
    // the fake API only answers the cluster-wide list, so a per-namespace ask fails visibly
    expect(node.kind).toBe('message');
  });
});
