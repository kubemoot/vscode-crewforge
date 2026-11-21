import type { KubeTransport } from '../k8s/request';
import { DEFAULT_TIMING, isRetryable, pause, reconnectDelayMs } from './client';
import { eventsPath } from './gatewayPath';
import { SseParser } from './sse';
import type { DiscussionEvent } from './types';

/** A conversation the crew says has something new: a late answer, a reminder that fired, a follow-up. */
export interface ConversationNews {
  conversationId: string;
  /** What is new: `answer`, `reminder` or `followup`. */
  reason?: string;
  threadId?: string;
  at?: string;
}

/**
 * One subscription to a crew's conversation events (`GET /api/v1/discussions/{crew}/events`),
 * through the gateway client, never to NATS. The events carry no content: each names a
 * conversation, and the caller reads that conversation. A dropped stream is opened again
 * after a pause that doubles with each attempt that brings no news, and resumes after the
 * last event id received, so no news is lost or repeated. It ends for good on an error that
 * would fail the same way again (credentials, access, a gateway without the stream).
 */
export class ConversationEvents {
  private readonly stopper = new AbortController();
  private last = '';
  private failures = 0;
  private running?: Promise<void>;

  constructor(
    private readonly client: KubeTransport,
    private readonly namespace: string,
    private readonly crew: string,
    private readonly onNews: (news: ConversationNews) => void,
    /** Called once when the subscription ends because the stream cannot be had; not called by `stop`. */
    private readonly onEnd: (err: unknown) => void = () => undefined,
    private readonly reconnectMs = DEFAULT_TIMING.reconnectMs,
  ) {}

  /** The id of the last event received: where a reconnect resumes. Empty before the first. */
  get lastEventId(): string {
    return this.last;
  }

  /** Starts listening, once. Resolves when the subscription has ended, which `stop` or a fatal error does. */
  start(): Promise<void> {
    this.running ??= this.run();
    return this.running;
  }

  stop(): void {
    this.stopper.abort();
  }

  private async run(): Promise<void> {
    while (!this.stopper.signal.aborted) {
      const news = await this.connectOnce();
      if (news === 'fatal' || this.stopper.signal.aborted) return;
      this.failures = news === 'news' ? 1 : this.failures + 1;
      await pause(reconnectDelayMs(this.failures, this.reconnectMs), this.stopper.signal);
    }
  }

  /** Reads one connection until it ends. Reports whether it brought news, nothing, or an error that ends the subscription. */
  private async connectOnce(): Promise<'news' | 'quiet' | 'fatal'> {
    const parser = new SseParser();
    let brought = false;
    const deliver = (events: DiscussionEvent[]) => {
      for (const e of events) brought = this.handle(e) || brought;
    };
    try {
      await this.client.stream(eventsPath(this.namespace, this.crew, this.last), (chunk) => deliver(parser.push(chunk)), this.stopper.signal);
      deliver(parser.end());
    } catch (err) {
      if (this.stopper.signal.aborted) return 'quiet';
      if (!isRetryable(err)) {
        this.stopper.abort();
        this.onEnd(err);
        return 'fatal';
      }
    }
    return brought ? 'news' : 'quiet';
  }

  /** Remembers the event's id and passes on the news it carries. True for an event that is news. */
  private handle(e: DiscussionEvent): boolean {
    if (e.id) this.last = e.id;
    if (e.type !== 'conversation_updated' || !e.conversationId) return false;
    this.onNews({ conversationId: e.conversationId, reason: e.reason, threadId: e.threadId, at: e.at });
    return true;
  }
}
