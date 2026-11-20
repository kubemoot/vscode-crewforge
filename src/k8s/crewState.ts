import type { CrewCondition, CrewRetentionStatus, CrewSummary } from './crews';

/** The condition the operator writes when it has checked the model catalog for a crew. */
export const CAPACITY_CONDITION = 'CapacityAvailable';
/** The condition the operator writes when it has checked spec.retention. */
export const RETENTION_CONDITION = 'RetentionValid';

const PHASE_READY = 'Ready';
const PHASE_WAITING = 'WaitingForCapacity';
/** The phase CrewForge shows when status.phase is absent. */
const PHASE_ABSENT = 'Unknown';

/** Whether a crew can answer a question now, and if not, what it is waiting for. */
export type CanAnswer = { ok: true } | { ok: false; reason: string; kind: 'capacity' | 'other' };

const withMessage = (prefix: string, message?: string): string => (message ? `${prefix}: ${message}` : prefix);

/** The condition of a type, or undefined when the operator reports none. */
export function conditionOf(crew: Pick<CrewSummary, 'conditions'>, type: string): CrewCondition | undefined {
  return crew.conditions?.find((c) => c.type === type);
}

/** True when the status describes an older generation of the Crew; a status without observedGeneration (0.95) is never stale. */
function stale(crew: CrewSummary): boolean {
  const { generation, observedGeneration } = crew;
  return observedGeneration !== undefined && observedGeneration > 0 && generation !== undefined && observedGeneration < generation;
}

/** Why a crew is not reconciled as declared, or undefined when it is. Reads status.ready and the generation, never capacity. */
export function notReconciled(crew: CrewSummary): string | undefined {
  if (stale(crew)) return 'waiting for the operator to reconcile the latest change';
  if (crew.phase === 'Error') return withMessage('the crew failed to reconcile', crew.message);
  return crew.ready ? undefined : withMessage('waiting for the crew to reconcile', crew.message);
}

/** What a reconciled crew without capacity is waiting for: False carries the scheduler's reason, Unknown means no coordinator runs yet. */
function capacityWaiting(capacity: CrewCondition): string {
  return withMessage(capacity.status === 'False' ? 'waiting for an accelerator' : 'waiting for the coordinator to run', capacity.message);
}

/**
 * Whether the crew can answer now: reconciled as declared, phase Ready, and
 * CapacityAvailable True. Against an operator without CapacityAvailable (0.95) it is
 * the reconciled crew whose phase is Ready or not reported.
 */
export function canAnswer(crew: CrewSummary): CanAnswer {
  const unreconciled = notReconciled(crew);
  if (unreconciled) return { ok: false, reason: unreconciled, kind: 'other' };
  const capacity = conditionOf(crew, CAPACITY_CONDITION);
  if (capacity && capacity.status !== 'True') return { ok: false, reason: capacityWaiting(capacity), kind: 'capacity' };
  if (crew.phase === PHASE_WAITING) return { ok: false, reason: withMessage('waiting for an accelerator', crew.message), kind: 'capacity' };
  if (crew.phase !== PHASE_ABSENT && crew.phase !== PHASE_READY) return { ok: false, reason: `waiting for the crew to become Ready (phase ${crew.phase})`, kind: 'other' };
  return { ok: true };
}

/** The CapacityAvailable condition in a line, or undefined on an operator without it. */
export function capacityLine(crew: CrewSummary): string | undefined {
  const capacity = conditionOf(crew, CAPACITY_CONDITION);
  if (!capacity) return undefined;
  if (capacity.status === 'True') return 'Capacity: available';
  return `Capacity: ${capacityWaiting(capacity)}`;
}

/** The last cleanup run as lines: when, what it removed, and why it failed. */
function cleanupLines(r: CrewRetentionStatus): string[] {
  const lines = [r.lastRunTime ? `Last retention cleanup: ${r.lastRunTime}` : 'Last retention cleanup: not run yet'];
  if (r.removed) lines.push(`Removed: ${r.removed.conversations ?? 0} conversations, ${r.removed.memory ?? 0} memory, ${r.removed.other ?? 0} other`);
  if (r.error) lines.push(`Retention cleanup error: ${r.error}`);
  return lines;
}

/** The retention status as lines: an invalid declaration, then the last cleanup run. */
export function retentionLines(crew: CrewSummary): string[] {
  const valid = conditionOf(crew, RETENTION_CONDITION);
  const invalid = valid && valid.status !== 'True' ? [withMessage(`Retention: ${valid.reason ?? 'invalid'}`, valid.message)] : [];
  return [...invalid, ...(crew.retention ? cleanupLines(crew.retention) : [])];
}
