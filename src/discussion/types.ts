/**
 * One event on a crew's discussion stream, as the discussion gateway sends it over SSE.
 * Mirrors kmctl's discussion.Event so both clients read the same contract.
 */
export interface DiscussionEvent {
  type: EventType;
  agent?: string;
  status?: string;
  gpu?: string;
  signal?: string;
  summary?: string;
  content?: string;
  threadId?: string;
  error?: string;
  stood_aside?: boolean;
  /** The model an agent is waiting for GPU room to run. */
  model?: string;
  /** Why an agent is waiting or stood aside, such as gpu-busy or model-too-large. */
  reason?: string;
}

export type EventType =
  | 'connected'
  | 'thread_found'
  | 'phase'
  | 'finding'
  | 'synthesis'
  | 'done'
  | 'heartbeat'
  | 'error'
  | (string & {});

/** Reports whether an event ends a turn's stream. */
export function isTerminal(e: DiscussionEvent): boolean {
  return e.type === 'done' || e.type === 'error';
}
