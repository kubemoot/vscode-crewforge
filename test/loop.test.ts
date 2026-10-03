import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KubeClient } from '../src/k8s/request';
import type { CrewSummary } from '../src/k8s/crews';
import { DevLoop, nextActions, type DevLoopDeps } from '../src/loop/devLoop';
import { readiness, waitUntilReady } from '../src/loop/ready';
import { type CrewState, LoopMemory, LoopStates, readEveryState, redeployTarget, stateFrom, stateText } from '../src/loop/state';
import { CrewStatusBar } from '../src/loop/statusBar';
import { ANNOTATIONS, type Deployment } from '../src/source/deployments';
import type { ResourceDrift } from '../src/source/drift';
import type { Exec } from '../src/source/render';
import type { SourceEntry } from '../src/source/service';
import type { DeploymentNode, SourceNode } from '../src/views/sourceTree';
import { FakeCluster, obj } from './fakeCluster';
import { recorded, resetFake, Uri, workspaceState } from './vscodeFake';

const ROOT = '/w/demo';
const entry: SourceEntry = { source: { kind: 'helm', root: ROOT, label: 'demo' }, identity: { id: 'local:demo' }, crewName: 'demo' };
const crew = (over: Partial<CrewSummary> = {}): CrewSummary => ({ name: 'demo', namespace: 'crew-demo', ready: true, phase: 'Ready', ...over });
const agent = (name: string, ready: boolean, phase?: string) => ({ name, ready, phase, capabilities: [], promptRefs: [], object: obj('Agent', name, 'ns') });
const node = (namespace: string, drift: ResourceDrift[] = [], extra: Partial<Deployment> = {}): DeploymentNode => ({
  kind: 'deployment',
  entry,
  deployment: { namespace, crew: crew({ namespace }), channel: 'helm', linked: true, ...extra },
  drift,
});
const changed: ResourceDrift = { kind: 'Agent', name: 'a', state: 'changed', paths: ['spec.x'] };

describe('readiness', () => {
  it('waits for the Crew, then for the operator to see the deploy, then for every agent', () => {
    expect(readiness({ agents: [] })).toEqual({ state: 'waiting', message: 'Waiting for the Crew to appear' });
    const stamped = { annotations: { [ANNOTATIONS.deployedAt]: 'T2' }, revisions: [{ deployedAt: 'T1' }] };
    expect(readiness({ crew: crew(stamped), agents: [] }).message).toBe('Waiting for the operator to see this deploy');
    const seen = { annotations: { [ANNOTATIONS.deployedAt]: 'T2' }, revisions: [{ deployedAt: 'T2' }], agents: 2 };
    expect(readiness({ crew: crew(seen), agents: [agent('a', true), agent('b', false, 'Pending')] })).toEqual({ state: 'waiting', message: 'Crew ready; 1 of 2 agents ready (b: Pending)' });
    expect(readiness({ crew: crew({ ...seen, agents: 3 }), agents: [agent('a', true), agent('b', true)] }).message).toBe('Crew ready; 2 of 3 agents ready');
    expect(readiness({ crew: crew({ ready: false, phase: 'Pending' }), agents: [agent('a', false)] }).message).toBe('Crew Pending; 0 of 1 agents ready (a: starting)');
    expect(readiness({ crew: crew({ ...seen, revisions: [] }), agents: [] }).state).toBe('waiting');
    expect(readiness({ crew: crew(seen), agents: [agent('a', true), agent('b', true)] }).state).toBe('ready');
    expect(readiness({ crew: crew({ annotations: { [ANNOTATIONS.deployedAt]: 'T' } }), agents: [agent('a', true)] }).state).toBe('ready');
  });

  it('ends the wait when the Crew or an agent failed', () => {
    expect(readiness({ crew: crew({ phase: 'Failed', message: 'no models' }), agents: [] })).toEqual({ state: 'failed', message: 'Crew demo is Failed: no models' });
    expect(readiness({ crew: crew({ phase: 'Error' }), agents: [] }).message).toBe('Crew demo is Error');
    expect(readiness({ crew: crew(), agents: [agent('a', false, 'Error')] }).message).toBe('Agent a is Error');
  });
});

describe('waitUntilReady', () => {
  const noSleep = async () => undefined;

  it('reads until ready, reporting each step', async () => {
    const reads = [{ agents: [] }, { crew: crew(), agents: [agent('a', true)] }];
    const reports: string[] = [];
    const out = await waitUntilReady({ read: async () => reads.shift()!, sleep: noSleep, report: (m) => reports.push(m) }, new AbortController().signal);
    expect(out).toEqual({ outcome: 'ready', message: 'Crew ready; 1 of 1 agents ready' });
    expect(reports).toEqual(['Waiting for the Crew to appear', 'Crew ready; 1 of 1 agents ready']);
  });

  it('stops when asked, and gives up at the safety limit', async () => {
    const stop = new AbortController();
    const stopped = await waitUntilReady({ read: async () => ({ agents: [] }), sleep: async () => stop.abort(), report: () => undefined }, stop.signal);
    expect(stopped).toEqual({ outcome: 'stopped', message: 'Waiting for the Crew to appear' });
    let t = 0;
    const out = await waitUntilReady({ read: async () => ({ agents: [] }), sleep: noSleep, report: () => undefined, now: () => (t += 1000) }, new AbortController().signal, 1, 2500);
    expect(out.outcome).toBe('gave-up');
    const failed = await waitUntilReady({ read: async () => ({ crew: crew({ phase: 'Failed' }), agents: [] }), sleep: noSleep, report: () => undefined }, new AbortController().signal);
    expect(failed.outcome).toBe('failed');
  });
});

describe('loop state', () => {
  it('picks the deployment Redeploy goes to: its namespace, else a linked one, else the first', () => {
    const a = node('a', [], { linked: false });
    const b = node('b');
    expect(redeployTarget([a, b], 'a')).toBe(a);
    expect(redeployTarget([a, b], 'zz')).toBe(b);
    expect(redeployTarget([a], undefined)).toBe(a);
    expect(redeployTarget([], 'a')).toBeUndefined();
  });

  it('tells in sync, changed, not deployed, and unknown apart', () => {
    expect(stateFrom([node('ns')]).kind).toBe('in-sync');
    expect(stateFrom([node('ns', [changed])]).kind).toBe('changed');
    expect(stateFrom([{ ...node('ns'), error: 'no discovery' }])).toEqual({ kind: 'unknown', reason: 'no discovery' });
    expect(stateFrom([{ kind: 'message', text: 'Not deployed in lab', icon: 'circle-slash' }])).toEqual({ kind: 'not-deployed' });
    expect(stateFrom([{ kind: 'message', text: 'Forbidden', detail: 'Forbidden: crews' }])).toEqual({ kind: 'unknown', reason: 'Forbidden: crews' });
    expect(stateFrom([{ kind: 'message', text: 'Forbidden' }])).toEqual({ kind: 'unknown', reason: 'Forbidden' });
    expect(stateFrom([])).toEqual({ kind: 'not-deployed' });
    expect(stateText(stateFrom([node('crew-demo', [changed])]))).toBe('deployed in crew-demo, changed');
    expect(stateText({ kind: 'not-deployed' })).toBe('not deployed');
  });

  it('fires only when the state reads differently, and marks a deployed source changed on save', () => {
    const states = new LoopStates();
    const fired: string[] = [];
    states.onDidChange((root) => fired.push(root));
    states.set(ROOT, { kind: 'not-deployed' });
    states.set(ROOT, { kind: 'not-deployed' });
    states.markChanged(ROOT);
    expect(states.get(ROOT)?.kind).toBe('not-deployed');
    states.set(ROOT, { kind: 'in-sync', deployment: node('ns') });
    states.markChanged(ROOT);
    expect(states.get(ROOT)?.kind).toBe('changed');
    states.markChanged('/other');
    expect(fired).toEqual([ROOT, ROOT, ROOT]);
  });

  it('remembers the namespace Redeploy goes to and the last fitness per source', async () => {
    resetFake();
    const memory = new LoopMemory(workspaceState as never);
    expect(memory.redeployNamespace(ROOT)).toBeUndefined();
    await memory.setRedeployNamespace(ROOT, 'crew-demo');
    await memory.setLastFitness(ROOT, 'demo-starter');
    expect([memory.redeployNamespace(ROOT), memory.lastFitness(ROOT)]).toEqual(['crew-demo', 'demo-starter']);
    expect(nextActions({ kind: 'changed', deployment: node('ns') })[0]).toBe('redeploy');
  });
});

describe('reading every source\'s state', () => {
  it('reads each source that renders a crew and has no state yet, and survives a read that fails', async () => {
    const states = new LoopStates();
    const a = { ...entry, source: { ...entry.source, root: '/w/a' } };
    const b = { ...entry, source: { ...entry.source, root: '/w/b' } };
    const known = { ...entry, source: { ...entry.source, root: '/w/known' } };
    const none = { ...entry, crewName: undefined, source: { ...entry.source, root: '/w/none' } };
    states.set('/w/known', { kind: 'not-deployed' });
    const read: string[] = [];
    await readEveryState([a, b, known, none], states, async (e) => {
      read.push(e.source.root);
      if (e === b) throw new Error('cluster down');
    });
    expect(read).toEqual(['/w/a', '/w/b']);
  });
});

describe('DevLoop', () => {
  let cluster: FakeCluster;
  let states: LoopStates;
  let memory: LoopMemory;
  let calls: string[];
  let lastPreferred: string | undefined;
  let drift: ResourceDrift[];
  let onApply: () => void;
  let onSleep: () => void;
  let refreshed: number;
  let saved: (() => void) | undefined;
  let sleeps: number;

  const exec: Exec = async () => ({ code: 128, stdout: '', stderr: '' });

  /** The deployments Crew Sources would load: the Crew in the cluster, or none. */
  const loadDeployments = async (): Promise<SourceNode[]> => {
    const found = cluster.objects.filter((o) => o.kind === 'Crew' && o.metadata.name === 'demo');
    if (found.length === 0) return [{ kind: 'message', text: 'Not deployed in lab', icon: 'circle-slash' }];
    return found.map((o) => node(o.metadata.namespace!, drift));
  };

  function liveCrew(namespace = 'crew-demo', status: Record<string, unknown> = { ready: true, phase: 'Ready', agentCount: 1 }, annotations: Record<string, string> = {}) {
    const c = obj('Crew', 'demo', namespace, {}, { 'app.kubernetes.io/managed-by': 'Helm' });
    c.metadata.annotations = annotations;
    c.status = status;
    const a = obj('Agent', 'demo-coordinator', namespace, {}, { 'kubemoot.ai/crew': 'demo' });
    a.status = { ready: true, phase: 'Running' };
    cluster.add(c, a);
    return c;
  }

  function loop(over: Partial<DevLoopDeps> = {}): DevLoop {
    return new DevLoop({
      sources: { entries: async () => [entry], known: [entry], loadDeployments, refresh: () => void refreshed++ },
      service: { kinds: async () => new Map([['Agent', { kind: 'Agent', plural: 'agents', namespaced: true }]]) },
      deploy: {
        apply: async (_c, request) => {
          calls.push(`apply ${request.namespace} ${request.channel} ${request.release ?? ''}`);
          onApply();
        },
      },
      fitness: {
        runFitness: async (n, preferred) => {
          calls.push(`fitness ${(n as DeploymentNode).deployment.namespace}`);
          lastPreferred = preferred;
          return 'demo-starter';
        },
      },
      linter: {
        lintCommand: async (e) => void calls.push(`lint ${e.source.label}`),
        lintOnSave: (e, after) => {
          calls.push(`lintOnSave ${e.source.label}`);
          saved = () => after?.();
        },
      },
      memory,
      states,
      chat: { ask: async (c) => void calls.push(`ask ${c.namespace}`), reaskLast: async (c) => void calls.push(`reask ${c.namespace}`) },
      revealLive: async (c) => void calls.push(`reveal ${c.namespace}`),
      exec,
      connectTo: () => ({ source: '/k', context: 'lab', client: cluster as unknown as KubeClient }),
      sleep: async () => {
        if (++sleeps > 50) throw new Error('the wait did not settle');
        onSleep();
      },
      ...over,
    });
  }

  const source: SourceNode = { kind: 'source', entry };

  beforeEach(() => {
    resetFake();
    cluster = new FakeCluster();
    states = new LoopStates();
    memory = new LoopMemory(workspaceState as never);
    calls = [];
    drift = [];
    refreshed = 0;
    saved = undefined;
    lastPreferred = undefined;
    onApply = () => liveCrew();
    onSleep = () => undefined;
    sleeps = 0;
  });

  it('deploys to crew-<name> after asking once, waits for ready, reveals the crew, and offers Ask', async () => {
    recorded.inputs.push('crew-demo');
    recorded.infoAnswers.push('Ask');
    await loop().redeploy(source);
    expect(calls.slice(0, 2)).toEqual(['apply crew-demo helm ', 'reveal crew-demo']);
    expect(memory.redeployNamespace(ROOT)).toBe('crew-demo');
    expect(recorded.info).toEqual(['demo in crew-demo is ready.']);
    expect(recorded.progress.at(-1)).toBe('Crew ready; 1 of 1 agents ready');
    expect(states.get(ROOT)?.kind).toBe('in-sync');
    await vi.waitFor(() => expect(calls.at(-1)).toBe('ask crew-demo'));
  });

  it('deploys to a namespace it asks for every time, offering the last one, and remembers it for Redeploy', async () => {
    await memory.setRedeployNamespace(ROOT, 'crew-demo');
    recorded.inputs.push('team-two');
    onApply = () => liveCrew('team-two');
    const l = loop();
    await l.deployToNamespace(source);
    expect(recorded.inputOffers).toEqual(['crew-demo']);
    expect(calls[0]).toBe('apply team-two helm ');
    expect(memory.redeployNamespace(ROOT)).toBe('team-two');
    recorded.inputs.push(undefined);
    await l.deployToNamespace(source);
    expect(calls.filter((c) => c.startsWith('apply'))).toHaveLength(1);
    await l.deployToNamespace({ kind: 'source', entry: { ...entry, crewName: undefined } });
    expect(calls.filter((c) => c.startsWith('apply'))).toHaveLength(1);
  });

  it('redeploys without a question, then offers to ask again and rerun the last fitness', async () => {
    await memory.setRedeployNamespace(ROOT, 'crew-demo');
    await memory.setLastFitness(ROOT, 'demo-starter');
    cluster.namespaces.add('crew-demo');
    const live = liveCrew('crew-demo', { ready: true, phase: 'Ready', agentCount: 1, revisions: [{ deployedAt: 'T1' }] }, { [ANNOTATIONS.deployedAt]: 'T1', [ANNOTATIONS.source]: 'local:demo', 'meta.helm.sh/release-name': 'demo' });
    onApply = () => {
      live.metadata.annotations = { ...live.metadata.annotations, [ANNOTATIONS.deployedAt]: 'T2' };
    };
    onSleep = () => {
      (live.status as { revisions: unknown[] }).revisions = [{ deployedAt: 'T2' }];
    };
    recorded.infoAnswers.push('Re-ask last question');
    const l = loop();
    await l.redeploy(source);
    expect(recorded.inputs).toEqual([]);
    expect(recorded.progress).toContain('Waiting for the operator to see this deploy');
    expect(recorded.info).toEqual(['demo in crew-demo is redeployed and ready.']);
    await vi.waitFor(() => expect(calls).toEqual(['apply crew-demo helm demo', 'reveal crew-demo', 'reask crew-demo']));
    recorded.infoAnswers.push('Rerun fitness');
    await l.redeploy(source);
    await vi.waitFor(() => expect(calls.at(-1)).toBe('fitness crew-demo'));
    expect(lastPreferred).toBe('demo-starter');
    recorded.infoAnswers.push(undefined);
    const offer = recorded.infoReplies.length;
    await l.redeploy(source);
    expect(recorded.info[offer]).toBe('demo in crew-demo is redeployed and ready.');
    // Dismissing the offer is acted on once its reply is handled; nothing follows it.
    await recorded.infoReplies[offer];
    expect(calls.at(-1)).toBe('reveal crew-demo');
  });

  it('says when the crew does not come up, when the wait is stopped, and when it is still not ready', async () => {
    await memory.setRedeployNamespace(ROOT, 'crew-demo');
    onApply = () => liveCrew('crew-demo', { ready: false, phase: 'Failed', message: 'no Models' });
    await loop().redeploy(source);
    expect(recorded.errors).toEqual(['demo in crew-demo did not come up: Crew demo is Failed: no Models. See its agents in the Deployed Crews view.']);
    cluster = new FakeCluster();
    onApply = () => liveCrew('crew-demo', { ready: false, phase: 'Pending' });
    onSleep = () => recorded.cancel?.();
    await loop().redeploy(source);
    expect(recorded.info.at(-1)).toBe('Stopped waiting. demo in crew-demo keeps deploying; the Deployed Crews view shows its state.');
    expect(calls.filter((c) => c.startsWith('reveal'))).toEqual([]);
  });

  it('reports a gave-up wait as a warning', async () => {
    await memory.setRedeployNamespace(ROOT, 'crew-demo');
    onApply = () => liveCrew('crew-demo', { ready: false, phase: 'Pending' });
    const clock = vi.spyOn(Date, 'now');
    let t = 0;
    clock.mockImplementation(() => (t += 10 * 60_000));
    try {
      await loop().redeploy(source);
    } finally {
      clock.mockRestore();
    }
    expect(recorded.warnings.at(-1)).toMatch(/^demo in crew-demo is not ready yet: Crew Pending/);
  });

  it('refuses a namespace another channel owns, and asks before replacing a crew from another source', async () => {
    await memory.setRedeployNamespace(ROOT, 'crew-demo');
    cluster.namespaces.add('crew-demo');
    const flux = obj('Crew', 'demo', 'crew-demo', {}, { 'helm.toolkit.fluxcd.io/name': 'demo' });
    cluster.add(flux);
    await loop().redeploy(source);
    expect(recorded.info[0]).toMatch(/^demo cannot go to crew-demo with one click: Flux manages demo in crew-demo/);
    cluster.objects = [];
    const other = obj('Crew', 'demo', 'crew-demo', {}, { 'app.kubernetes.io/managed-by': 'Helm' });
    other.metadata.annotations = { [ANNOTATIONS.source]: 'github.com/else//demo' };
    cluster.add(other);
    await loop().redeploy(source);
    expect(recorded.warnings[0]).toContain('came from github.com/else//demo');
    expect(calls).toEqual([]);
  });

  it('stops when the namespace question is cancelled, and says why a source without a Crew cannot deploy', async () => {
    recorded.inputs.push(undefined);
    await loop().redeploy(source);
    await loop().redeploy({ kind: 'source', entry: { ...entry, crewName: undefined, error: 'helm template failed' } });
    expect(recorded.errors).toEqual(['CrewForge: demo cannot be deployed: helm template failed.']);
    await loop().redeploy({ kind: 'source', entry: { ...entry, crewName: undefined } });
    expect(recorded.errors[1]).toContain('it renders no Crew');
    expect(calls).toEqual([]);
  });

  it('finds the source of a file, of the active editor, or the one picked', async () => {
    const l = loop();
    expect(await l.entryFor(Uri.file(`${ROOT}/templates/crew.yaml`) as never)).toBe(entry);
    recorded.activeEditor = { document: { uri: Uri.file(`${ROOT}/values.yaml`), languageId: 'yaml', getText: () => '' }, selection: undefined };
    expect(await l.entryFor()).toBe(entry);
    recorded.activeEditor = undefined;
    recorded.quickPicks.push((items: { entry: SourceEntry; description: string }[]) => items[0]);
    expect(await l.entryFor()).toBe(entry);
    recorded.quickPicks.push(undefined);
    expect(await l.entryFor(Uri.file('/elsewhere/x.yaml') as never)).toBeUndefined();
    const bare = loop({ sources: { entries: async () => [{ ...entry, crewName: undefined }], known: [], loadDeployments, refresh: () => undefined } });
    let offered: { description: string }[] = [];
    recorded.quickPicks.push((items: typeof offered) => ((offered = items), undefined));
    await bare.entryFor();
    expect(offered[0].description).toBe('helm');
  });

  it('asks and runs fitness against the deployment Redeploy goes to, and says when there is none', async () => {
    liveCrew('crew-demo');
    const l = loop();
    await l.ask(source);
    await l.runFitness(source);
    expect(calls).toEqual(['ask crew-demo', 'fitness crew-demo']);
    expect(lastPreferred).toBeUndefined();
    expect(memory.lastFitness(ROOT)).toBe('demo-starter');
    cluster.objects = [];
    recorded.infoAnswers.push('Deploy to Namespace...');
    recorded.inputs.push(undefined);
    const offersBefore = recorded.inputOffers.length;
    await l.ask(source);
    expect(recorded.info[0]).toBe('demo is not deployed in lab. Deploy it to a namespace first.');
    // Picking Deploy to Namespace... asks for the namespace, which is dismissed.
    await vi.waitFor(() => expect(recorded.inputOffers).toHaveLength(offersBefore + 1));
    expect(recorded.inputs).toEqual([]);
    const blind = loop({ sources: { entries: async () => [entry], known: [entry], loadDeployments: async () => [{ kind: 'message', text: 'Forbidden' }], refresh: () => undefined } });
    await blind.runFitness(source);
    expect(recorded.errors).toEqual(['CrewForge cannot tell where demo is deployed: Forbidden']);
    recorded.quickPicks.push(undefined);
    await loop({ sources: { entries: async () => [], known: [], loadDeployments, refresh: () => undefined } }).runFitness();
    expect(calls).toHaveLength(2);
  });

  it('keeps the last fitness only when one started', async () => {
    liveCrew('crew-demo');
    await loop({ fitness: { runFitness: async () => undefined } }).runFitness(source, true);
    expect(memory.lastFitness(ROOT)).toBeUndefined();
  });

  it('offers the next steps for the state, and runs the one picked', async () => {
    const l = loop();
    const pick = (label: string) => (items: { label: string }[]) => items.find((i) => i.label.includes(label));
    let offered: string[] = [];
    recorded.quickPicks.push((items: { label: string }[]) => ((offered = items.map((i) => i.label)), undefined));
    await l.actions(source);
    expect(offered.map((o) => o.replace(/^\$\([a-z-]+\) /, ''))).toEqual(['Deploy to Namespace...', 'Lint', 'Change the Namespace Redeploy Uses...']);
    recorded.quickPicks.push(pick('Lint'));
    await l.actions(source);
    recorded.quickPicks.push(pick('Change the Namespace Redeploy Uses...'));
    recorded.inputs.push('team-demo');
    await l.actions(source);
    expect(memory.redeployNamespace(ROOT)).toBe('team-demo');
    recorded.quickPicks.push(pick('Change the Namespace Redeploy Uses...'));
    recorded.inputs.push(undefined);
    await l.actions(source);
    liveCrew('team-demo');
    await l.refreshState(entry);
    recorded.quickPicks.push(pick('Show in the Deployed Crews view'), pick('Ask'), pick('Run Fitness'));
    await l.actions(source);
    await l.actions(source);
    await l.actions(source);
    drift = [changed];
    await l.refreshState(entry);
    recorded.quickPicks.push(pick('Redeploy'));
    await l.actions(source);
    expect(calls).toEqual(['lint demo', 'reveal team-demo', 'ask team-demo', 'fitness team-demo', 'apply team-demo helm ', 'reveal team-demo']);
    states.set(ROOT, { kind: 'unknown', reason: 'x' });
    recorded.quickPicks.push(pick('Check the state again'));
    await l.actions(source);
    expect(states.get(ROOT)?.kind).toBe('changed');
    recorded.quickPicks.push(pick('Deploy to Namespace...'));
    states.set(ROOT, { kind: 'not-deployed' });
    await l.actions(source);
    await l.actions({ kind: 'source', entry: { ...entry, crewName: undefined } });
    expect(calls.at(-1)).toBe('reveal team-demo');
  });

  it('shows nothing to reveal for a crew that is not deployed', async () => {
    const l = loop();
    const run = (l as unknown as { run: (id: string, e: SourceEntry, s: CrewState) => Promise<void> }).run.bind(l);
    await run('reveal', entry, { kind: 'not-deployed' });
    await l.lint(source);
    expect(calls).toEqual(['lint demo']);
    recorded.quickPicks.push(undefined);
    await loop({ sources: { entries: async () => [], known: [], loadDeployments, refresh: () => undefined } }).lint();
    expect(calls).toHaveLength(1);
  });

  it('on save of a crew file marks it changed, lints it, then checks its drift', async () => {
    liveCrew('crew-demo');
    const l = loop();
    await l.refreshState(entry);
    expect(states.get(ROOT)?.kind).toBe('in-sync');
    l.onSaved(`${ROOT}/templates/agents.yaml`);
    expect(states.get(ROOT)?.kind).toBe('changed');
    expect(calls).toEqual(['lintOnSave demo']);
    saved?.();
    await vi.waitFor(() => expect(states.get(ROOT)?.kind).toBe('in-sync'));
    expect(refreshed).toBe(1);
    l.onSaved('/elsewhere/x.yaml');
    expect(calls).toHaveLength(1);
  });

  it('reports a failure in a follow-up step as an error', async () => {
    recorded.inputs.push('crew-demo');
    recorded.infoAnswers.push('Ask');
    await loop({ chat: { ask: async () => Promise.reject(new Error('no gateway')), reaskLast: async () => undefined } }).redeploy(source);
    await vi.waitFor(() => expect(recorded.errors).toEqual(['CrewForge: no gateway']));
    recorded.inputs.push('crew-demo');
    recorded.infoAnswers.push('Ask');
    cluster = new FakeCluster();
    await loop({ chat: { ask: async () => Promise.reject('odd'), reaskLast: async () => undefined } }).redeploy(source);
    await vi.waitFor(() => expect(recorded.errors[1]).toBe('CrewForge: odd'));
  });

  it('reads agents only when the cluster serves them', async () => {
    recorded.inputs.push('crew-demo');
    onApply = () => liveCrew('crew-demo', { ready: true, phase: 'Ready' });
    await loop({ service: { kinds: async () => new Map() } }).redeploy(source);
    expect(recorded.info).toEqual(['demo in crew-demo is ready.']);
    expect(recorded.progress.at(-1)).toBe('Crew ready');
    expect(readiness({ crew: crew({ ready: false, phase: 'Pending' }) }).message).toBe('Crew Pending');
  });
});

describe('CrewStatusBar', () => {
  beforeEach(resetFake);

  it('names the crew of the active file and its state, and hides for other files', async () => {
    const states = new LoopStates();
    const refreshed: string[] = [];
    const bar = new CrewStatusBar(() => [entry], states, async (e) => void refreshed.push(e.source.root));
    const item = recorded.statusBarItems[0];
    bar.update(`${ROOT}/templates/crew.yaml`);
    expect(item).toMatchObject({ visible: true, text: '$(organization) demo: checking...' });
    expect(item.command).toMatchObject({ command: 'crewforge.crewActions', arguments: [{ kind: 'source', entry }] });
    expect(refreshed).toEqual([ROOT]);
    states.set(ROOT, { kind: 'changed', deployment: node('crew-demo') });
    bar.stateChanged(ROOT);
    expect(item.text).toBe('$(diff) demo: deployed in crew-demo, changed');
    expect(item.tooltip).toContain('Click for the next steps.');
    bar.stateChanged('/other');
    bar.update(`${ROOT}/values.yaml`);
    expect(refreshed).toHaveLength(1);
    bar.update('/elsewhere/x.yaml');
    expect(item.visible).toBe(false);
    bar.stateChanged(ROOT);
    expect(item.visible).toBe(false);
    bar.update(undefined);
    const failingRefresh = vi.fn(async () => Promise.reject(new Error('x')));
    const failing = new CrewStatusBar(() => [entry], new LoopStates(), failingRefresh);
    failing.update(`${ROOT}/Chart.yaml`);
    // The bar handles the failed refresh it started; awaiting the same promise resumes after that.
    await expect(failingRefresh.mock.results[0].value).rejects.toThrow('x');
    bar.dispose();
    expect(item.visible).toBe(false);
    new CrewStatusBar(() => [{ ...entry, crewName: undefined }], states, async () => undefined).update(`${ROOT}/Chart.yaml`);
    expect(recorded.statusBarItems[2].visible).toBe(false);
  });
});
