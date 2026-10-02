import { beforeEach, describe, expect, it } from 'vitest';
import { KubeError, type KubeTransport } from '../src/k8s/request';
import { DashboardApi, dashboardPath, findDashboard, parseService, threadStats } from '../src/kubemoot/dashboardApi';
import { recorded, resetFake } from './vscodeFake';

/** A cluster that answers the Service list and the dashboard's proxied API from a table of paths. */
class ProxyCluster implements KubeTransport {
  calls: string[] = [];
  answers = new Map<string, unknown>();

  async request(_method: string, p: string): Promise<string> {
    this.calls.push(p);
    const answer = [...this.answers.entries()].find(([prefix]) => p.startsWith(prefix))?.[1];
    if (answer === undefined) throw new Error(`no route ${p}`);
    if (answer instanceof Error) throw answer;
    return typeof answer === 'string' ? answer : JSON.stringify(answer);
  }

  stream(): Promise<void> {
    return Promise.reject(new Error('no stream'));
  }
}

const SERVICES = '/api/v1/services?labelSelector=app.kubernetes.io%2Fpart-of%3Dkubemoot%2Capp.kubernetes.io%2Fname%20in%20(dashboard%2Ckubemoot-dashboard)';
const PROXY = '/api/v1/namespaces/kubemoot/services/kubemoot-dashboard:8080/proxy';
const msg = (threadId: string, messageType: string, agentName?: string, content?: string) => ({ subject: `kubemoot.discuss.ns.demo.general.${threadId}`, data: JSON.stringify({ threadId, messageType, agentName, content }) });

let cluster: ProxyCluster;
beforeEach(() => {
  resetFake();
  cluster = new ProxyCluster();
  cluster.answers.set(SERVICES, { items: [{ metadata: { name: 'kubemoot-dashboard', namespace: 'kubemoot' }, spec: { ports: [{ port: 8080 }] } }] });
});

describe('finding the dashboard', () => {
  it('finds the operator chart\'s dashboard by its labels, its http port, and its /dashboard path', async () => {
    cluster.answers.set(SERVICES, { items: [{ metadata: { name: 'kubemoot-operator-dashboard', namespace: 'kubemoot' }, spec: { ports: [{ name: 'metrics', port: 9090 }, { name: 'http', port: 80 }] } }] });
    const proxy = '/api/v1/namespaces/kubemoot/services/kubemoot-operator-dashboard:80/proxy';
    cluster.answers.set(`${proxy}/api/kubemoot`, new KubeError('not found', 404));
    cluster.answers.set(`${proxy}/dashboard/api/kubemoot/crewfitnesssuites/ns/s1/scores`, { scores: { a: 70 }, complete: true, judged: 1 });
    cluster.answers.set(`${proxy}/dashboard/api/kubemoot/crewfitnesssuites/ns/s1/iterations`, { iterations: [] });
    const api = new DashboardApi();
    expect(await api.scores(cluster, 'ns', 's1')).toEqual({ scores: { a: 70 }, complete: true, judged: 1 });
    const before = cluster.calls.length;
    expect(await api.iterations(cluster, 'ns', 's1')).toEqual({ iterations: [] });
    expect(cluster.calls.slice(before)).toEqual([`${proxy}/dashboard/api/kubemoot/crewfitnesssuites/ns/s1/iterations`]);
  });

  it('passes on an error that is not a 404 without trying another path, and says when no path answers', async () => {
    const api = new DashboardApi();
    cluster.answers.set(`${PROXY}/api/kubemoot`, new KubeError('forbidden', 403));
    expect(await api.scores(cluster, 'ns', 's1')).toEqual({ unavailable: 'The Kubemoot dashboard did not answer: forbidden' });
    const fresh = new DashboardApi();
    const other = new ProxyCluster();
    other.answers.set(SERVICES, { items: [{ metadata: { name: 'kubemoot-dashboard', namespace: 'kubemoot' }, spec: { ports: [{ port: 8080 }] } }] });
    other.answers.set(PROXY, new KubeError('not found', 404));
    expect(await fresh.scores(other, 'ns', 's1')).toEqual({ unavailable: 'The Kubemoot dashboard did not answer: not found' });
  });

  it('takes a base path in the setting', () => {
    expect(parseService('kubemoot/kubemoot-operator-dashboard:80/dashboard')).toEqual({ namespace: 'kubemoot', name: 'kubemoot-operator-dashboard', port: '80', base: '/dashboard' });
    expect(dashboardPath({ namespace: 'k', name: 'd', port: '80', base: '/dashboard' }, '/api/x')).toBe('/api/v1/namespaces/k/services/d:80/proxy/dashboard/api/x');
  });

  it('parses the setting, with port 80 by default', () => {
    expect(parseService('kubemoot/kubemoot-dashboard:8080')).toEqual({ namespace: 'kubemoot', name: 'kubemoot-dashboard', port: '8080' });
    expect(parseService(' kubemoot/dash ')).toEqual({ namespace: 'kubemoot', name: 'dash', port: '80' });
    expect(parseService('')).toBeUndefined();
    expect(parseService('no-slash')).toBeUndefined();
  });

  it('uses the setting first, else the labelled Service, else nothing', async () => {
    recorded.settings.set('crewforge.dashboardService', 'ops/dash:3000');
    expect(await findDashboard(cluster)).toEqual({ namespace: 'ops', name: 'dash', port: '3000' });
    recorded.settings.clear();
    expect(await findDashboard(cluster)).toEqual({ namespace: 'kubemoot', name: 'kubemoot-dashboard', port: '8080' });
    cluster.answers.set(SERVICES, { items: [{ metadata: { name: 'x' } }, { metadata: { name: 'd', namespace: 'n' } }] });
    expect(await findDashboard(cluster)).toEqual({ namespace: 'n', name: 'd', port: '80' });
    cluster.answers.set(SERVICES, {});
    expect(await findDashboard(cluster)).toBeUndefined();
    cluster.answers.set(SERVICES, new Error('forbidden'));
    expect(await findDashboard(cluster)).toBeUndefined();
  });

  it('builds service proxy paths and refuses names that are not Kubernetes names', () => {
    expect(dashboardPath({ namespace: 'kubemoot', name: 'dash', port: '80' }, '/api/x')).toBe('/api/v1/namespaces/kubemoot/services/dash:80/proxy/api/x');
    expect(() => dashboardPath({ namespace: 'Bad NS', name: 'dash', port: '80' }, '/x')).toThrow('not a valid Kubernetes name');
  });
});

describe('threadStats', () => {
  it('counts threads and agent failures, newest failures first, skipping what does not parse', () => {
    const stats = threadStats({
      messages: [msg('t1', 'thread_start'), msg('t1', 'failure', 'k8s', 'tool timed out\nstack'), msg('t2', 'agree'), { data: 'not json' }, { data: '42' }, {}, msg('t3', 'failure', undefined, '')],
    });
    expect(stats).toEqual({ threads: 3, failures: 2, recentFailures: ['an agent: failed', 'k8s: tool timed out'], messages: 4 });
    expect(threadStats({})).toEqual({ threads: 0, failures: 0, recentFailures: [], messages: 0 });
  });
});

describe('DashboardApi', () => {
  it("reads a crew's discussion counts through the service proxy, finding the Service once", async () => {
    cluster.answers.set(`${PROXY}/api/nats/history`, { messages: [msg('t1', 'failure', 'a', 'x')] });
    const api = new DashboardApi();
    expect(await api.threads(cluster, 'ns', 'demo')).toMatchObject({ threads: 1, failures: 1 });
    await api.threads(cluster, 'ns', 'demo');
    expect(cluster.calls.filter((c) => c === SERVICES)).toHaveLength(1);
    expect(cluster.calls[1]).toBe(`${PROXY}/api/nats/history?stream=KUBEMOOT_DISCUSS&subject=kubemoot.discuss.ns.demo.%3E&limit=2000`);
  });

  it('reads suite scores and archived iterations, and says why when it cannot', async () => {
    cluster.answers.set(`${PROXY}/api/kubemoot/crewfitnesssuites/ns/s%201/scores`, { scores: { a: 80 }, complete: true, judged: 1 });
    cluster.answers.set(`${PROXY}/api/kubemoot/crewfitnesssuites/ns/s%201/iterations`, { iterations: [] });
    const api = new DashboardApi();
    expect(await api.scores(cluster, 'ns', 's 1')).toEqual({ scores: { a: 80 }, complete: true, judged: 1 });
    expect(await api.iterations(cluster, 'ns', 's 1')).toEqual({ iterations: [] });
    expect(await api.scores(cluster, 'ns', 'other')).toEqual({ unavailable: expect.stringMatching(/^The Kubemoot dashboard did not answer: no route/) });
    cluster.answers.set(SERVICES, {});
    const later = new DashboardApi();
    expect(await later.threads(cluster, 'ns', 'demo')).toEqual({ unavailable: 'No Kubemoot dashboard found; set crewforge.dashboardService to namespace/name:port.' });
    cluster.answers.set(SERVICES, { items: [{ metadata: { name: 'kubemoot-dashboard', namespace: 'kubemoot' }, spec: { ports: [{ port: 8080 }] } }] });
    cluster.answers.set(`${PROXY}/api/nats/history`, { messages: [] });
    expect(await later.threads(cluster, 'ns', 'demo')).toMatchObject({ threads: 0 });
  });
});
