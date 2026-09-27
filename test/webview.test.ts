// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KubeClient } from '../src/k8s/request';
import { ChatPanel } from '../src/panels/chatPanel';
import { newConversation, type Conversation } from '../src/store/conversation';
import { ConversationStore } from '../src/store/conversations';
import type { HostMessage, WebviewMessage } from '../src/webview/protocol';
import { recorded, resetFake, Uri } from './vscodeFake';

let sent: WebviewMessage[];
let state: unknown;

/** Loads the page ChatPanel generates, then runs the webview script against it. */
async function loadPage(): Promise<void> {
  resetFake();
  ChatPanel.show(Uri.file('/ext') as never, { source: 't', context: 'ctx', client: {} as KubeClient }, { name: 'lab-ops', namespace: 'team-a', ready: true, phase: 'Ready' }, new ConversationStore('/tmp/none'));
  const html = recorded.panels.at(-1)!.webview.html;
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)![1].replace(/<script[\s\S]*<\/script>/, '');
  sent = [];
  state = undefined;
  (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: (m: WebviewMessage) => sent.push(m),
    getState: () => state,
    setState: (s: unknown) => (state = s),
  });
  vi.resetModules();
  await import('../src/webview/main');
}

function post(conversation: Conversation, extra: Partial<HostMessage['view']> = {}, history: HostMessage['history'] = []): void {
  const message: HostMessage = { type: 'state', view: { conversation, busy: false, ...extra }, history, about: '2 agents' };
  window.dispatchEvent(new MessageEvent('message', { data: message }));
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
    expect(messages.querySelector('.notice')?.textContent).toBe('Stopped.');
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

  it('copies one message from its button', () => {
    const c = newConversation('ctx', 'team-a', 'lab-ops');
    c.messages.push({ role: 'assistant', content: 'answer', timestamp: c.startedAt });
    post(c);
    ($('messages').querySelector('[data-copy]') as HTMLElement).click();
    expect(sent.at(-1)).toEqual({ type: 'copyMessage', index: 0 });
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

  it('ignores messages that are not state', () => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'other' } }));
    expect($('title').textContent).toBe('');
  });
});
