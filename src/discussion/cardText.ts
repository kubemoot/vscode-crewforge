import type { AgentCard } from './reducer';

/** What a card in the live feed says about an agent. */
export interface CardText {
  text: string;
  /** The agent is still working: show a spinner. */
  working: boolean;
}

const ARTIFACT = /^\[ARTIFACT key=\S+ bytes=(\d+)/;

export function cardText(card: AgentCard): CardText {
  const where = card.gpu ? ` on ${card.gpu}` : '';
  if (card.status === 'triaging') return { text: `queued${where}...`, working: true };
  if (card.status === 'evaluating') return { text: `analyzing${where}...`, working: true };
  if (card.stoodAside) return { text: 'stood aside', working: false };
  if (card.summary) return { text: `${card.signal ? `${card.signal}: ` : ''}${readable(card.summary)}`, working: false };
  return { text: card.signal || card.status || 'waiting', working: false };
}

/** A finding that points at an artifact reads as what it is, not as the raw reference. */
function readable(summary: string): string {
  const artifact = ARTIFACT.exec(summary);
  return artifact ? `wrote a ${artifact[1]}-byte result to the crew's artifact store` : summary;
}
