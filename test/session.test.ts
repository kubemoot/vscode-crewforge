import { describe, expect, it } from 'vitest';
import type { TurnTiming } from '../src/discussion/client';
import { ChatSession, noticeFor, type SessionView } from '../src/discussion/session';
import { newConversation, type Conversation } from '../src/store/conversation';
import { FakeTransport, fixture } from './fakes';

const FAST: TurnTiming = { firstEventMs: 50, idleMs: 80, maxMs: 1_000, reconnectMs: 1 };

function setup() {
  const t = new FakeTransport();
  const saved: Conversation[] = [];
  const views: SessionView[] = [];
  const conversation = newConversation('ctx', 'team-1', 'lab-ops', new Date('2026-09-27T01:00:00Z'));
  const session = new ChatSession(t, conversation, async (c) => void saved.push(structuredClone(c)), (v) => views.push(v), FAST);
  return { t, saved, views, session, conversation };
}

describe('ChatSession', () => {
  it('runs two recorded turns as one conversation', async () => {
    const { t, saved, views, session } = setup();
    t.responses.push('{"conversationId":"conv-1"}', '{"conversationId":"conv-1"}');
    t.streams.push(fixture('turn1.sse'), fixture('turn2.sse'));

    await session.send('Which nodes have a GPU?');
    await session.send('What is running on them right now?');

    const posts = t.calls.filter((c) => c.method === 'POST');
    expect(posts.map((p) => (p.body as { conversationId: string }).conversationId)).toEqual(['', 'conv-1']);
    const c = session.view.conversation;
    expect(c.title).toBe('Which nodes have a GPU?');
    expect(c.conversationId).toBe('conv-1');
    expect(c.threadIds).toEqual(['0f643dce-5d20-429d-9316-1e0d79e2e91f', '6e8c0b87-5bd6-45c3-b510-8923102f64b1']);
    expect(c.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(c.messages[1].content).toMatch(/^No specialist contributed/);
    expect(c.signals.some((s) => s.type === 'agree' && s.agentName === 'node-watcher')).toBe(true);
    expect(saved).toHaveLength(2);
    expect(saved[1].messages).toHaveLength(4);
    expect(views.some((v) => v.busy && v.turn && v.turn.cards.length > 0)).toBe(true);
    expect(session.view).toMatchObject({ busy: false, turn: undefined });
  });

  it('answers from the thread a restarted coordinator finished, after a dropped stream', async () => {
    const { t, session } = setup();
    t.responses.push('{"conversationId":"conv-9","requestedAt":"2026-09-30T19:36:36Z"}');
    t.streams.push(
      'data: {"type":"connected"}\n\nid: A:1\ndata: {"type":"thread_found","threadId":"A"}\n\nid: A:2\ndata: {"type":"phase","agent":"k8s","status":"triaging"}\n\n',
      'data: {"type":"connected"}\n\nid: B:5\ndata: {"type":"thread_found","threadId":"B"}\n\nid: B:8\ndata: {"type":"synthesis","content":"the namespaces are ..."}\n\nid: B:9\ndata: {"type":"done"}\n\n',
    );
    await session.send('List the namespaces');
    const c = session.view.conversation;
    expect(c.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'List the namespaces'],
      ['assistant', 'the namespaces are ...'],
    ]);
    expect(c.threadIds).toEqual(['A', 'B']);
    expect(t.calls.at(-1)?.path).toMatch(/\/conv-9\/stream\?since=2026-09-30T19%3A36%3A36Z&lastEventId=A%3A2$/);
  });

  it('has saved the conversation by the time the turn ends on screen', async () => {
    const t = new FakeTransport();
    t.responses.push('{"conversationId":"c"}');
    t.streams.push(fixture('turn1.sse'));
    let savedCount = 0;
    const savedWhenIdle: number[] = [];
    const session = new ChatSession(
      t,
      newConversation('ctx', 'ns', 'crew'),
      async () => void savedCount++,
      (v) => { if (!v.busy) savedWhenIdle.push(savedCount); },
      FAST,
    );
    await session.send('q');
    expect(savedWhenIdle.at(-1)).toBe(1);
  });

  it('records a failed start as a notice and saves the question', async () => {
    const { t, saved, session } = setup();
    t.responses.push(new Error('The service has no ready pod behind it yet.'));
    await session.send('hello');
    const c = session.view.conversation;
    expect(c.messages.map((m) => m.role)).toEqual(['user', 'system']);
    expect(c.messages[1].content).toMatch(/no ready pod/);
    expect(saved).toHaveLength(1);
    expect(session.busy).toBe(false);
  });

  it('ignores blank questions and a second question while a turn runs', async () => {
    const { t, session } = setup();
    await session.send('   ');
    expect(t.calls).toHaveLength(0);
    t.holdOpen = true;
    t.responses.push('{"conversationId":"c"}');
    t.streams.push('data: {"type":"connected"}\n\n');
    const first = session.send('first');
    await new Promise((r) => setTimeout(r, 5));
    await session.send('second');
    session.stop();
    await first;
    expect(session.view.conversation.messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['first']);
  });

  it('keeps a synthesis that arrived before a stop', async () => {
    const { t, session } = setup();
    t.holdOpen = true;
    t.responses.push('{"conversationId":"c"}');
    t.streams.push('data: {"type":"synthesis","content":"partial answer"}\n\n');
    const turn = session.send('q');
    await new Promise((r) => setTimeout(r, 5));
    session.stop();
    await turn;
    expect(session.view.conversation.messages.map((m) => m.content)).toEqual(['q', 'partial answer']);
  });

  it('stops while the turn is still starting', async () => {
    const { t, session } = setup();
    t.hangRequests = true;
    const turn = session.send('q');
    await new Promise((r) => setTimeout(r, 5));
    expect(session.busy).toBe(true);
    session.stop();
    await turn;
    expect(session.busy).toBe(false);
    expect(session.view.conversation.messages.map((m) => m.content)).toEqual(['q', 'Stopped.']);
  });

  it('survives a failing save', async () => {
    const t = new FakeTransport();
    t.responses.push('{"conversationId":"c"}');
    t.streams.push(fixture('turn1.sse'));
    const session = new ChatSession(t, newConversation('x', 'ns', 'crew'), async () => { throw new Error('disk full'); }, () => {}, FAST);
    await expect(session.send('q')).resolves.toBeUndefined();
    expect(session.view.conversation.messages).toHaveLength(2);
  });

  it('does not replace the conversation while a turn runs', async () => {
    const { t, session, conversation } = setup();
    t.holdOpen = true;
    t.responses.push('{"conversationId":"c"}');
    t.streams.push('data: {"type":"connected"}\n\n');
    const turn = session.send('q');
    await new Promise((r) => setTimeout(r, 5));
    session.load(newConversation('other', 'ns', 'crew'));
    expect(session.view.conversation).toBe(conversation);
    session.stop();
    await turn;
  });
});

describe('noticeFor', () => {
  it('says nothing when there is an answer', () => {
    expect(noticeFor({ kind: 'done' }, true)).toBeUndefined();
    expect(noticeFor({ kind: 'timeout', message: 'slow' }, true)).toBeUndefined();
  });

  it('explains each way a turn can end without one', () => {
    expect(noticeFor({ kind: 'done' }, false)).toMatch(/without an answer/);
    expect(noticeFor({ kind: 'aborted' }, false)).toBe('Stopped.');
    expect(noticeFor({ kind: 'error', message: 'boom' }, false)).toBe('boom');
    expect(noticeFor({ kind: 'timeout', message: 'went quiet' }, false)).toBe('went quiet');
  });
});
