import type { ConversationActionId } from '../panels/conversationActions';
import type { RemoteState } from './remoteState';

/** Where a conversation stands for the menu: a turn running, paused, a question waiting in the crew's queue, or neither. */
export type ConversationState = 'running' | 'paused' | 'queued' | 'finished';

/**
 * The state of a conversation, from what the crew's gateway says when it said, else from the
 * turn streaming in this panel. A turn streaming here is running even when the crew's state is
 * older than the question.
 */
export function conversationState(remote: RemoteState | undefined, turnRunning: boolean): ConversationState {
  if (remote === 'paused' || remote === 'queued') return remote;
  return remote === 'running' || turnRunning ? 'running' : 'finished';
}

const CONTROLS: Record<ConversationState, readonly ConversationActionId[]> = {
  running: ['stop', 'pause'],
  paused: ['resume', 'stop'],
  // A question that has not begun is removed from the queue; it cannot be paused.
  queued: ['stop'],
  finished: [],
};

/** The stop, pause and resume a conversation in this state can take; deleting from the crew is always open. */
export function controlsFor(state: ConversationState): readonly ConversationActionId[] {
  return CONTROLS[state];
}

/** Whether `action` can be sent to a conversation in this state. */
export function canControl(state: ConversationState, action: ConversationActionId): boolean {
  return action === 'erase' || CONTROLS[state].includes(action);
}
