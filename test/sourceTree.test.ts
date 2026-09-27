import { beforeEach, describe, expect, it } from 'vitest';
import type { KubeClient } from '../src/k8s/request';
import { ANNOTATIONS } from '../src/source/deployments';
import { discoverKinds, liveObjects, objectPath } from '../src/source/live';
import { objectKey, type Manifest } from '../src/source/manifests';
import type { Exec } from '../src/source/render';
import { SourceService, type SourceDeps } from '../src/source/service';
import { ManifestDocuments, MANIFEST_SCHEME } from '../src/views/manifestDocuments';
import { SourceTreeProvider } from '../src/views/sourceTree';
import { FakeCluster, obj } from './fakeCluster';
import { recorded, resetFake, Uri } from './vscodeFake';

const CHART = '/w/charts/demo-crew';
const RENDERED = [
  'apiVersion: kubemoot.ai/v1alpha1',
  'kind: Crew',
  'metadata:',
  '  name: demo',
  'spec:',
  '  description: new',
  '---',
  'apiVersion: kubemoot.ai/v1alpha1',
  'kind: PromptModule',
  'metadata:',
  '  name: demo-rules',
  'spec:',
  '  content: rules',
].join('\n');

const noGit: Exec = async (cmd) => (cmd === 'git' ? { code: 128, stdout: '', stderr: 'not a repo' } : { code: 0, stdout: RENDERED, stderr: '' });

function deps(exec: Exec = noGit, files = { charts: [`${CHART}/Chart.yaml`], yamls: [`${CHART}/templates/crew.yaml`] }): SourceDeps {
  return {
    exec,
    readText: async () => 'apiVersion: kubemoot.ai/v1alpha1\nkind: Crew\n',
    readYamlFiles: async () => [],
    listFiles: async () => files,
  };
}

describe('live objects', () => {
  it('discovers kinds without subresources and builds paths', async () => {
    const kinds = await discoverKinds(new FakeCluster());
    expect(kinds.get('Agent')).toEqual({ kind: 'Agent', plural: 'agents', namespaced: true });
    expect([...kinds.keys()].some((k) => k.includes('/'))).toBe(false);
    expect(objectPath(kinds.get('Crew')!, 'ns', 'a b')).toBe('/apis/kubemoot.ai/v1alpha1/namespaces/ns/crews/a%20b');
    expect(() => objectPath(kinds.get('Crew')!, 'Bad NS')).toThrow('not a valid Kubernetes name');
  });

  it('keeps the rendered objects and the crew-labelled ones, and lists only rendered kinds', async () => {
    const cluster = new FakeCluster().add(
      obj('Crew', 'demo', 'ns'),
      obj('PromptModule', 'demo-rules', 'ns'),
      obj('PromptModule', 'old-rules', 'ns', {}, { 'kubemoot.ai/crew': 'demo' }),
      obj('PromptModule', 'someone-else', 'ns'),
      { ...obj('PromptModule', 'generated', 'ns', {}, { 'kubemoot.ai/crew': 'demo' }), metadata: { name: 'generated', namespace: 'ns', labels: { 'kubemoot.ai/crew': 'demo' }, ownerReferences: [{ kind: 'Crew' }] } },
      obj('Agent', 'unrendered-kind', 'ns', {}, { 'kubemoot.ai/crew': 'demo' }),
    );
    const kinds = await discoverKinds(cluster);
    const rendered = [obj('Crew', 'demo', 'ns'), obj('PromptModule', 'demo-rules', 'ns'), obj('Unknown', 'x', 'ns')];
    const live = await liveObjects(cluster, kinds, 'ns', rendered, 'demo');
    expect(live.map(objectKey).sort()).toEqual(['Crew/demo', 'PromptModule/demo-rules', 'PromptModule/old-rules']);
    expect(live[0].apiVersion).toBe('kubemoot.ai/v1alpha1');
    expect(cluster.calls.map((c) => c.path).filter((p) => p.includes('/namespaces/'))).toHaveLength(2);
  });
});

describe('SourceService', () => {
  it('loads sources with their crew name, or the reason there is none', async () => {
    const [ok] = await new SourceService(deps()).load();
    expect(ok).toMatchObject({ crewName: 'demo', identity: { id: 'local:demo-crew' } });
    const noCrew: Exec = async (cmd) => ({ code: 0, stdout: cmd === 'helm' ? 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\n' : '', stderr: '' });
    expect((await new SourceService(deps(noCrew)).load())[0].error).toBe('renders no Crew');
    const broken: Exec = async (cmd) => ({ code: cmd === 'helm' ? 1 : 128, stdout: '', stderr: 'boom' });
    expect((await new SourceService(deps(broken)).load())[0].error).toContain('boom');
  });

  it('compares a deployment with the source, discovering kinds once per client', async () => {
    const service = new SourceService(deps());
    const [entry] = await service.load();
    const cluster = new FakeCluster().add(obj('Crew', 'demo', 'ns', { description: 'old' }));
    const [deployment] = service.deployments(entry, [{ name: 'demo', namespace: 'ns', ready: true, phase: 'Ready' }]);
    const drift = await service.drift(entry, deployment, cluster);
    expect(drift.map((d) => `${d.kind}:${d.state}`)).toEqual(['Crew:changed', 'PromptModule:missing']);
    await service.drift(entry, deployment, cluster);
    expect(cluster.calls.filter((c) => c.path === '/apis/kubemoot.ai/v1alpha1')).toHaveLength(1);
    expect(service.deployments({ ...entry, crewName: undefined }, [])).toEqual([]);
  });

  it('forgets a failed discovery so the next comparison retries', async () => {
    const service = new SourceService(deps());
    const [entry] = await service.load();
    const cluster = new FakeCluster();
    cluster.failures.set('/apis/kubemoot.ai/v1alpha1', new Error('forbidden'));
    const deployment = service.deployments(entry, [{ name: 'demo', namespace: 'ns', ready: true, phase: 'Ready' }])[0];
    await expect(service.drift(entry, deployment, cluster)).rejects.toThrow('forbidden');
    cluster.failures.clear();
    await expect(service.drift(entry, deployment, cluster)).resolves.toHaveLength(2);
  });
});

describe('SourceTreeProvider', () => {
  let cluster: FakeCluster;

  beforeEach(() => {
    resetFake();
    cluster = new FakeCluster();
  });

  /** A provider whose connection is the fake cluster instead of a kubeconfig. */
  function provider(d: SourceDeps = deps()): SourceTreeProvider {
    return new SourceTreeProvider(new SourceService(d), () => ({ source: 'fake', context: 'lab', client: cluster as unknown as KubeClient }));
  }

  it('lists sources, their deployments with drift, and each resource', async () => {
    cluster.add(
      { ...obj('Crew', 'demo', 'team-a', { description: 'new' }), metadata: { name: 'demo', namespace: 'team-a', annotations: { [ANNOTATIONS.source]: 'local:demo-crew', [ANNOTATIONS.owner]: 'me', [ANNOTATIONS.revision]: 'abc' } } },
      obj('PromptModule', 'demo-rules', 'team-a', { content: 'rules' }),
      obj('Crew', 'demo', 'team-b', { description: 'old' }),
    );
    const tree = provider();
    const [source] = await tree.getChildren();
    expect(tree.getTreeItem(source)).toMatchObject({ label: 'demo-crew', description: 'crew demo · helm', contextValue: 'source-helm' });
    expect(tree.known).toHaveLength(1);
    const deployments = await tree.getChildren(source);
    const items = deployments.map((d) => tree.getTreeItem(d));
    expect(items.map((i) => [i.label, i.description])).toEqual([
      ['team-a', 'bundle · Unknown · in sync'],
      ['team-b', 'bundle · Unknown · 1 changed, 1 missing · same name, other source?'],
    ]);
    expect(items[0].tooltip).toContain('Owner: me');
    expect(items[1].tooltip).toContain('does not name this source');
    const resources = await tree.getChildren(deployments[1]);
    const resourceItems = resources.map((r) => tree.getTreeItem(r));
    expect(resourceItems.map((i) => [i.label, i.description])).toEqual([
      ['Crew/demo', 'changed in source'],
      ['PromptModule/demo-rules', 'in source, not deployed'],
    ]);
    expect(resourceItems[0].tooltip).toContain('spec.description');
    expect(resourceItems[0].command).toMatchObject({ command: 'crewforge.showDrift' });
    expect(await tree.getChildren(resources[0])).toEqual([]);
  });

  it('says when a source is not deployed, cannot render, or the cluster cannot be read', async () => {
    const tree = provider();
    const [source] = await tree.getChildren();
    const [none] = await tree.getChildren(source);
    expect(tree.getTreeItem(none).label).toBe('Not deployed in lab');
    const broken = (await provider(deps(async (cmd) => ({ code: cmd === 'helm' ? 1 : 128, stdout: '', stderr: 'bad chart' }))).getChildren())[0];
    const [why] = await tree.getChildren(broken);
    expect(tree.getTreeItem(why).label).toContain('bad chart');
    cluster.failures.set('/apis/kubemoot.ai/v1alpha1/crews', new Error('Forbidden: crews\nmore detail'));
    const [denied] = await tree.getChildren(source);
    expect(tree.getTreeItem(denied)).toMatchObject({ label: 'Forbidden: crews', tooltip: 'Forbidden: crews\nmore detail' });
  });

  it('shows a deployment it cannot compare, and an empty or failing workspace', async () => {
    cluster.add(obj('Crew', 'demo', 'team-a'));
    cluster.failures.set('/apis/kubemoot.ai/v1alpha1', new Error('no discovery'));
    const tree = provider();
    const [source] = await tree.getChildren();
    const [deployment] = await tree.getChildren(source);
    expect(tree.getTreeItem(deployment).description).toContain('cannot compare');
    const [reason] = await tree.getChildren(deployment);
    expect(tree.getTreeItem(reason).label).toBe('no discovery');
    const empty = provider(deps(noGit, { charts: [], yamls: [] }));
    expect((await empty.getChildren()).map((n) => empty.getTreeItem(n).label)).toEqual(['No crew charts or bundles in this workspace']);
    const failing = provider({ ...deps(), listFiles: () => Promise.reject(new Error('no workspace')) });
    expect((await failing.getChildren()).map((n) => failing.getTreeItem(n).label)).toEqual(['no workspace']);
  });

  it('fires a change on refresh', () => {
    const tree = provider();
    let fired = 0;
    tree.onDidChangeTreeData(() => fired++);
    tree.refresh();
    expect(fired).toBe(1);
  });

  it('connects with the settings by default', async () => {
    recorded.settings.set('crewforge.kubeconfig', '/no/such/kubeconfig');
    const tree = new SourceTreeProvider(new SourceService(deps()));
    const [source] = await tree.getChildren();
    const [message] = await tree.getChildren(source);
    expect(message.kind).toBe('message');
  });
});

describe('ManifestDocuments', () => {
  beforeEach(resetFake);

  it('opens the live and source YAML side by side', async () => {
    const docs = new ManifestDocuments();
    const live: Manifest = obj('Crew', 'demo', 'ns', { description: 'old' });
    await docs.showDrift('ns', { kind: 'Crew', name: 'demo', state: 'changed', paths: ['spec.description'], live, rendered: obj('Crew', 'demo', 'ns', { description: 'new' }) });
    const [call] = recorded.executed;
    expect(call.id).toBe('vscode.diff');
    const [left, right, title] = call.args as [Uri, Uri, string];
    expect(left.toString()).toBe(`${MANIFEST_SCHEME}:/live/ns/Crew-demo.yaml`);
    expect(docs.provideTextDocumentContent(left as never)).toContain('description: old');
    expect(docs.provideTextDocumentContent(right as never)).toContain('description: new');
    expect(title).toBe('Crew/demo: live in ns vs source');
    await docs.showDrift('ns', { kind: 'Agent', name: 'a', state: 'missing', paths: [] });
    const [l2, r2] = recorded.executed[1].args as [Uri, Uri];
    expect(docs.provideTextDocumentContent(l2 as never)).toBe('# not deployed\n');
    expect(docs.provideTextDocumentContent(r2 as never)).toBe('# not in the source\n');
    expect(docs.provideTextDocumentContent(Uri.parse('crewforge-manifest:/nothing') as never)).toBe('');
  });
});
