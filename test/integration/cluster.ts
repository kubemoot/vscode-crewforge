import { FakeCluster, obj, seedCrew, seedInfrastructure } from '../fakeCluster';

/**
 * The cluster the integration run talks to: the chart-installed crew "lab-ops" in team-a
 * with the Models, RAG sources, gateway, policies, and sinks it uses, its fitness suite
 * finished, a judged baseline suite whose results are in its status (the operator
 * has removed its iterations), and the bundle crew "demo" in "somewhere", deployed from the workspace's demo
 * source with a changed description and a display name so its drift shows, one finished
 * fitness run, and the fitness scenarios it carries in a ConfigMap.
 */
export function integrationCluster(): FakeCluster {
  const cluster = seedInfrastructure(seedCrew(new FakeCluster()));
  cluster.namespaces.add('team-a').add('somewhere');
  const demo = obj('Crew', 'demo', 'somewhere', { description: 'A demo crew, changed in the cluster' }, { 'kubemoot.ai/crew': 'demo' });
  demo.status = { ready: true, phase: 'Ready', agentCount: 0 };
  demo.metadata.annotations = { 'kubemoot.ai/display-name': 'Demo Crew' };
  const scenarios = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'demo-fitness', namespace: 'somewhere', labels: { 'kubemoot.ai/crew': 'demo', 'kubemoot.ai/fitness-kind': 'scenarios' } }, data: { 'greeting.adl': 'DESCRIPTION The crew answers a greeting.' } };
  const smoke = cluster.objects.find((o) => o.metadata.name === 'lab-ops-smoke');
  if (smoke) smoke.status = { phase: 'Succeeded' };
  const run = obj('CrewFitness', 'demo-smoke', 'somewhere', { crewRef: 'demo', question: 'Are you there?' }, { 'kubemoot.ai/crew': 'demo' });
  run.status = { phase: 'Passed', passed: true, startedAt: '2026-09-30T10:00:00Z', completedAt: '2026-09-30T10:00:42Z' };
  const labScenarios = {
    ...scenarios,
    metadata: { name: 'lab-ops-fitness', namespace: 'team-a', labels: { 'kubemoot.ai/crew': 'lab-ops', 'kubemoot.ai/fitness-kind': 'scenarios' } },
    data: { 'pods.adl': 'DESCRIPTION Lists the pods.', 'events.adl': 'DESCRIPTION Reads the events.', 'gpus.adl': 'DESCRIPTION Reports the GPUs.' },
  };
  finishRunsAtOnce(cluster);
  return cluster.add(demo, run, scenarios as never, labScenarios as never, judgedBaseline());
}

/** A finished lab-ops suite as the operator leaves it: no iterations, results and judge scores in status. */
function judgedBaseline() {
  const suite = obj('CrewFitnessSuite', 'lab-ops-baseline', 'team-a', { crewRef: 'lab-ops', iterations: 2, scripts: [{ testRef: 'pods' }, { testRef: 'events' }] }, { 'kubemoot.ai/crew': 'lab-ops' });
  suite.metadata.creationTimestamp = '2026-09-29T10:00:00Z';
  suite.status = {
    phase: 'Completed',
    runId: 'b4se1ine',
    startedAt: '2026-09-29T10:00:00Z',
    completedAt: '2026-09-29T10:20:00Z',
    iterationsTotal: 4,
    iterationsCompleted: 4,
    passed: 3,
    failed: 1,
    scenarios: [
      { name: 'pods', iterations: 2, passed: 2, meanDurationMs: 61000 },
      { name: 'events', iterations: 2, passed: 1, failed: 1, meanDurationMs: 45000 },
    ],
    judge: {
      phase: 'Complete',
      judged: 2,
      total: 2,
      mean: 72,
      completedAt: '2026-09-29T10:31:00Z',
      scores: [
        { scenario: 'pods', score: 88, reason: 'Lists every pod with its phase.' },
        { scenario: 'events', score: 56, reason: 'Names the warning events but misses their reasons.' },
      ],
    },
  };
  return suite;
}

/**
 * A fitness run CrewForge starts finishes at once, as if an operator ran it, so starting
 * another never waits on a run in progress; a run created with a status keeps it.
 */
function finishRunsAtOnce(cluster: FakeCluster): void {
  const request = cluster.request.bind(cluster);
  cluster.request = async (method, path, body) => {
    const created = body as { status?: unknown } | undefined;
    if (method === 'POST' && /\/crewfitness(es|suites)$/.test(path) && created && !created.status) created.status = { phase: 'Succeeded' };
    return request(method, path, body);
  };
}
