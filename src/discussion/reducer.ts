import { eventErrorText, type DiscussionEvent } from './types';

/** What one agent is doing in the current turn, as the stream has told us. */
export interface AgentCard {
  agent: string;
  status: string;
  gpu?: string;
  signal?: string;
  summary?: string;
  stoodAside: boolean;
  model?: string;
  reason?: string;
}

/** Everything the stream has said about one turn. */
export interface TurnState {
  /** When the question was sent, as epoch milliseconds. */
  startedAt: number;
  connected: boolean;
  threadId?: string;
  /** One card per agent, in the order agents first appeared. */
  cards: AgentCard[];
  synthesis?: string;
  done: boolean;
  error?: string;
  /** Why the stream dropped, while the client reconnects; cleared when it is back. */
  reconnecting?: string;
  /** The coordinator started the question over under a new thread, for example after it restarted. */
  restarted?: boolean;
  /** Threads the coordinator gave up on; a late mention of one is not a restart. */
  abandoned?: string[];
}

export function initialTurn(now = Date.now()): TurnState {
  return { startedAt: now, connected: false, cards: [], done: false };
}

type Handler = (state: TurnState, e: DiscussionEvent) => TurnState;

const handlers: Record<string, Handler> = {
  connected: (s) => ({ ...s, connected: true, reconnecting: undefined }),
  thread_found: threadFound,
  reconnecting: (s, e) => ({ ...s, reconnecting: e.error || 'the connection dropped' }),
  phase: (s, e) =>
    upsertCard(s, e.agent, (c) => ({
      ...c,
      status: e.status ?? c.status,
      gpu: e.gpu ?? c.gpu,
      signal: e.signal ?? c.signal,
      stoodAside: e.stood_aside ?? c.stoodAside,
      model: e.model ?? c.model,
      // Why an agent waits or stood aside belongs to that status, not to the ones after it.
      reason: e.reason,
    })),
  finding: (s, e) =>
    upsertCard(s, e.agent, (c) => ({
      ...c,
      status: 'finding',
      signal: e.signal ?? c.signal,
      summary: e.summary || firstLine(e.content) || c.summary,
    })),
  synthesis: (s, e) => ({ ...s, synthesis: e.content ?? s.synthesis }),
  done: (s) => ({ ...s, done: true }),
  error: (s, e) => ({ ...s, done: true, error: eventErrorText(e) }),
};

/**
 * Folds one event into the turn. Pure: returns a new state and never mutates. Events
 * after the turn is done, heartbeats, and unknown types leave the state as it was.
 */
export function reduce(state: TurnState, e: DiscussionEvent): TurnState {
  if (state.done) return state;
  const handler = handlers[e.type];
  return handler ? handler(state, e) : state;
}

/**
 * The first thread_found names the turn's thread. A later one with another id means the
 * coordinator started the question over; the earlier thread's cards and answer are
 * dropped, since that thread will not finish.
 */
function threadFound(s: TurnState, e: DiscussionEvent): TurnState {
  if (!e.threadId || e.threadId === s.threadId || s.abandoned?.includes(e.threadId)) return s;
  if (!s.threadId) return { ...s, threadId: e.threadId };
  const abandoned = [...(s.abandoned ?? []), s.threadId];
  return { ...s, threadId: e.threadId, cards: [], synthesis: undefined, restarted: true, abandoned };
}

function upsertCard(state: TurnState, agent: string | undefined, update: (c: AgentCard) => AgentCard): TurnState {
  const name = agent || 'crew';
  const index = state.cards.findIndex((c) => c.agent === name);
  const current = index >= 0 ? state.cards[index] : { agent: name, status: '', stoodAside: false };
  const cards = [...state.cards];
  if (index >= 0) cards[index] = update(current);
  else cards.push(update(current));
  return { ...state, cards };
}

function firstLine(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const newline = text.indexOf('\n');
  return newline >= 0 ? text.slice(0, newline) : text;
}
