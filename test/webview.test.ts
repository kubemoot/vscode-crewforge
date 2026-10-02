// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KubeClient } from '../src/k8s/request';
import { ChatPanel } from '../src/panels/chatPanel';
import { newConversation, type Conversation } from '../src/store/conversation';
import { ConversationStore } from '../src/store/conversations';
import type { StateMessage, WebviewMessage } from '../src/webview/protocol';
import { META_SEPARATOR } from '../src/webview/render';
import { recorded, resetFake, Uri } from './vscodeFake';

let sent: WebviewMessage[];
/** The text the page reported after each render. */
let shown: string[] = [];
/** What the host says the page may link to; a test changes it before posting. */
let links: StateMessage['links'];
let state: unknown;

/** Loads the page ChatPanel generates, then runs the webview script against it. */
async function loadPage(): Promise<void> {
  resetFake();
  ChatPanel.show(Uri.file('/ext') as never, { source: 't', context: 'ctx', client: {} as KubeClient }, { name: 'lab-ops', namespace: 'team-a', ready: true, phase: 'Ready' }, new ConversationStore('/tmp/none'));
  const html = recorded.panels.at(-1)!.webview.html;
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)![1].replace(/<script[\s\S]*<\/script>/, '');
  sent = [];
  shown = [];
  state = undefined;
  links = { agents: [], dashboard: false };
  availability = undefined;
  (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: (m: WebviewMessage) => (m.type === 'shown' ? shown.push(m.text) : sent.push(m)),
    getState: () => state,
    setState: (s: unknown) => (state = s),
  });
  vi.resetModules();
  await import('../src/webview/main');
}

/** What the host says about the crew's availability; a test changes it before posting. */
let availability: StateMessage['availability'];

function stateMessage(conversation: Conversation, extra: Partial<StateMessage['view']> = {}, history: StateMessage['history'] = []): StateMessage {
  return { type: 'state', view: { conversation, busy: false, ...extra }, crewTitle: conversation.crewName, history, about: '2 agents', links, availability };
}

/** Delivers a message as VS Code's host frame does: with the page's own origin. */
function post(conversation: Conversation, extra: Partial<StateMessage['view']> = {}, history: StateMessage['history'] = []): void {
  window.dispatchEvent(new MessageEvent('message', { data: stateMessage(conversation, extra, history), origin: window.origin }));
}

const $ = (id: string) => document.getElementById(id)!;

beforeEach(loadPage);
afterEach(() => {
  for (const p of recorded.panels) p.dispose();
  vi.useRealTimers();
});

describe('the chat page', () => {
  it('tells the host it is ready, and shows the empty state for a new conversation', () => {
    expect(sent[0]).toEqual({ type: 'ready' });
    post(newConversation('ctx', 'team-a', 'lab-ops'));
    expect($('title').textContent).toBe('lab-ops');
    expect($('where').textContent).toContain('team-a');
    expect($('messages').textContent).toContain('Discuss with the lab-ops crew');
    expect(($('copy') as HTMLButtonElement).hidden).toBe(true);
    expect(shown.at(-1)).toContain('Discuss with the lab-ops crew');
  });

  it("titles the page with the crew's display name, its technical name beside it and on hover", () => {
    const message = { ...stateMessage(newConversation('ctx', 'team-a', 'lab-ops')), crewTitle: 'Lab-Ops Crew' };
    window.dispatchEvent(new MessageEvent('message', { data: message, origin: window.origin }));
    expect($('title').textContent).toBe('Lab-Ops Crew');
    expect($('title').title).toBe('lab-ops');
    expect($('where').textContent).toBe('lab-ops · team-a · ctx');
    expect($('messages').textContent).toContain('Discuss with Lab-Ops Crew');
  });

  it('renders the answer as Markdown, shows raw HTML as text, and links only web URLs', () => {
    const c = newConversation('ctx', 'team-a', 'lab-ops');
    c.messages.push(
      { role: 'user', content: 'hi <b>there</b>', timestamp: c.startedAt },
      { role: 'assistant', content: '**bold** <img src=x onerror=alert(1)> [safe](https://kubemoot.org) [bad](javascript:alert(1))', timestamp: c.startedAt },
      { role: 'system', content: 'Stopped.', timestamp: c.startedAt },
    );
    post(c);
    const messages = $('messages');
    expect(messages.querySelector('strong')?.textContent).toBe('bold');
    expect(messages.querySelector('img')).toBeNull();
    expect(messages.textContent).toContain('<img src=x');
    const links = [...messages.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(links).toEqual(['https://kubemoot.org']);
    expect(messages.textContent).toContain('bad');
    expect(messages.querySelector('.message.user .message-text')?.textContent).toBe('hi <b>there</b>');
    expect(messages.querySelector('.notice-text')?.textContent).toBe('Stopped.');
    expect(messages.querySelector('.notice .message-time')).not.toBeNull();
    expect(($('copy') as HTMLButtonElement).hidden).toBe(false);
  });

  it('shows each agent and where the turn stands while the crew works', () => {
    const c = newConversation('ctx', 'team-a', 'lab-ops');
    c.messages.push({ role: 'user', content: 'q', timestamp: c.startedAt });
    post(c, {
      busy: true,
      turn: { startedAt: Date.now(), connected: true, threadId: 't', done: false, cards: [{ agent: 'node-watcher', status: 'evaluating', gpu: 'rig0', stoodAside: false }] },
    });
    expect($('messages').querySelector('.finding-agent')?.textContent).toBe('node-watcher');
    expect($('messages').textContent).toContain('analyzing on rig0');
    expect($('messages').querySelector('.loading-text')?.textContent).toMatch(/^1 of 1 agent still working/);
    expect($('send').title).toBe('Stop this turn');
  });

  it('sends on Enter, not on Shift+Enter, and asks to stop while busy', () => {
    const c = newConversation('ctx', 'team-a', 'lab-ops');
    post(c);
    const input = $('input') as HTMLTextAreaElement;
    input.value = 'Which nodes?';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }));
    expect(sent.filter((m) => m.type === 'send')).toEqual([]);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(sent.at(-1)).toEqual({ type: 'send', text: 'Which nodes?' });
    expect(input.value).toBe('');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(sent.filter((m) => m.type === 'send')).toHaveLength(1);

    post(c, { busy: true });
    $('form').dispatchEvent(new Event('submit'));
    expect(sent.at(-1)).toEqual({ type: 'stop' });
  });

  it('shows Send only with text to send, and Stop in its place while the crew answers; Enter never stops', () => {
    const c = newConversation('ctx', 'team-a', 'lab-ops');
    post(c);
    const input = $('input') as HTMLTextAreaElement;
    const send = $('send') as HTMLButtonElement;
    const note = $('note');
    expect([send.hidden, note.hidden]).toEqual([true, true]);
    input.value = '  ';
    input.dispatchEvent(new Event('input'));
    expect(send.hidden).toBe(true);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(sent.filter((m) => m.type === 'send')).toEqual([]);
    input.value = 'Which nodes?';
    input.dispatchEvent(new Event('input'));
    expect([send.hidden, send.title]).toEqual([false, 'Send']);
    post(c, { busy: true });
    expect([send.hidden, send.title, note.hidden, note.textContent]).toEqual([false, 'Stop this turn', false, 'The crew is answering']);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(sent.filter((m) => m.type === 'send' || m.type === 'stop')).toEqual([]);
    $('form').dispatchEvent(new Event('submit'));
    expect(sent.at(-1)).toEqual({ type: 'stop' });
    post(c);
    expect([send.hidden, note.hidden]).toEqual([false, true]);
  });

  it.each([
    [{ state: 'not-ready', reason: 'The crew is not ready: phase Pending' }],
    [{ state: 'error', reason: 'The crew is in an error state: Agent a is Failed' }],
    [{ state: 'unreachable', reason: "Can't reach the cluster: connect ECONNREFUSED" }],
    [{ state: 'unreachable', reason: "Can't reach the crew's discussion gateway" }],
  ] as const)('blocks sending with the reason beside the input: %o', (blocked) => {
    const c = newConversation('ctx', 'team-a', 'lab-ops');
    availability = blocked;
    post(c);
    const input = $('input') as HTMLTextAreaElement;
    input.value = 'Which nodes?';
    input.dispatchEvent(new Event('input'));
    expect(($('send') as HTMLButtonElement).hidden).toBe(true);
    expect([$('note').hidden, $('note').textContent]).toEqual([false, blocked.reason]);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    $('form').dispatchEvent(new Event('submit'));
    expect(sent.filter((m) => m.type === 'send')).toEqual([]);
    availability = { state: 'ready' };
    post(c);
    expect([($('send') as HTMLButtonElement).hidden, $('note').hidden]).toEqual([false, true]);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(sent.at(-1)).toEqual({ type: 'send', text: 'Which nodes?' });
    expect(($('send') as HTMLButtonElement).hidden).toBe(true);
  });

  it('lists saved conversations and opens one; the header buttons reach the host', () => {
    const c = newConversation('ctx', 'team-a', 'lab-ops');
    post(c, {}, [{ id: 'old-1', title: 'Earlier question', startedAt: new Date(Date.now() - 3_600_000).toISOString(), crewName: 'lab-ops', namespace: 'team-a', context: 'ctx' }]);
    const item = $('history').querySelector('[data-id="old-1"]') as HTMLElement;
    expect(item.textContent).toContain('Earlier question');
    expect(item.textContent).toContain('1h ago');
    item.click();
    $('new').click();
    $('copy').click();
    $('export').click();
    $('dashboard').click();
    expect(sent.slice(1).map((m) => m.type)).toEqual(['open', 'new', 'copy', 'export', 'openDashboard']);
    post(c);
    expect($('history').textContent).toContain('No saved conversations yet');
  });

  it('puts the time and the response duration under each message, and handles saved ones without a duration', () => {
    const c = newConversation('ctx', 'team-a', 'lab-ops');
    c.messages.push(
      { role: 'user', content: 'q', timestamp: '2026-09-27T15:36:00Z' },
      { role: 'assistant', content: 'a', timestamp: '2026-09-27T15:36:42Z', durationMs: 42_000 },
      { role: 'assistant', content: 'old', timestamp: '2026-09-27T15:40:00Z' },
    );
    post(c);
    const times = [...$('messages').querySelectorAll('.message-time')].map((el) => el.textContent ?? '');
    expect(times[0]).not.toContain(META_SEPARATOR);
    expect(times[1].endsWith(`${META_SEPARATOR}42 s`)).toBe(true);
    expect(times[1].length).toBeGreaterThan(`${META_SEPARATOR}42 s`.length);
    expect(times[2]).not.toContain(META_SEPARATOR);
    expect($('messages').querySelector('.message-time')?.getAttribute('title')).toBe('2026-09-27T15:36:00Z');
    expect($('messages').querySelectorAll('.message-avatar')).toHaveLength(3);
    expect($('messages').querySelector('.message-avatar')?.closest('.message-meta')).not.toBeNull();
  });

  it('gives each message a row of labelled actions that reach the host', () => {
    const c = newConversation('ctx', 'team-a', 'lab-ops');
    c.messages.push({ role: 'user', content: 'q', timestamp: c.startedAt }, { role: 'assistant', content: 'answer', timestamp: c.startedAt });
    post(c);
    const rows = [...$('messages').querySelectorAll('.message-actions')];
    expect(rows.map((r) => r.getAttribute('role'))).toEqual(['toolbar', 'toolbar']);
    const labels = rows.map((r) => [...r.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')));
    expect(labels).toEqual([
      ['Copy', 'Ask again', 'Edit and resend'],
      ['Copy answer as Markdown', 'Ask the question again'],
    ]);
    for (const b of $('messages').querySelectorAll('.action-btn')) expect(b.getAttribute('title')).toBe(b.getAttribute('aria-label'));
    const click = (index: number, action: string) => ($('messages').querySelector(`[data-index="${index}"][data-action="${action}"]`) as HTMLElement).click();
    click(1, 'copy');
    click(1, 'reask');
    click(0, 'reask');
    expect(sent.slice(1)).toEqual([
      { type: 'copyMessage', index: 1 },
      { type: 'reask', index: 1 },
      { type: 'reask', index: 0 },
    ]);
  });

  it('puts a question back in the input to edit and resend it', () => {
    const c = newConversation('ctx', 'team-a', 'lab-ops');
    c.messages.push({ role: 'user', content: 'Which nodes\nhave a GPU?', timestamp: c.startedAt });
    post(c);
    ($('messages').querySelector('[data-action="edit"]') as HTMLElement).click();
    const input = $('input') as HTMLTextAreaElement;
    expect(input.value).toBe('Which nodes\nhave a GPU?');
    expect(document.activeElement).toBe(input);
    expect(($('send') as HTMLButtonElement).hidden).toBe(false);
    expect(sent).toHaveLength(1);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(sent.at(-1)).toEqual({ type: 'send', text: 'Which nodes\nhave a GPU?' });
  });

  it('disables asking again while a turn runs, and ignores a click on a disabled or stale button', () => {
    const c = newConversation('ctx', 'team-a', 'lab-ops');
    c.messages.push({ role: 'user', content: 'q', timestamp: c.startedAt });
    post(c, { busy: true });
    const reask = $('messages').querySelector('[data-action="reask"]') as HTMLButtonElement;
    expect(reask.disabled).toBe(true);
    expect(($('messages').querySelector('[data-action="edit"]') as HTMLButtonElement).disabled).toBe(false);
    reask.click();
    reask.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(sent).toHaveLength(1);
    const stale = document.createElement('button');
    stale.dataset.action = 'edit';
    stale.dataset.index = '5';
    $('messages').appendChild(stale);
    stale.click();
    stale.dataset.action = 'unknown';
    stale.click();
    expect(($('input') as HTMLTextAreaElement).value).toBe('');
    expect(sent).toHaveLength(1);
  });

  it('keeps keyboard focus on a message button when the page re-renders', () => {
    const c = newConversation('ctx', 'team-a', 'lab-ops');
    c.messages.push({ role: 'user', content: 'q', timestamp: c.startedAt });
    post(c);
    ($('messages').querySelector('[data-action="copy"]') as HTMLElement).focus();
    post(c, { busy: true });
    expect((document.activeElement as HTMLElement).dataset.action).toBe('copy');
    $('input').focus();
    post(c);
    expect(document.activeElement).toBe($('input'));
  });

  it('offers rename, delete, copy and save for a conversation with messages, and waits for a running turn', () => {
    const c = newConversation('ctx', 'team-a', 'lab-ops');
    const header = ['rename', 'delete', 'copy', 'export'].map((id) => $(id) as HTMLButtonElement);
    post(c);
    expect(header.map((b) => b.hidden)).toEqual([true, true, true, true]);
    c.messages.push({ role: 'user', content: 'q', timestamp: c.startedAt });
    post(c);
    expect(header.map((b) => b.hidden)).toEqual([false, false, false, false]);
    expect(header.map((b) => b.getAttribute('aria-label'))).toEqual(['Rename conversation', 'Delete conversation', 'Copy conversation as Markdown', 'Save conversation as Markdown']);
    $('rename').click();
    $('delete').click();
    expect(sent.slice(1)).toEqual([{ type: 'rename' }, { type: 'delete' }]);
    post(c, { busy: true });
    expect(header.map((b) => b.disabled)).toEqual([true, true, false, false]);
  });

  it('shows what went wrong under an answer and a notice, escaped, and ignores a malformed list', () => {
    const c = newConversation('ctx', 'team-a', 'lab-ops');
    c.messages.push(
      { role: 'user', content: 'q', timestamp: c.startedAt },
      { role: 'assistant', content: 'a', timestamp: c.startedAt, problems: ['k8s failed: <b>tool</b> error'] },
      { role: 'system', content: 'Stopped.', timestamp: c.startedAt, problems: ['rules did not finish before the turn ended'] },
      { role: 'assistant', content: 'old', timestamp: c.startedAt, problems: 'bad' as unknown as string[] },
    );
    post(c);
    const lists = [...$('messages').querySelectorAll('.turn-problems')];
    expect(lists.map((l) => l.textContent)).toEqual(['k8s failed: <b>tool</b> error', 'rules did not finish before the turn ended']);
    expect(lists[0].querySelector('b')).toBeNull();
    expect(lists[0].closest('.message.crew')).not.toBeNull();
    expect(lists[1].closest('.notice')).not.toBeNull();
  });

  it('marks the card of an agent that failed or could not run', () => {
    const c = newConversation('ctx', 'team-a', 'lab-ops');
    c.messages.push({ role: 'user', content: 'q', timestamp: c.startedAt });
    const cards = [
      { agent: 'k8s', status: 'finding', signal: 'failure', summary: 'tool error', stoodAside: false },
      { agent: 'big', status: 'done', stoodAside: true, reason: 'model-too-large' },
      { agent: 'fine', status: 'finding', signal: 'agree', summary: 'ok', stoodAside: false },
    ];
    post(c, { busy: true, turn: { startedAt: Date.now(), connected: true, threadId: 't', done: false, cards } });
    const shown = [...$('messages').querySelectorAll('.finding-card')].map((el) => [el.className, el.querySelector('.finding-summary')?.textContent]);
    expect(shown).toEqual([
      ['finding-card finding-problem', 'failed: tool error'],
      ['finding-card finding-problem', 'stood aside: no GPU in this cluster can hold its model'],
      ['finding-card', 'agrees: ok'],
    ]);
  });

  it('hides the conversations pane, and remembers a dragged width', () => {
    $('toggle').click();
    expect($('sidebar').classList.contains('hidden')).toBe(true);
    const handle = $('resizer');
    handle.setPointerCapture = () => {};
    handle.dispatchEvent(new MouseEvent('pointerdown', { clientX: 240 }));
    handle.dispatchEvent(new MouseEvent('pointermove', { clientX: 1000 }));
    expect($('sidebar').style.width).toBe('480px');
    handle.dispatchEvent(new MouseEvent('pointerup'));
    expect(state).toHaveProperty('sidebarWidth');
  });

  it('starts with the conversations pane closed in a narrow panel, and closes it after a pick', async () => {
    const listeners: ((e: { matches: boolean }) => void)[] = [];
    const query = { matches: true, addEventListener: (_: string, l: (e: { matches: boolean }) => void) => listeners.push(l) };
    globalThis.matchMedia = (() => query) as unknown as typeof globalThis.matchMedia;
    try {
      for (const p of recorded.panels) p.dispose();
      await loadPage();
      expect($('sidebar').classList.contains('hidden')).toBe(true);
      $('toggle').click();
      post(newConversation('ctx', 'team-a', 'lab-ops'), {}, [{ id: 'old-1', title: 'Earlier', startedAt: new Date().toISOString(), crewName: 'lab-ops', namespace: 'team-a', context: 'ctx' }]);
      ($('history').querySelector('[data-id="old-1"]') as HTMLElement).click();
      expect($('sidebar').classList.contains('hidden')).toBe(true);
      $('toggle').click();
      listeners.forEach((l) => l({ matches: false }));
      expect($('sidebar').classList.contains('hidden')).toBe(false);
      listeners.forEach((l) => l({ matches: true }));
      expect($('sidebar').classList.contains('hidden')).toBe(true);
    } finally {
      delete (globalThis as { matchMedia?: unknown }).matchMedia;
    }
  });

  it('ignores a click in the conversations list that is not on a conversation', () => {
    post(newConversation('ctx', 'team-a', 'lab-ops'));
    ($('history').querySelector('.no-discussions') as HTMLElement).click();
    expect(sent).toHaveLength(1);
  });

  it('puts text from the editor in the input after any draft, focused at the end', () => {
    const input = $('input') as HTMLTextAreaElement;
    const send = (data: unknown, origin = window.origin) => window.dispatchEvent(new MessageEvent('message', { data, origin }));
    expect(($('send') as HTMLButtonElement).hidden).toBe(true);
    send({ type: 'prefill', text: 'From a.ts:\n\n```ts\nx\n```\n\n' });
    expect(input.value).toBe('From a.ts:\n\n```ts\nx\n```\n\n');
    expect(($('send') as HTMLButtonElement).hidden).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(input.value.length);
    input.value = 'my draft  ';
    send({ type: 'prefill', text: 'more' });
    expect(input.value).toBe('my draft\n\nmore');
    send({ type: 'prefill', text: 'from elsewhere' }, 'https://attacker.example');
    send({ type: 'prefill', text: 42 });
    expect(input.value).toBe('my draft\n\nmore');
    expect(sent).toHaveLength(1);
  });

  it('ignores messages that are not state', () => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'other' }, origin: window.origin }));
    expect($('title').textContent).toBe('');
  });

  it('ignores a state message from any origin but its own', () => {
    const data = stateMessage(newConversation('ctx', 'team-a', 'lab-ops'));
    for (const origin of ['https://attacker.example', '', 'null', 'vscode-webview://another-webview']) {
      window.dispatchEvent(new MessageEvent('message', { data, origin }));
    }
    expect($('title').textContent).toBe('');
    expect($('messages').textContent).toBe('');
    window.dispatchEvent(new MessageEvent('message', { data, origin: window.origin }));
    expect($('title').textContent).toBe('lab-ops');
  });

  it('shows a link title from the Markdown, escaped', () => {
    const c = newConversation('ctx', 'team-a', 'lab-ops');
    c.messages.push({ role: 'assistant', content: '[docs](https://kubemoot.org "the \\"docs\\" <site>") [plain](https://kubemoot.org/a)', timestamp: c.startedAt });
    post(c);
    const [titled, plain] = [...$('messages').querySelectorAll('a')];
    expect(titled.getAttribute('title')).toBe('the "docs" <site>');
    expect(titled.getAttribute('href')).toBe('https://kubemoot.org');
    expect(plain.hasAttribute('title')).toBe(false);
  });

  it('marks queued and analyzing cards, and shows the synthesis as Markdown once it arrives', () => {
    const c = newConversation('ctx', 'team-a', 'lab-ops');
    c.messages.push({ role: 'user', content: 'q', timestamp: c.startedAt });
    const cards = [
      { agent: 'a', status: 'triaging', stoodAside: false },
      { agent: 'b', status: 'evaluating', stoodAside: false },
      { agent: 'c', status: 'done', signal: 'agree', summary: 'fine', stoodAside: false },
    ];
    post(c, { busy: true, turn: { startedAt: Date.now(), connected: true, threadId: 't', done: false, cards, synthesis: '**all good**' } });
    const classes = [...$('messages').querySelectorAll('.finding-card')].map((el) => el.className);
    expect(classes).toEqual(['finding-card finding-triaging', 'finding-card finding-evaluating', 'finding-card']);
    expect($('messages').querySelector('.turn strong')?.textContent).toBe('all good');
    expect($('messages').querySelector('.loading-text')).toBeNull();
  });

  it('links an agent to its source when the host says it can, on the live card and under the answer', () => {
    links = { agents: ['node-watcher'], dashboard: false };
    const c = newConversation('ctx', 'team-a', 'lab-ops');
    c.messages.push({ role: 'user', content: 'q', timestamp: c.startedAt });
    post(c, { busy: true, turn: { startedAt: Date.now(), connected: true, done: false, cards: [{ agent: 'node-watcher', status: 'evaluating', stoodAside: false }, { agent: 'other', status: 'evaluating', stoodAside: false }] } });
    const live = $('messages').querySelectorAll('.finding-agent');
    expect([...live].map((el) => el.tagName)).toEqual(['BUTTON', 'SPAN']);
    (live[0] as HTMLElement).click();
    expect(sent.at(-1)).toEqual({ type: 'openAgentSource', agent: 'node-watcher' });
    c.messages.push({
      role: 'assistant',
      content: 'answer',
      timestamp: c.startedAt,
      threadId: 'th-1',
      agents: [{ agent: 'node-watcher', text: 'agrees: rig0', problem: false }, { agent: '<b>x</b>', text: 'failed: boom', problem: true }, { bad: true } as never],
    });
    post(c);
    const details = $('messages').querySelector('details.turn-agents')!;
    expect(details.querySelector('summary')?.textContent).toBe('2 agents took part');
    expect(details.querySelectorAll('.finding-card.finding-problem')).toHaveLength(1);
    expect(details.textContent).toContain('<b>x</b>');
    (details.querySelector('button.finding-agent') as HTMLElement).click();
    expect(sent.at(-1)).toEqual({ type: 'openAgentSource', agent: 'node-watcher' });
    c.messages[1].agents = [{ agent: 'solo', text: 'agrees', problem: false }];
    post(c);
    expect($('messages').querySelector('details.turn-agents summary')?.textContent).toBe('1 agent took part');
  });

  it('offers Open in Dashboard on a turn with a thread, only when the dashboard is set', () => {
    const c = newConversation('ctx', 'team-a', 'lab-ops');
    c.messages.push(
      { role: 'user', content: 'q', timestamp: c.startedAt },
      { role: 'assistant', content: 'answer', timestamp: c.startedAt, threadId: 'th-1' },
      { role: 'user', content: 'q2', timestamp: c.startedAt },
      { role: 'system', content: 'The crew finished without an answer.', timestamp: c.startedAt, threadId: 'th-2' },
      { role: 'assistant', content: 'no thread', timestamp: c.startedAt },
    );
    post(c);
    expect($('messages').querySelectorAll('[data-action="dashboard"]')).toHaveLength(0);
    expect($('messages').querySelector('.notice .message-actions')).toBeNull();
    links = { agents: [], dashboard: true };
    post(c);
    const buttons = [...$('messages').querySelectorAll<HTMLElement>('[data-action="dashboard"]')];
    expect(buttons.map((b) => b.dataset.index)).toEqual(['1', '3']);
    expect(buttons[0].getAttribute('aria-label')).toBe('Open this turn in the Kubemoot dashboard');
    buttons[1].click();
    expect(sent.at(-1)).toEqual({ type: 'openTurnInDashboard', index: 3 });
  });
});
