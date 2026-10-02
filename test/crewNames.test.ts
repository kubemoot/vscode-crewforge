import { beforeEach, describe, expect, it } from 'vitest';
import { renderCrewPage } from '../src/dashboard/crewPage';
import type { CrewVitals } from '../src/dashboard/crewVitals';
import { renderFitnessPage } from '../src/dashboard/fitnessPage';
import { renderOverview } from '../src/dashboard/overview';
import { listCrewsEach, type CrewSummary } from '../src/k8s/crews';
import { KubeError, type KubeClient } from '../src/k8s/request';
import { CrewTreeProvider, type CrewNode } from '../src/views/crewTree';
import { crewDescription, crewTooltip, groupByNamespace, sortCrews } from '../src/views/treeModel';
import { FakeCluster, obj } from './fakeCluster';
import { recorded, resetFake } from './vscodeFake';

const DISPLAY = 'kubemoot.ai/display-name';

/** A Crew in a namespace, Ready with two agents, with a display name when given. */
function crewObj(name: string, namespace: string, display?: string) {
  const crew = obj('Crew', name, namespace);
  if (display) crew.metadata.annotations = { [DISPLAY]: display };
  crew.status = { ready: true, phase: 'Ready', agentCount: 2 };
  return crew;
}

const summary = (name: string, namespace: string, display?: string): CrewSummary => ({
  name,
  namespace,
  ready: true,
  phase: 'Ready',
  agents: 2,
  annotations: display ? { [DISPLAY]: display } : undefined,
});

const onCluster = (cluster: FakeCluster) => new CrewTreeProvider(() => ({ source: '/k', context: 'lab', client: cluster as unknown as KubeClient }));

beforeEach(resetFake);

describe('the flat Deployed Crews list', () => {
  const cluster = () => new FakeCluster().add(crewObj('test', 'crew-test', 'Homelab Health Guide'), crewObj('quiz', 'team-a'), crewObj('ops', 'team-a', 'Lab Ops'));

  it('lists one row per crew by namespace, then name, labeled with the display name, its namespace in the description', async () => {
    const tree = onCluster(cluster());
    tree.sourceOpen = (crew) => crew.name === 'test';
    const roots = await tree.getChildren();
    const items = roots.map((n) => tree.getTreeItem(n));
    expect(items.map((i) => [i.label, i.description])).toEqual([
      ['Homelab Health Guide', 'crew-test/test · Ready, 2 agents · source open'],
      ['Lab Ops', 'team-a/ops · Ready, 2 agents · no local source'],
      ['quiz', 'team-a · Ready, 2 agents · no local source'],
    ]);
    expect(items[0].id).toBe('crew:crew-test/test');
    expect(items[0].contextValue).toBe('crew');
    expect(tree.getParent(roots[0])).toBeUndefined();
    const found = await tree.nodeFor('team-a', 'ops');
    expect(tree.getParent(found!)).toBeUndefined();
  });

  it('groups under namespaces when asked, the same crews with the technical name beside a display name', async () => {
    const tree = Object.assign(onCluster(cluster()), { grouped: true });
    const roots = await tree.getChildren();
    expect(roots.map((n) => tree.getTreeItem(n).label)).toEqual(['crew-test', 'team-a']);
    const teamA = await tree.getChildren(roots[1]);
    expect(teamA.map((n) => [tree.getTreeItem(n).label, tree.getTreeItem(n).description])).toEqual([
      ['Lab Ops', 'ops · Ready, 2 agents'],
      ['quiz', 'Ready, 2 agents'],
    ]);
    expect(tree.getParent(teamA[0])).toMatchObject({ kind: 'namespace', group: { namespace: 'team-a' } });
  });

  it('keeps a namespace it cannot read visible as an error row naming it, in both modes, after the connection row', async () => {
    recorded.settings.set('crewforge.namespaces', ['team-a', 'locked']);
    const fake = cluster();
    fake.failures.set('/apis/kubemoot.ai/v1alpha1/namespaces/locked/crews', new KubeError('crews is forbidden: User cannot list crews in locked. More detail.', 403));
    for (const grouped of [false, true]) {
      const tree = Object.assign(onCluster(fake), { grouped });
      tree.connectionItem = () => ({ label: 'lab', tooltip: 'lab' });
      const roots = await tree.getChildren();
      expect(roots[0].kind).toBe('connection');
      const error = roots[1] as Extract<CrewNode, { kind: 'message' }>;
      expect(error.text).toBe('Cannot read namespace locked: crews is forbidden: User cannot list crews in locked.');
      expect(error.detail).toContain('More detail.');
      expect(roots).toHaveLength(grouped ? 3 : 4);
    }
  });

  it('shows the error itself when no namespace can be read', async () => {
    recorded.settings.set('crewforge.namespaces', ['locked']);
    const fake = new FakeCluster();
    fake.failures.set('/apis/kubemoot.ai/v1alpha1/namespaces/locked/crews', new Error('crews is forbidden.'));
    const roots = await onCluster(fake).getChildren();
    expect(roots).toEqual([{ kind: 'message', text: 'crews is forbidden.', detail: 'crews is forbidden.' }]);
  });
});

describe('listCrewsEach', () => {
  it('lists across the cluster without a filter, and reports each namespace it cannot read', async () => {
    const fake = new FakeCluster().add(crewObj('a', 'one'), crewObj('b', 'two'));
    expect((await listCrewsEach(fake as never, [])).crews.map((c) => c.name)).toEqual(['a', 'b']);
    const boom = new Error('no');
    fake.failures.set('/apis/kubemoot.ai/v1alpha1/namespaces/two/crews', boom);
    expect(await listCrewsEach(fake as never, ['one', 'two'])).toMatchObject({ crews: [{ name: 'a' }], failed: [{ namespace: 'two', error: boom }] });
    await expect(listCrewsEach(fake as never, ['two'])).rejects.toBe(boom);
  });
});

describe('display names in the tree model', () => {
  it('describes a crew with its technical name only when people read another', () => {
    expect(crewDescription(summary('test', 'ns', 'Test Crew'))).toBe('test · Ready, 2 agents');
    expect(crewDescription(summary('test', 'ns'))).toBe('Ready, 2 agents');
    expect(crewDescription(summary('test', 'ns', 'Test Crew'), true)).toBe('ns/test · Ready, 2 agents');
    expect(crewDescription(summary('test', 'ns'), true)).toBe('ns · Ready, 2 agents');
  });

  it('puts the display name first in the tooltip, and sorts by it within a namespace', () => {
    expect(crewTooltip(summary('test', 'ns', 'Test Crew')).split('\n').slice(0, 2)).toEqual(['Test Crew', 'ns/test']);
    expect(crewTooltip(summary('test', 'ns')).split('\n')[0]).toBe('ns/test');
    const crews = [summary('b', 'x', 'Alpha'), summary('a', 'x', 'Zulu'), summary('c', 'w'), summary('d', 'x', 'Alpha')];
    expect(groupByNamespace(crews).map((g) => g.crews.map((c) => c.name))).toEqual([['c'], ['b', 'd', 'a']]);
    expect(sortCrews(crews).map((c) => c.name)).toEqual(['c', 'b', 'd', 'a']);
  });
});

describe('display names on the pages', () => {
  const vitals = (title: string): CrewVitals =>
    ({ name: 'test', title, context: 'lab', agents: [], agentsFrom: 'none', models: [], contents: [], contentsFrom: 'none', conversations: { total: 0, turns: 0, errors: [] }, fitnessRunning: false }) as unknown as CrewVitals;

  it('heads the crew dashboard with the display name and names the technical one beside where it runs', () => {
    const page = renderCrewPage(vitals('Homelab Health Guide'));
    expect(page).toContain('<h1>Homelab Health Guide <span');
    expect(page).toContain('<p class="muted">test · not deployed in lab</p>');
    expect(page).toContain('Homelab Health Guide is not deployed in lab.');
    expect(renderCrewPage(vitals('test'))).toContain('<p class="muted">not deployed in lab</p>');
  });

  it('heads the fitness dashboard with the display name', () => {
    const fitness = { crew: 'test', namespace: 'ns', runs: [], iterations: [], controls: { suspend: false, cancel: false } };
    expect(renderFitnessPage({ ...fitness, title: 'Test & Crew' })).toContain('<h1>Fitness: Test &amp; Crew</h1><p class="muted">test · ns</p>');
    expect(renderFitnessPage({ ...fitness, title: 'test' })).toContain('<h1>Fitness: test</h1><p class="muted">ns</p>');
  });

  it('lists the display name in the Crews Overview, escaped, with the technical name beside it', () => {
    const connection = { context: 'lab', source: '/k', server: 'https://x' } as never;
    const html = renderOverview({ connection, rows: [{ crew: summary('test', 'ns', '<b>Guide</b>'), channel: 'helm', problems: 0, sourceOpen: false }] });
    expect(html).toContain('title="Open the dashboard of test">&lt;b&gt;Guide&lt;/b&gt;</button> <span class="muted">test</span>');
    const plain = renderOverview({ connection, rows: [{ crew: summary('test', 'ns'), channel: 'helm', problems: 0, sourceOpen: false }] });
    expect(plain).toContain('>test</button></td>');
  });
});
