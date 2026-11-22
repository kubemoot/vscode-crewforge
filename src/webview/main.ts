import { marked } from 'marked';
import { cardText } from '../discussion/cardText';
import { turnStatus } from '../discussion/turnStatus';
import type { AgentCard, TurnState } from '../discussion/reducer';
import { agentsOf, problemsOf, type AgentNote, type ChatMessage, type ConversationMeta } from '../store/conversation';
import type { ConversationActionId } from '../panels/conversationActions';
import type { HostMessage, StateMessage, WebviewMessage } from './protocol';
import { escapeHtml, formatAgo, htmlAttribute, icons, isWebLink, metaLine } from './render';
import { reportErrors } from './reportErrors';
import { shownText } from './shown';

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

/** The header buttons that act on the conversation on the crew, and what each does. */
const CONVERSATION_BUTTONS: Array<[string, ConversationActionId]> = [
  ['conv-stop', 'stop'],
  ['conv-pause', 'pause'],
  ['conv-resume', 'resume'],
  ['conv-erase', 'erase'],
];

/** The entries of a saved conversation's menu in the list: what each does, and its tooltip. */
const LIST_ACTIONS: Array<{ action: ConversationActionId; label: string; title: string }> = [
  { action: 'stop', label: 'Stop', title: 'Stop the conversation on the crew' },
  { action: 'pause', label: 'Pause', title: 'Pause the conversation on the crew' },
  { action: 'resume', label: 'Resume', title: 'Resume the conversation on the crew' },
  { action: 'erase', label: 'Delete from the crew...', title: 'Delete the conversation from the crew' },
];

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
  note: $<HTMLParagraphElement>('note'),
  menu: $<HTMLDetailsElement>('menu'),
  copy: $<HTMLButtonElement>('copy'),
  rename: $<HTMLButtonElement>('rename'),
  deleteBtn: $<HTMLButtonElement>('delete'),
  convButtons: CONVERSATION_BUTTONS.map(([id, action]) => ({ action, el: $<HTMLButtonElement>(id) })),
  exportBtn: $<HTMLButtonElement>('export'),
};

let state: StateMessage | undefined;

// VS Code's webview host frame forwards each extension host message into this page with
// its own origin as the target, and this page is served from that same origin; a message
// with any other origin came from some other window and is ignored.
globalThis.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  if (event.origin !== globalThis.origin) return;
  const message = event.data;
  if (message?.type === 'state') {
    state = message;
    render();
  } else if (message?.type === 'prefill' && typeof message.text === 'string') {
    prefill(message.text);
  }
});

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  submit(true);
});
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submit(false);
  }
});
els.input.addEventListener('input', () => {
  autoGrow();
  renderSend();
});
$('toggle').addEventListener('click', () => els.sidebar.classList.toggle('hidden'));
$('new').addEventListener('click', () => vscode.postMessage({ type: 'new' }));
els.copy.addEventListener('click', () => vscode.postMessage({ type: 'copy' }));
els.exportBtn.addEventListener('click', () => vscode.postMessage({ type: 'export' }));
els.rename.addEventListener('click', () => vscode.postMessage({ type: 'rename' }));
els.deleteBtn.addEventListener('click', () => vscode.postMessage({ type: 'delete' }));
for (const { action, el } of els.convButtons) el.addEventListener('click', () => vscode.postMessage({ type: 'conversationAction', action }));
$('dashboard').addEventListener('click', (e) => {
  e.preventDefault();
  vscode.postMessage({ type: 'openDashboard' });
});
// A menu closes when an entry is chosen, when the page is clicked elsewhere, and on Escape.
document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  for (const menu of document.querySelectorAll<HTMLDetailsElement>('details.menu[open]')) {
    if (!menu.contains(target) || target.closest('.menu-item')) menu.open = false;
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  for (const menu of document.querySelectorAll<HTMLDetailsElement>('details.menu[open]')) menu.open = false;
});
els.history.addEventListener('click', (e) => {
  const act = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-conv-action]');
  if (act?.dataset.id) {
    vscode.postMessage({ type: 'conversationAction', action: act.dataset.convAction as ConversationActionId, id: act.dataset.id });
    return;
  }
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
  const agent = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-agent]');
  if (agent?.dataset.agent) {
    vscode.postMessage({ type: 'openAgentSource', agent: agent.dataset.agent });
    return;
  }
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
reportErrors((message) => vscode.postMessage({ type: 'error', message }));

vscode.postMessage({ type: 'ready' });

/**
 * Sends the question, or stops the turn when the button (the Stop button while a turn
 * runs) was pressed. Enter never stops a turn, and nothing is sent while the crew is
 * answering or cannot take a question.
 */
function submit(fromButton: boolean): void {
  const input = inputState();
  if (input.stop) {
    if (fromButton) vscode.postMessage({ type: 'stop' });
    return;
  }
  if (!input.canSend) return;
  vscode.postMessage({ type: 'send', text: els.input.value.trim() });
  els.input.value = '';
  autoGrow();
  renderSend();
}

/** What the input offers now: Stop while a turn runs, Send once there is text and the crew can take it, and why not when it cannot. */
function inputState(): { stop: boolean; canSend: boolean; note?: string } {
  if (state?.view.busy) return { stop: true, canSend: false, note: 'The crew is answering' };
  const availability = state?.availability;
  if (availability && availability.state !== 'ready') return { stop: false, canSend: false, note: availability.reason };
  return { stop: false, canSend: els.input.value.trim() !== '', note: freshNote() };
}

/** Says so when the crew reported something new in the conversation shown, which is not in the chat itself. */
function freshNote(): string | undefined {
  const id = state?.view.conversation.conversationId;
  if (!id || !state?.fresh.includes(id)) return undefined;
  return state.links.dashboard ? 'The crew has something new in this conversation. Read it under Conversations in the Kubemoot dashboard.' : 'The crew has something new in this conversation.';
}

/** Shows the Send or Stop button only when it can be used, with the reason beside the input when sending is blocked. */
function renderSend(): void {
  const input = inputState();
  els.send.hidden = !input.stop && !input.canSend;
  if (els.send.classList.contains('stop') !== input.stop || !els.send.innerHTML) els.send.innerHTML = input.stop ? icons.stop : icons.send;
  els.send.title = input.stop ? 'Stop this turn' : 'Send';
  els.send.classList.toggle('stop', input.stop);
  els.note.hidden = !input.note;
  els.note.textContent = input.note ?? '';
}

function autoGrow(): void {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, 150)}px`;
}

function render(): void {
  if (!state) return;
  const { conversation, busy } = state.view;
  els.title.textContent = state.crewTitle;
  els.title.title = conversation.crewName;
  const technical = state.crewTitle === conversation.crewName ? '' : `${conversation.crewName} · `;
  els.where.textContent = `${technical}${conversation.namespace} · ${conversation.context}`;
  const hasMessages = conversation.messages.length > 0;
  // A conversation is saved once it has a message; before that there is nothing to act on.
  for (const button of [els.copy, els.exportBtn, els.rename, els.deleteBtn]) button.hidden = !hasMessages;
  els.menu.hidden = !hasMessages && !conversation.conversationId;
  // Renaming or deleting waits for the turn, which saves the conversation when it ends.
  els.rename.disabled = busy;
  els.deleteBtn.disabled = busy;
  // The crew knows a conversation by the id its gateway gave; one that has not reached it has nothing to act on.
  for (const { el } of els.convButtons) el.hidden = !conversation.conversationId;
  els.history.innerHTML = renderHistory(state.history, conversation.id, new Set(state.fresh));
  renderMessages();
  renderSend();
  vscode.postMessage({ type: 'shown', text: shownText(document.body) });
}

function renderHistory(history: ConversationMeta[], activeId: string, fresh: Set<string>): string {
  if (history.length === 0) return '<div class="no-discussions"><p>No saved conversations yet</p></div>';
  return history
    .map((h) => {
      const isNew = h.conversationId !== undefined && fresh.has(h.conversationId);
      const badge = isNew ? '<span class="fresh-dot" role="img" title="Something new from the crew" aria-label="Something new from the crew"></span>' : '';
      return `<div class="discussion-item${h.id === activeId ? ' active' : ''}${isNew ? ' fresh' : ''}">
        <button class="discussion-btn" data-id="${escapeHtml(h.id)}">
          <span class="conv-title">${badge}${escapeHtml(h.title)}</span>
          <span class="conv-date">${escapeHtml(formatAgo(h.startedAt))}</span>
        </button>${h.conversationId ? listActions(h.id) : ''}</div>`;
    })
    .join('');
}

/** The menu of what a saved conversation on the crew can be told to do, shown on hover or focus. */
function listActions(id: string): string {
  const entries = LIST_ACTIONS.map(
    (a) => `<button type="button" class="menu-item conv-action" role="menuitem"${htmlAttribute('data-conv-action', a.action)}${htmlAttribute('data-id', id)}${htmlAttribute('title', a.title)}>${escapeHtml(a.label)}</button>`,
  );
  return `<details class="menu conv-actions"><summary title="Conversation actions" aria-label="Conversation actions">${icons.more}</summary><div class="menu-list" role="menu">${entries.join('')}</div></details>`;
}

function renderMessages(): void {
  if (!state) return;
  const { conversation, turn, busy } = state.view;
  const atBottom = els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 40;
  if (conversation.messages.length === 0 && !turn) {
    els.messages.innerHTML = emptyState(state.crewTitle === conversation.crewName ? `the ${conversation.crewName} crew` : state.crewTitle, state.about);
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

/** The empty state; `crew` reads after "Ask": a display name, or "the <name> crew". */
function emptyState(crew: string, about: string): string {
  const list = about ? `<p class="agent-list">${escapeHtml(about)}</p>` : '';
  return `<div class="empty-state"><div class="empty-icon">${icons.crewLarge}</div>
    <h2>Ask ${escapeHtml(crew)}</h2>
    <p>Type a question below. The answer appears here.</p>${list}</div>`;
}

type MessageActionId = 'copy' | 'reask' | 'edit' | 'dashboard';

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
  dashboard: (index) => vscode.postMessage({ type: 'openTurnInDashboard', index }),
};

/** Opens the Moot of the turn a message ends, in the Kubemoot dashboard; offered when a dashboard URL is set and the turn's thread is known. */
const DASHBOARD_ACTION: MessageAction = { action: 'dashboard', label: 'Open in the Moot', icon: icons.dashboard };

/** The message's buttons: its role's, and Open in the Moot for a turn the dashboard can show. */
function actionsFor(base: MessageAction[], m: ChatMessage): MessageAction[] {
  return state?.links?.dashboard && typeof m.threadId === 'string' && m.threadId ? [...base, DASHBOARD_ACTION] : base;
}

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

/** Adds text from the editor to the input, after any draft, with the cursor at the end for the question. */
function prefill(text: string): void {
  const draft = els.input.value.trimEnd();
  els.input.value = draft ? `${draft}\n\n${text}` : text;
  els.input.focus();
  els.input.setSelectionRange(els.input.value.length, els.input.value.length);
  autoGrow();
  renderSend();
}

/** Puts a question back in the input, to change it and send it again. */
function editMessage(index: number): void {
  const message = state?.view.conversation.messages[index];
  if (!message) return;
  els.input.value = message.content;
  autoGrow();
  renderSend();
  els.input.focus();
}

function renderMessage(m: ChatMessage, index: number, busy: boolean): string {
  const meta = `<span class="message-time"${htmlAttribute('title', m.timestamp)}>${escapeHtml(metaLine(m.timestamp, m.durationMs))}</span>`;
  if (m.role === 'system') {
    const actions = actionsFor([], m);
    const row = actions.length ? actionRow(actions, index, busy) : '';
    return `<div class="notice" role="status"><div class="notice-text">${escapeHtml(m.content)}</div>${problemList(m)}${turnAgents(m)}<div class="message-meta">${meta}${row}</div></div>`;
  }
  const role = ROLES[m.role];
  return `<div class="message ${role.cls}">${role.body(m)}${problemList(m)}${turnAgents(m)}
    <div class="message-meta">
      <span class="message-avatar" aria-hidden="true">${role.icon}</span>
      ${meta}
      ${actionRow(actionsFor(role.actions, m), index, busy)}
    </div></div>`;
}

/** What went wrong in the turn a message ends, as a list, or nothing when all went well. */
function problemList(m: ChatMessage): string {
  const problems = problemsOf(m);
  if (problems.length === 0) return '';
  const items = problems.map((p) => `<li>${escapeHtml(p)}</li>`).join('');
  return `<div class="turn-problems" role="note" aria-label="What went wrong in this turn"><ul>${items}</ul></div>`;
}

/** The Moot of the turn a message ends: the agents that took part, folded away under a count. */
function turnAgents(m: ChatMessage): string {
  const agents = agentsOf(m);
  if (agents.length === 0) return '';
  const cards = agents.map((a) => noteCard(a)).join('');
  const count = agents.length === 1 ? 'The Moot: 1 agent' : `The Moot: ${agents.length} agents`;
  return `<details class="turn-agents"><summary title="What each agent said in this turn">${count}</summary><div class="findings-feed">${cards}</div></details>`;
}

function noteCard(a: AgentNote): string {
  return `<div class="finding-card${a.problem ? ' finding-problem' : ''}">${agentLabel(a.agent)}<span class="finding-summary">${escapeHtml(a.text)}</span></div>`;
}

/** An agent's name on its card: a link to its source when the crew's source is open in the workspace. */
function agentLabel(agent: string): string {
  if (!state?.links?.agents.includes(agent)) return `<span class="finding-agent">${escapeHtml(agent)}</span>`;
  const title = `Open where ${agent} is defined: the Agent and its PromptModules`;
  return `<button type="button" class="finding-agent"${htmlAttribute('data-agent', agent)}${htmlAttribute('title', title)}>${escapeHtml(agent)}</button>`;
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

const CARD_CLASSES = new Map([
  ['triaging', ' finding-triaging'],
  ['evaluating', ' finding-evaluating'],
]);

/** The extra class of a card, by what its agent is doing or what went wrong for it. */
function cardClass(card: AgentCard, problem: boolean): string {
  if (problem) return ' finding-problem';
  return CARD_CLASSES.get(card.status) ?? '';
}

function renderTurn(turn: TurnState): string {
  const cards = turn.cards
    .map((card) => {
      const { text, working, problem } = cardText(card);
      const cls = cardClass(card, problem);
      return `<div class="finding-card${cls}">${agentLabel(card.agent)}
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
