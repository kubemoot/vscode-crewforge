import type { TurnState } from './reducer';

const WORKING = new Set(['triaging', 'evaluating', 'waiting']);

/**
 * One line saying where the turn stands, from what the stream has reported: the
 * question in flight, the coordinator picking it up and choosing agents, agents still
 * working, then the coordinator writing the answer. Always ends with the elapsed time.
 */
export function turnStatus(turn: TurnState, now = Date.now()): string {
  return `${stage(turn)} · ${elapsed(now - turn.startedAt)}`;
}

function stage(turn: TurnState): string {
  if (!turn.connected) return 'Sending the question';
  if (!turn.threadId) return 'Waiting for the coordinator to pick up the question';
  if (turn.cards.length === 0) return 'The coordinator is choosing which agents to ask';
  const working = turn.cards.filter((c) => WORKING.has(c.status)).length;
  const waiting = turn.cards.filter((c) => c.status === 'waiting').length;
  if (waiting > 0 && waiting === working) return `${waiting} agent${waiting === 1 ? ' is' : 's are'} waiting for a GPU with room; the cluster is busy`;
  if (working > 0) return `${working} of ${turn.cards.length} agent${turn.cards.length === 1 ? '' : 's'} still working`;
  return 'The coordinator is writing the answer';
}

/** "12s", "3m 05s". */
export function elapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}
