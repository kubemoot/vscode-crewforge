import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection } from '../src/connection';
import type { KubeClient } from '../src/k8s/request';
import { ChatPanel, dashboardThreadUrl, type ChatLinks } from '../src/panels/chatPanel';
import type { Located } from '../src/source/locate';
import { obj } from './fakeCluster';
import { newConversation } from '../src/store/conversation';
import { ConversationStore } from '../src/store/conversations';
import type { StateMessage } from '../src/webview/protocol';
import { FakeTransport, fixture } from './fakes';
import { recorded, resetFake, Uri, type FakePanel } from './vscodeFake';

const crew = { name: 'lab-ops', namespace: 'team-a', ready: true, phase: 'Ready', agents: 2, coordinator: 'lab-ops-coordinator' };
let store: ConversationStore;
let transport: FakeTransport;
let connection: Connection;

/** Lets the panel's asynchronous post (it re-reads the saved list) land. */
const settle = () => new Promise((r) => setTimeout(r, 30));

function lastState(panel: FakePanel): StateMessage {
  return panel.webview.posted.at(-1) as StateMessage;
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
    expect(ChatPanel.states()).toEqual([{ title: 'Ask lab-ops', ready: false, shown: undefined, errors: [] }]);
    await panel.webview.receive({ type: 'ready' });
    expect(lastState(panel)).toMatchObject({ type: 'state', about: '2 agents, coordinator lab-ops-coordinator', view: { busy: false } });
    await panel.webview.receive({ type: 'shown', text: 'lab-ops team-a' });
    await panel.webview.receive({ type: 'shown', text: 7 });
    await panel.webview.receive({ type: 'error', message: 'boom' });
    expect(ChatPanel.states()[0]).toEqual({ title: 'Ask lab-ops', ready: true, shown: '', errors: ['boom'] });
    await panel.webview.receive({ type: 'shown', text: 'lab-ops team-a' });
    expect(ChatPanel.states()[0].shown).toBe('lab-ops team-a');

    transport.responses.push('{"conversationId":"conv-1"}');
    transport.streams.push(fixture('turn1.sse'));
    await panel.webview.receive({ type: 'send', text: 'Which nodes have a GPU?' });
    // The turn streams on its own; wait for it to end rather than for a fixed time.
    await vi.waitFor(() => expect(lastState(panel).view.busy).toBe(false), { timeout: 5000 });
    const states = panel.webview.posted as StateMessage[];
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

  it('holds text for the input until the page is ready, then sends it once', async () => {
    const panel = open();
    const chat = ChatPanel.active!;
    chat.prefill('first');
    chat.prefill('second');
    expect(panel.webview.posted).toEqual([]);
    await panel.webview.receive({ type: 'ready' });
    const prefills = () => panel.webview.posted.filter((m) => (m as { type: string }).type === 'prefill');
    expect(prefills()).toEqual([{ type: 'prefill', text: 'second' }]);
    chat.prefill('later');
    await settle();
    expect(prefills().at(-1)).toEqual({ type: 'prefill', text: 'later' });
    await panel.webview.receive({ type: 'ready' });
    expect(prefills()).toHaveLength(2);
  });

  it('sends no text to a panel that has closed', async () => {
    const panel = open();
    const chat = ChatPanel.active!;
    await panel.webview.receive({ type: 'ready' });
    panel.dispose();
    chat.prefill('too late');
    await settle();
    expect(panel.webview.posted.some((m) => (m as { type: string }).type === 'prefill')).toBe(false);
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

describe('ChatPanel links into the workspace and the dashboard', () => {
  const place = (kind: string, name: string, file?: string, line = 0): Located => ({ manifest: obj(kind, name, 'team-a'), file, line });
  const sources = new Map([
    ['lab-ops-coordinator', [place('Agent', 'lab-ops-coordinator', '/w/lab/templates/agents.yaml', 3), place('PromptModule', 'rules', '/w/lab/templates/prompts.yaml', 9)]],
    ['k8s', [place('Agent', 'k8s', '/w/lab/templates/agents.yaml', 20)]],
    ['ghost', [place('Agent', 'ghost')]],
  ]);
  const links: ChatLinks = { agentSources: async () => sources };
  const withLinks = (l: ChatLinks = links, conversation?: Parameters<typeof ChatPanel.show>[4]) => {
    ChatPanel.show(Uri.file('/ext') as never, connection, crew, store, conversation, l);
    return recorded.panels.at(-1)!;
  };

  it('tells the page which agents link to their source, and whether the dashboard is set', async () => {
    const panel = withLinks();
    await settle();
    expect(lastState(panel).links).toEqual({ agents: ['lab-ops-coordinator', 'k8s', 'ghost'], dashboard: false });
    recorded.settings.set('crewforge.dashboardUrl', 'http://localhost:8080/dashboard/');
    await panel.webview.receive({ type: 'ready' });
    expect(lastState(panel).links.dashboard).toBe(true);
    const failing = withLinks({ agentSources: async () => Promise.reject(new Error('no workspace')) }, undefined);
    expect(failing).toBe(panel);
    for (const p of recorded.panels) p.dispose();
    const fresh = withLinks({ agentSources: async () => Promise.reject(new Error('no workspace')) });
    await settle();
    expect(lastState(fresh).links.agents).toEqual([]);
  });

  it("opens an agent's only definition, or the part the developer picks, at its line", async () => {
    const panel = withLinks();
    await settle();
    await panel.webview.receive({ type: 'openAgentSource', agent: 'k8s' });
    expect(recorded.executed.at(-1)).toMatchObject({ id: 'vscode.open', args: [{ fsPath: '/w/lab/templates/agents.yaml' }, { selection: { startLine: 20 } }] });
    let offered: { label: string; description?: string }[] = [];
    recorded.quickPicks.push((items: typeof offered) => ((offered = items), items[1]));
    await panel.webview.receive({ type: 'openAgentSource', agent: 'lab-ops-coordinator' });
    expect(offered.map((i) => [i.label, i.description])).toEqual([
      ['Agent lab-ops-coordinator', '/w/lab/templates/agents.yaml:4'],
      ['PromptModule rules', '/w/lab/templates/prompts.yaml:10'],
    ]);
    expect(recorded.executed.at(-1)).toMatchObject({ args: [{ fsPath: '/w/lab/templates/prompts.yaml' }, { selection: { startLine: 9 } }] });
    recorded.quickPicks.push(undefined);
    await panel.webview.receive({ type: 'openAgentSource', agent: 'lab-ops-coordinator' });
    await panel.webview.receive({ type: 'openAgentSource', agent: 'ghost' });
    await panel.webview.receive({ type: 'openAgentSource', agent: 'nobody' });
    await panel.webview.receive({ type: 'openAgentSource', agent: 42 });
    expect(recorded.executed).toHaveLength(2);
  });

  it('opens a turn in the dashboard by its thread, only when a dashboard is set and the thread is known', async () => {
    const c = newConversation('ctx', 'team-a', 'lab-ops');
    c.messages.push({ role: 'user', content: 'q', timestamp: c.startedAt }, { role: 'assistant', content: 'a', timestamp: c.startedAt, threadId: 'th-1' });
    const panel = withLinks(links, c);
    await panel.webview.receive({ type: 'openTurnInDashboard', index: 1 });
    expect(recorded.opened).toEqual([]);
    recorded.settings.set('crewforge.dashboardUrl', 'http://localhost:8080/dashboard/');
    await panel.webview.receive({ type: 'openTurnInDashboard', index: 1 });
    await panel.webview.receive({ type: 'openTurnInDashboard', index: 0 });
    await panel.webview.receive({ type: 'openTurnInDashboard', index: '1' });
    expect(recorded.opened).toEqual(['http://localhost:8080/dashboard/discussions?thread=th-1&namespace=team-a&crew=lab-ops']);
    expect(dashboardThreadUrl('https://d.example', { namespace: 'n s', name: 'c' }, 'a&b')).toBe('https://d.example/discussions?thread=a%26b&namespace=n+s&crew=c');
  });

  it('asks the last question again after a redeploy, unless there is none or a turn runs', async () => {
    const c = newConversation('ctx', 'team-a', 'lab-ops');
    c.messages.push({ role: 'user', content: 'Which nodes have a GPU?', timestamp: c.startedAt }, { role: 'assistant', content: 'rig0', timestamp: c.startedAt });
    const panel = withLinks(links, c);
    expect(ChatPanel.find('ctx', crew)).toBeDefined();
    expect(ChatPanel.find('other', crew)).toBeUndefined();
    transport.responses.push('{"conversationId":"conv-1"}');
    transport.streams.push(fixture('turn1.sse'));
    expect(await ChatPanel.find('ctx', crew)!.reaskLast()).toBe(true);
    expect(panel.revealed).toBe(1);
    expect(transport.calls.filter((call) => call.method === 'POST').map((call) => (call.body as { message: string }).message)).toEqual(['Which nodes have a GPU?']);
    transport.holdOpen = true;
    transport.responses.push('{"conversationId":"conv-1"}');
    transport.streams.push('data: {"type":"connected"}\n\n');
    const turn = ChatPanel.find('ctx', crew)!.reaskLast();
    await settle();
    expect(await ChatPanel.find('ctx', crew)!.reaskLast()).toBe(false);
    await panel.webview.receive({ type: 'stop' });
    await turn;
    panel.dispose();
    const empty = withLinks(links);
    expect(await ChatPanel.find('ctx', crew)!.reaskLast()).toBe(false);
    empty.dispose();
  });
});
