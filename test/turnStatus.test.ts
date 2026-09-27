import { describe, expect, it } from 'vitest';
import { initialTurn, reduce, type TurnState } from '../src/discussion/reducer';
import type { DiscussionEvent } from '../src/discussion/types';
import { elapsed, turnStatus } from '../src/discussion/turnStatus';

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
