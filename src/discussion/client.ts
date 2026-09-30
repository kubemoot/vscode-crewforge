import { ConnectionError, KubeError, type KubeTransport } from '../k8s/request';
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
  /** The pause before the first reconnect after a drop; it doubles per failed attempt, up to ten times this. */
  reconnectMs: number;
}

export const DEFAULT_TIMING: TurnTiming = { firstEventMs: 30_000, idleMs: 90_000, maxMs: 600_000, reconnectMs: 500 };

export type TurnEnd =
  | { kind: 'done' }
  | { kind: 'error'; message: string }
  | { kind: 'aborted' }
  | { kind: 'timeout'; message: string };

/** A question the gateway queued: its conversation, and when the gateway queued it. */
export interface QueuedTurn {
  conversationId: string;
  /** The gateway's own time, sent back on the stream; absent from gateways that predate it. */
  requestedAt?: string;
}

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
): Promise<QueuedTurn> {
  const body = await client.request('POST', startPath(namespace, crew), { message, conversationId }, signal);
  let parsed: { conversationId?: unknown; requestedAt?: unknown };
  try {
    parsed = JSON.parse(body) as { conversationId?: unknown; requestedAt?: unknown };
  } catch {
    throw new Error(`The discussion gateway answered with something that is not JSON: ${body.slice(0, 200)}`);
  }
  if (typeof parsed.conversationId !== 'string' || !parsed.conversationId) {
    throw new Error(`The discussion gateway returned no conversationId: ${body.slice(0, 200)}`);
  }
  const requestedAt = typeof parsed.requestedAt === 'string' && parsed.requestedAt ? parsed.requestedAt : undefined;
  return { conversationId: parsed.conversationId, requestedAt };
}

/** The pause before reconnect attempt `failures` (1 for the first try after a drop). */
export function reconnectDelayMs(failures: number, baseMs = DEFAULT_TIMING.reconnectMs): number {
  return Math.min(baseMs * 2 ** Math.max(0, failures - 1), baseMs * 10);
}

/**
 * Reports whether a failed stream is worth opening again: a dropped connection, or a
 * 5xx or 429 while the gateway or the API server restarts. A 4xx (credentials, access,
 * a crew that is gone, a request the gateway rejects) or a local failure such as a
 * kubeconfig without a cluster will fail the same way again.
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof ConnectionError) return true;
  if (!(err instanceof KubeError) || err.status === undefined) return false;
  return err.status === 429 || err.status >= 500;
}

/**
 * Streams one turn, handing each event to `onEvent`, until the stream says done or
 * error, the caller aborts, or a safety net fires. A stream that drops before the
 * answer is opened again and resumes after the last event received, so no event is
 * lost or repeated; `onEvent` sees a `reconnecting` event while it is down.
 */
export async function streamTurn(
  client: KubeTransport,
  namespace: string,
  crew: string,
  turn: QueuedTurn,
  onEvent: (e: DiscussionEvent) => void,
  signal: AbortSignal,
  timing: TurnTiming = DEFAULT_TIMING,
): Promise<TurnEnd> {
  if (signal.aborted) return { kind: 'aborted' };
  const stream = new TurnStream(client, namespace, crew, turn, onEvent, timing);
  const onAbort = () => stream.finish({ kind: 'aborted' });
  signal.addEventListener('abort', onAbort);
  try {
    return await stream.run();
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** One turn's stream across however many connections it takes. */
class TurnStream {
  private end?: TurnEnd;
  private lastEventId = '';
  /** Why the connection dropped, while it is being reopened. */
  private lost?: string;
  private failures = 0;
  private readonly stop = new AbortController();
  private readonly watchdog: Watchdog;
  private readonly reconnectMs: number;

  constructor(
    private readonly client: KubeTransport,
    private readonly namespace: string,
    private readonly crew: string,
    private readonly turn: QueuedTurn,
    private readonly onEvent: (e: DiscussionEvent) => void,
    timing: TurnTiming,
  ) {
    this.reconnectMs = timing.reconnectMs;
    this.watchdog = new Watchdog(timing, (message) =>
      this.finish({ kind: 'timeout', message: this.lost ? `Lost the connection to the crew and could not reconnect: ${this.lost}` : message }),
    );
  }

  /**
   * Reads until the turn ends. A drop is reopened after a pause that doubles with each
   * attempt that brings no progress; the watchdog's idle window keeps running while the stream is down, so a
   * gateway that stays unreachable ends the turn with the reason it dropped.
   */
  async run(): Promise<TurnEnd> {
    this.watchdog.start();
    while (!this.end) {
      const dropped = await this.connectOnce();
      if (this.end) break;
      this.lost = dropped;
      this.failures++;
      this.onEvent({ type: 'reconnecting', error: dropped });
      await pause(reconnectDelayMs(this.failures, this.reconnectMs), this.stop.signal);
    }
    return this.end;
  }

  finish(result: TurnEnd): void {
    if (this.end) return;
    this.end = result;
    this.watchdog.clear();
    this.stop.abort();
  }

  /** Reads one connection until it ends, and returns why it ended short of the answer. */
  private async connectOnce(): Promise<string> {
    const parser = new SseParser();
    const path = streamPath(this.namespace, this.crew, this.turn.conversationId, { since: this.turn.requestedAt, lastEventId: this.lastEventId });
    try {
      await this.client.stream(path, (chunk) => this.deliverSafely(parser.push(chunk)), this.stop.signal);
      this.deliver(parser.end());
      return 'the stream closed before the crew finished its answer';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!isRetryable(err)) this.finish({ kind: 'error', message });
      return message;
    }
  }

  /** Delivers from inside the transport's data callback, where a throw would escape the turn. */
  private deliverSafely(events: DiscussionEvent[]): void {
    try {
      this.deliver(events);
    } catch (err) {
      this.finish({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  private deliver(events: DiscussionEvent[]): void {
    for (const e of events) {
      if (this.end) return;
      this.watchdog.sawEvent();
      this.lost = undefined;
      // The gateway's own connected and heartbeat events show it is up, not that the
      // turn moved; only progress resets the reconnect backoff.
      if (e.type !== 'connected' && e.type !== 'heartbeat') this.failures = 0;
      try {
        this.onEvent(e);
      } finally {
        if (e.id) this.lastEventId = e.id;
      }
      if (isTerminal(e)) this.finish(e.type === 'done' ? { kind: 'done' } : { kind: 'error', message: e.error || e.content || 'The discussion reported an error' });
    }
  }
}

/** Waits `ms`, or less when `signal` aborts first; never rejects. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** The three safety-net timers of a turn. */
export class Watchdog {
  private first?: ReturnType<typeof setTimeout>;
  private idle?: ReturnType<typeof setTimeout>;
  private max?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly timing: Pick<TurnTiming, 'firstEventMs' | 'idleMs' | 'maxMs'>,
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
