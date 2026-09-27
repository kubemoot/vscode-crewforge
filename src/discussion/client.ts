import type { KubeTransport } from '../k8s/request';
import { startPath, streamPath } from './proxyPath';
import { SseParser } from './sse';
import { isTerminal, type DiscussionEvent } from './types';

/** Safety nets for a turn. The normal path ends on the stream's own `done` event. */
export interface TurnTiming {
  /** No event at all within this long means the gateway is not answering. */
  firstEventMs: number;
  /**
   * This long without any event means the stream has stalled. The gateway sends a
   * heartbeat every 30 s, so this is three missed heartbeats: one delayed on its way
   * through a tunnel is not a stall.
   */
  idleMs: number;
  /** The longest a single turn may stream. */
  maxMs: number;
}

export const DEFAULT_TIMING: TurnTiming = { firstEventMs: 30_000, idleMs: 90_000, maxMs: 600_000 };

export type TurnEnd =
  | { kind: 'done' }
  | { kind: 'error'; message: string }
  | { kind: 'aborted' }
  | { kind: 'timeout'; message: string }
  | { kind: 'closed'; message: string };

/**
 * Starts a turn. An empty `conversationId` starts a new conversation; the gateway's
 * reply carries the id to send with the next message.
 */
export async function ask(
  client: KubeTransport,
  namespace: string,
  crew: string,
  message: string,
  conversationId = '',
  signal?: AbortSignal,
): Promise<string> {
  const body = await client.request('POST', startPath(namespace, crew), { message, conversationId }, signal);
  let parsed: { conversationId?: unknown };
  try {
    parsed = JSON.parse(body) as { conversationId?: unknown };
  } catch {
    throw new Error(`The discussion gateway answered with something that is not JSON: ${body.slice(0, 200)}`);
  }
  if (typeof parsed.conversationId !== 'string' || !parsed.conversationId) {
    throw new Error(`The discussion gateway returned no conversationId: ${body.slice(0, 200)}`);
  }
  return parsed.conversationId;
}

/**
 * Streams one turn, handing each event to `onEvent`, until the stream says done or
 * error, the caller aborts, a safety net fires, or the server closes the stream.
 */
export async function streamTurn(
  client: KubeTransport,
  namespace: string,
  crew: string,
  conversationId: string,
  onEvent: (e: DiscussionEvent) => void,
  signal: AbortSignal,
  timing: TurnTiming = DEFAULT_TIMING,
): Promise<TurnEnd> {
  const stop = new AbortController();
  const watchdog = new Watchdog(timing, (message) => finish({ kind: 'timeout', message }));
  let end: TurnEnd | undefined;
  function finish(result: TurnEnd): void {
    if (end) return;
    end = result;
    watchdog.clear();
    stop.abort();
  }
  const onAbort = () => finish({ kind: 'aborted' });
  if (signal.aborted) return { kind: 'aborted' };
  signal.addEventListener('abort', onAbort);

  const parser = new SseParser();
  const deliver = (events: DiscussionEvent[]) => {
    for (const e of events) {
      if (end) return;
      watchdog.sawEvent();
      onEvent(e);
      if (isTerminal(e)) finish(e.type === 'done' ? { kind: 'done' } : { kind: 'error', message: e.error || e.content || 'The discussion reported an error' });
    }
  };
  try {
    watchdog.start();
    await client.stream(streamPath(namespace, crew, conversationId), (chunk) => deliver(parser.push(chunk)), stop.signal);
    deliver(parser.end());
    finish({ kind: 'closed', message: 'The stream closed before the crew finished its answer.' });
  } catch (err) {
    finish({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  return end as TurnEnd;
}

/** The three safety-net timers of a turn. */
export class Watchdog {
  private first?: ReturnType<typeof setTimeout>;
  private idle?: ReturnType<typeof setTimeout>;
  private max?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly timing: TurnTiming,
    private readonly fire: (message: string) => void,
  ) {}

  start(): void {
    this.first = setTimeout(
      () => this.fire('No response from the crew. Its discussion gateway may be unreachable, or no agent answered in time.'),
      this.timing.firstEventMs,
    );
    this.max = setTimeout(
      () => this.fire(`The turn ran longer than ${Math.round(this.timing.maxMs / 1000)} s and was stopped. The crew may still finish; ask again to see.`),
      this.timing.maxMs,
    );
  }

  sawEvent(): void {
    if (this.first) clearTimeout(this.first);
    this.first = undefined;
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(
      () => this.fire('The discussion went quiet without a final answer. Agents may have stood aside, or the coordinator did not synthesize.'),
      this.timing.idleMs,
    );
  }

  clear(): void {
    for (const t of [this.first, this.idle, this.max]) if (t) clearTimeout(t);
    this.first = this.idle = this.max = undefined;
  }
}
