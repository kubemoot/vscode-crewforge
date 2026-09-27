import { afterEach, describe, expect, it, vi } from 'vitest';
import { ask, DEFAULT_TIMING, streamTurn, Watchdog, type TurnTiming } from '../src/discussion/client';
import type { DiscussionEvent } from '../src/discussion/types';
import { FakeTransport, fixture } from './fakes';

const FAST: TurnTiming = { firstEventMs: 50, idleMs: 80, maxMs: 1_000 };

describe('ask', () => {
  it('posts the message and returns the conversation id', async () => {
    const t = new FakeTransport();
    t.responses.push('{"conversationId":"abc"}');
    expect(await ask(t, 'team-1', 'lab-ops', 'Which nodes?', '')).toBe('abc');
    expect(t.calls[0]).toEqual({
      method: 'POST',
      path: '/api/v1/namespaces/team-1/services/lab-ops-discussion:80/proxy/api/v1/discussions/lab-ops',
      body: { message: 'Which nodes?', conversationId: '' },
    });
  });

  it('sends the conversation id of a continued conversation', async () => {
    const t = new FakeTransport();
    t.responses.push('{"conversationId":"abc"}');
    await ask(t, 'ns', 'crew', 'again', 'abc');
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
    const end = await streamTurn(t, 'team-1', 'lab-ops', 'conv-1', (e) => seen.push(e), new AbortController().signal, FAST);
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
    const end = await streamTurn(t, 'ns', 'crew', 'c', (e) => seen.push(e), new AbortController().signal, FAST);
    expect(end.kind).toBe('done');
    expect(seen.filter((e) => e.content === 'after')).toHaveLength(0);
  });

  it('ends with the error event message', async () => {
    const t = new FakeTransport();
    t.streams.push('data: {"type":"connected"}\n\ndata: {"type":"error","error":"no coordinator"}\n\n');
    expect(await streamTurn(t, 'ns', 'crew', 'c', () => {}, new AbortController().signal, FAST)).toEqual({ kind: 'error', message: 'no coordinator' });
  });

  it('reports a stream that closes before done', async () => {
    const t = new FakeTransport();
    t.streams.push('data: {"type":"connected"}\n\n');
    expect((await streamTurn(t, 'ns', 'crew', 'c', () => {}, new AbortController().signal, FAST)).kind).toBe('closed');
  });

  it('reports a transport failure as an error', async () => {
    const t = new FakeTransport();
    t.streams.push(new Error('503 no endpoints'));
    expect(await streamTurn(t, 'ns', 'crew', 'c', () => {}, new AbortController().signal, FAST)).toEqual({ kind: 'error', message: '503 no endpoints' });
  });

  it('times out when no event arrives at all', async () => {
    const t = new FakeTransport();
    t.holdOpen = true;
    t.streams.push('');
    const end = await streamTurn(t, 'ns', 'crew', 'c', () => {}, new AbortController().signal, FAST);
    expect(end).toMatchObject({ kind: 'timeout', message: expect.stringMatching(/No response/) });
  });

  it('times out when the stream goes quiet after it started', async () => {
    const t = new FakeTransport();
    t.holdOpen = true;
    t.streams.push('data: {"type":"connected"}\n\n');
    const end = await streamTurn(t, 'ns', 'crew', 'c', () => {}, new AbortController().signal, FAST);
    expect(end).toMatchObject({ kind: 'timeout', message: expect.stringMatching(/went quiet/) });
  });

  it('ends as aborted when the caller aborts, before or during the turn', async () => {
    const t = new FakeTransport();
    const pre = new AbortController();
    pre.abort();
    expect(await streamTurn(t, 'ns', 'crew', 'c', () => {}, pre.signal, FAST)).toEqual({ kind: 'aborted' });

    t.holdOpen = true;
    t.streams.push('data: {"type":"connected"}\n\n');
    const during = new AbortController();
    setTimeout(() => during.abort(), 10);
    expect(await streamTurn(t, 'ns', 'crew', 'c', () => {}, during.signal, FAST)).toEqual({ kind: 'aborted' });
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
