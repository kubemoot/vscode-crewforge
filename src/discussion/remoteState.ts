import type { KubeTransport } from '../k8s/request';
import { statePath } from './gatewayPath';

/** Where a conversation or one of its turns stands on the crew, as the gateway reads it from the bus. */
export type RemoteState = 'queued' | 'running' | 'paused' | 'stopped' | 'finished';

/** One turn of a conversation, as the gateway's state read gives it. */
export interface TurnStatus {
  threadId?: string;
  question?: string;
  state: RemoteState;
  /** A stop was sent to a running or paused turn and the coordinator has not closed it yet. */
  stopRequested?: boolean;
  /** On a queued turn: how many questions are ahead of it, counting the one being worked; 1 is next. */
  queuePosition?: number;
}

/** The gateway's answer to `GET .../state`. */
export interface ConversationStatus {
  conversationId: string;
  state: RemoteState;
  turns: TurnStatus[];
}

const STATES: readonly string[] = ['queued', 'running', 'paused', 'stopped', 'finished'];

function isStatus(body: unknown): body is ConversationStatus {
  const s = body as ConversationStatus | null;
  return typeof s === 'object' && s !== null && STATES.includes(s.state) && Array.isArray(s.turns);
}

/**
 * Reads where a conversation stands from the crew's gateway, so CrewForge offers Stop, Pause
 * and Resume by what the crew says, not by what this panel last did. Undefined when the
 * gateway cannot say: it is older than the state read, the conversation is not the caller's,
 * or the crew is away. The caller then goes by what its own panel shows.
 */
export async function readConversationState(client: KubeTransport, namespace: string, crew: string, conversationId: string): Promise<ConversationStatus | undefined> {
  try {
    const body: unknown = JSON.parse(await client.request('GET', statePath(namespace, crew, conversationId)));
    return isStatus(body) ? body : undefined;
  } catch {
    return undefined;
  }
}

/** The turn waiting nearest the front of the crew's queue, if one waits. */
export function waitingTurn(status: ConversationStatus | undefined): TurnStatus | undefined {
  return status?.turns.filter((t) => t.state === 'queued').sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0))[0];
}

/** Whether the state shows work in flight, so it is read again soon. */
export function isActive(state: RemoteState | undefined): boolean {
  return state === 'queued' || state === 'running' || state === 'paused';
}
