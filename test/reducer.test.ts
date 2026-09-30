import { describe, expect, it } from 'vitest';
import { initialTurn, reduce, type TurnState } from '../src/discussion/reducer';
import { SseParser } from '../src/discussion/sse';
import type { DiscussionEvent } from '../src/discussion/types';
import { fixture } from './fakes';

function fold(events: DiscussionEvent[], from: TurnState = initialTurn()): TurnState {
  return events.reduce(reduce, from);
}

function events(name: string): DiscussionEvent[] {
  const p = new SseParser();
  return [...p.push(fixture(name)), ...p.end()];
}

describe('reduce', () => {
  it('folds a recorded turn where the only agent stood aside', () => {
    const s = fold(events('turn1.sse'));
    expect(s.connected).toBe(true);
    expect(s.threadId).toBe('0f643dce-5d20-429d-9316-1e0d79e2e91f');
    expect(s.cards).toEqual([{ agent: 'node-watcher', status: 'done', gpu: 'ollama-rig0', signal: 'stand_aside', stoodAside: true }]);
    expect(s.synthesis).toMatch(/^No specialist contributed/);
    expect(s.done).toBe(true);
    expect(s.error).toBeUndefined();
  });

  it('folds a recorded turn with a finding into one card per agent', () => {
    const s = fold(events('turn2.sse'));
    expect(s.threadId).toBe('6e8c0b87-5bd6-45c3-b510-8923102f64b1');
    expect(s.cards).toHaveLength(1);
    expect(s.cards[0]).toMatchObject({ agent: 'node-watcher', status: 'finding', signal: 'agree', gpu: 'ollama-rig0' });
    expect(s.cards[0].summary).toMatch(/^\[ARTIFACT key=/);
    expect(s.synthesis).toContain('Kubernetes pods');
  });

  it('marks the turn reconnecting until the stream connects again', () => {
    const down = fold([{ type: 'connected' }, { type: 'thread_found', threadId: 'A' }, { type: 'reconnecting', error: 'socket hang up' }]);
    expect(down.reconnecting).toBe('socket hang up');
    expect(fold([{ type: 'reconnecting' }]).reconnecting).toBe('the connection dropped');
    const back = fold([{ type: 'connected' }], down);
    expect(back.reconnecting).toBeUndefined();
    expect(back.threadId).toBe('A');
  });

  it('starts over when the coordinator restarts the question under a new thread', () => {
    const s = fold([
      { type: 'connected' },
      { type: 'thread_found', threadId: 'A' },
      { type: 'phase', agent: 'a', status: 'triaging' },
      { type: 'synthesis', content: 'partial' },
      { type: 'thread_found', threadId: 'A' },
    ]);
    expect(s.cards).toHaveLength(1);
    expect(s.restarted).toBeUndefined();
    const restarted = fold([{ type: 'thread_found', threadId: 'B' }], s);
    expect(restarted).toMatchObject({ threadId: 'B', cards: [], synthesis: undefined, restarted: true, abandoned: ['A'] });
    expect(fold([{ type: 'thread_found' }], s)).toBe(s);
    const withB = fold([{ type: 'phase', agent: 'b', status: 'triaging' }], restarted);
    expect(fold([{ type: 'thread_found', threadId: 'A' }], withB)).toBe(withB);
    expect(fold([{ type: 'thread_found', threadId: 'C' }], withB).abandoned).toEqual(['A', 'B']);
  });

  it('keeps agents in the order they first appeared', () => {
    const s = fold([
      { type: 'phase', agent: 'b', status: 'triaging' },
      { type: 'phase', agent: 'a', status: 'triaging' },
      { type: 'phase', agent: 'b', status: 'evaluating' },
    ]);
    expect(s.cards.map((c) => `${c.agent}:${c.status}`)).toEqual(['b:evaluating', 'a:triaging']);
  });

  it('uses the first line of content when a finding has no summary', () => {
    const s = fold([{ type: 'finding', agent: 'x', signal: 'concern', content: 'line one\nline two' }]);
    expect(s.cards[0].summary).toBe('line one');
  });

  it('files events without an agent under "crew"', () => {
    expect(fold([{ type: 'phase', status: 'triaging' }]).cards[0].agent).toBe('crew');
  });

  it('ends the turn on error with the message, falling back to content, then a default', () => {
    expect(fold([{ type: 'error', error: 'boom' }])).toMatchObject({ done: true, error: 'boom' });
    expect(fold([{ type: 'error', content: 'from content' }]).error).toBe('from content');
    expect(fold([{ type: 'error' }]).error).toMatch(/error/);
  });

  it('ignores heartbeats, unknown types, and anything after the turn is done', () => {
    const before = fold([{ type: 'connected' }]);
    expect(reduce(before, { type: 'heartbeat' })).toBe(before);
    expect(reduce(before, { type: 'something-new' })).toBe(before);
    const done = fold([{ type: 'synthesis', content: 'answer' }, { type: 'done' }]);
    expect(reduce(done, { type: 'synthesis', content: 'late' })).toBe(done);
  });

  it('never mutates the state it is given', () => {
    const s = initialTurn();
    const frozen = JSON.stringify(s);
    reduce(s, { type: 'phase', agent: 'a', status: 'triaging' });
    expect(JSON.stringify(s)).toBe(frozen);
  });
});
