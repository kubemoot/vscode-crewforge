import { beforeEach, describe, expect, it } from 'vitest';
import { namespaceScope } from '../src/connection';
import { agentCounts, renderOverview } from '../src/dashboard/overview';
import { listCrews, listCrewsEach } from '../src/k8s/crews';
import type { KubeClient } from '../src/k8s/request';
import { discoverKinds } from '../src/source/live';
import { CrewTreeProvider } from '../src/views/crewTree';
import { FakeCluster, obj } from './fakeCluster';
import { recorded, resetFake } from './vscodeFake';

const SETTING = 'crewforge.namespaces';
const WORKSHOP = 30;

/** A cluster where each of thirty teams has a namespace with a crew and an agent, as at a workshop. */
function workshop(): FakeCluster {
  const cluster = new FakeCluster();
  for (let i = 1; i <= WORKSHOP; i++) {
    cluster.add(obj('Crew', `crew-${i}`, `team-${i}`), obj('Agent', `agent-${i}`, `team-${i}`, {}, { 'kubemoot.ai/crew': `crew-${i}` }));
  }
  return cluster;
}

/** What opening the Deployed Crews view and the Crews Overview ask the cluster, under a connection. */
async function open(cluster: FakeCluster, namespace?: string): Promise<{ crews: number; calls: number }> {
  const client = cluster as unknown as KubeClient;
  const connection = { source: '/k', context: 'lab', client, namespace };
  const tree = new CrewTreeProvider(() => connection);
  const roots = await tree.getChildren();
  const scope = namespaceScope(connection);
  const crews = await listCrews(client, scope);
  await agentCounts(client, await discoverKinds(client), crews.map((c) => c.namespace));
  return { crews: roots.length, calls: cluster.calls.length };
}

beforeEach(resetFake);

describe('the namespaces that crews are shown from', () => {
  it('is the kubeconfig context namespace when the setting is empty', () => {
    expect(namespaceScope({ namespace: 'team-4' })).toEqual({ namespaces: ['team-4'], implicit: true });
  });

  it('is every namespace when the setting is empty and the context names none', () => {
    expect(namespaceScope({})).toEqual({ namespaces: [] });
    expect(namespaceScope({ namespace: undefined })).toEqual({ namespaces: [] });
  });

  it('lets an explicit setting win over the context namespace, ignoring blank entries', () => {
    recorded.settings.set(SETTING, ['team-1', ' team-2 ', '  ']);
    expect(namespaceScope({ namespace: 'team-9' })).toEqual({ namespaces: ['team-1', 'team-2'] });
  });

  it('reads every namespace when the setting says *, even with a context namespace', () => {
    recorded.settings.set(SETTING, ['*']);
    expect(namespaceScope({ namespace: 'team-9' })).toEqual({ namespaces: [] });
    recorded.settings.set(SETTING, ['team-1', '*']);
    expect(namespaceScope({ namespace: 'team-9' })).toEqual({ namespaces: [] });
  });

  it('asks only the context namespace, and no other namespace', async () => {
    const cluster = workshop();
    const crews = await listCrews(cluster as never, namespaceScope({ namespace: 'team-4' }));
    expect(crews.map((c) => c.name)).toEqual(['crew-4']);
    expect(cluster.calls.map((c) => c.path)).toEqual(['/apis/kubemoot.ai/v1alpha1/namespaces/team-4/crews']);
  });

  it('widens to the whole cluster when the context namespace holds no crews, once', async () => {
    const cluster = workshop();
    const scope = namespaceScope({ namespace: 'default' });
    expect((await listCrews(cluster as never, scope)).length).toBe(WORKSHOP);
    expect(cluster.calls.map((c) => c.path)).toEqual(['/apis/kubemoot.ai/v1alpha1/namespaces/default/crews', '/apis/kubemoot.ai/v1alpha1/crews']);
    expect(await listCrewsEach(cluster as never, scope)).toMatchObject({ failed: [], scope: 'all namespaces (default had no crews)' });
  });

  it('widens the same way in listCrews and listCrewsEach when the implicit namespace is forbidden', async () => {
    const cluster = workshop();
    cluster.failures.set('/apis/kubemoot.ai/v1alpha1/namespaces/team-4/crews', new Error('forbidden'));
    const scope = namespaceScope({ namespace: 'team-4' });
    expect(await listCrews(cluster as never, scope)).toHaveLength(WORKSHOP);
    expect(await listCrewsEach(cluster as never, scope)).toMatchObject({ failed: [], scope: 'all namespaces (team-4 could not be read)' });
  });

  it('throws from listCrews only when every namespace failed, and reports the scope read', async () => {
    const cluster = workshop();
    const boom = new Error('forbidden');
    cluster.failures.set('/apis/kubemoot.ai/v1alpha1/namespaces/team-2/crews', boom);
    expect((await listCrews(cluster as never, ['team-1', 'team-2'])).map((c) => c.name)).toEqual(['crew-1']);
    await expect(listCrews(cluster as never, ['team-2'])).rejects.toBe(boom);
    expect((await listCrewsEach(cluster as never, namespaceScope({ namespace: 'team-4' }))).scope).toBe('namespace team-4');
    expect((await listCrewsEach(cluster as never, ['team-1', 'team-3'])).scope).toBe('namespaces team-1, team-3');
    expect((await listCrewsEach(cluster as never, [])).scope).toBe('all namespaces');
  });

  it('does not widen an explicit setting that holds no crews', async () => {
    recorded.settings.set(SETTING, ['default']);
    const cluster = workshop();
    expect(await listCrews(cluster as never, namespaceScope({ namespace: 'team-4' }))).toEqual([]);
    expect(cluster.calls).toHaveLength(1);
  });

  it('keeps the first failure when an implicit namespace cannot be read and the cluster cannot either', async () => {
    const cluster = workshop();
    const boom = new Error('forbidden');
    cluster.failures.set('/apis/kubemoot.ai/v1alpha1/namespaces/team-4/crews', boom);
    cluster.failures.set('/apis/kubemoot.ai/v1alpha1/crews', new Error('also forbidden'));
    await expect(listCrewsEach(cluster as never, namespaceScope({ namespace: 'team-4' }))).rejects.toBe(boom);
  });
});

describe('calls made opening the views on a thirty-namespace cluster', () => {
  it('drops from one per namespace to one for the context namespace', async () => {
    recorded.settings.set(SETTING, ['*']);
    const before = await open(workshop(), 'team-4');
    const after = await (async () => {
      recorded.settings.delete(SETTING);
      return open(workshop(), 'team-4');
    })();
    expect(before).toEqual({ crews: WORKSHOP, calls: 1 + 1 + 1 + WORKSHOP });
    expect(after).toEqual({ crews: 1, calls: 1 + 1 + 1 + 1 });
  });
});

describe('showing the scope in use', () => {
  it('tells the Deployed Crews view which namespaces it read, and clears it on an error', async () => {
    const cluster = workshop();
    const seen: (string | undefined)[] = [];
    const tree = new CrewTreeProvider(() => ({ source: '/k', context: 'lab', client: cluster as unknown as KubeClient, namespace: 'default' }));
    tree.onScope = (scope) => seen.push(scope);
    await tree.getChildren();
    cluster.failures.set('/apis/kubemoot.ai/v1alpha1/namespaces/default/crews', new Error('down'));
    cluster.failures.set('/apis/kubemoot.ai/v1alpha1/crews', new Error('down'));
    tree.refresh();
    await tree.getChildren();
    expect(seen).toEqual(['all namespaces (default had no crews)', undefined]);
  });

  it('puts a line on the Crews Overview, and none when the scope is unknown', () => {
    const connection = { label: 'lab', lines: [] } as never;
    expect(renderOverview({ connection, rows: [], scope: 'namespace team-4' })).toContain('Showing crews from namespace team-4.');
    expect(renderOverview({ connection, rows: [] })).not.toContain('Showing crews from');
  });
});
