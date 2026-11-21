import { describe, expect, it } from 'vitest';
import { ConversationEvents, type ConversationNews } from '../src/discussion/events';
import { ConnectionError, KubeError } from '../src/k8s/request';
import { FakeTransport } from './fakes';

/** One server-sent event the way the gateway writes it. */
function sse(id: string | undefined, data: object): string {
  return `${id ? `id: ${id}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
}

const news = (conversationId: string, extra: object = {}) => ({ type: 'conversation_updated', conversationId, reason: 'answer', threadId: 't-1', at: '2026-11-21T01:00:00Z', ...extra });
const connected = (id: string) => sse(id, { type: 'connected' });

/** Subscribes, and resolves once the subscription has ended. */
async function listen(transport: FakeTransport, ends: unknown[] = []): Promise<{ heard: ConversationNews[]; events: ConversationEvents }> {
  const heard: ConversationNews[] = [];
  const events = new ConversationEvents(transport, 'team-a', 'demo', (n) => heard.push(n), (err) => ends.push(err), 1);
  await events.start();
  return { heard, events };
}

describe('ConversationEvents', () => {
  it('names each conversation that has something new, and ignores connect and heartbeat events', async () => {
    const t = new FakeTransport();
    t.streams.push(connected('10') + sse(undefined, { type: 'heartbeat' }) + sse('11', news('conv-1')) + sse('12', news('conv-2', { reason: 'reminder' })) + sse('13', { type: 'conversation_updated' }));
    t.streams.push(new KubeError('forbidden', 403));
    const { heard } = await listen(t);
    expect(heard.map((n) => [n.conversationId, n.reason, n.threadId, n.at])).toEqual([
      ['conv-1', 'answer', 't-1', '2026-11-21T01:00:00Z'],
      ['conv-2', 'reminder', 't-1', '2026-11-21T01:00:00Z'],
    ]);
    expect(t.calls[0]).toEqual({ method: 'GET', path: '/api/v1/discussions/demo/events' });
  });

  it('opens again after the stream closes, resuming after the last event id it received', async () => {
    const t = new FakeTransport();
    t.streams.push(connected('10') + sse('11', news('conv-1')));
    t.streams.push(connected('11') + sse('15', news('conv-2')));
    t.streams.push(new KubeError('unauthorized', 401));
    const { heard, events } = await listen(t);
    expect(heard.map((n) => n.conversationId)).toEqual(['conv-1', 'conv-2']);
    expect(t.calls.map((c) => c.path)).toEqual([
      '/api/v1/discussions/demo/events',
      '/api/v1/discussions/demo/events?lastEventId=11',
      '/api/v1/discussions/demo/events?lastEventId=15',
    ]);
    expect(events.lastEventId).toBe('15');
  });

  it('keeps the connected event id, so news that fails to arrive is not skipped on reconnect', async () => {
    const t = new FakeTransport();
    t.streams.push(connected('7'));
    t.streams.push(new KubeError('forbidden', 403));
    await listen(t);
    expect(t.calls[1].path).toBe('/api/v1/discussions/demo/events?lastEventId=7');
  });

  it('reconnects after a dropped connection and a 5xx, and ends for good on an error that would repeat', async () => {
    const t = new FakeTransport();
    t.streams.push(new ConnectionError('cut'));
    t.streams.push(new KubeError('unavailable', 503));
    t.streams.push(sse('3', news('conv-1')));
    const refused = new KubeError('forbidden', 403);
    t.streams.push(refused);
    const ends: unknown[] = [];
    const { heard } = await listen(t, ends);
    expect(heard).toHaveLength(1);
    expect(t.calls).toHaveLength(4);
    expect(ends).toEqual([refused]);
  });

  it('ends quietly when stopped, without calling onEnd', async () => {
    const t = new FakeTransport();
    t.holdOpen = true;
    t.streams.push(connected('1'));
    const ends: unknown[] = [];
    const heard: ConversationNews[] = [];
    const events = new ConversationEvents(t, 'team-a', 'demo', (n) => heard.push(n), (e) => ends.push(e), 1);
    const running = events.start();
    expect(events.start()).toBe(running);
    await new Promise((resolve) => setTimeout(resolve, 20));
    events.stop();
    await running;
    expect(ends).toEqual([]);
    expect(t.calls).toHaveLength(1);
  });

  it('stops without an error when the abort surfaces as a failure of the stream', async () => {
    const t = new FakeTransport();
    const ends: unknown[] = [];
    const events = new ConversationEvents(
      {
        request: () => Promise.reject(new Error('unused')),
        stream: () => {
          events.stop();
          return Promise.reject(new Error('aborted mid-read'));
        },
      },
      'team-a',
      'demo',
      () => undefined,
      (e) => ends.push(e),
      1,
    );
    await events.start();
    expect(ends).toEqual([]);
    expect(t.calls).toHaveLength(0);
  });

  it('works without an onEnd', async () => {
    const t = new FakeTransport();
    t.streams.push(new KubeError('forbidden', 403));
    await new ConversationEvents(t, 'team-a', 'demo', () => undefined).start();
    expect(t.calls).toHaveLength(1);
  });
});
