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
  /**
   * The SSE id the event arrived under (not part of the JSON): where a reconnecting
   * client resumes once this event is handled.
   */
  id?: string;
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
  /** Not from the gateway: the client lost the stream before the answer and is reconnecting. */
  | 'reconnecting'
  | (string & {});

/** Reports whether an event ends a turn's stream. */
export function isTerminal(e: DiscussionEvent): boolean {
  return e.type === 'done' || e.type === 'error';
}

/** What an error event says went wrong, in plain words. */
export function eventErrorText(e: DiscussionEvent): string {
  const detail = e.error || e.content;
  return detail ? `The crew's discussion gateway reported an error: ${detail}` : "The crew's discussion gateway reported an error.";
}
