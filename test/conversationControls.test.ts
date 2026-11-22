import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection } from '../src/connection';
import { ACCESS_REASON_HEADER } from '../src/discussion/controls';
import { KubeError, type KubeClient } from '../src/k8s/request';
import { ChatPanel } from '../src/panels/chatPanel';
import { isConversationAction } from '../src/panels/conversationActions';
import { newConversation, type Conversation } from '../src/store/conversation';
import { ConversationStore } from '../src/store/conversations';
import type { StateMessage } from '../src/webview/protocol';
import { FakeTransport } from './fakes';
import { recorded, resetFake, Uri, type FakePanel } from './vscodeFake';

const crew = { name: 'lab-ops', namespace: 'team-a', ready: true, phase: 'Ready', agents: 2, coordinator: 'lab-ops-coordinator' };
const REASON_REQUIRED = '{"error":"acting on another caller\'s conversations needs a reason of 1 to 200 characters in the Kubemoot-Access-Reason header"}';

let store: ConversationStore;
let gateway: GatewayFake;

/** A gateway transport whose event stream a test opens when it is ready, and that records being closed. */
class GatewayFake extends FakeTransport {
  closed = false;
  /** Event streams are held until a test calls `release`. */
  private gate: Promise<void>;
  release!: () => void;
  eventText: string[] = [];
  eventFailures: Error[] = [];
  /** How many event streams close right after their text, as a dropped connection does. */
  drops = 0;

  constructor() {
    super();
    this.gate = new Promise((resolve) => (this.release = resolve));
  }

  async stream(streamPath: string, onChunk: (text: string) => void, signal: AbortSignal): Promise<void> {
    this.calls.push({ method: 'GET', path: streamPath });
    await this.gate;
    const failure = this.eventFailures.shift();
    if (failure) throw failure;
    const text = this.eventText.shift();
    if (text) onChunk(text);
    if (text && this.drops > 0) {
      this.drops--;
      return;
    }
    await new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener('abort', () => resolve())));
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

function failure(status: number, body: string, message = 'refused'): KubeError {
  return new KubeError(message, status, `POST /x returned ${status} (${body})`);
}

function lastState(panel: FakePanel): StateMessage {
  return panel.webview.posted.filter((m) => (m as StateMessage).type === 'state').at(-1) as StateMessage;
}

async function saved(id: string, conversationId: string | undefined, title = 'Which nodes?'): Promise<Conversation> {
  const c = newConversation('ctx', 'team-a', 'lab-ops', new Date(`2026-11-21T01:00:0${id}Z`));
  c.title = title;
  c.conversationId = conversationId;
  c.messages.push({ role: 'user', content: title, timestamp: c.startedAt });
  await store.save(c);
  return c;
}

function open(conversation?: Conversation): FakePanel {
  ChatPanel.show(Uri.file('/ext') as never, connection(), crew, store, conversation);
  return recorded.panels.at(-1)!;
}

function connection(): Connection {
  return { source: 'test', context: 'ctx', client: {} as KubeClient, gateway: () => gateway };
}

const act = (panel: FakePanel, action: string, id?: string) => panel.webview.receive({ type: 'conversationAction', action, ...(id ? { id } : {}) });

beforeEach(() => {
  resetFake();
  store = new ConversationStore(fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-controls-')));
  gateway = new GatewayFake();
});

afterEach(() => {
  gateway.release();
  for (const p of recorded.panels) p.dispose();
});

describe('conversation actions', () => {
  it.each([
    ['stop', 'Stopped'],
    ['pause', 'Paused'],
    ['resume', 'Resumed'],
  ])('%s sends the control for the conversation shown and says what it reached', async (action, said) => {
    const panel = open(await saved('1', 'conv-1'));
    gateway.responses.push(JSON.stringify({ conversationId: 'conv-1', action, threads: ['t1', 't2'] }));
    await act(panel, action);
    expect(gateway.calls.filter((c) => c.method === 'POST')).toEqual([{ method: 'POST', path: `/api/v1/discussions/lab-ops/conv-1/${action}`, body: undefined }]);
    expect(recorded.info).toContain(`${said} "Which nodes?" (2 running turns).`);
  });

  it('tells the page which conversations it paused, until they are resumed, stopped, or the person declines', async () => {
    const panel = open(await saved('1', 'conv-1'));
    const paused = () => (panel.webview.posted.at(-1) as { paused: string[] }).paused;
    const reply = (action: string) => gateway.responses.push(JSON.stringify({ conversationId: 'conv-1', action, threads: ['t1'] }));
    reply('pause');
    await act(panel, 'pause');
    expect(paused()).toEqual(['conv-1']);
    reply('resume');
    await act(panel, 'resume');
    expect(paused()).toEqual([]);
    reply('pause');
    await act(panel, 'pause');
    reply('stop');
    await act(panel, 'stop');
    expect(paused()).toEqual([]);
  });

  it('says one running turn in the singular', async () => {
    const panel = open(await saved('1', 'conv-1'));
    gateway.responses.push('{"conversationId":"conv-1","action":"stop","threads":["t1"]}');
    await act(panel, 'stop');
    expect(recorded.info).toContain('Stopped "Which nodes?" (1 running turn).');
  });

  it('acts on a saved conversation from the list, not the one shown', async () => {
    const shown = await saved('1', 'conv-1', 'Shown');
    const other = await saved('2', 'conv-2', 'Other');
    const panel = open(shown);
    gateway.responses.push('{"conversationId":"conv-2","action":"pause","threads":["t9"]}');
    await act(panel, 'pause', other.id);
    expect(gateway.calls.at(-1)?.path).toBe('/api/v1/discussions/lab-ops/conv-2/pause');
    expect(recorded.info).toContain('Paused "Other" (1 running turn).');
  });

  it('ignores an action the page made up, and tells a conversation the crew never saw to ask first', async () => {
    const panel = open(await saved('1', undefined));
    await act(panel, 'explode');
    expect(recorded.info).toEqual([]);
    await act(panel, 'stop');
    expect(recorded.info).toEqual(['This conversation has not reached the crew yet. Ask the crew something first.']);
    expect(gateway.calls.filter((c) => c.method === 'POST')).toEqual([]);
    expect(isConversationAction('erase')).toBe(true);
    expect(isConversationAction(7)).toBe(false);
  });

  it.each([
    [401, 'The crew lab-ops did not accept your Kubernetes token.', /did not accept your Kubernetes token/],
    [403, 'The crew lab-ops refused your identity.', /refused your identity/],
    [404, 'Conversation not found on crew lab-ops.', /Conversation not found on crew lab-ops\.( To stop another caller's conversation you need the kubemoot-conversation-controller role\.)?/],
  ])('shows a %i in plain words', async (status, message, shown) => {
    const panel = open(await saved('1', 'conv-1'));
    gateway.responses.push(failure(status, '{"error":"x"}', message));
    await act(panel, 'stop');
    expect(recorded.errors.at(-1)).toMatch(shown);
    expect(recorded.errors.at(-1)).toMatch(/^CrewForge: /);
  });

  it('shows a 404 with the role an operator needs, a 409 with nothing running, and a 500', async () => {
    const panel = open(await saved('1', 'conv-1'));
    gateway.responses.push(failure(404, '{"error":"conversation not found"}', 'Conversation not found on crew lab-ops.'));
    await act(panel, 'stop');
    expect(recorded.errors.at(-1)).toContain('you need the kubemoot-conversation-controller role');
    gateway.responses.push(failure(409, '{"error":"the conversation has no running discussion"}'));
    await act(panel, 'resume');
    expect(recorded.errors.at(-1)).toContain('The conversation has no turn running to resume');
    gateway.responses.push(failure(500, '{"error":"boom"}'));
    await act(panel, 'pause');
    expect(recorded.errors.at(-1)).toContain('The crew lab-ops failed to pause the conversation.');
  });

  it("asks for a reason when the conversation is another caller's, and sends it in the header", async () => {
    const panel = open(await saved('1', 'conv-1'));
    gateway.responses.push(failure(400, REASON_REQUIRED), '{"conversationId":"conv-1","action":"stop","threads":["t1"]}');
    recorded.inputs.push('  customer asked us to halt it  ');
    await act(panel, 'stop');
    const posts = gateway.calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[0].headers).toBeUndefined();
    expect(posts[1].headers).toEqual({ [ACCESS_REASON_HEADER]: 'customer asked us to halt it' });
    expect(recorded.inputTitles[0]).toContain('Reason to stop "Which nodes?"');
    expect(recorded.inputTitles[0]).toContain('kubemoot-conversation-controller');
    expect(recorded.inputTitles[0]).toContain('1 to 200 characters');
    expect(recorded.info.at(-1)).toContain('Stopped');
  });

  it('does nothing more when the reason prompt is cancelled or the reason is not allowed', async () => {
    const panel = open(await saved('1', 'conv-1'));
    gateway.responses.push(failure(400, REASON_REQUIRED));
    await act(panel, 'pause');
    expect(gateway.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(recorded.errors).toEqual([]);
    gateway.responses.push(failure(400, REASON_REQUIRED));
    recorded.inputs.push('x'.repeat(201));
    await act(panel, 'pause');
    expect(gateway.calls.filter((c) => c.method === 'POST')).toHaveLength(2);
  });

  it('shows the error when the gateway refuses the reason it was given', async () => {
    const panel = open(await saved('1', 'conv-1'));
    gateway.responses.push(failure(400, REASON_REQUIRED), failure(400, REASON_REQUIRED));
    recorded.inputs.push('because');
    await act(panel, 'stop');
    expect(gateway.calls.filter((c) => c.method === 'POST')).toHaveLength(2);
    expect(recorded.errors.at(-1)).toContain('give a reason');
  });
});

describe('delete from the crew', () => {
  const erased = {
    conversationId: 'conv-1',
    threads: ['t1'],
    deleted: { history: 1, owner: 1, discussionMessages: 9, workspaceObjects: 2, coordinatorEvents: 3, scheduled: 0, memoryFacts: 1 },
    kept: ['logs and backups: erasing from NATS does not erase them'],
  };

  it('asks first, deletes, and shows the report with what the crew cannot remove', async () => {
    const panel = open(await saved('1', 'conv-1'));
    gateway.responses.push(JSON.stringify(erased));
    recorded.warningAnswers.push('Delete from crew');
    await act(panel, 'erase');
    expect(recorded.warnings).toEqual(['Delete "Which nodes?" from the crew?']);
    expect(recorded.warningDetails[0]).toContain('The copy on this computer stays');
    expect(gateway.calls.filter((c) => c.method === 'DELETE')).toEqual([{ method: 'DELETE', path: '/api/v1/discussions/lab-ops/conv-1', body: undefined }]);
    expect(recorded.info).toEqual(['Deleted the conversation from the crew: 17 items removed across 1 turn.']);
    expect(recorded.infoDetails[0]).toContain('agent messages: 9');
    expect(recorded.infoDetails[0]).toContain('Not removed:');
    expect(recorded.infoDetails[0]).toContain('logs and backups');
  });

  it('does nothing when the person does not confirm', async () => {
    const panel = open(await saved('1', 'conv-1'));
    await act(panel, 'erase');
    expect(gateway.calls.filter((c) => c.method === 'DELETE')).toEqual([]);
    expect(recorded.info).toEqual([]);
  });

  it('offers Stop and delete when the conversation is running, and deletes with force once chosen', async () => {
    const panel = open(await saved('1', 'conv-1'));
    gateway.responses.push(failure(409, '{"error":"the conversation has a running discussion; stop it first, or pass force=true"}'), JSON.stringify(erased));
    recorded.warningAnswers.push('Delete from crew', 'Stop and delete');
    await act(panel, 'erase');
    expect(recorded.warnings).toEqual(['Delete "Which nodes?" from the crew?', '"Which nodes?" is still running.']);
    expect(gateway.calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(['/api/v1/discussions/lab-ops/conv-1', '/api/v1/discussions/lab-ops/conv-1?force=true']);
    expect(recorded.info[0]).toContain('Deleted the conversation');
  });

  it('keeps a running conversation when Stop and delete is declined', async () => {
    const panel = open(await saved('1', 'conv-1'));
    gateway.responses.push(failure(409, '{"error":"running"}'));
    recorded.warningAnswers.push('Delete from crew');
    await act(panel, 'erase');
    expect(gateway.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
    expect(recorded.info).toEqual([]);
    expect(recorded.errors).toEqual([]);
  });

  it('asks for a reason for another caller\'s conversation, then for Stop and delete, and sends both', async () => {
    const panel = open(await saved('1', 'conv-1'));
    gateway.responses.push(failure(400, REASON_REQUIRED), failure(409, '{"error":"running"}'), JSON.stringify(erased));
    recorded.warningAnswers.push('Delete from crew', 'Stop and delete');
    recorded.inputs.push('retention request 8812');
    await act(panel, 'erase');
    const deletes = gateway.calls.filter((c) => c.method === 'DELETE');
    expect(deletes.map((c) => c.path)).toEqual(['/api/v1/discussions/lab-ops/conv-1', '/api/v1/discussions/lab-ops/conv-1', '/api/v1/discussions/lab-ops/conv-1?force=true']);
    expect(deletes[0].headers).toBeUndefined();
    expect(deletes[1].headers).toEqual({ [ACCESS_REASON_HEADER]: 'retention request 8812' });
    expect(deletes[2].headers).toEqual({ [ACCESS_REASON_HEADER]: 'retention request 8812' });
    expect(recorded.inputTitles[0]).toContain('Reason to delete "Which nodes?"');
  });

  it('stops when the reason prompt is cancelled', async () => {
    const panel = open(await saved('1', 'conv-1'));
    gateway.responses.push(failure(400, REASON_REQUIRED));
    recorded.warningAnswers.push('Delete from crew');
    await act(panel, 'erase');
    expect(gateway.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
    expect(recorded.info).toEqual([]);
  });

  it.each([
    [401, 'The crew did not accept your Kubernetes token.'],
    [403, 'The crew refused your identity.'],
  ])('shows a %i', async (status, message) => {
    const panel = open(await saved('1', 'conv-1'));
    gateway.responses.push(failure(status, '{"error":"x"}', message));
    recorded.warningAnswers.push('Delete from crew');
    await act(panel, 'erase');
    expect(recorded.errors.at(-1)).toBe(`CrewForge: ${message}`);
  });

  it('shows a 404 for a conversation that is not there, and a 500 with the stores that failed', async () => {
    const panel = open(await saved('1', 'conv-1'));
    gateway.responses.push(failure(404, '{"error":"conversation not found"}', 'Conversation not found on crew lab-ops.'));
    recorded.warningAnswers.push('Delete from crew');
    await act(panel, 'erase');
    expect(recorded.errors.at(-1)).toContain('Conversation not found on crew lab-ops.');
    gateway.responses.push(failure(500, '{"conversationId":"conv-1","deleted":{},"kept":[],"failed":["workspace"]}'));
    recorded.warningAnswers.push('Delete from crew');
    await act(panel, 'erase');
    expect(recorded.errors.at(-1)).toContain('These stores could not be cleared: workspace.');
    expect(recorded.info).toEqual([]);
  });

  it('shows an erasure the gateway reports as something other than JSON as an error', async () => {
    const panel = open(await saved('1', 'conv-1'));
    gateway.responses.push('ok');
    recorded.warningAnswers.push('Delete from crew');
    await act(panel, 'erase');
    expect(recorded.errors.at(-1)).toContain('not JSON');
  });
});

describe('live updates', () => {
  const connected = (id: string) => `id: ${id}\ndata: {"type":"connected"}\n\n`;
  const news = (id: string, conversationId: string) => `id: ${id}\ndata: ${JSON.stringify({ type: 'conversation_updated', conversationId, reason: 'answer', threadId: 't1' })}\n\n`;
  const freshIn = (panel: FakePanel) => lastState(panel).fresh;

  it('subscribes once for the crew, through the gateway client', async () => {
    gateway.release();
    open(await saved('1', 'conv-1'));
    await vi.waitFor(() => expect(gateway.calls.filter((c) => c.method === 'GET')).toHaveLength(1));
    expect(gateway.calls.find((c) => c.method === 'GET')?.path).toBe('/api/v1/discussions/lab-ops/events');
    open();
    expect(gateway.calls.filter((c) => c.method === 'GET')).toHaveLength(1);
  });

  it('does not subscribe when the crew is reached without a gateway client', async () => {
    ChatPanel.show(Uri.file('/ext') as never, { source: 't', context: 'ctx', client: new FakeTransport() as unknown as KubeClient }, crew, store, await saved('1', 'conv-1'));
    gateway.release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(gateway.calls).toEqual([]);
  });

  it('marks a conversation that has something new, and clears the mark when it is opened', async () => {
    const other = await saved('2', 'conv-2', 'Other');
    const shown = await saved('1', 'conv-1', 'Shown');
    gateway.eventText.push(connected('4') + news('5', 'conv-2'));
    const panel = open(shown);
    await panel.webview.receive({ type: 'ready' });
    gateway.release();
    await vi.waitFor(() => expect(freshIn(panel)).toEqual(['conv-2']));
    expect(lastState(panel).history.find((h) => h.conversationId === 'conv-2')).toBeTruthy();
    await panel.webview.receive({ type: 'open', id: other.id });
    await vi.waitFor(() => expect(lastState(panel).view.conversation.conversationId).toBe('conv-2'));
    expect(freshIn(panel)).toEqual([]);
  });

  it('reads the shown conversation again from the store when the news names it', async () => {
    const shown = await saved('1', 'conv-1', 'Shown');
    gateway.eventText.push(news('5', 'conv-1'));
    const panel = open(shown);
    await panel.webview.receive({ type: 'ready' });
    const onDisk = { ...shown, messages: [...shown.messages, { role: 'assistant' as const, content: 'A late answer', timestamp: shown.startedAt }] };
    await store.save(onDisk);
    gateway.release();
    await vi.waitFor(() => expect(lastState(panel).view.conversation.messages).toHaveLength(2));
    expect(freshIn(panel)).toEqual(['conv-1']);
    await panel.webview.receive({ type: 'send', text: '' });
    expect(freshIn(panel)).toEqual(['conv-1']);
  });

  it('marks the shown conversation even when it was never saved, and a question clears the mark', async () => {
    const unsaved = newConversation('ctx', 'team-a', 'lab-ops');
    unsaved.conversationId = 'conv-9';
    gateway.eventText.push(news('5', 'conv-9'));
    const panel = open(unsaved);
    await panel.webview.receive({ type: 'ready' });
    gateway.release();
    await vi.waitFor(() => expect(freshIn(panel)).toEqual(['conv-9']));
    gateway.hangRequests = true;
    const sending = panel.webview.receive({ type: 'send', text: 'and now?' });
    await vi.waitFor(() => expect(lastState(panel).view.busy).toBe(true));
    expect(freshIn(panel)).toEqual([]);
    await panel.webview.receive({ type: 'stop' });
    await sending;
  });

  it('does not mark the conversation a running turn is streaming', async () => {
    const shown = await saved('1', 'conv-1', 'Shown');
    gateway.eventText.push(news('5', 'conv-1') + news('6', 'conv-2'));
    const panel = open(shown);
    await panel.webview.receive({ type: 'ready' });
    gateway.hangRequests = true;
    const sending = panel.webview.receive({ type: 'send', text: 'again' });
    await vi.waitFor(() => expect(lastState(panel).view.busy).toBe(true));
    gateway.release();
    await vi.waitFor(() => expect(freshIn(panel)).toEqual(['conv-2']));
    await panel.webview.receive({ type: 'stop' });
    await sending;
  });

  it('resumes after the last event id when the stream drops, and refreshes on the news that follows', async () => {
    const shown = await saved('1', 'conv-1', 'Shown');
    gateway.drops = 1;
    gateway.eventText.push(connected('9'), news('12', 'conv-1'));
    const panel = open(shown);
    await panel.webview.receive({ type: 'ready' });
    await store.save({ ...shown, messages: [...shown.messages, { role: 'assistant' as const, content: 'A late answer', timestamp: shown.startedAt }] });
    gateway.release();
    await vi.waitFor(() => expect(freshIn(panel)).toEqual(['conv-1']));
    const paths = gateway.calls.filter((c) => c.method === 'GET').map((c) => c.path);
    expect(paths).toEqual(['/api/v1/discussions/lab-ops/events', '/api/v1/discussions/lab-ops/events?lastEventId=9']);
    expect(lastState(panel).view.conversation.messages).toHaveLength(2);
  });

  it('says once that it stopped listening, unless the gateway is an older one without the stream', async () => {
    gateway.eventFailures.push(new KubeError('forbidden', 403));
    open(await saved('1', 'conv-1'));
    gateway.release();
    await vi.waitFor(() => expect(recorded.warnings).toHaveLength(1));
    expect(recorded.warnings[0]).toContain('CrewForge stopped listening for new activity in lab-ops: forbidden');
    for (const p of recorded.panels) p.dispose();

    resetFake();
    gateway = new GatewayFake();
    gateway.eventFailures.push(new KubeError('missing', 404));
    open(await saved('1', 'conv-1'));
    gateway.release();
    await vi.waitFor(() => expect(gateway.calls.filter((c) => c.method === 'GET')).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(recorded.warnings).toEqual([]);
  });

  it('stops listening and closes the gateway when the panel is closed', async () => {
    const panel = open(await saved('1', 'conv-1'));
    gateway.release();
    await vi.waitFor(() => expect(gateway.calls.some((c) => c.method === 'GET')).toBe(true));
    panel.dispose();
    expect(gateway.closed).toBe(true);
    gateway.eventText.push(news('5', 'conv-1'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(gateway.calls.filter((c) => c.method === 'GET')).toHaveLength(1);
  });
});
