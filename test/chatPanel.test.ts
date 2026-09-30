import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Connection } from '../src/connection';
import type { KubeClient } from '../src/k8s/request';
import { ChatPanel } from '../src/panels/chatPanel';
import { newConversation } from '../src/store/conversation';
import { ConversationStore } from '../src/store/conversations';
import type { HostMessage } from '../src/webview/protocol';
import { FakeTransport, fixture } from './fakes';
import { recorded, resetFake, Uri, type FakePanel } from './vscodeFake';

const crew = { name: 'lab-ops', namespace: 'team-a', ready: true, phase: 'Ready', agents: 2, coordinator: 'lab-ops-coordinator' };
let store: ConversationStore;
let transport: FakeTransport;
let connection: Connection;

/** Lets the panel's asynchronous post (it re-reads the saved list) land. */
const settle = () => new Promise((r) => setTimeout(r, 30));

function lastState(panel: FakePanel): HostMessage {
  return panel.webview.posted.at(-1) as HostMessage;
}

function open(conversation?: Parameters<typeof ChatPanel.show>[4]): FakePanel {
  ChatPanel.show(Uri.file('/ext') as never, connection, crew, store, conversation);
  return recorded.panels.at(-1)!;
}

beforeEach(() => {
  resetFake();
  store = new ConversationStore(fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-panel-')));
  transport = new FakeTransport();
  connection = { source: 'test', context: 'ctx', client: transport as unknown as KubeClient };
});

afterEach(() => {
  for (const p of recorded.panels) p.dispose();
});

describe('ChatPanel', () => {
  it('opens one panel per crew with a nonce-guarded page', () => {
    const panel = open();
    expect(panel.title).toBe('Ask lab-ops');
    const nonce = /nonce-([^']+)'/.exec(panel.webview.html)?.[1];
    expect(nonce).toBeTruthy();
    expect(panel.webview.html).toContain(`<script nonce="${nonce}"`);
    expect(panel.webview.html).toContain("default-src 'none'");
    open();
    expect(recorded.panels).toHaveLength(1);
    expect(panel.revealed).toBe(1);
  });

  it('answers ready with the state, and runs a turn on send, saving it', async () => {
    const panel = open();
    await panel.webview.receive({ type: 'ready' });
    expect(lastState(panel)).toMatchObject({ type: 'state', about: '2 agents, coordinator lab-ops-coordinator', view: { busy: false } });

    transport.responses.push('{"conversationId":"conv-1"}');
    transport.streams.push(fixture('turn1.sse'));
    await panel.webview.receive({ type: 'send', text: 'Which nodes have a GPU?' });
    await settle();
    const states = panel.webview.posted as HostMessage[];
    expect(states.some((s) => s.view.busy)).toBe(true);
    const final = lastState(panel);
    expect(final.view.busy).toBe(false);
    expect(final.view.conversation.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(final.history.map((h) => h.title)).toEqual(['Which nodes have a GPU?']);
  });

  it('starts a new conversation, and opens a saved one', async () => {
    const saved = newConversation('ctx', 'team-a', 'lab-ops', new Date('2026-09-01T00:00:00Z'));
    saved.title = 'An old question';
    await store.save(saved);
    const panel = open();
    await panel.webview.receive({ type: 'open', id: saved.id });
    await settle();
    expect(lastState(panel).view.conversation.title).toBe('An old question');
    await panel.webview.receive({ type: 'new' });
    await settle();
    expect(lastState(panel).view.conversation.messages).toEqual([]);
  });

  it('copies a message and the whole conversation, and exports it as Markdown', async () => {
    const c = newConversation('ctx', 'team-a', 'lab-ops');
    c.title = 'Exported';
    c.messages.push({ role: 'user', content: 'hello there', timestamp: c.startedAt });
    const panel = open(c);
    await panel.webview.receive({ type: 'copyMessage', index: 0 });
    await panel.webview.receive({ type: 'copyMessage', index: 9 });
    await panel.webview.receive({ type: 'copy' });
    expect(recorded.clipboard[0]).toBe('hello there');
    expect(recorded.clipboard[1]).toContain('# Exported');

    const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-export-')), 'out.md');
    recorded.saveDialog = Uri.file(target);
    await panel.webview.receive({ type: 'export' });
    expect(fs.readFileSync(target, 'utf8')).toContain('hello there');
    expect(recorded.info.some((m) => m.includes(target))).toBe(true);
  });

  it('asks the question behind a message again, as a new turn', async () => {
    const c = newConversation('ctx', 'team-a', 'lab-ops');
    c.messages.push(
      { role: 'user', content: 'Which nodes have a GPU?', timestamp: c.startedAt },
      { role: 'assistant', content: 'rig0', timestamp: c.startedAt, durationMs: 42_000 },
    );
    const panel = open(c);
    transport.responses.push('{"conversationId":"conv-1"}', '{"conversationId":"conv-1"}');
    transport.streams.push(fixture('turn1.sse'), fixture('turn1.sse'));
    await panel.webview.receive({ type: 'reask', index: 1 });
    await panel.webview.receive({ type: 'reask', index: 0 });
    const posts = transport.calls.filter((call) => call.method === 'POST').map((call) => (call.body as { message: string }).message);
    expect(posts).toEqual(['Which nodes have a GPU?', 'Which nodes have a GPU?']);
    expect(c.messages.filter((m) => m.role === 'user')).toHaveLength(3);
  });

  it('does not ask when there is no question behind the message', async () => {
    const c = newConversation('ctx', 'team-a', 'lab-ops');
    c.messages.push({ role: 'system', content: 'note', timestamp: c.startedAt });
    const panel = open(c);
    await panel.webview.receive({ type: 'reask', index: 0 });
    await panel.webview.receive({ type: 'reask', index: 7 });
    expect(transport.calls).toEqual([]);
  });

  it('does not ask again while a turn runs', async () => {
    const c = newConversation('ctx', 'team-a', 'lab-ops');
    const panel = open(c);
    transport.holdOpen = true;
    transport.responses.push('{"conversationId":"conv-1"}');
    transport.streams.push('data: {"type":"connected"}\n\n');
    const turn = panel.webview.receive({ type: 'send', text: 'first' });
    await settle();
    await panel.webview.receive({ type: 'reask', index: 0 });
    await panel.webview.receive({ type: 'stop' });
    await turn;
    expect(transport.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('ignores a message of a type it does not know', async () => {
    const panel = open();
    await panel.webview.receive({ type: 'launch-missiles' });
    expect(recorded.errors).toEqual([]);
  });

  it('renames the conversation, keeping the name when the dialog is cancelled', async () => {
    const c = newConversation('ctx', 'team-a', 'lab-ops');
    c.title = 'Which nodes have a GPU?';
    c.messages.push({ role: 'user', content: 'Which nodes have a GPU?', timestamp: c.startedAt });
    await store.save(c);
    const panel = open(c);
    recorded.inputs.push('  GPU inventory  ');
    await panel.webview.receive({ type: 'rename' });
    await settle();
    expect(lastState(panel).view.conversation.title).toBe('GPU inventory');
    expect(lastState(panel).history.map((h) => h.title)).toEqual(['GPU inventory']);
    expect((await store.load(c)).title).toBe('GPU inventory');

    recorded.inputs.push(undefined, '   ');
    await panel.webview.receive({ type: 'rename' });
    await panel.webview.receive({ type: 'rename' });
    expect((await store.load(c)).title).toBe('GPU inventory');
  });

  it('deletes the conversation after asking, and closes the panel', async () => {
    const c = newConversation('ctx', 'team-a', 'lab-ops');
    c.title = 'Old';
    c.messages.push({ role: 'user', content: 'q', timestamp: c.startedAt });
    await store.save(c);
    const panel = open(c);

    recorded.warningAnswers.push(undefined);
    await panel.webview.receive({ type: 'delete' });
    expect(recorded.warnings).toEqual(['Delete this conversation?']);
    expect(fs.existsSync(store.file(c))).toBe(true);
    expect(ChatPanel.active).toBeDefined();

    recorded.warningAnswers.push('Delete');
    await panel.webview.receive({ type: 'delete' });
    expect(fs.existsSync(store.file(c))).toBe(false);
    expect(ChatPanel.active).toBeUndefined();
    open(c);
    expect(recorded.panels).toHaveLength(2);
  });

  it('keeps the panel open and reports it when the delete fails', async () => {
    const c = newConversation('ctx', 'team-a', 'lab-ops');
    c.messages.push({ role: 'user', content: 'q', timestamp: c.startedAt });
    await store.save(c);
    store.remove = () => Promise.reject(new Error('EBUSY: resource busy'));
    const panel = open(c);
    recorded.warningAnswers.push('Delete');
    await panel.webview.receive({ type: 'delete' });
    expect(recorded.errors).toEqual(['CrewForge: EBUSY: resource busy']);
    expect(ChatPanel.active).toBeDefined();
    expect(fs.existsSync(store.file(c))).toBe(true);
  });

  it('does not delete while a turn runs', async () => {
    const c = newConversation('ctx', 'team-a', 'lab-ops');
    const panel = open(c);
    transport.holdOpen = true;
    transport.responses.push('{"conversationId":"conv-1"}');
    transport.streams.push('data: {"type":"connected"}\n\n');
    const turn = panel.webview.receive({ type: 'send', text: 'first' });
    await settle();
    recorded.warningAnswers.push('Delete');
    await panel.webview.receive({ type: 'delete' });
    expect(recorded.info).toEqual(['Stop the turn before deleting the conversation.']);
    expect(ChatPanel.active).toBeDefined();
    await panel.webview.receive({ type: 'stop' });
    await turn;
    expect(fs.existsSync(store.file(c))).toBe(true);
  });

  it('does nothing when the export dialog is cancelled', async () => {
    const panel = open();
    await panel.webview.receive({ type: 'export' });
    expect(recorded.info).toEqual([]);
  });

  it('opens the dashboard, or its setting when none is set', async () => {
    const panel = open();
    await panel.webview.receive({ type: 'openDashboard' });
    expect(recorded.executed).toEqual([{ id: 'workbench.action.openSettings', args: ['crewforge.dashboardUrl'] }]);
    recorded.settings.set('crewforge.dashboardUrl', ' https://example.org/dashboard/ ');
    await panel.webview.receive({ type: 'openDashboard' });
    expect(recorded.opened).toEqual(['https://example.org/dashboard/']);
  });

  it('reports a failing action as an error message, and stops a turn', async () => {
    const panel = open();
    await panel.webview.receive({ type: 'open', id: 'missing' });
    expect(recorded.errors[0]).toMatch(/^CrewForge: /);
    await panel.webview.receive({ type: 'stop' });
  });

  it('is the active panel until disposed', () => {
    const panel = open();
    expect(ChatPanel.active).toBeDefined();
    panel.dispose();
    expect(ChatPanel.active).toBeUndefined();
  });
});
