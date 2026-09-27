import { beforeEach, describe, expect, it } from 'vitest';
import { followRolloutCommand } from '../src/gitops/commands';
import { fluxSummary, helmReleaseRef, readHelmRelease, rolloutState, toFluxState, type FluxState } from '../src/gitops/flux';
import { followRollout, sleep } from '../src/gitops/follow';
import type { CrewSummary } from '../src/k8s/crews';
import type { KubeClient, KubeTransport } from '../src/k8s/request';
import type { Deployment } from '../src/source/deployments';
import { render } from '../src/source/render';
import { SourceService } from '../src/source/service';
import { SourceTreeProvider } from '../src/views/sourceTree';
import { recorded, resetFake } from './vscodeFake';

const ref = { name: 'demo-crew', namespace: 'flux-system' };
const fluxLabels = { 'helm.toolkit.fluxcd.io/name': 'demo-crew', 'helm.toolkit.fluxcd.io/namespace': 'flux-system' };

function hr(revision: string, ready = 'True', extra: { generation?: number; observed?: number; suspend?: boolean; message?: string } = {}) {
  return {
    metadata: { generation: extra.generation ?? 2 },
    spec: { suspend: extra.suspend, values: { global: { imageRegistry: 'reg.example/k' } } },
    status: { observedGeneration: extra.observed ?? 2, lastAttemptedRevision: revision, conditions: [{ type: 'Ready', status: ready, message: extra.message ?? 'Helm upgrade succeeded' }] },
  };
}

const state = (revision: string, ready = 'True', extra = {}): FluxState => toFluxState(ref, hr(revision, ready, extra));

describe('flux state', () => {
  it('finds the HelmRelease from the labels Flux leaves on the Crew', () => {
    const crew = (labels: Record<string, string>): CrewSummary => ({ name: 'demo', namespace: 'ns', ready: true, phase: 'Ready', labels });
    expect(helmReleaseRef(crew(fluxLabels))).toEqual(ref);
    expect(helmReleaseRef(crew({ 'helm.toolkit.fluxcd.io/name': 'x' }))).toBeUndefined();
    expect(helmReleaseRef({ name: 'demo', namespace: 'ns', ready: true, phase: 'Ready' })).toBeUndefined();
  });

  it('reads readiness, currency, suspension, revision, and values', () => {
    expect(state('0.2.0')).toMatchObject({ ready: 'True', current: true, suspended: false, revision: '0.2.0', hasValuesFrom: false, values: { global: { imageRegistry: 'reg.example/k' } } });
    expect(toFluxState(ref, {})).toMatchObject({ ready: 'Unknown', message: 'Flux has not reported on this release yet', current: true, values: {} });
    expect(toFluxState(ref, { spec: { valuesFrom: [{}] }, status: { conditions: [{ type: 'Ready', status: 'False' }] } })).toMatchObject({ hasValuesFrom: true, message: '' });
  });

  it('summarizes the release in one line', () => {
    expect(fluxSummary(state('0.2.0'))).toBe('Flux ready at 0.2.0');
    expect(fluxSummary({ ...state('0.2.0'), revision: undefined })).toBe('Flux ready');
    expect(fluxSummary(state('0.2.0', 'False', { message: 'install retries exhausted' }))).toBe('Flux failed: install retries exhausted');
    expect(fluxSummary(state('0.2.0', 'Unknown'))).toBe('Flux reconciling');
    expect(fluxSummary(state('0.2.0', 'True', { observed: 1 }))).toBe('Flux reconciling');
    expect(fluxSummary(state('0.2.0', 'True', { suspend: true }))).toBe('Flux suspended');
  });

  it('tells where a rollout stands', () => {
    const start = state('0.1.0');
    expect(rolloutState(start, state('0.1.0'), true)).toBe('waiting');
    expect(rolloutState(start, state('0.2.0', 'Unknown'), false)).toBe('reconciling');
    expect(rolloutState(start, state('0.2.0'), false)).toBe('reconciling');
    expect(rolloutState(start, state('0.2.0'), true)).toBe('done');
    expect(rolloutState(start, state('0.2.0', 'False'), true)).toBe('failed');
    expect(rolloutState(start, state('0.2.0', 'False', { observed: 1 }), true)).toBe('reconciling');
    expect(rolloutState(start, state('0.1.0', 'True', { suspend: true }), true)).toBe('suspended');
  });

  it('reads a HelmRelease from the API', async () => {
    const paths: string[] = [];
    const client: KubeTransport = { request: async (_m, path) => (paths.push(path), JSON.stringify(hr('0.3.0'))), stream: async () => undefined };
    expect((await readHelmRelease(client, ref)).revision).toBe('0.3.0');
    expect(paths[0]).toBe('/apis/helm.toolkit.fluxcd.io/v2/namespaces/flux-system/helmreleases/demo-crew');
  });
});

describe('followRollout', () => {
  const noWait = async () => undefined;

  it('follows a new revision through reconciling to done', async () => {
    const states = [state('0.1.0'), state('0.1.0'), state('0.2.0', 'Unknown'), state('0.2.0')];
    const reports: string[] = [];
    const outcome = await followRollout({ readFlux: async () => states.shift() as FluxState, crewReady: async () => true, sleep: noWait, report: (t) => reports.push(t) }, new AbortController().signal);
    expect(outcome).toBe('done');
    expect(reports[0]).toBe('Waiting for a new chart revision to reach Flux (now 0.1.0)');
    expect(reports[2]).toContain('Flux is rolling out 0.2.0');
    expect(reports.at(-1)).toBe('Rolled out 0.2.0; the crew is Ready');
  });

  it('ends on failure or suspension, when stopped, and at the safety limit', async () => {
    const run = (after: FluxState, signal = new AbortController().signal, now?: () => number) => {
      const states = [state('0.1.0'), after];
      return followRollout({ readFlux: async () => states.shift() ?? after, crewReady: async () => false, sleep: noWait, report: () => undefined, now }, signal, 1, 100);
    };
    expect(await run(state('0.2.0', 'False'))).toBe('failed');
    expect(await run(state('0.1.0', 'True', { suspend: true }))).toBe('suspended');
    const stopped = new AbortController();
    stopped.abort();
    expect(await run(state('0.1.0'), stopped.signal)).toBe('stopped');
    let t = 0;
    expect(await run(state('0.1.0'), new AbortController().signal, () => (t += 60))).toBe('gave-up');
    const midway = new AbortController();
    const states = [state('0.1.0')];
    const outcome = await followRollout({ readFlux: async () => states.shift() ?? state('0.1.0'), crewReady: async () => false, sleep: async () => midway.abort(), report: () => undefined }, midway.signal, 1, 1000);
    expect(outcome).toBe('stopped');
  });

  it('sleeps, and wakes early when stopped', async () => {
    const started = Date.now();
    await sleep(5, new AbortController().signal);
    const stop = new AbortController();
    const waiting = sleep(60_000, stop.signal);
    stop.abort();
    await waiting;
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('GitOps in the tree and the Follow command', () => {
  beforeEach(resetFake);

  const crew: CrewSummary = { name: 'demo', namespace: 'ns', ready: true, phase: 'Ready', labels: fluxLabels };
  const deployment: Deployment = { namespace: 'ns', crew, channel: 'flux', linked: false };
  const entry = { source: { kind: 'helm' as const, root: '/w/demo-crew', label: 'demo-crew' }, identity: { id: 'x' }, crewName: 'demo' };

  function clusterWith(releases: unknown[], crews: CrewSummary[] = [crew]): KubeTransport {
    return {
      request: async (_m, path) => {
        if (path.includes('helmreleases')) {
          const next = releases.length > 1 ? releases.shift() : releases[0];
          if (next instanceof Error) throw next;
          return JSON.stringify(next);
        }
        if (path === '/apis/kubemoot.ai/v1alpha1') return JSON.stringify({ resources: [{ name: 'crews', kind: 'Crew', namespaced: true }] });
        if (path.endsWith('/crews')) return JSON.stringify({ items: crews.map((c) => ({ metadata: { name: c.name, namespace: c.namespace, labels: c.labels }, status: { ready: c.ready, phase: c.phase } })) });
        return JSON.stringify({ items: [] });
      },
      stream: async () => undefined,
    };
  }

  it('renders a Flux deployment with its HelmRelease values and shows the release state', async () => {
    const calls: string[][] = [];
    const exec = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return cmd === 'git' ? { code: 128, stdout: '', stderr: '' } : { code: 0, stdout: 'apiVersion: kubemoot.ai/v1alpha1\nkind: Crew\nmetadata:\n  name: demo\nspec: {}\n', stderr: '' };
    };
    const service = new SourceService({ exec, readText: async () => '', readYamlFiles: async () => [], listFiles: async () => ({ charts: [], yamls: [] }) });
    const client = clusterWith([{ ...hr('0.2.0'), spec: { ...hr('0.2.0').spec, valuesFrom: [{ kind: 'ConfigMap' }] } }]);
    const tree = new SourceTreeProvider(service, () => ({ source: '/k', context: 'lab', client: client as unknown as KubeClient }));
    const [node] = await (tree as unknown as { loadDeployments(e: unknown): Promise<unknown[]> }).loadDeployments(entry) as never[];
    const item = tree.getTreeItem(node);
    expect(item.description).toContain('Flux ready at 0.2.0');
    expect(item.tooltip).toContain('HelmRelease flux-system/demo-crew: Flux ready at 0.2.0');
    expect(item.tooltip).toContain('valuesFrom are not read');
    expect(calls.find((c) => c[0] === 'helm' && c.includes('--namespace') && c.includes('ns'))).toContain('global={"imageRegistry":"reg.example/k"}');
  });

  it('shows why the HelmRelease could not be read', async () => {
    const service = new SourceService({ exec: async (cmd) => ({ code: cmd === 'git' ? 128 : 0, stdout: cmd === 'git' ? '' : 'apiVersion: kubemoot.ai/v1alpha1\nkind: Crew\nmetadata:\n  name: demo\n', stderr: '' }), readText: async () => '', readYamlFiles: async () => [], listFiles: async () => ({ charts: [], yamls: [] }) });
    const client = clusterWith([new Error('forbidden')]);
    const tree = new SourceTreeProvider(service, () => ({ source: '/k', context: 'lab', client: client as unknown as KubeClient }));
    const [node] = await (tree as unknown as { loadDeployments(e: unknown): Promise<unknown[]> }).loadDeployments(entry) as never[];
    expect(tree.getTreeItem(node).tooltip).toContain('Flux: cannot read the HelmRelease (forbidden)');
  });

  it('follows a rollout to Ready and reports progress', async () => {
    let refreshed = 0;
    const client = clusterWith([hr('0.1.0'), hr('0.2.0')]);
    await followRolloutCommand({ kind: 'deployment', entry, deployment }, () => refreshed++, () => ({ source: '/k', context: 'lab', client: client as unknown as KubeClient }), 1);
    expect(recorded.progress[0]).toContain('Waiting for a new chart revision');
    expect(recorded.info[0]).toBe('demo in ns: rolled out; the crew is Ready.');
    expect(refreshed).toBe(1);
  });

  it('reports a failed rollout as an error, and declines crews Flux does not manage', async () => {
    const client = clusterWith([hr('0.1.0'), hr('0.2.0', 'False', { message: 'upgrade failed' })]);
    const connect = () => ({ source: '/k', context: 'lab', client: client as unknown as KubeClient });
    await followRolloutCommand({ kind: 'deployment', entry, deployment }, () => undefined, connect, 1);
    expect(recorded.errors[0]).toContain('Flux reported a failure');
    await followRolloutCommand({ kind: 'deployment', entry, deployment: { ...deployment, channel: 'helm' } }, () => undefined, connect, 1);
    expect(recorded.info[0]).toContain('is not managed by a Flux HelmRelease');
    await followRolloutCommand({ kind: 'message', text: 'x' }, () => undefined, connect, 1);
  });

  it('stops following when cancelled', async () => {
    const client = clusterWith([hr('0.1.0')]);
    const connect = () => ({ source: '/k', context: 'lab', client: client as unknown as KubeClient });
    const following = followRolloutCommand({ kind: 'deployment', entry, deployment }, () => undefined, connect, 5);
    await new Promise((r) => setTimeout(r, 20));
    recorded.cancel?.();
    await following;
    expect(recorded.info[0]).toBe('demo in ns: stopped following.');
  });

  it('passes values to helm as set-json, one per top-level key', async () => {
    const calls: string[][] = [];
    const exec = async (_cmd: string, args: string[]) => (calls.push(args), { code: 0, stdout: '', stderr: '' });
    await render(entry.source, { namespace: 'ns', values: { a: 1, b: { c: 'd' } } }, { exec, readYamlFiles: async () => [] });
    expect(calls[0].slice(-4)).toEqual(['--set-json', 'a=1', '--set-json', 'b={"c":"d"}']);
  });
});
