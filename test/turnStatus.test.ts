import { describe, expect, it } from 'vitest';
import { initialTurn, reduce, type TurnState } from '../src/discussion/reducer';
import type { DiscussionEvent } from '../src/discussion/types';
import { elapsed, turnStatus } from '../src/discussion/turnStatus';
import { cardText } from '../src/discussion/cardText';

const T0 = 1_000_000;
const at = (events: DiscussionEvent[]): TurnState => events.reduce(reduce, initialTurn(T0));

describe('turnStatus', () => {
  it('follows the turn from sending to the answer being written', () => {
    expect(turnStatus(at([]), T0 + 1_000)).toBe('Sending the question · 1s');
    expect(turnStatus(at([{ type: 'connected' }]), T0)).toMatch(/^Waiting for the coordinator/);
    const picked = at([{ type: 'connected' }, { type: 'thread_found', threadId: 't' }]);
    expect(turnStatus(picked, T0)).toMatch(/^The coordinator is choosing/);
    const working = at([
      { type: 'connected' },
      { type: 'thread_found', threadId: 't' },
      { type: 'phase', agent: 'a', status: 'evaluating' },
      { type: 'phase', agent: 'b', status: 'triaging' },
      { type: 'phase', agent: 'c', status: 'done', stood_aside: true },
    ]);
    expect(turnStatus(working, T0)).toMatch(/^2 of 3 agents still working/);
    const writing = at([
      { type: 'connected' },
      { type: 'thread_found', threadId: 't' },
      { type: 'finding', agent: 'a', signal: 'agree', summary: 'x' },
      { type: 'phase', agent: 'c', status: 'done', stood_aside: true },
    ]);
    expect(turnStatus(writing, T0 + 125_000)).toBe('The coordinator is writing the answer · 2m 05s');
  });

  it('counts a single agent in the singular', () => {
    const one = at([{ type: 'connected' }, { type: 'thread_found', threadId: 't' }, { type: 'phase', agent: 'a', status: 'triaging' }]);
    expect(turnStatus(one, T0)).toMatch(/^1 of 1 agent still working/);
  });
});

describe('elapsed', () => {
  it('formats seconds and minutes, never negative', () => {
    expect(elapsed(0)).toBe('0s');
    expect(elapsed(59_999)).toBe('59s');
    expect(elapsed(60_000)).toBe('1m 00s');
    expect(elapsed(-5)).toBe('0s');
  });
});

describe('waiting for a GPU', () => {
  it('says the agents are waiting on a busy cluster, and counts waiting agents as working', () => {
    let t = reduce(reduce(reduce(initialTurn(0), { type: 'connected' }), { type: 'thread_found', threadId: 't' }), { type: 'phase', agent: 'rules', status: 'waiting', model: 'qwen3:14b', reason: 'gpu-busy' });
    expect(turnStatus(t, 1000)).toBe('1 agent is waiting for a GPU with room; the cluster is busy · 1s');
    expect(cardText(t.cards[0])).toEqual({ text: 'waiting for a GPU with room for qwen3:14b...', working: true });
    t = reduce(t, { type: 'phase', agent: 'other', status: 'evaluating', gpu: 'g' });
    expect(turnStatus(t, 1000)).toBe('2 of 2 agents still working · 1s');
    t = reduce(t, { type: 'phase', agent: 'third', status: 'waiting' });
    t = reduce(t, { type: 'phase', agent: 'other', status: 'done', stood_aside: true, signal: 'stand_aside' });
    expect(turnStatus(t, 1000)).toBe('2 agents are waiting for a GPU with room; the cluster is busy · 1s');
    expect(cardText(t.cards.find((c) => c.agent === 'third')!).text).toBe('waiting for a GPU with room for its model...');
  });

  it('explains why an agent stood aside', () => {
    const card = { agent: 'a', status: 'done', stoodAside: true };
    expect(cardText({ ...card, reason: 'gpu-busy' }).text).toBe('stood aside: every GPU was busy, so it could not run');
    expect(cardText({ ...card, reason: 'model-too-large' }).text).toBe('stood aside: no GPU in this cluster can hold its model');
    expect(cardText({ ...card, reason: 'other' }).text).toBe('stood aside');
    expect(cardText(card).text).toBe('stood aside');
  });
});
