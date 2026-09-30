import { marked } from 'marked';
import { cardText } from '../discussion/cardText';
import { turnStatus } from '../discussion/turnStatus';
import type { TurnState } from '../discussion/reducer';
import type { ChatMessage, ConversationMeta } from '../store/conversation';
import type { HostMessage, WebviewMessage } from './protocol';
import { escapeHtml, formatAgo, htmlAttribute, icons, isWebLink, metaLine } from './render';

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): { sidebarWidth?: number } | undefined;
  setState(state: { sidebarWidth?: number }): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

// Crew answers are model output: raw HTML in them is shown as text, never rendered, and
// only web links become anchors.
marked.use({
  gfm: true,
  renderer: {
    html: ({ text }) => escapeHtml(text),
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      if (!isWebLink(href)) return text;
      const titleAttr = title ? htmlAttribute('title', title) : '';
      return `<a${htmlAttribute('href', href)}${titleAttr}>${text}</a>`;
    },
  },
});

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const els = {
  sidebar: $<HTMLElement>('sidebar'),
  history: $<HTMLDivElement>('history'),
  title: $<HTMLHeadingElement>('title'),
  where: $<HTMLSpanElement>('where'),
  messages: $<HTMLDivElement>('messages'),
  form: $<HTMLFormElement>('form'),
  input: $<HTMLTextAreaElement>('input'),
  send: $<HTMLButtonElement>('send'),
  copy: $<HTMLButtonElement>('copy'),
  exportBtn: $<HTMLButtonElement>('export'),
};

let state: HostMessage | undefined;

// VS Code's webview host frame forwards each extension host message into this page with
// its own origin as the target, and this page is served from that same origin; a message
// with any other origin came from some other window and is ignored.
globalThis.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  if (event.origin !== globalThis.origin || event.data?.type !== 'state') return;
  state = event.data;
  render();
});

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  submit();
});
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
});
els.input.addEventListener('input', autoGrow);
$('toggle').addEventListener('click', () => els.sidebar.classList.toggle('hidden'));
$('new').addEventListener('click', () => vscode.postMessage({ type: 'new' }));
els.copy.addEventListener('click', () => vscode.postMessage({ type: 'copy' }));
els.exportBtn.addEventListener('click', () => vscode.postMessage({ type: 'export' }));
$('dashboard').addEventListener('click', (e) => {
  e.preventDefault();
  vscode.postMessage({ type: 'openDashboard' });
});
els.history.addEventListener('click', (e) => {
  const item = (e.target as HTMLElement).closest<HTMLElement>('[data-id]');
  if (!item?.dataset.id) return;
  vscode.postMessage({ type: 'open', id: item.dataset.id });
  if (narrow?.matches) els.sidebar.classList.add('hidden');
});
// In a narrow panel the conversations pane floats over the chat, so it starts closed and
// closes again once a conversation is picked.
const narrow = globalThis.matchMedia?.('(max-width: 480px)');
if (narrow?.matches) els.sidebar.classList.add('hidden');
narrow?.addEventListener('change', (e) => {
  if (e.matches) els.sidebar.classList.add('hidden');
});
els.messages.addEventListener('click', (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
  if (!button || button.disabled) return;
  const run = MESSAGE_ACTIONS[button.dataset.action as MessageActionId] as ((index: number) => void) | undefined;
  run?.(Number(button.dataset.index));
});
// The status line's clock advances between stream events.
setInterval(() => {
  const label = document.querySelector('.loading-text');
  const turn = state?.view.turn;
  if (label && turn) label.textContent = turnStatus(turn);
}, 1000);

setupResizer();

vscode.postMessage({ type: 'ready' });

function submit(): void {
  if (state?.view.busy) {
    vscode.postMessage({ type: 'stop' });
    return;
  }
  const text = els.input.value.trim();
  if (!text) return;
  vscode.postMessage({ type: 'send', text });
  els.input.value = '';
  autoGrow();
}

function autoGrow(): void {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, 150)}px`;
}

function render(): void {
  if (!state) return;
  const { conversation, busy } = state.view;
  els.title.textContent = conversation.crewName;
  els.where.textContent = `${conversation.namespace} · ${conversation.context}`;
  const hasMessages = conversation.messages.length > 0;
  els.copy.hidden = !hasMessages;
  els.exportBtn.hidden = !hasMessages;
  els.history.innerHTML = renderHistory(state.history, conversation.id);
  renderMessages();
  els.send.innerHTML = busy ? icons.stop : icons.send;
  els.send.title = busy ? 'Stop this turn' : 'Send';
  els.send.classList.toggle('stop', busy);
}

function renderHistory(history: ConversationMeta[], activeId: string): string {
  if (history.length === 0) return '<div class="no-discussions"><p>No saved conversations yet</p></div>';
  return history
    .map(
      (h) => `<div class="discussion-item${h.id === activeId ? ' active' : ''}">
        <button class="discussion-btn" data-id="${escapeHtml(h.id)}">
          <span class="conv-title">${escapeHtml(h.title)}</span>
          <span class="conv-date">${escapeHtml(formatAgo(h.startedAt))}</span>
        </button></div>`,
    )
    .join('');
}

function renderMessages(): void {
  if (!state) return;
  const { conversation, turn, busy } = state.view;
  const atBottom = els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 40;
  if (conversation.messages.length === 0 && !turn) {
    els.messages.innerHTML = emptyState(conversation.crewName, state.about);
    return;
  }
  const parts = conversation.messages.map((m, index) => renderMessage(m, index, busy));
  if (turn) parts.push(renderTurn(turn));
  const focused = focusedAction();
  els.messages.innerHTML = parts.join('');
  if (focused) refocus(focused);
  if (atBottom || turn) els.messages.scrollTop = els.messages.scrollHeight;
}

/** The message button that has keyboard focus, as its action and index, so a re-render can give focus back. */
function focusedAction(): { action?: string; index?: string } | undefined {
  const el = document.activeElement;
  if (!(el instanceof HTMLButtonElement) || !els.messages.contains(el)) return undefined;
  return { action: el.dataset.action, index: el.dataset.index };
}

function refocus(focused: { action?: string; index?: string }): void {
  const buttons = els.messages.querySelectorAll<HTMLButtonElement>('button[data-action]');
  [...buttons].find((b) => b.dataset.action === focused.action && b.dataset.index === focused.index)?.focus();
}

function emptyState(crew: string, about: string): string {
  const list = about ? `<p class="agent-list">${escapeHtml(about)}</p>` : '';
  return `<div class="empty-state"><div class="empty-icon">${icons.crewLarge}</div>
    <h2>Discuss with the ${escapeHtml(crew)} crew</h2>
    <p>Ask a question and its agents will discuss it.</p>${list}</div>`;
}

type MessageActionId = 'copy' | 'reask' | 'edit';

/** One button under a message: what it does, its tooltip, and its icon. */
interface MessageAction {
  action: MessageActionId;
  label: string;
  icon: string;
  /** Sends a question, so it waits while a turn runs. */
  asks?: boolean;
}

/** What each message button does, by its data-action, given the message's index. */
const MESSAGE_ACTIONS: Record<MessageActionId, (index: number) => void> = {
  copy: (index) => vscode.postMessage({ type: 'copyMessage', index }),
  reask: (index) => vscode.postMessage({ type: 'reask', index }),
  edit: editMessage,
};

/** How a question and a crew answer are shown: their class, avatar, body, and buttons. */
const ROLES = {
  user: {
    cls: 'user',
    icon: icons.user,
    body: (m: ChatMessage) => `<div class="message-text">${escapeHtml(m.content)}</div>`,
    actions: [
      { action: 'copy', label: 'Copy', icon: icons.copy },
      { action: 'reask', label: 'Ask again', icon: icons.reask, asks: true },
      { action: 'edit', label: 'Edit and resend', icon: icons.edit },
    ] as MessageAction[],
  },
  assistant: {
    cls: 'crew',
    icon: icons.crew,
    body: (m: ChatMessage) => `<div class="message-text markdown-content">${marked.parse(m.content, { async: false })}</div>`,
    actions: [
      { action: 'copy', label: 'Copy answer as Markdown', icon: icons.copy },
      { action: 'reask', label: 'Ask the question again', icon: icons.reask, asks: true },
    ] as MessageAction[],
  },
};

/** Puts a question back in the input, to change it and send it again. */
function editMessage(index: number): void {
  const message = state?.view.conversation.messages[index];
  if (!message) return;
  els.input.value = message.content;
  autoGrow();
  els.input.focus();
}

function renderMessage(m: ChatMessage, index: number, busy: boolean): string {
  const meta = `<span class="message-time"${htmlAttribute('title', m.timestamp)}>${escapeHtml(metaLine(m.timestamp, m.durationMs))}</span>`;
  if (m.role === 'system') return `<div class="notice"><div class="notice-text">${escapeHtml(m.content)}</div><div class="message-meta">${meta}</div></div>`;
  const role = ROLES[m.role];
  return `<div class="message ${role.cls}">${role.body(m)}
    <div class="message-meta">
      <span class="message-avatar" aria-hidden="true">${role.icon}</span>
      ${meta}
      ${actionRow(role.actions, index, busy)}
    </div></div>`;
}

/** The buttons under a message; ones that ask are disabled while a turn runs. */
function actionRow(actions: MessageAction[], index: number, busy: boolean): string {
  const buttons = actions.map((a) => {
    const attributes = [
      htmlAttribute('data-action', a.action),
      htmlAttribute('data-index', String(index)),
      htmlAttribute('title', a.label),
      htmlAttribute('aria-label', a.label),
    ].join('');
    return `<button type="button" class="action-btn"${attributes}${a.asks && busy ? ' disabled' : ''}>${a.icon}</button>`;
  });
  return `<div class="message-actions" role="toolbar" aria-label="Message actions">${buttons.join('')}</div>`;
}

/** The extra class of a card whose agent is still at work, by status. */
const CARD_CLASSES: Record<string, string> = {
  triaging: ' finding-triaging',
  evaluating: ' finding-evaluating',
};

function renderTurn(turn: TurnState): string {
  const cards = turn.cards
    .map((card) => {
      const { text, working } = cardText(card);
      const cls = CARD_CLASSES[card.status] ?? '';
      return `<div class="finding-card${cls}"><span class="finding-agent">${escapeHtml(card.agent)}</span>
        <span class="${working ? 'finding-status' : 'finding-summary'}">${escapeHtml(text)}</span>${working ? '<div class="finding-spinner"></div>' : ''}</div>`;
    })
    .join('');
  const feed = cards ? `<div class="findings-feed">${cards}</div>` : '';
  const answer = turn.synthesis
    ? `<div class="message-text markdown-content">${marked.parse(turn.synthesis, { async: false })}</div>`
    : `<div class="loading-indicator"><div class="loading-spinner"></div><span class="loading-text">${escapeHtml(turnStatus(turn))}</span></div>`;
  return `<div class="message crew turn">${feed}${answer}</div>`;
}

/** Lets the conversations pane be resized by dragging its edge; the width is remembered. */
function setupResizer(): void {
  const handle = $('resizer');
  const saved = Number(vscode.getState()?.sidebarWidth);
  if (saved) els.sidebar.style.width = `${saved}px`;
  handle.addEventListener('pointerdown', (down) => {
    handle.setPointerCapture(down.pointerId);
    const startX = down.clientX;
    const startWidth = els.sidebar.getBoundingClientRect().width;
    const move = (e: PointerEvent) => {
      const width = Math.min(480, Math.max(160, startWidth + e.clientX - startX));
      els.sidebar.style.width = `${width}px`;
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      vscode.setState({ sidebarWidth: els.sidebar.getBoundingClientRect().width });
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
  });
}
