import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FitnessBatches, iterationsProblem, MAX_ITERATIONS, scenarioDescription, scenarioSuite, type BatchTarget, type Scenario } from '../src/fitness/batch';
import { SourceFitness } from '../src/fitness/sourceFitness';
import type { Deployment } from '../src/source/deployments';
import type { SourceEntry } from '../src/source/service';
import type { DeploymentNode, SourceNode } from '../src/views/sourceTree';
import { recorded, resetFake } from './vscodeFake';

beforeEach(resetFake);

const deployment: Deployment = { namespace: 'crew-test', crew: { name: 'test', namespace: 'crew-test', ready: true, phase: 'Ready' }, channel: 'helm', linked: true };
const scenarios: Scenario[] = [
  { name: 'pods', content: 'DESCRIPTION Workloads: the pods.\nASSERT(x)' },
  { name: 'events', content: '  DESCRIPTION   Warning events  \n' },
  { name: 'bare', content: 'ASSERT(y)' },
];
const target: BatchTarget = { deployment, title: 'Test Crew', scenarios };

type Pick = { label: string; description?: string; picked?: boolean; scenario: Scenario };
const pickAll = (items: Pick[]) => items;
const pickNames = (...names: string[]) => (items: Pick[]) => items.filter((i) => names.includes(i.label));
const iterations = (label: string) => (items: { label: string }[]) => items.find((i) => i.label === label);

function make(refused = false) {
  const runDefinition = vi.fn(async (_d: Deployment, _def: unknown) => (refused ? undefined : 'test-batch-2-20261002-120000'));
  const openDashboard = vi.fn();
  return { batches: new FitnessBatches({ runDefinition, openDashboard }), runDefinition, openDashboard };
}

describe('scenarioSuite', () => {
  it('names a suite for what it holds and runs each scenario the given iterations', () => {
    expect(scenarioSuite('test', scenarios, 'all')).toMatchObject({ kind: 'CrewFitnessSuite', metadata: { name: 'test-all', labels: { 'kubemoot.ai/crew': 'test' } }, spec: { crewRef: 'test', iterations: 1, description: '3 scenarios run by CrewForge.' } });
    const batch = scenarioSuite('test', scenarios.slice(0, 2), 'batch', 5);
    expect(batch).toMatchObject({ metadata: { name: 'test-batch-2' }, spec: { iterations: 5, scripts: [{ testRef: 'pods' }, { testRef: 'events' }] } });
    expect(batch.metadata.annotations).toBeUndefined();
    expect(scenarioSuite('test', [scenarios[2]], 'single')).toMatchObject({ metadata: { name: 'test-bare', annotations: { 'crewforge.kubemoot.ai/single-scenario': 'true' } }, spec: { description: '1 scenario run by CrewForge.' } });
    expect(scenarioSuite('test', [], 'single').metadata.name).toBe('test-scenario');
  });

  it('reads a scenario description, and says what an iteration count must be', () => {
    expect(scenarios.map((s) => scenarioDescription(s.content))).toEqual(['Workloads: the pods.', 'Warning events', undefined]);
    for (const ok of ['1', ' 7 ', String(MAX_ITERATIONS)]) expect(iterationsProblem(ok), ok).toBeUndefined();
    for (const bad of ['0', '-1', '2.5', 'x', '', String(MAX_ITERATIONS + 1)]) expect(iterationsProblem(bad), bad).toBe('Enter a whole number from 1 to 100.');
  });
});

describe('FitnessBatches', () => {
  it('offers every scenario with its description, all checked, then the iterations, and runs the chosen ones as one suite', async () => {
    const { batches, runDefinition, openDashboard } = make();
    let offered: Pick[] = [];
    recorded.quickPicks.push((items: Pick[]) => ((offered = items), pickNames('pods', 'bare')(items)), iterations('5'));
    await batches.choose(target);
    expect(offered.map((i) => [i.label, i.description, i.picked])).toEqual([
      ['pods', 'Workloads: the pods.', true],
      ['events', 'Warning events', true],
      ['bare', undefined, true],
    ]);
    const [at, suite] = runDefinition.mock.calls[0];
    expect(at).toBe(deployment);
    expect(suite).toMatchObject({ metadata: { name: 'test-batch-2' }, spec: { iterations: 5, scripts: [{ testRef: 'pods' }, { testRef: 'bare' }] } });
    expect(openDashboard).toHaveBeenCalledWith(deployment, 'test-batch-2-20261002-120000');
  });

  it('calls a batch of every scenario all, and takes a typed iteration count', async () => {
    const { batches, runDefinition } = make();
    recorded.quickPicks.push(pickAll, iterations('Another number...'));
    recorded.inputs.push(' 12 ');
    await batches.choose(target);
    expect(runDefinition.mock.calls[0][1]).toMatchObject({ metadata: { name: 'test-all' }, spec: { iterations: 12 } });
  });

  it('runs nothing when the pick, the iterations, or the typed count is cancelled or wrong', async () => {
    const { batches, runDefinition } = make();
    recorded.quickPicks.push(undefined);
    await batches.choose(target);
    recorded.quickPicks.push(pickAll, undefined);
    await batches.choose(target);
    recorded.quickPicks.push(pickAll, iterations('Another number...'));
    recorded.inputs.push(undefined);
    await batches.choose(target);
    recorded.quickPicks.push(pickAll, iterations('Another number...'));
    recorded.inputs.push('500');
    await batches.choose(target);
    expect(runDefinition).not.toHaveBeenCalled();
  });

  it('says so when nothing is selected, or the crew has no scenarios', async () => {
    const { batches, runDefinition } = make();
    recorded.quickPicks.push(() => []);
    await batches.choose(target);
    await batches.choose({ ...target, scenarios: [] });
    await batches.runChosen(target, []);
    await batches.runAll({ ...target, scenarios: [] });
    expect(recorded.info).toEqual(['No scenarios were selected, so nothing was run.', 'Test Crew has no fitness scenarios to run.', 'No scenarios were selected, so nothing was run.', 'Test Crew has no fitness scenarios to run.']);
    expect(runDefinition).not.toHaveBeenCalled();
  });

  it('runs all once and one scenario once in a click, and opens no dashboard when the run was refused', async () => {
    const { batches, runDefinition, openDashboard } = make(true);
    await batches.runAll(target);
    await batches.runOne(target, scenarios[1]);
    expect(runDefinition.mock.calls.map((c) => (c[1] as { metadata: { name: string }; spec: { iterations: number } }).metadata.name)).toEqual(['test-all', 'test-events']);
    expect(openDashboard).not.toHaveBeenCalled();
  });
});

describe('SourceFitness', () => {
  const entry = (root: string) => ({ source: { kind: 'helm', root, label: 'test' }, identity: { id: `local:${root}` }, crewName: 'test', displayName: 'Test Crew' }) as SourceEntry;
  const fitnessNode = (root = '/w/test'): SourceNode => ({ kind: 'fitness', entry: entry(root), deployment });
  const scenarioRow = (name: string, root = '/w/test'): SourceNode => ({ kind: 'declared', entry: entry(root), item: { label: name, scenario: { kind: 'suite-script', name, owner: 'test-starter', file: `${root}/fitness/fitness.yaml` } } as never });

  function make(deployed = true) {
    const redeploy: DeploymentNode | undefined = deployed ? { kind: 'deployment', entry: entry('/w/test'), deployment } : undefined;
    const batches = { choose: vi.fn(async () => undefined), runChosen: vi.fn(async () => undefined), runOne: vi.fn(async () => undefined) };
    const scenarioScripts = vi.fn(async () => scenarios);
    const redeployTarget = vi.fn(async () => redeploy);
    return { source: new SourceFitness({ batches, scenarioScripts, redeployTarget }), batches, scenarioScripts, redeployTarget };
  }

  it('picks a batch from the Fitness node of a deployment, or from Fitness Scenarios through its Redeploy target', async () => {
    const { source, batches, scenarioScripts, redeployTarget } = make();
    await source.choose(fitnessNode());
    await source.choose({ kind: 'declSection', entry: entry('/w/test'), section: 'fitness', items: [] });
    expect(redeployTarget).toHaveBeenCalledTimes(1);
    expect(scenarioScripts).toHaveBeenCalledWith(entry('/w/test'), 'crew-test');
    expect(batches.choose).toHaveBeenCalledWith({ deployment, title: 'Test Crew', scenarios });
    expect(batches.choose).toHaveBeenCalledTimes(2);
    await source.choose(undefined);
    expect(batches.choose).toHaveBeenCalledTimes(2);
  });

  it('runs the selected scenario rows of one source as one batch, and nothing without a deployment', async () => {
    const { source, batches } = make();
    await source.runSelected(scenarioRow('pods'), [scenarioRow('pods'), scenarioRow('bare'), fitnessNode()]);
    expect(batches.runChosen).toHaveBeenCalledWith({ deployment, title: 'Test Crew', scenarios }, [scenarios[0], scenarios[2]]);
    const none = make(false);
    await none.source.runSelected(scenarioRow('pods'));
    expect(none.batches.runChosen).not.toHaveBeenCalled();
  });

  it('refuses rows of two sources, and an empty selection, saying why', async () => {
    const { source, batches } = make();
    await source.runSelected(undefined, [scenarioRow('pods'), scenarioRow('pods', '/w/other')]);
    await source.runSelected(fitnessNode(), undefined);
    expect(recorded.info).toEqual([
      "The selected scenarios belong to 2 crew sources. Select the scenarios of one source: CrewForge runs one crew's batch at a time.",
      'No scenarios are selected. Select scenario rows under Fitness Scenarios, then choose Run Selected Scenarios.',
    ]);
    expect(batches.runChosen).not.toHaveBeenCalled();
  });
});
