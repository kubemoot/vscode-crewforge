import { afterEach, describe, expect, it, vi } from 'vitest';
import { ask, DEFAULT_TIMING, isRetryable, reconnectDelayMs, streamTurn, Watchdog, type TurnTiming } from '../src/discussion/client';
import { ConnectionError, KubeError } from '../src/k8s/request';
import type { DiscussionEvent } from '../src/discussion/types';
import { FakeTransport, fixture } from './fakes';

const FAST: TurnTiming = { firstEventMs: 50, idleMs: 80, maxMs: 1_000, reconnectMs: 1 };
const turn = (conversationId = 'c', requestedAt?: string) => ({ conversationId, requestedAt });

describe('ask', () => {
  it('posts the message and returns the conversation id and when it was queued', async () => {
    const t = new FakeTransport();
    t.responses.push('{"conversationId":"abc","requestedAt":"2026-09-30T19:36:36.05Z"}');
    expect(await ask(t, 'team-1', 'lab-ops', 'Which nodes?', '')).toEqual({ conversationId: 'abc', requestedAt: '2026-09-30T19:36:36.05Z' });
    expect(t.calls[0]).toEqual({
      method: 'POST',
      path: '/api/v1/namespaces/team-1/services/lab-ops-discussion:80/proxy/api/v1/discussions/lab-ops',
      body: { message: 'Which nodes?', conversationId: '' },
    });
  });

  it('sends the conversation id of a continued conversation', async () => {
    const t = new FakeTransport();
    t.responses.push('{"conversationId":"abc"}');
    expect(await ask(t, 'ns', 'crew', 'again', 'abc')).toEqual({ conversationId: 'abc', requestedAt: undefined });
    expect(t.calls[0].body).toEqual({ message: 'again', conversationId: 'abc' });
  });

  it('fails clearly on a body without an id, or one that is not JSON', async () => {
    const t = new FakeTransport();
    t.responses.push('{}', '<html>bad gateway</html>');
    await expect(ask(t, 'ns', 'crew', 'q')).rejects.toThrow(/no conversationId/);
    await expect(ask(t, 'ns', 'crew', 'q')).rejects.toThrow(/not JSON/);
  });

  it('passes transport errors through', async () => {
    const t = new FakeTransport();
    t.responses.push(new Error('403 forbidden'));
    await expect(ask(t, 'ns', 'crew', 'q')).rejects.toThrow('403 forbidden');
  });
});

describe('streamTurn', () => {
  it('delivers a recorded turn and ends on done', async () => {
    const t = new FakeTransport();
    t.streams.push(fixture('turn1.sse'));
    const seen: DiscussionEvent[] = [];
    const end = await streamTurn(t, 'team-1', 'lab-ops', turn('conv-1'), (e) => seen.push(e), new AbortController().signal, FAST);
    expect(end).toEqual({ kind: 'done' });
    expect(seen.map((e) => e.type)).toContain('synthesis');
    expect(seen.at(-1)?.type).toBe('done');
    expect(t.calls[0].path).toMatch(/\/discussions\/lab-ops\/conv-1\/stream$/);
  });

  it('stops reading at done even when the server keeps the stream open', async () => {
    const t = new FakeTransport();
    t.holdOpen = true;
    t.streams.push(fixture('turn2.sse') + 'data: {"type":"synthesis","content":"after"}\n\n');
    const seen: DiscussionEvent[] = [];
    const end = await streamTurn(t, 'ns', 'crew', turn(), (e) => seen.push(e), new AbortController().signal, FAST);
    expect(end.kind).toBe('done');
    expect(seen.filter((e) => e.content === 'after')).toHaveLength(0);
  });

  it('ends with the error event message', async () => {
    const t = new FakeTransport();
    t.streams.push('data: {"type":"connected"}\n\ndata: {"type":"error","error":"no coordinator"}\n\n');
    expect(await streamTurn(t, 'ns', 'crew', turn(), () => {}, new AbortController().signal, FAST)).toEqual({ kind: 'error', message: "The crew's discussion gateway reported an error: no coordinator" });
  });

  it('sends when the question was queued, so the gateway picks this turn\'s thread', async () => {
    const t = new FakeTransport();
    t.streams.push(fixture('turn1.sse'));
    await streamTurn(t, 'ns', 'crew', turn('c', '2026-09-30T19:36:36.05Z'), () => {}, new AbortController().signal, FAST);
    expect(t.calls[0].path).toMatch(/\/c\/stream\?since=2026-09-30T19%3A36%3A36.05Z$/);
  });

  it('reopens a stream that closed before done and resumes after the last event id', async () => {
    const t = new FakeTransport();
    t.streams.push(
      'data: {"type":"connected"}\n\nid: A:7\ndata: {"type":"thread_found","threadId":"A"}\n\n',
      'data: {"type":"connected"}\n\nid: A:9\ndata: {"type":"synthesis","content":"answer"}\n\nid: A:10\ndata: {"type":"done"}\n\n',
    );
    const seen: DiscussionEvent[] = [];
    const end = await streamTurn(t, 'ns', 'crew', turn('c', 'T0'), (e) => seen.push(e), new AbortController().signal, FAST);
    expect(end).toEqual({ kind: 'done' });
    expect(seen.map((e) => e.type)).toEqual(['connected', 'thread_found', 'reconnecting', 'connected', 'synthesis', 'done']);
    expect(seen[2].error).toMatch(/closed before the crew finished/);
    expect(t.calls[1].path).toMatch(/\?since=T0&lastEventId=A%3A7$/);
  });

  it('keeps reconnecting while the gateway restarts (5xx or a dropped connection)', async () => {
    const t = new FakeTransport();
    t.streams.push(new KubeError('no endpoints', 503), new ConnectionError('Could not reach the API server: socket hang up'), fixture('turn1.sse'));
    const seen: DiscussionEvent[] = [];
    const end = await streamTurn(t, 'ns', 'crew', turn(), (e) => seen.push(e), new AbortController().signal, FAST);
    expect(end).toEqual({ kind: 'done' });
    expect(seen.filter((e) => e.type === 'reconnecting')).toHaveLength(2);
    expect(t.calls).toHaveLength(3);
  });

  it('does not retry a failure that will repeat: a 4xx, a local KubeError, or an error that is not a KubeError', async () => {
    const t = new FakeTransport();
    t.streams.push(new KubeError('Your account is not allowed to do this.', 403));
    expect(await streamTurn(t, 'ns', 'crew', turn(), () => {}, new AbortController().signal, FAST)).toEqual({ kind: 'error', message: 'Your account is not allowed to do this.' });
    t.streams.push(new Error('503 no endpoints'));
    expect(await streamTurn(t, 'ns', 'crew', turn(), () => {}, new AbortController().signal, FAST)).toEqual({ kind: 'error', message: '503 no endpoints' });
    t.streams.push(new KubeError('The kubeconfig has no current cluster'));
    expect(await streamTurn(t, 'ns', 'crew', turn(), () => {}, new AbortController().signal, FAST)).toMatchObject({ kind: 'error' });
    expect(t.calls).toHaveLength(3);
  });

  it('backs off while connections bring only connected and heartbeats', async () => {
    const t = new FakeTransport();
    for (let i = 0; i < 50; i++) t.streams.push('data: {"type":"connected"}\n\ndata: {"type":"heartbeat"}\n\n');
    const pauses: number[] = [];
    const real = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      if (ms !== undefined && ms < 50) pauses.push(ms);
      return real(fn, ms);
    }) as typeof setTimeout);
    try {
      await streamTurn(t, 'ns', 'crew', turn(), () => {}, new AbortController().signal, { firstEventMs: 1_000, idleMs: 60, maxMs: 1_000, reconnectMs: 2 });
    } finally {
      spy.mockRestore();
    }
    expect(pauses.slice(0, 4)).toEqual([2, 4, 8, 16]);
  });

  it('ends the turn with the error when the event handler throws', async () => {
    const t = new FakeTransport();
    t.streams.push('id: A:4\ndata: {"type":"thread_found","threadId":"A"}\n\n', 'data: {"type":"done"}\n\n');
    let first = true;
    const end = await streamTurn(t, 'ns', 'crew', turn(), () => {
      if (first) {
        first = false;
        throw new Error('panel gone');
      }
    }, new AbortController().signal, FAST);
    expect(end).toEqual({ kind: 'error', message: 'panel gone' });
    expect(t.calls).toHaveLength(1);
  });

  it('gives up with the reason when the gateway stays unreachable', async () => {
    const t = new FakeTransport();
    for (let i = 0; i < 100; i++) t.streams.push(new KubeError('no endpoints', 503));
    const end = await streamTurn(t, 'ns', 'crew', turn(), () => {}, new AbortController().signal, { ...FAST, reconnectMs: 5 });
    expect(end).toMatchObject({ kind: 'timeout', message: expect.stringMatching(/could not reconnect: no endpoints/) });
  });

  it('stops reconnecting when the caller aborts', async () => {
    const t = new FakeTransport();
    for (let i = 0; i < 100; i++) t.streams.push(new KubeError('no endpoints', 503));
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 20);
    expect(await streamTurn(t, 'ns', 'crew', turn(), () => {}, stop.signal, { ...FAST, reconnectMs: 5 })).toEqual({ kind: 'aborted' });
    const calls = t.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(t.calls).toHaveLength(calls);
  });

  it('times out when no event arrives at all', async () => {
    const t = new FakeTransport();
    t.holdOpen = true;
    t.streams.push('');
    const end = await streamTurn(t, 'ns', 'crew', turn(), () => {}, new AbortController().signal, FAST);
    expect(end).toMatchObject({ kind: 'timeout', message: expect.stringMatching(/No response/) });
  });

  it('times out when the stream goes quiet after it started', async () => {
    const t = new FakeTransport();
    t.holdOpen = true;
    t.streams.push('data: {"type":"connected"}\n\n');
    const end = await streamTurn(t, 'ns', 'crew', turn(), () => {}, new AbortController().signal, FAST);
    expect(end).toMatchObject({ kind: 'timeout', message: expect.stringMatching(/went quiet/) });
  });

  it('ends as aborted when the caller aborts, before or during the turn', async () => {
    const t = new FakeTransport();
    const pre = new AbortController();
    pre.abort();
    expect(await streamTurn(t, 'ns', 'crew', turn(), () => {}, pre.signal, FAST)).toEqual({ kind: 'aborted' });

    t.holdOpen = true;
    t.streams.push('data: {"type":"connected"}\n\n');
    const during = new AbortController();
    setTimeout(() => during.abort(), 10);
    expect(await streamTurn(t, 'ns', 'crew', turn(), () => {}, during.signal, FAST)).toEqual({ kind: 'aborted' });
  });
});

describe('isRetryable', () => {
  it('retries dropped connections, 5xx and 429, and nothing else, not a local failure', () => {
    expect(isRetryable(new ConnectionError('socket hang up'))).toBe(true);
    expect(isRetryable(new KubeError('The kubeconfig has no current cluster'))).toBe(false);
    expect(isRetryable(new KubeError('bad gateway', 502))).toBe(true);
    expect(isRetryable(new KubeError('slow down', 429))).toBe(true);
    expect(isRetryable(new KubeError('bad request', 400))).toBe(false);
    expect(isRetryable(new KubeError('not found', 404))).toBe(false);
    expect(isRetryable(new Error('plain'))).toBe(false);
    expect(isRetryable('text')).toBe(false);
  });
});

describe('reconnectDelayMs', () => {
  it('doubles from the base and levels off at ten times it', () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => reconnectDelayMs(n, 500))).toEqual([500, 1_000, 2_000, 4_000, 5_000, 5_000]);
    expect(reconnectDelayMs(0)).toBe(DEFAULT_TIMING.reconnectMs);
  });
});

describe('DEFAULT_TIMING', () => {
  it('outlasts a delayed gateway heartbeat (every 30 s) and stays within the turn cap', () => {
    expect(DEFAULT_TIMING.idleMs).toBeGreaterThanOrEqual(3 * 30_000);
    expect(DEFAULT_TIMING.idleMs).toBeLessThan(DEFAULT_TIMING.maxMs);
  });
});

describe('Watchdog', () => {
  afterEach(() => vi.useRealTimers());

  it('fires the overall cap even while heartbeats keep arriving', () => {
    vi.useFakeTimers();
    const fired: string[] = [];
    const w = new Watchdog({ firstEventMs: 30_000, idleMs: 60_000, maxMs: 120_000 }, (m) => fired.push(m));
    w.start();
    for (let s = 0; s < 150; s += 20) {
      w.sawEvent();
      vi.advanceTimersByTime(20_000);
    }
    expect(fired[0]).toMatch(/longer than 120 s/);
    w.clear();
  });

  it('does not fire after it is cleared', () => {
    vi.useFakeTimers();
    const fired: string[] = [];
    const w = new Watchdog({ firstEventMs: 10, idleMs: 10, maxMs: 10 }, (m) => fired.push(m));
    w.start();
    w.clear();
    vi.advanceTimersByTime(1_000);
    expect(fired).toEqual([]);
  });
});
