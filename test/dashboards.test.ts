import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection } from '../src/connection';
import { loadCrewDetails } from '../src/crew/details';
import { Dashboards, type DashboardParts } from '../src/dashboard/register';
import { FitnessActivity } from '../src/fitness/controls';
import type { CrewSummary } from '../src/k8s/crews';
import { OPENAPI_PATH } from '../src/schema/kubemootSchema';
import { discoverKinds } from '../src/source/live';
import type { Located } from '../src/source/locate';
import type { Manifest } from '../src/source/manifests';
import type { SourceEntry } from '../src/source/service';
import { newConversation } from '../src/store/conversation';
import { ConversationStore } from '../src/store/conversations';
import type { SourceNode } from '../src/views/sourceTree';
import { FakeCluster, obj } from './fakeCluster';
import { recorded, resetFake, type FakePanel } from './vscodeFake';

/** The fake API server plus /version, the operator Deployment, and the suite CRD's OpenAPI. */
class Cluster extends FakeCluster {
  reachable = true;
  async request(method: string, p: string, body?: unknown): Promise<string> {
    if (p === '/version') {
      if (!this.reachable) throw new Error('connect ECONNREFUSED');
      return JSON.stringify({ gitVersion: 'v1.33.2' });
    }
    if (p.startsWith('/apis/apps/v1/deployments')) return JSON.stringify({ items: [{ metadata: { namespace: 'kubemoot' }, spec: { template: { spec: { containers: [{ image: 'op:0.46.0' }] } } } }] });
    if (p === OPENAPI_PATH) return JSON.stringify({ components: { schemas: { s: { 'x-kubernetes-group-version-kind': [{ kind: 'CrewFitnessSuite' }], properties: { spec: { properties: { suspend: {}, cancel: {} } } } } } } });
    return super.request(method, p, body);
  }
}

const NS = 'crew-demo';
let cluster: Cluster;
let store: ConversationStore;
let parts: DashboardParts;
let deployed: boolean;
const entry: SourceEntry = { source: { kind: 'helm', root: '/w/demo', label: 'demo' }, identity: { id: 'local:demo' }, crewName: 'demo', chart: { version: '0.2.2' } };

function crewObject(): Manifest {
  const c = obj('Crew', 'demo', NS, { description: 'Answers lab questions' }, { 'app.kubernetes.io/managed-by': 'Helm', 'helm.sh/chart': 'demo-0.46.0' });
  c.metadata.annotations = { 'meta.helm.sh/release-name': 'demo', 'crewforge.kubemoot.ai/source': 'local:demo' };
  c.status = { ready: true, phase: 'Ready', agentCount: 1 };
  return c;
}

const liveCrew = (): CrewSummary => ({ name: 'demo', namespace: NS, ready: true, phase: 'Ready', labels: { 'app.kubernetes.io/managed-by': 'Helm', 'helm.sh/chart': 'demo-0.46.0' }, annotations: { 'meta.helm.sh/release-name': 'demo' } });

function suite(name: string, status: Record<string, unknown>, spec: Record<string, unknown> = {}): Manifest {
  return { apiVersion: 'kubemoot.ai/v1alpha1', kind: 'CrewFitnessSuite', metadata: { name, namespace: NS, creationTimestamp: '2026-09-30T10:00:00Z' }, spec: { crewRef: 'demo', scripts: [{ testRef: 'a' }], ...spec }, status };
}

beforeEach(async () => {
  resetFake();
  cluster = new Cluster();
  const agent = obj('Agent', 'demo-coordinator', NS, { discussRole: 'coordinator', capabilities: ['reasoning'] }, { 'kubemoot.ai/crew': 'demo' });
  agent.status = { ready: true, phase: 'Running' };
  cluster.add(crewObject(), agent, obj('Crew', 'other', 'elsewhere'));
  deployed = true;
  store = new ConversationStore(fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-dash-')));
  const convo = newConversation('lab', NS, 'demo');
  convo.messages.push({ role: 'user', content: 'q', timestamp: 'T1' }, { role: 'assistant', content: 'a', timestamp: 'T2', problems: ['Agent k8s failed'] });
  await store.save(convo);
  const located: Located[] = [{ manifest: obj('Crew', 'demo', 'default'), file: '/w/demo/templates/crew.yaml', line: 3 }];
  parts = {
    extensionUri: { fsPath: '/ext' } as never,
    crewforgeVersion: '0.14.0',
    connect: (): Connection => ({ source: '/k', context: 'lab', client: cluster as never, server: 'https://k' }),
    sources: {
      known: [entry],
      loadDeployments: async (e: SourceEntry): Promise<SourceNode[]> => (deployed ? [{ kind: 'deployment', entry: e, deployment: { namespace: NS, crew: { ...liveCrew(), agents: 1 }, channel: 'helm', release: 'demo', linked: true } }] : [{ kind: 'message', text: 'Not deployed in lab', icon: 'circle-slash' }]),
    },
    service: { located: async () => located, kinds: discoverKinds },
    details: async (crew) => loadCrewDetails(cluster, await discoverKinds(cluster), crew.namespace, crew.name),
    store,
    memory: { devNamespace: () => undefined },
    exec: async (cmd, args) => (cmd === 'helm' && args.includes('status') ? { code: 0, stdout: '{"version":2,"info":{"first_deployed":"F","last_deployed":"L"}}', stderr: '' } : { code: 1, stdout: '', stderr: '' }),
    activity: new FitnessActivity(),
    api: {
      threads: async () => ({ threads: 4, failures: 0, recentFailures: [], messages: 10 }),
      scores: async () => ({ scores: { a: 90 }, complete: true, judged: 1 }),
      iterations: async () => ({ iterations: [{ scenario: 'a', iter: 0, status: 'Passed', assertionsPassed: 1, assertionsTotal: 1, durationMs: 2000 }] }),
    } as never,
  };
});

afterEach(() => {
  for (const p of recorded.panels) p.dispose();
  vi.useRealTimers();
});

/** Tells the page it is ready and returns the body it was sent. */
async function body(panel: FakePanel): Promise<string> {
  await panel.webview.receive({ type: 'ready' });
  return (panel.webview.posted.at(-1) as { html: string }).html;
}

const press = (panel: FakePanel, action: string, arg?: string) => panel.webview.receive({ type: 'action', action, arg });

describe('the crew dashboard', () => {
  it('opens from a Crew Sources crew with its vitals, and its buttons run the lifecycle commands', async () => {
    const dashboards = new Dashboards(parts);
    dashboards.openCrew({ kind: 'source', entry });
    const [panel] = recorded.panels;
    const html = await body(panel);
    for (const text of ['demo', 'crew-demo in lab', 'Chart version differs: source 0.2.2, deployed 0.46.0', 'L', 'demo-coordinator', 'Agent k8s failed', 'Threads']) expect(html).toContain(text);
    expect(panel.title).toBe('demo');
    for (const action of ['redeploy', 'undeploy', 'ask', 'fitness', 'lint', 'yaml', 'refresh', 'deploy']) await press(panel, action);
    expect(recorded.executed.map((e) => e.id)).toEqual([
      'crewforge.redeployDev',
      'crewforge.removeDeployment',
      'crewforge.askCrew',
      'crewforge.runFitness',
      'crewforge.lintCrew',
      'vscode.open',
      'crewforge.deployDev',
    ]);
    expect(recorded.executed[1].args[0]).toMatchObject({ kind: 'deployment', entry });
    await press(panel, 'fitnessDashboard');
    expect(recorded.panels.map((p) => p.title)).toContain('demo fitness');
    dashboards.openCrew({ kind: 'deployment', entry, deployment: { namespace: NS, crew: liveCrew(), channel: 'helm', linked: true } });
    expect(recorded.panels.filter((p) => p.viewType === 'crewforge.page' && p.title === 'demo')).toHaveLength(1);
    dashboards.dispose();
  });

  it('opens from a live crew, finding its source, or without one', async () => {
    const dashboards = new Dashboards(parts);
    dashboards.openCrew({ kind: 'crew', crew: liveCrew() });
    await body(recorded.panels[0]);
    parts.sources.known.length = 0;
    const alone = new Dashboards({ ...parts, sources: { ...parts.sources, known: [] } });
    alone.openCrew({ kind: 'crew', crew: { ...liveCrew(), name: 'other', namespace: 'elsewhere' } });
    const panel = recorded.panels[1];
    const html = await body(panel);
    expect(html).toContain('No workspace source renders this crew');
    await press(panel, 'yaml');
    await press(panel, 'deploy');
    await press(panel, 'undeploy');
    expect(recorded.executed.map((e) => [e.id, (e.args[0] as { kind?: string })?.kind])).toEqual([
      ['crewforge.showLiveYaml', 'crew'],
      ['crewforge.removeDeployment', 'crew'],
    ]);
    expect(alone.openCrew({ kind: 'message', text: 'x' })).toBeUndefined();
    expect(alone.openCrew()).toBeUndefined();
  });

  it('shows an undeployed source, and says why when the deployments cannot be read', async () => {
    deployed = false;
    const dashboards = new Dashboards(parts);
    dashboards.openCrew({ kind: 'source', entry });
    const panel = recorded.panels[0];
    expect(await body(panel)).toContain('not deployed in lab');
    await press(panel, 'ask');
    await press(panel, 'fitnessDashboard');
    expect(recorded.executed).toEqual([]);
    panel.dispose();
    const failing = new Dashboards({ ...parts, sources: { known: [], loadDeployments: async () => [{ kind: 'message', text: 'Forbidden.', detail: 'crews is forbidden' }] } });
    failing.openCrew({ kind: 'source', entry });
    expect(await body(recorded.panels[1])).toContain('Cannot tell where it is deployed: crews is forbidden');
  });
});

describe('the Crews Overview', () => {
  it('lists every deployed crew with the connection on top, and opens a crew\'s dashboard', async () => {
    const dashboards = new Dashboards(parts);
    dashboards.openOverview();
    const [panel] = recorded.panels;
    const html = await body(panel);
    expect(html).toContain('Kubernetes v1.33.2');
    expect(html).toContain('Kubemoot 0.46.0 (operator in kubemoot)');
    expect(html).toContain('data-action="open" data-arg="crew-demo/demo"');
    expect(html).toContain('<td>1/1</td>');
    expect(html).toContain('<td>0.46.0</td>');
    expect(html).toContain('<td>open</td>');
    expect(html).toContain('badge bad">1');
    expect(html).toContain('Deployed crews (2)');
    await press(panel, 'open', 'crew-demo/demo');
    await press(panel, 'open', 'nowhere/none');
    expect(recorded.panels.map((p) => p.title)).toEqual(['Crews Overview', 'demo']);
    recorded.quickPicks.push(undefined);
    await press(panel, 'connection');
    await press(panel, 'refresh');
    expect(dashboards.status.latest?.kubernetes).toBe('v1.33.2');
  });

  it('says plainly when the cluster cannot be reached or the crews cannot be listed', async () => {
    cluster.reachable = false;
    new Dashboards(parts).openOverview();
    expect(await body(recorded.panels[0])).toContain('Cannot reach the cluster, so no crews are listed: connect ECONNREFUSED');
    recorded.panels[0].dispose();
    cluster.reachable = true;
    cluster.failures.set('/apis/kubemoot.ai/v1alpha1/crews', new Error('crews is forbidden'));
    new Dashboards(parts).openOverview();
    expect(await body(recorded.panels[1])).toContain('Cannot list the crews: crews is forbidden');
  });
});

describe('the fitness dashboard', () => {
  it('shows the runs and the selected one, and its controls act on the run', async () => {
    cluster.add(suite('s-new', { phase: 'Running', iterationsTotal: 2, iterationsCompleted: 1 }), { ...suite('s-old', { phase: 'Completed', artifactRef: { bucket: 'b', objectKey: 'k' } }), metadata: { name: 's-old', namespace: NS, creationTimestamp: '2026-09-29T10:00:00Z' } });
    recorded.settings.set('crewforge.dashboardUrl', 'http://dash/');
    const dashboards = new Dashboards(parts);
    const deployment = { namespace: NS, crew: liveCrew(), channel: 'helm' as const, linked: true };
    dashboards.openFitness({ kind: 'fitness', entry, deployment });
    const [panel] = recorded.panels;
    let html = await body(panel);
    expect(html).toContain('Run s-new');
    expect(html).toContain('1 of 2 iterations');
    expect(parts.activity.isBusy(NS, 'demo')).toBe(true);
    await press(panel, 'pause', 's-new');
    recorded.warningAnswers.push('Stop');
    await press(panel, 'stop', 's-new');
    await press(panel, 'resume', 's-new');
    await press(panel, 'pause', 'missing');
    expect(cluster.calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ spec: { suspend: true } }, { spec: { cancel: true } }, { spec: { suspend: false } }]);
    await press(panel, 'select', 's-old');
    html = (panel.webview.posted.at(-1) as { html: string }).html;
    expect(html).toContain('Run s-old');
    expect(html).toContain('Judge: done, 1 scenarios scored');
    expect(html).toContain('<td>90</td>');
    await press(panel, 'xlsx', 's-old');
    expect(recorded.opened).toEqual(['http://dash/api/kubemoot/crewfitnesssuites/crew-demo/s-old/artifact']);
    await press(panel, 'run');
    expect(recorded.executed.at(-1)).toMatchObject({ id: 'crewforge.runFitness', args: [{ kind: 'deployment', entry }] });
    dashboards.openFitness({ kind: 'run', entry, deployment, run: { kind: 'CrewFitnessSuite', name: 's-new', namespace: NS, crew: 'demo', phase: 'Running', createdAt: '', assertions: [] } });
    expect(recorded.panels).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 20));
    expect((panel.webview.posted.at(-1) as { html: string }).html).toContain('Run s-new');
  });

  it('opens for a live crew without a source, and says why it cannot run or read', async () => {
    cluster.add(suite('s-cancel', { phase: 'Cancelled' }));
    const dashboards = new Dashboards({ ...parts, sources: { ...parts.sources, known: [] } });
    dashboards.openFitness({ kind: 'crew', crew: liveCrew() });
    const [panel] = recorded.panels;
    const html = await body(panel);
    expect(html).toContain('No workspace source renders this crew');
    expect(html).toContain('Judge: skipped, since the suite was cancelled');
    await press(panel, 'xlsx');
    await press(panel, 'run');
    expect(recorded.executed.at(-1)).toMatchObject({ id: 'crewforge.runFitness', args: [{ kind: 'crew' }] });
    expect(dashboards.openFitness({ kind: 'message', text: 'x' })).toBeUndefined();
    cluster.failures.set('/apis/kubemoot.ai/v1alpha1', new Error('discovery down'));
    const broken = new Dashboards({ ...parts, service: { ...parts.service, kinds: async () => Promise.reject(new Error('discovery down')) } });
    broken.openFitness({ kind: 'crew', crew: { ...liveCrew(), name: 'x' } });
    expect(await body(recorded.panels[1])).toContain('Cannot read the fitness runs: discovery down');
  });

  it('shows a Connection Info quick pick', async () => {
    recorded.quickPicks.push((items: { label: string }[]) => items[0]);
    await new Dashboards(parts).showConnection();
    expect(recorded.quickPicks).toEqual([]);
  });
});
