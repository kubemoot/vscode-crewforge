/** The line that stands where an answer would be, for a turn the person stopped. */
export const STOPPED_NOTICE = 'Stopped by you. The crew did not answer this turn.';

/** Where a question that waits in the crew's queue stands: how many questions are ahead of it. */
export function queueNote(ahead: number): string {
  if (ahead <= 0) return "Waiting in the crew's queue: next to be taken.";
  return `Waiting in the crew's queue: ${ahead} question${ahead === 1 ? '' : 's'} ahead.`;
}
