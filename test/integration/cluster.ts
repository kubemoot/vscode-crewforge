import { FakeCluster, obj, seedCrew } from '../fakeCluster';

/**
 * The cluster the integration run talks to: the chart-installed crew "lab-ops" in team-a,
 * and the bundle crew "demo" in "somewhere", deployed from the workspace's demo source
 * with a changed description so its drift shows, and one finished fitness run.
 */
export function integrationCluster(): FakeCluster {
  const cluster = seedCrew(new FakeCluster());
  cluster.namespaces.add('team-a').add('somewhere');
  const demo = obj('Crew', 'demo', 'somewhere', { description: 'A demo crew, changed in the cluster' }, { 'kubemoot.ai/crew': 'demo' });
  demo.status = { ready: true, phase: 'Ready', agentCount: 0 };
  const run = obj('CrewFitness', 'demo-smoke', 'somewhere', { crewRef: 'demo', question: 'Are you there?' }, { 'kubemoot.ai/crew': 'demo' });
  run.status = { phase: 'Passed', passed: true, startedAt: '2026-09-30T10:00:00Z', completedAt: '2026-09-30T10:00:42Z' };
  return cluster.add(demo, run);
}
