import type { AgentCard } from './reducer';

/** What a card in the live feed says about an agent. */
export interface CardText {
  text: string;
  /** The agent is still working: show a spinner. */
  working: boolean;
}

const ARTIFACT = /^\[ARTIFACT key=\S+ bytes=(\d+)/;

/** The words for an agent still at work, by status. */
const WORKING: Record<string, (card: AgentCard) => string> = {
  triaging: (c) => `queued${where(c)}...`,
  evaluating: (c) => `analyzing${where(c)}...`,
  waiting: (c) => `waiting for a GPU with room for ${c.model ?? 'its model'}...`,
};

function where(card: AgentCard): string {
  return card.gpu ? ` on ${card.gpu}` : '';
}

export function cardText(card: AgentCard): CardText {
  const working = WORKING[card.status];
  if (working) return { text: working(card), working: true };
  if (card.stoodAside) return { text: standAsideText(card.reason), working: false };
  if (card.summary) return { text: `${card.signal ? `${card.signal}: ` : ''}${readable(card.summary)}`, working: false };
  return { text: card.signal || card.status || 'waiting', working: false };
}

const STAND_ASIDE_REASONS: Record<string, string> = {
  'gpu-busy': 'stood aside: every GPU was busy, so it could not run',
  'model-too-large': 'stood aside: no GPU in this cluster can hold its model',
};

function standAsideText(reason?: string): string {
  return (reason && STAND_ASIDE_REASONS[reason]) || 'stood aside';
}

/** A finding that points at an artifact reads as what it is, not as the raw reference. */
function readable(summary: string): string {
  const artifact = ARTIFACT.exec(summary);
  return artifact ? `wrote a ${artifact[1]}-byte result to the crew's artifact store` : summary;
}
