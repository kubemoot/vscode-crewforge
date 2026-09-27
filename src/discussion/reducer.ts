import type { DiscussionEvent } from './types';

/** What one agent is doing in the current turn, as the stream has told us. */
export interface AgentCard {
  agent: string;
  status: string;
  gpu?: string;
  signal?: string;
  summary?: string;
  stoodAside: boolean;
}

/** Everything the stream has said about one turn. */
export interface TurnState {
  connected: boolean;
  threadId?: string;
  /** One card per agent, in the order agents first appeared. */
  cards: AgentCard[];
  synthesis?: string;
  done: boolean;
  error?: string;
}

export function initialTurn(): TurnState {
  return { connected: false, cards: [], done: false };
}

type Handler = (state: TurnState, e: DiscussionEvent) => TurnState;

const handlers: Record<string, Handler> = {
  connected: (s) => ({ ...s, connected: true }),
  thread_found: (s, e) => ({ ...s, threadId: e.threadId ?? s.threadId }),
  phase: (s, e) =>
    upsertCard(s, e.agent, (c) => ({
      ...c,
      status: e.status ?? c.status,
      gpu: e.gpu ?? c.gpu,
      signal: e.signal ?? c.signal,
      stoodAside: e.stood_aside ?? c.stoodAside,
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
  error: (s, e) => ({ ...s, done: true, error: e.error || e.content || 'The discussion reported an error' }),
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
