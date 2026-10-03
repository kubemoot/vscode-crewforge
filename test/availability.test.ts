import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection } from '../src/connection';
import { availabilityOf, readAvailability, type CrewAvailability } from '../src/discussion/availability';
import type { KubeClient } from '../src/k8s/request';
import { KubeError } from '../src/k8s/request';
import { AVAILABILITY_MS, ChatPanel } from '../src/panels/chatPanel';
import { discoverKinds } from '../src/source/live';
import { ConversationStore } from '../src/store/conversations';
import type { StateMessage } from '../src/webview/protocol';
import { FakeCluster, obj } from './fakeCluster';
import { FakeTransport, fixture } from './fakes';
import { recorded, resetFake, Uri } from './vscodeFake';

const crew = (over: Record<string, unknown> = {}) => ({ name: 'demo', namespace: 'crew-demo', ready: true, phase: 'Ready', ...over });
const agent = (name: string, ready: boolean, phase = ready ? 'Running' : 'Pending') => ({ name, ready, phase, capabilities: [], promptRefs: [], object: obj('Agent', name, 'crew-demo') });

describe('availabilityOf', () => {
  it('is ready when the Crew and an agent are ready and the gateway is up or unknown', () => {
    expect(availabilityOf({ crew: crew(), agents: [agent('a', true)], gateway: true })).toEqual({ state: 'ready' });
    expect(availabilityOf({ crew: crew() })).toEqual({ state: 'ready' });
    expect(availabilityOf({ crew: crew(), agents: [agent('a', true), agent('b', false)] })).toEqual({ state: 'ready' });
  });

  it('names what blocks a question: gone, failed, not ready, no agent ready, or no gateway', () => {
    expect(availabilityOf({})).toEqual({ state: 'not-ready', reason: 'The crew is not deployed here any more' });
    expect(availabilityOf({ crew: crew({ phase: 'Failed', message: 'no models' }) })).toEqual({ state: 'error', reason: 'The crew is in an error state: Crew demo is Failed: no models' });
    expect(availabilityOf({ crew: crew({ phase: 'Error' }) })).toEqual({ state: 'error', reason: 'The crew is in an error state: Crew demo is Error' });
    expect(availabilityOf({ crew: crew(), agents: [agent('a', false, 'Failed')] })).toEqual({ state: 'error', reason: 'The crew is in an error state: Agent a is Failed' });
    expect(availabilityOf({ crew: crew(), agents: [] })).toEqual({ state: 'not-ready', reason: 'The crew is not ready: it has no agents yet' });
    expect(availabilityOf({ crew: crew({ ready: false, phase: 'Pending' }) })).toEqual({ state: 'not-ready', reason: 'The crew is not ready: phase Pending' });
    expect(availabilityOf({ crew: crew({ ready: false, phase: 'Pending', message: 'waiting for models' }) })).toEqual({ state: 'not-ready', reason: 'The crew is not ready: waiting for models' });
    expect(availabilityOf({ crew: crew(), agents: [agent('a', false), agent('b', false, undefined as never)] })).toEqual({ state: 'not-ready', reason: 'The crew is not ready: no agent is ready yet' });
    expect(availabilityOf({ crew: crew(), gateway: false })).toEqual({ state: 'unreachable', reason: "Can't reach the crew's discussion gateway" });
  });
});

/** A cluster that also answers the gateway's Endpoints. */
class ClusterWithEndpoints extends FakeCluster {
  endpoints?: unknown;
  async request(method: string, p: string, body?: unknown): Promise<string> {
    if (p === '/api/v1/namespaces/crew-demo/endpoints/demo-discussion') {
      if (this.endpoints === undefined) throw new KubeError('endpoints "demo-discussion" not found', 404);
      if (this.endpoints instanceof Error) throw this.endpoints;
      return JSON.stringify(this.endpoints);
    }
    return super.request(method, p, body);
  }
}

describe('readAvailability', () => {
  let cluster: ClusterWithEndpoints;
  beforeEach(() => {
    const c = obj('Crew', 'demo', 'crew-demo');
    c.status = { ready: true, phase: 'Ready' };
    const a = obj('Agent', 'demo-coordinator', 'crew-demo', {}, { 'kubemoot.ai/crew': 'demo' });
    a.status = { ready: true, phase: 'Running' };
    cluster = new ClusterWithEndpoints();
    cluster.add(c, a, obj('Agent', 'other', 'crew-demo', {}, { 'kubemoot.ai/crew': 'other' }));
  });

  it('reads the Crew, its agents, and the gateway endpoints', async () => {
    const kinds = await discoverKinds(cluster);
    cluster.endpoints = { subsets: [{ addresses: [{ ip: '10.0.0.1' }] }] };
    expect(await readAvailability(cluster, kinds, 'crew-demo', 'demo')).toEqual({ state: 'ready' });
    cluster.endpoints = { subsets: [{ notReadyAddresses: [{}] }, {}] };
    expect(await readAvailability(cluster, kinds, 'crew-demo', 'demo')).toMatchObject({ state: 'unreachable' });
    cluster.endpoints = {};
    expect(await readAvailability(cluster, kinds, 'crew-demo', 'demo')).toMatchObject({ state: 'unreachable' });
    cluster.endpoints = undefined;
    expect(await readAvailability(cluster, kinds, 'crew-demo', 'demo')).toMatchObject({ state: 'unreachable' });
    cluster.endpoints = new KubeError('forbidden', 403);
    expect(await readAvailability(cluster, kinds, 'crew-demo', 'demo')).toEqual({ state: 'ready' });
  });

  it('judges on the Crew alone when Agents cannot be read, and says when the cluster cannot be reached', async () => {
    cluster.endpoints = new KubeError('forbidden', 403);
    const kinds = await discoverKinds(cluster);
    expect(await readAvailability(cluster, new Map(), 'crew-demo', 'demo')).toEqual({ state: 'ready' });
    cluster.failures.set('/apis/kubemoot.ai/v1alpha1/namespaces/crew-demo/agents', new Error('forbidden'));
    expect(await readAvailability(cluster, kinds, 'crew-demo', 'demo')).toEqual({ state: 'ready' });
    cluster.failures.set('/apis/kubemoot.ai/v1alpha1/namespaces/crew-demo/crews', new Error('connect ECONNREFUSED'));
    expect(await readAvailability(cluster, kinds, 'crew-demo', 'demo')).toEqual({ state: 'unreachable', reason: 'Cannot reach the cluster: connect ECONNREFUSED' });
  });
});

describe('ChatPanel availability', () => {
  let transport: FakeTransport;
  let connection: Connection;
  let store: ConversationStore;
  let answers: (CrewAvailability | Error)[];
  const states = () => recorded.panels[0].webview.posted as StateMessage[];
  /** Waits until the panel has posted the availability its first read found. */
  const firstReadPosted = () => vi.waitFor(() => expect(states().at(-1)?.availability).toEqual({ state: 'ready' }));

  beforeEach(() => {
    resetFake();
    transport = new FakeTransport();
    connection = { source: 't', context: 'ctx', client: transport as unknown as KubeClient };
    store = new ConversationStore(fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-avail-')));
    answers = [];
  });
  afterEach(() => {
    for (const p of recorded.panels) p.dispose();
    vi.useRealTimers();
  });

  const links = {
    agentSources: async () => new Map(),
    availability: vi.fn(async () => {
      const next = answers.shift() ?? { state: 'ready' as const };
      if (next instanceof Error) throw next;
      return next;
    }),
  };

  it('posts the availability it reads on open, and a failed read as unreachable', async () => {
    answers.push({ state: 'not-ready', reason: 'The crew is not ready: phase Pending' });
    ChatPanel.show(Uri.file('/ext') as never, connection, crew(), store, undefined, links);
    await vi.waitFor(() => expect(states().at(-1)?.availability).toEqual({ state: 'not-ready', reason: 'The crew is not ready: phase Pending' }));
    recorded.panels[0].dispose();
    answers.push(new Error('boom'));
    ChatPanel.show(Uri.file('/ext') as never, connection, crew(), store, undefined, links);
    await vi.waitFor(() => expect(recorded.panels[1].webview.posted.at(-1)).toMatchObject({ availability: { state: 'unreachable', reason: 'Cannot reach the cluster: boom' } }));
  });

  it('reads it again while visible, not while hidden, and stops when closed', async () => {
    vi.useFakeTimers();
    links.availability.mockClear();
    ChatPanel.show(Uri.file('/ext') as never, connection, crew(), store, undefined, links);
    expect(links.availability).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(AVAILABILITY_MS);
    expect(links.availability).toHaveBeenCalledTimes(2);
    recorded.panels[0].setVisible(false);
    await vi.advanceTimersByTimeAsync(AVAILABILITY_MS);
    expect(links.availability).toHaveBeenCalledTimes(2);
    recorded.panels[0].dispose();
    await vi.advanceTimersByTimeAsync(AVAILABILITY_MS * 2);
    expect(links.availability).toHaveBeenCalledTimes(2);
  });

  it('reads it again when the panel becomes visible, one read at a time', async () => {
    let finish: (a: CrewAvailability) => void = () => undefined;
    const slow = { agentSources: async () => new Map(), availability: vi.fn(() => new Promise<CrewAvailability>((r) => (finish = r))) };
    ChatPanel.show(Uri.file('/ext') as never, connection, crew(), store, undefined, slow);
    recorded.panels[0].setVisible(false);
    recorded.panels[0].setVisible(true);
    expect(slow.availability).toHaveBeenCalledTimes(1);
    finish({ state: 'ready' });
    // The read ends before it posts what it found, so the post shows it is done.
    await firstReadPosted();
    recorded.panels[0].setVisible(true);
    expect(slow.availability).toHaveBeenCalledTimes(2);
  });

  it('posts the end of a turn at once, without waiting for the availability read it starts', async () => {
    const hang = { agentSources: async () => new Map(), availability: vi.fn(async (): Promise<CrewAvailability> => ({ state: 'ready' })) };
    ChatPanel.show(Uri.file('/ext') as never, connection, crew(), store, undefined, hang);
    await firstReadPosted();
    hang.availability.mockImplementation(() => new Promise<CrewAvailability>(() => undefined));
    transport.responses.push('{"conversationId":"conv-1"}');
    transport.streams.push(fixture('turn1.sse'));
    await recorded.panels[0].webview.receive({ type: 'send', text: 'Hi?' });
    // The read the turn's end starts never finishes, so this post proves the panel did not wait for it.
    await vi.waitFor(() => {
      expect(hang.availability).toHaveBeenCalledTimes(2);
      expect(states().at(-1)).toMatchObject({ view: { busy: false }, availability: { state: 'ready' } });
    });
  });

  it('names the question of the turn running now, and none when idle or closed', async () => {
    expect(ChatPanel.activeTurn('ctx', crew())).toBeUndefined();
    ChatPanel.show(Uri.file('/ext') as never, connection, crew(), store, undefined, links);
    await firstReadPosted();
    expect(ChatPanel.activeTurn('ctx', crew())).toBeUndefined();
    transport.responses.push('{"conversationId":"conv-1"}');
    transport.holdOpen = true;
    transport.streams.push(fixture('turn1.sse').split('data: {"type":"done"}')[0]);
    void recorded.panels[0].webview.receive({ type: 'send', text: 'Which nodes?' });
    await vi.waitFor(() => expect(ChatPanel.activeTurn('ctx', crew())).toBe('Which nodes?'));
    recorded.panels[0].dispose();
    expect(ChatPanel.activeTurn('ctx', crew())).toBeUndefined();
  });

  it('reads it again when a turn ends', async () => {
    ChatPanel.show(Uri.file('/ext') as never, connection, crew(), store, undefined, links);
    await firstReadPosted();
    links.availability.mockClear();
    answers.push({ state: 'error', reason: 'The crew is in an error state: Agent a is Failed' });
    transport.responses.push('{"conversationId":"conv-1"}');
    transport.streams.push(fixture('turn1.sse'));
    await recorded.panels[0].webview.receive({ type: 'send', text: 'Hi?' });
    await vi.waitFor(() => expect(states().at(-1)).toMatchObject({ view: { busy: false }, availability: { state: 'error' } }));
    expect(links.availability).toHaveBeenCalledTimes(1);
  });
});
