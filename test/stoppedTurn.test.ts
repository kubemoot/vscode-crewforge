import { describe, expect, it } from 'vitest';
import { DEFAULT_TIMING, type TurnTiming } from '../src/discussion/client';
import { reportControl, type ConversationControl } from '../src/discussion/controls';
import { ChatSession } from '../src/discussion/session';
import { STOPPED_NOTICE } from '../src/discussion/stopped';
import { newConversation, type Conversation } from '../src/store/conversation';
import { FakeTransport } from './fakes';

const FAST: TurnTiming = { ...DEFAULT_TIMING, firstEventMs: 50, idleMs: 80, maxMs: 1_000, reconnectMs: 1 };

/** The stream of a turn whose question was stopped: the agent had begun, the synthesis is the stopped text. */
const STOPPED_STREAM = [
  'data: {"type":"connected"}\n\n',
  'data: {"type":"thread_found","threadId":"t-1"}\n\n',
  'data: {"type":"phase","agent":"metrics","status":"evaluating"}\n\n',
  'data: {"type":"synthesis","content":"The crew has no source for GPU temperatures; this is not an answer.","outcome":"stopped"}\n\n',
  'data: {"type":"done","outcome":"stopped"}\n\n',
].join('');

describe('a turn the person stopped', () => {
  it('is saved as a notice that says so, never as the crew\'s answer', async () => {
    const t = new FakeTransport();
    t.responses.push('{"conversationId":"conv-1"}');
    t.streams.push(STOPPED_STREAM);
    const saved: Conversation[] = [];
    const conversation = newConversation('ctx', 'team-1', 'lab-ops', new Date('2026-09-27T01:00:00Z'));
    const session = new ChatSession(t, conversation, async (c) => void saved.push(structuredClone(c)), () => undefined, FAST);

    await session.send('What are the GPU temperatures?');

    const messages = session.view.conversation.messages;
    expect(messages.map((m) => m.role)).toEqual(['user', 'system']);
    expect(messages[1].content).toBe(STOPPED_NOTICE);
    expect(messages.some((m) => m.content.includes('no source for GPU temperatures'))).toBe(false);
    expect(messages[1].problems).toBeUndefined();
    expect(messages[1].agents).toBeUndefined();
    expect(messages[1].threadId).toBe('t-1');
    expect(saved).toHaveLength(1);
  });
});

describe('reportControl', () => {
  const sent = (over: Partial<ConversationControl>): ConversationControl => ({ conversationId: 'c-1', action: 'stop', threads: ['t1'], ...over });

  it.each([
    ['stopped', /Stopped\. The crew abandoned the turn/, false],
    ['cancelled', /Cancelled\. The question was still waiting in the queue/, false],
    ['nothing_to_stop', /Nothing to stop/, false],
    ['unconfirmed', /did not confirm the stop in time\. The work may still be running/, true],
  ] as const)('says what a %s stop did', (outcome, text, warn) => {
    const report = reportControl('stop', 'Which nodes?', sent({ outcome }));
    expect(report.text).toMatch(text);
    expect(report.text).toContain('"Which nodes?"');
    expect(report.warn).toBe(warn);
  });

  it('describes pause and resume, and a stop from a gateway that does not report an outcome, by the turns reached', () => {
    expect(reportControl('pause', 'Q', sent({ action: 'pause', threads: ['a', 'b'] })).text).toBe('Paused "Q" (2 running turns).');
    expect(reportControl('resume', 'Q', sent({ action: 'resume' })).text).toBe('Resumed "Q" (1 running turn).');
    expect(reportControl('stop', 'Q', sent({})).text).toBe('Stopped "Q" (1 running turn).');
  });
});
