import type { KubeTransport } from '../k8s/request';
import { titleFrom, type ChatSignal, type Conversation } from '../store/conversation';
import { ask, DEFAULT_TIMING, streamTurn, type TurnEnd, type TurnTiming } from './client';
import { initialTurn, reduce, type TurnState } from './reducer';
import type { DiscussionEvent } from './types';

/** What a chat panel renders. */
export interface SessionView {
  conversation: Conversation;
  turn?: TurnState;
  busy: boolean;
}

/**
 * One conversation with one crew: sends each question, folds the stream into the turn,
 * appends the answer, and saves after every turn. Knows nothing about VS Code.
 */
export class ChatSession {
  private turn?: TurnState;
  private controller?: AbortController;

  constructor(
    private readonly client: KubeTransport,
    private conversation: Conversation,
    private readonly save: (c: Conversation) => Promise<void>,
    private readonly onChange: (view: SessionView) => void,
    private readonly timing: TurnTiming = DEFAULT_TIMING,
  ) {}

  get view(): SessionView {
    return { conversation: this.conversation, turn: this.turn, busy: this.controller !== undefined };
  }

  get busy(): boolean {
    return this.controller !== undefined;
  }

  /** Replaces the conversation shown, when no turn is running. */
  load(conversation: Conversation): void {
    if (this.busy) return;
    this.conversation = conversation;
    this.emit();
  }

  /** Stops the running turn; what arrived so far is kept and saved. */
  stop(): void {
    this.controller?.abort();
  }

  async send(text: string): Promise<void> {
    const question = text.trim();
    if (!question || this.busy) return;
    const c = this.conversation;
    if (c.messages.length === 0) c.title = titleFrom(question);
    c.messages.push({ role: 'user', content: question, timestamp: now() });
    this.turn = initialTurn();
    this.controller = new AbortController();
    this.emit();

    const signal = this.controller.signal;
    let end: TurnEnd;
    try {
      const queued = await ask(this.client, c.namespace, c.crewName, question, c.conversationId ?? '', signal);
      c.conversationId = queued.conversationId;
      end = await streamTurn(this.client, c.namespace, c.crewName, queued, (e) => this.onEvent(e), signal, this.timing);
    } catch (err) {
      end = signal.aborted ? { kind: 'aborted' } : { kind: 'error', message: err instanceof Error ? err.message : String(err) };
    }
    await this.finish(end);
  }

  private onEvent(e: DiscussionEvent): void {
    if (!this.turn) return;
    this.turn = reduce(this.turn, e);
    if (e.type === 'thread_found' && e.threadId) this.conversation.threadIds.push(e.threadId);
    const signal = toSignal(e);
    if (signal) this.conversation.signals.push(signal);
    this.emit();
  }

  private async finish(end: TurnEnd): Promise<void> {
    const c = this.conversation;
    const synthesis = this.turn?.synthesis;
    if (synthesis) c.messages.push({ role: 'assistant', content: synthesis, timestamp: now(), agentName: 'Crew' });
    const notice = noticeFor(end, synthesis !== undefined);
    if (notice) c.messages.push({ role: 'system', content: notice, timestamp: now() });
    // Saved before the turn ends on screen, so the refreshed conversation list includes it.
    try {
      await this.save(c);
    } catch {
      // A failed save must not lose the answer on screen; the next turn saves again.
    }
    this.turn = undefined;
    this.controller = undefined;
    this.emit();
  }

  private emit(): void {
    this.onChange(this.view);
  }
}

/** The line shown when a turn ends without a normal answer, or undefined when it has one. */
export function noticeFor(end: TurnEnd, answered: boolean): string | undefined {
  switch (end.kind) {
    case 'done':
      return answered ? undefined : 'The crew finished without an answer.';
    case 'aborted':
      return answered ? undefined : 'Stopped.';
    default:
      return answered ? undefined : end.message;
  }
}

function toSignal(e: DiscussionEvent): ChatSignal | undefined {
  if (e.type === 'phase') {
    return { type: e.status || 'phase', agentName: e.agent || '', timestamp: now(), data: compact({ gpu: e.gpu, signal: e.signal, stoodAside: e.stood_aside }) };
  }
  if (e.type === 'finding') {
    return { type: e.signal || 'finding', agentName: e.agent || '', timestamp: now(), data: compact({ summary: e.summary }) };
  }
  return undefined;
}

function compact(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(data).filter(([, v]) => v !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function now(): string {
  return new Date().toISOString();
}
