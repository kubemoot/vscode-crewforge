import type { AgentCard } from './reducer';

/** What a card in the live feed says about an agent. */
export interface CardText {
  text: string;
  /** The agent is still working: show a spinner. */
  working: boolean;
  /** Something went wrong for the agent: it failed, or it could not run. */
  problem: boolean;
}

const ARTIFACT = /^\[ARTIFACT key=\S+ bytes=(\d+)/;

// Maps, not object literals: the keys come from the stream, and a key such as
// "constructor" must not find something on Object's prototype.

/**
 * The words for an agent starting up. An agent sends these once, when its pod starts, not
 * for a turn, so they are neither work in progress nor a turn left unfinished.
 */
const STARTING = new Map([
  ['waking', 'starting up'],
  ['ready', 'ready'],
]);

/** The words for an agent still at work on the turn, by the status the gateway sends. */
const WORKING = new Map<string, (card: AgentCard) => string>([
  ['triaging', (c) => `queued${where(c)}...`],
  ['evaluating', (c) => `analyzing${where(c)}...`],
  ['waiting', (c) => `waiting for a GPU with room for ${c.model ?? 'its model'}...`],
]);

/** The statuses of an agent still at work on the turn. */
export const WORKING_STATUSES: ReadonlySet<string> = new Set(WORKING.keys());

/** Each verdict an agent can give, in plain words. */
const VERDICTS = new Map([
  ['agree', 'agrees'],
  ['concern', 'has a concern'],
  ['block', 'objects'],
  ['failure', 'failed'],
]);

/** Why an agent stood aside because it could not run, in plain words. */
const STAND_ASIDE_REASONS = new Map([
  ['gpu-busy', 'stood aside: every GPU was busy, so it could not run'],
  ['model-too-large', 'stood aside: no GPU in this cluster can hold its model'],
]);

function where(card: AgentCard): string {
  return card.gpu ? ` on ${card.gpu}` : '';
}

export function cardText(card: AgentCard): CardText {
  const working = WORKING.get(card.status);
  if (working) return { text: working(card), working: true, problem: false };
  if (card.stoodAside) return { text: standAsideText(card.reason), working: false, problem: couldNotRun(card) };
  return { text: verdictText(card), working: false, problem: card.signal === 'failure' };
}

/** What the agent found, led by its verdict in plain words; else how it is starting up, or its status. */
function verdictText(card: AgentCard): string {
  const verdict = card.signal ? (VERDICTS.get(card.signal) ?? card.signal) : undefined;
  if (card.summary) {
    const lead = verdict ? `${verdict}: ` : '';
    return `${lead}${readable(card.summary)}`;
  }
  return verdict || STARTING.get(card.status) || card.status || 'waiting';
}

/**
 * What went wrong for the agents of a turn, one plain line each: an agent that failed,
 * one that could not run, and one still at work when the turn ended.
 */
export function agentProblems(cards: AgentCard[]): string[] {
  return cards.flatMap((card) => {
    if (WORKING_STATUSES.has(card.status)) return [`${card.agent} did not finish before the turn ended`];
    const { text, problem } = cardText(card);
    return problem ? [`${card.agent} ${text}`] : [];
  });
}

function standAsideText(reason?: string): string {
  return (reason && STAND_ASIDE_REASONS.get(reason)) || 'stood aside';
}

/** An agent that stood aside for a reason that kept it from running, not by choice. */
function couldNotRun(card: AgentCard): boolean {
  return card.reason !== undefined && STAND_ASIDE_REASONS.has(card.reason);
}

/** A finding that points at an artifact reads as what it is, not as the raw reference. */
function readable(summary: string): string {
  const artifact = ARTIFACT.exec(summary);
  return artifact ? `wrote a ${artifact[1]}-byte result to the crew's artifact store` : summary;
}
