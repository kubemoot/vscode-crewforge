/**
 * One event on a crew's discussion stream, as the gateway sends it over SSE.
 * Mirrors kmctl's discussion.Event so both clients read the same contract.
 */
export interface DiscussionEvent {
  type: EventType;
  agent?: string;
  status?: string;
  accelerator?: string;
  /** The deprecated old name of accelerator; read only when accelerator is absent. */
  gpu?: string;
  signal?: string;
  summary?: string;
  content?: string;
  threadId?: string;
  error?: string;
  stood_aside?: boolean;
  /** The model an agent is waiting for accelerator room to run. */
  model?: string;
  /** Why an agent is waiting or stood aside, such as accelerator-busy (gpu-busy from an older gateway) or model-too-large. */
  reason?: string;
  /**
   * The SSE id the event arrived under (not part of the JSON): where a reconnecting
   * client resumes once this event is handled.
   */
  id?: string;
  /** On a conversation_updated event: the conversation that has something new. */
  conversationId?: string;
  /** On a conversation_updated event: when the news was published, RFC 3339 in UTC. */
  at?: string;
}

export type EventType =
  | 'connected'
  | 'thread_found'
  | 'phase'
  | 'finding'
  | 'synthesis'
  | 'done'
  | 'heartbeat'
  /** On the conversation event stream: a conversation has something new. */
  | 'conversation_updated'
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
  return detail ? `The crew's gateway reported an error: ${detail}` : "The crew's gateway reported an error.";
}

/** The accelerator an event names: `accelerator`, else the deprecated `gpu` of an older gateway. */
export function acceleratorOf(e: Pick<DiscussionEvent, 'accelerator' | 'gpu'>): string | undefined {
  return e.accelerator || e.gpu || undefined;
}
