import type { ConversationActionId } from '../panels/conversationActions';

/** Where a conversation stands on the crew, as far as CrewForge knows: a turn running, paused by CrewForge, or neither. */
export type ConversationState = 'running' | 'paused' | 'finished';

/** The state of a conversation: paused once CrewForge paused it, else running while a turn streams, else finished. */
export function conversationState(turnRunning: boolean, paused: boolean): ConversationState {
  if (paused) return 'paused';
  return turnRunning ? 'running' : 'finished';
}

const CONTROLS: Record<ConversationState, readonly ConversationActionId[]> = {
  running: ['stop', 'pause'],
  paused: ['resume', 'stop'],
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
