import { beforeEach, describe, expect, it } from 'vitest';
import type { KubeClient } from '../src/k8s/request';
import { DevLoop, type DevLoopDeps } from '../src/loop/devLoop';
import { LoopMemory, LoopStates } from '../src/loop/state';
import type { Exec } from '../src/source/render';
import { SourceService, type SourceEntry } from '../src/source/service';
import { CrewTreeProvider } from '../src/views/crewTree';
import { SourceTreeProvider, type SourceNode } from '../src/views/sourceTree';
import { FakeCluster, obj } from './fakeCluster';
import { recorded, resetFake, workspaceState } from './vscodeFake';

beforeEach(resetFake);

const entry: SourceEntry = { source: { kind: 'helm', root: '/w/demo', label: 'demo' }, identity: { id: 'local:demo' }, crewName: 'demo' };
const deployment = { namespace: 'ns', crew: { name: 'demo', namespace: 'ns', ready: true, phase: 'Ready' }, channel: 'helm' as const, linked: true };

describe('Deployed Crews', () => {
  it('starts with the connection, which opens the Crews Overview, and marks a crew with a fitness run going', async () => {
    const c = obj('Crew', 'demo', 'ns');
    c.status = { ready: true, phase: 'Ready' };
    const cluster = new FakeCluster().add(c);
    const tree = new CrewTreeProvider(() => ({ source: '/k', context: 'lab', client: cluster as unknown as KubeClient }));
    const [plain] = await tree.getChildren();
    expect(plain.kind).toBe('namespace');
    tree.connectionItem = () => ({ label: 'lab', tooltip: 'CrewForge dev\nContext: lab' });
    tree.fitnessBusy = (ns, crew) => ns === 'ns' && crew === 'demo';
    const [connection, ns] = await tree.getChildren();
    const item = tree.getTreeItem(connection);
    expect(item).toMatchObject({ label: 'lab', description: 'Crews Overview', tooltip: 'CrewForge dev\nContext: lab', contextValue: 'connection', command: { command: 'crewforge.openCrewsOverview' } });
    expect(tree.getParent(connection)).toBeUndefined();
    expect(await tree.getChildren(connection)).toEqual([]);
    const [crew] = await tree.getChildren(ns);
    expect(tree.getTreeItem(crew).contextValue).toBe('crew-running');
  });
});

describe('Crew Sources and dashboards', () => {
  const exec: Exec = async (cmd) => (cmd === 'git' ? { code: 128, stdout: '', stderr: '' } : { code: 0, stdout: 'apiVersion: kubemoot.ai/v1alpha1\nkind: Crew\nmetadata:\n  name: demo\n', stderr: '' });
  const service = () =>
    new SourceService({ exec, readText: async () => 'apiVersion: kubemoot.ai/v1alpha1\nkind: Crew\n', readYamlFiles: async () => [], listFiles: async () => ({ charts: ['/w/demo/Chart.yaml'], yamls: ['/w/demo/templates/crew.yaml'] }) });

  it('opens a crew or fitness dashboard on click, and hides Run Fitness while a run is going', async () => {
    const c = obj('Crew', 'demo', 'ns');
    c.status = { ready: true, phase: 'Ready' };
    const cluster = new FakeCluster().add(c);
    const tree = new SourceTreeProvider(service(), () => ({ source: '/k', context: 'lab', client: cluster as unknown as KubeClient }));
    const recordedRuns: string[] = [];
    tree.onRuns = (ns, crew, runs) => void recordedRuns.push(`${ns}/${crew}:${runs.length}`);
    const source: SourceNode = { kind: 'source', entry };
    expect(tree.getTreeItem(source)).toMatchObject({ contextValue: 'source-helm', command: { command: 'crewforge.openCrewDashboard', arguments: [source] } });
    await tree.loadDeployments(entry);
    tree.fitnessBusy = () => true;
    expect(tree.getTreeItem(source).contextValue).toBe('source-helm-running');
    const deploymentNode: SourceNode = { kind: 'deployment', entry, deployment, drift: [] };
    expect(tree.getTreeItem(deploymentNode).contextValue).toBe('deployment-helm-running');
    const fitness: SourceNode = { kind: 'fitness', entry, deployment };
    expect(tree.getTreeItem(fitness)).toMatchObject({ contextValue: 'fitness-running', description: 'run in progress', command: { command: 'crewforge.openFitnessDashboard' } });
    tree.fitnessBusy = () => false;
    expect(tree.getTreeItem(fitness)).toMatchObject({ contextValue: 'fitness', description: undefined });
    await tree.getChildren(fitness);
    expect(recordedRuns).toEqual(['ns/demo:0']);
    const run = (phase: string) => tree.getTreeItem({ kind: 'run', entry, deployment, run: { kind: 'CrewFitnessSuite', name: 'r', namespace: 'ns', crew: 'demo', phase, createdAt: '', assertions: [] } });
    expect((run('Cancelled').iconPath as { id: string }).id).toBe('circle-slash');
    expect((run('Paused').iconPath as { id: string }).id).toBe('debug-pause');
    expect((run('Running').iconPath as { id: string }).id).toBe('sync~spin');
    const scenario: SourceNode = { kind: 'declared', entry, item: { label: 'a', tooltip: '', icon: 'beaker', line: 0, file: '/f', scenario: { kind: 'script-file', name: 'a', file: '/f' } } };
    expect(tree.getTreeItem(scenario).contextValue).toBe('declared-scenario');
  });

  it('redraws from the loaded sources without loading them again', async () => {
    let loads = 0;
    const counting = new SourceService({ exec, readText: async () => '', readYamlFiles: async () => [], listFiles: async () => (loads++, { charts: [], yamls: [] }) });
    const tree = new SourceTreeProvider(counting, () => ({ source: '/k', context: 'lab', client: new FakeCluster() as unknown as KubeClient }));
    let fired = 0;
    tree.onDidChangeTreeData(() => fired++);
    tree.redraw();
    await tree.getChildren();
    expect(loads).toBe(1);
    const withSources = new SourceTreeProvider(service(), () => ({ source: '/k', context: 'lab', client: new FakeCluster() as unknown as KubeClient }));
    const first = await withSources.getChildren();
    expect(first.map((n) => n.kind)).toEqual(['source']);
    withSources.redraw();
    expect(await withSources.getChildren()).toBe(first);
    expect(fired).toBe(1);
  });
});

describe('DevLoop.redeployTargetOf', () => {
  it('finds the deployment Redeploy goes to for a node\'s source, or says why there is none', async () => {
    const node = { kind: 'deployment' as const, entry, deployment, drift: [] };
    let nodes: SourceNode[] = [node];
    const deps = {
      sources: { entries: async () => [entry], known: [entry], loadDeployments: async () => nodes, refresh: () => undefined },
      memory: new LoopMemory(workspaceState),
      states: new LoopStates(),
      connectTo: () => ({ source: '/k', context: 'lab', client: new FakeCluster() as unknown as KubeClient }),
    } as unknown as DevLoopDeps;
    const loop = new DevLoop(deps);
    expect(await loop.redeployTargetOf({ kind: 'source', entry })).toBe(node);
    nodes = [{ kind: 'message', text: 'Not deployed in lab', icon: 'circle-slash' }];
    expect(await loop.redeployTargetOf({ kind: 'source', entry })).toBeUndefined();
    expect(recorded.info.at(-1)).toMatch(/^demo is not deployed in lab/);
    expect(await loop.redeployTargetOf({ kind: 'source', entry: { ...entry, crewName: undefined } })).toBeUndefined();
  });
});
