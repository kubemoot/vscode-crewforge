import { beforeEach, describe, expect, it } from 'vitest';
import { FitnessCommands } from '../src/fitness/commands';
import { isRunning, judgeOf, listRuns, scenarioResults, scenarioResultsFromStatus, runName, runReport, runsInProgress, runSummary, scenariosOf, startRun, toRun, type FitnessRun } from '../src/fitness/fitness';
import type { KubeClient } from '../src/k8s/request';
import type { Deployment } from '../src/source/deployments';
import type { CrewSource } from '../src/source/discover';
import { discoverKinds } from '../src/source/live';
import type { Manifest } from '../src/source/manifests';
import { SourceService, type SourceDeps } from '../src/source/service';
import { SourceTreeProvider } from '../src/views/sourceTree';
import { FakeCluster } from './fakeCluster';
import { recorded, resetFake } from './vscodeFake';

function fitnessObj(kind: 'CrewFitness' | 'CrewFitnessSuite', name: string, namespace: string, crew: string, status: Record<string, unknown> = {}, created = '2026-09-27T10:00:00Z'): Manifest {
  return { apiVersion: 'kubemoot.ai/v1alpha1', kind, metadata: { name, namespace, creationTimestamp: created }, spec: { crewRef: crew }, status };
}

const assertion = (passed: boolean, raw = 'synthesis CONTAINS "Paris"') => ({ raw, passed, message: passed ? 'ok' : 'missing | pipe\nline' });

describe('runs', () => {
  it('reads status into runs and summarizes them', () => {
    const suite = toRun('CrewFitnessSuite', fitnessObj('CrewFitnessSuite', 's', 'ns', 'demo', { phase: 'Completed', passed: 2, failed: 1, errored: 0 }) as never);
    expect(runSummary(suite)).toBe('Completed · 2 passed, 1 failed, 0 errored');
    const single = toRun('CrewFitness', fitnessObj('CrewFitness', 'f', 'ns', 'demo', { phase: 'Failed', assertions: [assertion(true), assertion(false)], error: '' }) as never);
    expect(runSummary(single)).toBe('Failed · 1/2 assertions');
    expect(single.error).toBeUndefined();
    const fresh = toRun('CrewFitness', { apiVersion: 'kubemoot.ai/v1alpha1', kind: 'CrewFitness', metadata: { name: 'n' } } as never);
    expect(fresh).toMatchObject({ phase: '', crew: '', namespace: '', createdAt: '', assertions: [] });
    expect(runSummary(fresh)).toBe('Pending');
    expect(runSummary({ ...suite, passed: undefined, phase: 'Running' })).toBe('Running');
    expect(runSummary({ ...suite, phase: '', failed: undefined, errored: undefined })).toBe('Pending · 2 passed, 0 failed, 0 errored');
    expect(isRunning(fresh)).toBe(true);
    expect(isRunning(suite)).toBe(false);
  });

  it('keeps a text creation time and drops any other kind', () => {
    const at = (created: unknown) => toRun('CrewFitness', { apiVersion: 'kubemoot.ai/v1alpha1', kind: 'CrewFitness', metadata: { name: 'n', creationTimestamp: created } } as never).createdAt;
    expect(at('2026-09-27T10:00:00Z')).toBe('2026-09-27T10:00:00Z');
    expect(at({ seconds: 1 })).toBe('');
    expect(at(1_758_967_200)).toBe('');
    expect(at(null)).toBe('');
  });

  it('writes a Markdown report with every assertion, escaping table cells', () => {
    const run: FitnessRun = { kind: 'CrewFitness', name: 'f', namespace: 'ns', crew: 'demo', phase: 'Failed', createdAt: '2026-09-27T10:00:00Z', assertions: [assertion(true), assertion(false)], error: 'judge down' };
    const report = runReport(run);
    expect(report).toContain('# f');
    expect(report).toContain('Error: judge down');
    expect(report).toContain('| pass | synthesis CONTAINS "Paris" | ok |');
    expect(report).toContain('| FAIL | synthesis CONTAINS "Paris" | missing \\| pipe line |');
    expect(runReport({ ...run, assertions: [], error: undefined, createdAt: '' })).not.toContain('|');
  });

  it('lists a crew\'s runs newest first, and only its own', async () => {
    const cluster = new FakeCluster().add(
      fitnessObj('CrewFitness', 'old', 'ns', 'demo', {}, '2026-09-27T09:00:00Z'),
      fitnessObj('CrewFitnessSuite', 'new', 'ns', 'demo', {}, '2026-09-27T11:00:00Z'),
      fitnessObj('CrewFitness', 'other-crew', 'ns', 'else'),
      fitnessObj('CrewFitness', 'other-ns', 'ns2', 'demo'),
    );
    const runs = await listRuns(cluster, await discoverKinds(cluster), 'ns', 'demo');
    expect(runs.map((r) => r.name)).toEqual(['new', 'old']);
    const noSuites = new Map([...(await discoverKinds(cluster))].filter(([k]) => k !== 'CrewFitnessSuite'));
    expect((await listRuns(cluster, noSuites, 'ns', 'demo')).map((r) => r.name)).toEqual(['old']);
  });

  it('finds runs in progress across the cluster, or in the namespace when that is all it may list', async () => {
    const cluster = new FakeCluster().add(
      fitnessObj('CrewFitnessSuite', 'busy', 'far', 'x', { phase: 'Running' }),
      fitnessObj('CrewFitness', 'done', 'ns', 'demo', { phase: 'Passed' }),
      fitnessObj('CrewFitness', 'waiting', 'ns', 'demo'),
    );
    const kinds = await discoverKinds(cluster);
    expect((await runsInProgress(cluster, kinds, 'ns')).map((r) => r.name).sort()).toEqual(['busy', 'waiting']);
    cluster.failures.set('/apis/kubemoot.ai/v1alpha1/crewfitnesssuites', new Error('forbidden'));
    cluster.failures.set('/apis/kubemoot.ai/v1alpha1/crewfitnesses', new Error('forbidden'));
    expect((await runsInProgress(cluster, kinds, 'ns')).map((r) => r.name)).toEqual(['waiting']);
    expect(await runsInProgress(cluster, new Map(), 'ns')).toEqual([]);
  });

  it('starts a run under a timestamped name, keeping labels and dropping server fields', async () => {
    const cluster = new FakeCluster();
    const kinds = await discoverKinds(cluster);
    const definition = { ...fitnessObj('CrewFitnessSuite', 'starter', 'elsewhere', 'demo'), metadata: { name: 'starter', namespace: 'elsewhere', labels: { a: 'b' }, resourceVersion: '9', uid: 'u' } };
    const name = await startRun(cluster, kinds, 'ns', definition, new Date('2026-09-27T10:11:12Z'));
    expect(name).toBe('starter-20260927-101112');
    const post = cluster.calls.find((c) => c.method === 'POST')!;
    expect(post.path).toBe('/apis/kubemoot.ai/v1alpha1/namespaces/ns/crewfitnesssuites');
    expect((post.body as Manifest).metadata).toEqual({ name: 'starter-20260927-101112', namespace: 'ns', labels: { a: 'b' }, annotations: undefined });
    await expect(startRun(cluster, new Map(), 'ns', definition)).rejects.toThrow('does not serve CrewFitnessSuite');
  });

  it('keeps run names within 63 characters', () => {
    const name = runName('a'.repeat(70), new Date('2026-09-27T10:11:12Z'));
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name.endsWith('-20260927-101112')).toBe(true);
    expect(runName('x-'.repeat(30), new Date('2026-09-27T10:11:12Z'))).not.toContain('--');
  });
});

const chart: CrewSource = { kind: 'helm', root: '/w/demo-crew', label: 'demo-crew' };
const RENDERED = 'apiVersion: kubemoot.ai/v1alpha1\nkind: Crew\nmetadata:\n  name: demo\nspec: {}\n---\napiVersion: kubemoot.ai/v1alpha1\nkind: CrewFitnessSuite\nmetadata:\n  name: rendered-suite\nspec:\n  crewRef: demo\n';

function deps(folders: Record<string, string> = {}): SourceDeps {
  return {
    exec: async (cmd) => (cmd === 'git' ? { code: 128, stdout: '', stderr: '' } : { code: 0, stdout: RENDERED, stderr: '' }),
    readText: async () => '',
    readYamlFiles: async (dir) => {
      if (dir === '/w/broken/fitness') throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      if (!(dir in folders)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return [{ file: `${dir}/f.yaml`, text: folders[dir] }];
    },
    listFiles: async () => ({ charts: [], yamls: [] }),
  };
}

const entry = { source: chart, identity: { id: 'local:demo-crew' }, crewName: 'demo' };
const deployment: Deployment = { namespace: 'ns', crew: { name: 'demo', namespace: 'ns', ready: true, phase: 'Ready' }, channel: 'helm', linked: true };

describe('SourceService fitness', () => {
  it('offers rendered definitions and those in fitness/ inside or beside the source, once each', async () => {
    const suite = 'apiVersion: kubemoot.ai/v1alpha1\nkind: CrewFitness\nmetadata:\n  name: inside\nspec:\n  crewRef: demo\n';
    const beside = 'apiVersion: kubemoot.ai/v1alpha1\nkind: CrewFitnessSuite\nmetadata:\n  name: rendered-suite\nspec:\n  crewRef: demo\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\n';
    const service = new SourceService(deps({ '/w/demo-crew/fitness': suite, '/w/fitness': beside }));
    const definitions = await service.fitnessDefinitions(entry, 'ns');
    expect(definitions.map((d) => d.metadata.name)).toEqual(['rendered-suite', 'inside']);
  });

  it('reports a fitness folder it cannot read instead of calling it empty', async () => {
    const broken = { ...entry, source: { ...chart, root: '/w/broken' } };
    await expect(new SourceService(deps()).fitnessDefinitions(broken, 'ns')).rejects.toThrow('permission denied');
  });

  it('compares the fitness the source renders, leaves started runs out of drift, and lists both as runs', async () => {
    const cluster = new FakeCluster().add(
      { apiVersion: 'kubemoot.ai/v1alpha1', kind: 'Crew', metadata: { name: 'demo', namespace: 'ns' }, spec: {} },
      { ...fitnessObj('CrewFitnessSuite', 'rendered-suite', 'ns', 'demo', { phase: 'Completed' }), spec: { crewRef: 'demo' } },
      { ...fitnessObj('CrewFitnessSuite', 'rendered-suite-20260927-101112', 'ns', 'demo'), metadata: { name: 'rendered-suite-20260927-101112', namespace: 'ns', labels: { 'kubemoot.ai/crew': 'demo' } } },
    );
    const service = new SourceService(deps());
    const drift = await service.drift(entry, deployment, cluster);
    expect(drift.map((d) => `${d.kind}:${d.state}`)).toEqual(['Crew:in-sync', 'CrewFitnessSuite:in-sync']);
    expect((await service.runs(deployment, cluster)).map((r) => r.name).sort()).toEqual(['rendered-suite', 'rendered-suite-20260927-101112']);
  });
});

describe('fitness in the tree and commands', () => {
  let cluster: FakeCluster;
  let started: number;

  beforeEach(() => {
    resetFake();
    cluster = new FakeCluster();
    started = 0;
  });

  const connection = () => ({ source: '/k', context: 'lab', client: cluster as unknown as KubeClient });
  const commands = (service = new SourceService(deps())) => new FitnessCommands(service, () => started++, connection);
  const fitnessNode = { kind: 'fitness' as const, entry, deployment };

  it('shows runs with icons by phase, or says there are none', async () => {
    const tree = new SourceTreeProvider(new SourceService(deps()), connection);
    const [none] = await tree.getChildren(fitnessNode);
    expect(tree.getTreeItem(none).label).toBe('No fitness runs yet');
    expect(tree.getTreeItem(fitnessNode)).toMatchObject({ label: 'Fitness', contextValue: 'fitness' });
    cluster.add(
      fitnessObj('CrewFitness', 'a', 'ns', 'demo', { phase: 'Passed' }, '2026-09-27T12:00:00Z'),
      fitnessObj('CrewFitness', 'b', 'ns', 'demo', { phase: 'Running' }, '2026-09-27T11:00:00Z'),
      fitnessObj('CrewFitness', 'c', 'ns', 'demo', { phase: 'Weird', error: 'odd' }, '2026-09-27T10:00:00Z'),
    );
    const runs = await tree.getChildren(fitnessNode);
    const items = runs.map((r) => tree.getTreeItem(r));
    expect(items.map((i) => (i.iconPath as { id: string }).id)).toEqual(['pass', 'sync~spin', 'circle-outline']);
    expect(items[2].tooltip).toContain('odd');
    expect(items[0].command).toMatchObject({ command: 'crewforge.openFitnessDashboard' });
    cluster.failures.set('/apis/kubemoot.ai/v1alpha1', new Error('discovery down'));
    const broken = new SourceTreeProvider(new SourceService(deps()), connection);
    expect(broken.getTreeItem((await broken.getChildren(fitnessNode))[0]).label).toBe('discovery down');
  });

  it('runs a picked definition, warning first when another run is in progress', async () => {
    cluster.add(fitnessObj('CrewFitnessSuite', 'busy', 'far', 'x', { phase: 'Running' }));
    recorded.quickPicks.push((items: { label: string }[]) => items[0], (items: { label: string }[]) => items[0]);
    recorded.warningAnswers.push(undefined, 'Start anyway');
    await commands().runFitness(fitnessNode);
    expect(recorded.warnings[0]).toContain('far/busy');
    expect(cluster.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    await commands().runFitness({ kind: 'deployment', entry, deployment });
    expect(cluster.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(recorded.info[0]).toMatch(/^Started rendered-suite-\d{8}-\d{6} in ns/);
    expect(started).toBe(1);
  });

  it('starts without asking on a quiet cluster, and explains when there is nothing to run', async () => {
    recorded.quickPicks.push((items: { label: string }[]) => items[0]);
    await commands().runFitness(fitnessNode);
    expect(recorded.warnings).toEqual([]);
    expect(started).toBe(1);
    const empty = new SourceService({ ...deps(), exec: async (cmd) => ({ code: cmd === 'git' ? 128 : 0, stdout: cmd === 'git' ? '' : 'apiVersion: kubemoot.ai/v1alpha1\nkind: Crew\nmetadata:\n  name: demo\n', stderr: '' }) });
    await commands(empty).runFitness(fitnessNode);
    expect(recorded.info.at(-1)).toContain('has no CrewFitness');
    recorded.quickPicks.push(undefined);
    await commands().runFitness(fitnessNode);
    await commands().runFitness({ kind: 'message', text: 'x' });
    expect(started).toBe(1);
  });

  it('reruns a remembered definition without asking, and asks when the source no longer has it', async () => {
    expect(await commands().runFitness(fitnessNode, 'rendered-suite')).toBe('rendered-suite');
    expect(recorded.quickPicks).toEqual([]);
    expect(await commands().runFitness(fitnessNode, 'rendered-suite')).toBeUndefined();
    expect(recorded.info.at(-1)).toMatch(/^A fitness run of demo is in progress \(rendered-suite-\d{8}-\d{6}\)/);
    cluster.objects.at(-1)!.status = { phase: 'Completed' };
    recorded.quickPicks.push((items: { label: string }[]) => items[0]);
    recorded.warningAnswers.push('Start anyway');
    expect(await commands().runFitness(fitnessNode, 'gone')).toBe('rendered-suite');
    expect(started).toBe(2);
  });

  it('opens a run as a Markdown report', async () => {
    const run = toRun('CrewFitness', fitnessObj('CrewFitness', 'f', 'ns', 'demo', { phase: 'Passed', assertions: [assertion(true)] }) as never);
    await commands().showRun({ kind: 'run', entry, deployment, run });
    expect(recorded.shownDocuments[0]).toContain('# f');
    await commands().showRun({ kind: 'message', text: 'x' });
    expect(recorded.shownDocuments).toHaveLength(1);
  });
});

describe('suite results from status', () => {
  it('reads status.judge, filling counts the operator omits at 0', () => {
    expect(judgeOf({ phase: 'Judging', total: 3, scores: [{ scenario: 'a', score: 80, reason: 'ok' }, { scenario: 'b' }, { score: 5 }, 'x', null] })).toEqual({
      phase: 'Judging',
      judged: 0,
      total: 3,
      mean: undefined,
      zeros: 0,
      completedAt: undefined,
      scores: [
        { scenario: 'a', score: 80, reason: 'ok' },
        { scenario: 'b', score: 0, reason: undefined },
      ],
    });
    expect(judgeOf({ phase: 'Complete', judged: 2, total: 2, mean: 0, zeros: 2, completedAt: '2026-10-02T10:00:00Z', scores: 'nope' })).toMatchObject({ mean: 0, zeros: 2, completedAt: '2026-10-02T10:00:00Z', scores: [] });
    expect(judgeOf({ phase: 'Judging', judged: Number.NaN, mean: '7', completedAt: '' })).toMatchObject({ judged: 0, mean: undefined, completedAt: undefined });
  });

  it('skips a score entry whose score is not a number, and reads an absent score as 0', () => {
    const judge = judgeOf({ phase: 'Complete', scores: [{ scenario: 'a', score: 'high' }, { scenario: 'b', score: Number.NaN }, { scenario: 'c' }] });
    expect(judge?.scores).toEqual([{ scenario: 'c', score: 0, reason: undefined }]);
  });

  it('rolls up the same results from live iterations and from the status, in script order', () => {
    const live = scenarioResults(
      ['b', 'a'],
      [
        { scenario: 'a', status: 'Passed', durationMs: 1000 },
        { scenario: 'a', status: 'Failed', durationMs: 3000 },
        { scenario: 'z', status: 'Error' },
      ],
    );
    const fromStatus = scenarioResultsFromStatus(['b', 'a'], [
      { name: 'z', iterations: 1, passed: 0, failed: 0, errored: 1 },
      { name: 'a', iterations: 2, passed: 1, failed: 1, errored: 0, meanDurationMs: 2000 },
    ]);
    expect(fromStatus).toEqual(live);
    expect(fromStatus.map((r) => r.scenario)).toEqual(['b', 'a', 'z']);
  });

  it('has no judge when status.judge is missing or malformed', () => {
    for (const raw of [undefined, null, 'Complete', [], {}, { phase: 3 }]) expect(judgeOf(raw)).toBeUndefined();
  });

  it('reads status.scenarios, skipping entries without a name', () => {
    expect(scenariosOf([{ name: 'a', iterations: 2, passed: 1, failed: 1, meanDurationMs: 1500 }, { iterations: 1 }, 'x'])).toEqual([{ name: 'a', iterations: 2, passed: 1, failed: 1, errored: 0, meanDurationMs: 1500 }]);
    expect(scenariosOf(undefined)).toBeUndefined();
    expect(scenariosOf({ name: 'a' })).toBeUndefined();
    expect(scenariosOf([])).toEqual([]);
  });

  it('carries both on a suite run', () => {
    const run = toRun('CrewFitnessSuite', {
      apiVersion: 'kubemoot.ai/v1alpha1',
      kind: 'CrewFitnessSuite',
      metadata: { name: 's', namespace: 'ns' },
      status: { phase: 'Completed', judge: { phase: 'Complete', judged: 1, total: 1, mean: 90, scores: [{ scenario: 'a', score: 90 }] }, scenarios: [{ name: 'a', iterations: 1, passed: 1 }] },
    } as never);
    expect(run.judge?.mean).toBe(90);
    expect(run.scenarios?.[0]).toMatchObject({ name: 'a', passed: 1 });
  });
});
