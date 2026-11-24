import { describe, expect, it } from 'vitest';
import { statePath } from '../src/discussion/gatewayPath';
import { isActive, readConversationState, waitingTurn, type ConversationStatus } from '../src/discussion/remoteState';
import { queueNote, STOPPED_NOTICE } from '../src/discussion/stopped';
import { FakeTransport } from './fakes';

const status = (over: Partial<ConversationStatus> = {}): ConversationStatus => ({ conversationId: 'c-1', state: 'running', turns: [{ state: 'running', threadId: 't1' }], ...over });

describe('readConversationState', () => {
  it('reads the state from the gateway state route', async () => {
    const gateway = new FakeTransport();
    gateway.states['c-1'] = status();
    expect((await readConversationState(gateway, 'team-a', 'lab-ops', 'c-1'))?.state).toBe('running');
    expect(gateway.stateReads).toEqual(['/api/v1/discussions/lab-ops/c-1/state']);
    expect(statePath('team-a', 'lab-ops', 'c 1')).toBe('/api/v1/discussions/lab-ops/c%201/state');
    expect(() => statePath('team-a', 'lab-ops', '')).toThrow('conversationId is required');
  });

  it('is undefined for a conversation the gateway does not know, an answer that is not a state, and a body that is not JSON', async () => {
    const gateway = new FakeTransport();
    expect(await readConversationState(gateway, 'team-a', 'lab-ops', 'c-9')).toBeUndefined();
    gateway.states['c-2'] = { hello: 1 };
    expect(await readConversationState(gateway, 'team-a', 'lab-ops', 'c-2')).toBeUndefined();
    gateway.states['c-3'] = { conversationId: 'c-3', state: 'exploded', turns: [] };
    expect(await readConversationState(gateway, 'team-a', 'lab-ops', 'c-3')).toBeUndefined();
    const broken = new FakeTransport();
    broken.request = async () => 'not json';
    expect(await readConversationState(broken, 'team-a', 'lab-ops', 'c-4')).toBeUndefined();
  });
});

describe('waitingTurn and isActive', () => {
  it('finds the queued turn nearest the front', () => {
    const s = status({ state: 'queued', turns: [{ state: 'finished' }, { state: 'queued', queuePosition: 3 }, { state: 'queued', queuePosition: 2 }] });
    expect(waitingTurn(s)?.queuePosition).toBe(2);
    expect(waitingTurn(status())).toBeUndefined();
    expect(waitingTurn(undefined)).toBeUndefined();
  });

  it('is active while queued, running or paused', () => {
    expect(['queued', 'running', 'paused'].map((s) => isActive(s as never))).toEqual([true, true, true]);
    expect([isActive('stopped'), isActive('finished'), isActive(undefined)]).toEqual([false, false, false]);
  });
});

describe('what is said', () => {
  it('says where a queued question stands', () => {
    expect(queueNote(0)).toBe("Waiting in the crew's queue: next to be taken.");
    expect(queueNote(1)).toBe("Waiting in the crew's queue: 1 question ahead.");
    expect(queueNote(3)).toBe("Waiting in the crew's queue: 3 questions ahead.");
    expect(STOPPED_NOTICE).toContain('Stopped by you');
  });
});
