import { beforeEach, describe, expect, it } from 'vitest';
import { judgeText, renderFitnessPage, type FitnessView } from '../src/dashboard/fitnessPage';
import { controlsIn, ControlsReader, FitnessActivity, RunControls, runControls, shownPhase } from '../src/fitness/controls';
import { isRunning, listIterations, listRuns, scenarioResults, toRun, type FitnessRun } from '../src/fitness/fitness';
import { KubeError } from '../src/k8s/request';
import { OPENAPI_PATH } from '../src/schema/kubemootSchema';
import { discoverKinds } from '../src/source/live';
import type { Manifest } from '../src/source/manifests';
import { FakeCluster } from './fakeCluster';
import { recorded, resetFake } from './vscodeFake';

beforeEach(resetFake);

const suite = (over: Partial<FitnessRun> = {}): FitnessRun => ({ kind: 'CrewFitnessSuite', name: 's1', namespace: 'ns', crew: 'demo', phase: 'Running', createdAt: '2026-09-30T10:00:00Z', assertions: [], scripts: ['a', 'b'], ...over });
const single = (over: Partial<FitnessRun> = {}): FitnessRun => ({ kind: 'CrewFitness', name: 'f1', namespace: 'ns', crew: 'demo', phase: 'Running', createdAt: '2026-09-30T10:00:00Z', assertions: [], ...over });

function fitnessObject(kind: string, name: string, spec: Record<string, unknown>, status: Record<string, unknown> = {}, labels: Record<string, string> = {}, annotations: Record<string, string> = {}): Manifest {
  return { apiVersion: 'kubemoot.ai/v1alpha1', kind, metadata: { name, namespace: 'ns', labels, annotations, creationTimestamp: '2026-09-30T10:00:00Z' }, spec, status };
}

describe('the fitness run model', () => {
  it('reads a suite\'s progress, times, artifact, controls, and scripts', () => {
    const run = toRun(
      'CrewFitnessSuite',
      fitnessObject(
        'CrewFitnessSuite',
        's1',
        { crewRef: 'demo', suspend: true, scripts: [{ testRef: 'a' }, {}, { testRef: 'b' }] },
        { phase: 'Paused', iterationsTotal: 4, iterationsCompleted: 2, startedAt: 'T0', runId: 'r1', artifactRef: { bucket: 'b', objectKey: 'k' }, conditions: [{ type: 'Ready', status: 'False' }] },
        {},
        { 'crewforge.kubemoot.ai/single-scenario': 'true' },
      ) as never,
    );
    expect(run).toMatchObject({ iterationsTotal: 4, iterationsCompleted: 2, startedAt: 'T0', runId: 'r1', artifact: { bucket: 'b', objectKey: 'k' }, suspend: true, cancel: false, scripts: ['a', 'b'], single: true });
    expect(isRunning(run)).toBe(true);
    expect(isRunning(suite({ phase: 'Cancelled' }))).toBe(false);
  });

  it('keeps suite iterations out of the crew\'s runs, and lists them for their suite', async () => {
    const cluster = new FakeCluster().add(
      fitnessObject('CrewFitnessSuite', 's1', { crewRef: 'demo' }),
      fitnessObject('CrewFitness', 's1-a-0', { crewRef: 'demo', testRef: 'a' }, { phase: 'Passed', durationMs: 2000 }, { 'kubemoot.ai/fitness-suite': 's1' }),
      fitnessObject('CrewFitness', 'other-it', { crewRef: 'demo', testRef: 'a' }, {}, { 'kubemoot.ai/fitness-suite': 's2' }),
    );
    const kinds = await discoverKinds(cluster);
    expect((await listRuns(cluster, kinds, 'ns', 'demo')).map((r) => r.name)).toEqual(['s1']);
    expect((await listIterations(cluster, kinds, 'ns', 's1')).map((r) => [r.name, r.testRef, r.iterationOf])).toEqual([['s1-a-0', 'a', 's1']]);
    expect(await listIterations(cluster, new Map(), 'ns', 's1')).toEqual([]);
  });

  it('groups iterations by scenario, in script order, with outcomes and mean durations', () => {
    const results = scenarioResults(['b', 'a'], [
      { scenario: 'a', status: 'Passed', durationMs: 1000 },
      { scenario: 'a', status: 'Failed', durationMs: 3000 },
      { scenario: 'a', status: 'Running' },
      { scenario: 'z', status: 'Timeout' },
      { scenario: 'y', status: 'Error', durationMs: 0 },
    ]);
    expect(results).toEqual([
      { scenario: 'b', done: 0, passed: 0, failed: 0, errored: 0, running: 0 },
      { scenario: 'a', done: 2, passed: 1, failed: 1, errored: 0, running: 1, meanMs: 2000 },
      { scenario: 'y', done: 1, passed: 0, failed: 0, errored: 1, running: 0 },
      { scenario: 'z', done: 1, passed: 0, failed: 0, errored: 1, running: 0 },
    ]);
  });
});

describe('suite controls', () => {
  const openapi = (spec: Record<string, object>): Parameters<typeof controlsIn>[0] => ({
    components: {
      schemas: {
        other: { 'x-kubernetes-group-version-kind': [{ kind: 'Crew' }] },
        suite: { 'x-kubernetes-group-version-kind': [{ kind: 'CrewFitnessSuite' }], properties: { spec: { properties: spec } } },
      },
    },
  });

  it('reads suspend and cancel from the CRD schema, once per client', async () => {
    expect(controlsIn(openapi({ suspend: {}, cancel: {} }))).toEqual({ suspend: true, cancel: true });
    expect(controlsIn(openapi({ iterations: {} }))).toEqual({ suspend: false, cancel: false });
    expect(controlsIn({})).toEqual({ suspend: false, cancel: false });
    const cluster = new FakeCluster();
    let reads = 0;
    const client = { request: async (_m: string, p: string) => (reads++, p === OPENAPI_PATH ? JSON.stringify(openapi({ cancel: {} })) : '{}'), stream: cluster.stream };
    const reader = new ControlsReader();
    expect(await reader.read(client)).toEqual({ suspend: false, cancel: true });
    await reader.read(client);
    expect(reads).toBe(1);
    let tries = 0;
    const flaky = { request: async () => (tries++, Promise.reject(new Error('down'))), stream: cluster.stream };
    const again = new ControlsReader();
    expect(await again.read(flaky)).toEqual({ suspend: false, cancel: false });
    await again.read(flaky);
    expect(tries).toBe(2);
  });

  it('shows Pausing and Stopping until the operator settles, and offers only the controls that apply', () => {
    expect(shownPhase(suite({ suspend: true }))).toBe('Pausing');
    expect(shownPhase(suite({ suspend: true, phase: 'Paused' }))).toBe('Paused');
    expect(shownPhase(suite({ cancel: true }))).toBe('Stopping');
    expect(shownPhase(single({ phase: '' }))).toBe('Pending');
    const both = { suspend: true, cancel: true };
    expect(runControls(suite(), both)).toEqual({ pause: true, resume: false, stop: true });
    expect(runControls(suite({ suspend: true, phase: 'Paused' }), both)).toEqual({ pause: false, resume: true, stop: true });
    expect(runControls(suite({ cancel: true }), both)).toEqual({ pause: true, resume: false, stop: false });
    expect(runControls(suite(), { suspend: false, cancel: false })).toEqual({ pause: false, resume: false, stop: false });
    expect(runControls(suite({ phase: 'Completed' }), both)).toEqual({ pause: false, resume: false, stop: false });
    expect(runControls(single({ single: true }), both)).toEqual({ pause: false, resume: false, stop: true });
    expect(runControls(single(), both)).toEqual({ pause: false, resume: false, stop: false });
  });

  it('pauses, resumes, and stops through the run\'s own object', async () => {
    const cluster = new FakeCluster().add(fitnessObject('CrewFitness', 'f1', { crewRef: 'demo' }));
    const controls = new RunControls(() => cluster, discoverKinds);
    await controls.pause(suite());
    await controls.resume(suite());
    recorded.warningAnswers.push('Stop', undefined, 'Stop', 'Stop', 'Stop');
    await controls.stop(suite());
    await controls.stop(suite());
    await controls.stop(single());
    await controls.stop(single());
    expect(cluster.calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.path, c.body])).toEqual([
      ['PATCH', '/apis/kubemoot.ai/v1alpha1/namespaces/ns/crewfitnesssuites/s1', { spec: { suspend: true } }],
      ['PATCH', '/apis/kubemoot.ai/v1alpha1/namespaces/ns/crewfitnesssuites/s1', { spec: { suspend: false } }],
      ['PATCH', '/apis/kubemoot.ai/v1alpha1/namespaces/ns/crewfitnesssuites/s1', { spec: { cancel: true } }],
      ['DELETE', '/apis/kubemoot.ai/v1alpha1/namespaces/ns/crewfitnesses/f1', undefined],
      ['DELETE', '/apis/kubemoot.ai/v1alpha1/namespaces/ns/crewfitnesses/f1', undefined],
    ]);
    expect(recorded.warnings).toEqual(['Stop s1?', 'Stop s1?', 'Stop f1?', 'Stop f1?']);
    cluster.failures.set('/apis/kubemoot.ai/v1alpha1/namespaces/ns/crewfitnesses/f1', new KubeError('forbidden', 403));
    await expect(controls.stop(single())).rejects.toThrow('forbidden');
    await expect(new RunControls(() => cluster, async () => new Map()).pause(suite())).rejects.toThrow('does not serve CrewFitnessSuite');
  });
});

describe('FitnessActivity', () => {
  it('tracks which crews have a run going, and tells the views when that changes', () => {
    const activity = new FitnessActivity();
    let changes = 0;
    activity.onDidChange(() => changes++);
    activity.record('ns', 'demo', [suite({ phase: 'Completed' })]);
    expect(changes).toBe(0);
    activity.started('ns', 'demo', 'run-1');
    expect(activity.isBusy('ns', 'demo')).toBe(true);
    activity.record('ns', 'demo', [suite({ name: 'run-1', phase: 'Pending' })]);
    expect(changes).toBe(1);
    activity.started('ns', 'demo', 'run-2');
    expect(changes).toBe(2);
    activity.record('ns', 'demo', []);
    expect(activity.isBusy('ns', 'demo')).toBe(false);
    expect(changes).toBe(3);
  });
});

describe('renderFitnessPage', () => {
  const view = (over: Partial<FitnessView> = {}): FitnessView => ({ crew: 'demo', namespace: 'ns', runs: [], iterations: [], controls: { suspend: true, cancel: true }, ...over });

  it('lists runs and shows the selected suite with its progress, controls, scenarios, and judge', () => {
    const running = suite({ iterationsTotal: 4, iterationsCompleted: 1, startedAt: '2026-09-30T10:00:00Z' });
    const html = renderFitnessPage(
      view({
        runs: [running, single({ phase: 'Passed', createdAt: 'T' })],
        selected: running,
        iterations: [toRun('CrewFitness', fitnessObject('CrewFitness', 'it', { testRef: 'a' }, { phase: 'Passed', durationMs: 42000 }) as never)],
      }),
    );
    expect(html).toContain('<h1>Fitness: demo</h1>');
    expect(html).toContain('data-action="select" data-arg="s1"');
    expect(html).toContain('1 of 4 iterations');
    expect(html).toContain('<progress max="4" value="1"></progress>');
    expect(html).toMatch(/data-action="run"[^>]*title="A fitness run for this crew is in progress\." disabled/);
    expect(html).toContain('data-action="pause" data-arg="s1"');
    expect(html).toContain('data-action="stop" data-arg="s1"');
    expect(html).not.toContain('data-action="resume"');
    expect(html).toContain('<td>a</td><td>1</td><td>1</td><td>0</td><td>0</td><td>42 s</td>');
    expect(html).toContain('From the iterations in the cluster.');
    expect(html).toContain('Judge: waits for the suite to finish');
  });

  it('shows a finished suite from the archived iterations with scores, and the XLSX when it can be downloaded', () => {
    const done = suite({ phase: 'Completed', passed: 2, failed: 0, errored: 0, artifact: { bucket: 'b', objectKey: 'ns/s1/r.xlsx' }, completedAt: '2026-09-30T10:05:00Z', startedAt: '2026-09-30T10:00:00Z' });
    const archived = [{ scenario: 'a', iter: 0, status: 'Passed', assertionsPassed: 3, assertionsTotal: 3, durationMs: 1000 }];
    const html = renderFitnessPage(view({ runs: [done], selected: done, archived, scores: { scores: { a: 85 }, complete: true, judged: 1 }, xlsxUrl: 'http://dash/x' }));
    expect(html).toContain('<td>a</td><td>1</td><td>1</td><td>0</td><td>0</td><td>1 s</td><td>85</td>');
    expect(html).toContain('From the iteration transcripts the Kubemoot dashboard keeps.');
    expect(html).toContain('Judge: done, 1 scenarios scored');
    expect(html).toMatch(/data-action="xlsx" data-arg="s1" title="Download/);
    expect(html).toContain('2 / 0 / 0');
    const noUrl = renderFitnessPage(view({ runs: [done], selected: done, archived: { unavailable: 'No dashboard.' } }));
    expect(noUrl).toContain('title="Set crewforge.dashboardUrl to download the XLSX." disabled');
    expect(noUrl).toContain('The cluster no longer holds the iterations. No dashboard.');
    expect(renderFitnessPage(view({ runs: [done], selected: done }))).toContain('The cluster no longer holds the iterations.');
  });

  it('shows a single run\'s assertions, the Resume and Stop it may have, and errors as text', () => {
    const paused = suite({ phase: 'Paused', suspend: true });
    expect(renderFitnessPage(view({ runs: [paused], selected: paused }))).toContain('data-action="resume"');
    const f = single({ phase: 'Failed', single: true, durationMs: 3000, error: '<judge down>', assertions: [{ raw: 'a', passed: true, message: 'ok' }, { raw: 'b', passed: false, message: 'no' }] });
    const html = renderFitnessPage(view({ runs: [f], selected: f, error: 'partial <read>', cannotRun: 'No source.' }));
    expect(html).toContain('&lt;judge down&gt;');
    expect(html).toContain('partial &lt;read&gt;');
    expect(html).toContain('badge bad">fail');
    expect(html).toContain('3 s');
    expect(html).toMatch(/data-action="run"[^>]*title="No source\." disabled/);
    const going = single({ single: true });
    const goingHtml = renderFitnessPage(view({ runs: [going], selected: going }));
    expect(goingHtml).toContain('Running...');
    expect(goingHtml).toContain('data-action="stop"');
    expect(renderFitnessPage(view())).toContain('No fitness runs yet.');
    expect(renderFitnessPage(view({ runs: [single({ phase: 'Passed' })], selected: single({ phase: 'Passed' }) }))).toContain('No assertions reported.');
  });

  it('says where the judge stands', () => {
    expect(judgeText(suite({ phase: 'Cancelled' }))).toBe('skipped, since the suite was cancelled');
    expect(judgeText(suite({ phase: 'Completed' }))).toBe('unknown');
    expect(judgeText(suite({ phase: 'Completed' }), { unavailable: 'down' })).toBe('unknown (down)');
    expect(judgeText(suite({ phase: 'Completed' }), { judged: 1 })).toBe('judging, 1 of 2 scenarios scored');
    expect(judgeText(suite({ phase: 'Completed', scripts: undefined }), {})).toBe('judging, 0 of 0 scenarios scored');
    expect(judgeText(suite({ phase: 'Completed' }), { complete: true })).toBe('done, 0 scenarios scored');
  });
});
