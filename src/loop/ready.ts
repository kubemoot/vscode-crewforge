import type { AgentInfo } from '../crew/details';
import type { CrewSummary } from '../k8s/crews';
import { ANNOTATIONS } from '../source/deployments';

/** A deployed crew as the cluster reports it now: its Crew and its Agents. */
export interface CrewReadiness {
  crew?: CrewSummary;
  /** Undefined when the cluster does not serve Agents; the Crew alone then decides. */
  agents?: AgentInfo[];
}

export type ReadyState = 'ready' | 'waiting' | 'failed';

export interface ReadyVerdict {
  state: ReadyState;
  /** What the crew is doing, in plain words, for the progress notification. */
  message: string;
}

/** Phases that end a wait: the operator gave up on the object until something changes. */
const FAILED = new Set(['Error', 'Failed']);

/**
 * Whether a freshly deployed crew is ready. It is once the operator has seen this
 * deploy (its revision record names the deployed-at time CrewForge stamped; operators
 * without the record skip this), the Crew reports ready, and every one of its agents
 * does, as many as the Crew counts. An agent or Crew in a failed phase ends the wait.
 */
export function readiness(r: CrewReadiness): ReadyVerdict {
  const { crew, agents = [] } = r;
  if (!crew) return { state: 'waiting', message: 'Waiting for the Crew to appear' };
  const failed = agents.find((a) => FAILED.has(a.phase ?? ''));
  if (FAILED.has(crew.phase) || failed) return { state: 'failed', message: failedText(crew, failed) };
  if (!observed(crew)) return { state: 'waiting', message: 'Waiting for the operator to see this deploy' };
  if (!r.agents) return crew.ready ? { state: 'ready', message: 'Crew ready' } : { state: 'waiting', message: `Crew ${crew.phase}` };
  return agentsVerdict(crew, agents);
}

/** Ready when the Crew is and all its agents are, as many as it counts; else what is still starting. */
function agentsVerdict(crew: CrewSummary, agents: AgentInfo[]): ReadyVerdict {
  const ready = agents.filter((a) => a.ready).length;
  const expected = Math.max(crew.agents ?? 0, agents.length, 1);
  const line = `Crew ${crew.ready ? 'ready' : crew.phase}; ${ready} of ${expected} agents ready`;
  if (crew.ready && ready === expected) return { state: 'ready', message: line };
  const pending = agents.find((a) => !a.ready);
  return { state: 'waiting', message: pending ? `${line} (${pending.name}: ${pending.phase ?? 'starting'})` : line };
}

/** True when the operator's revision record shows the deploy stamped on the Crew, or keeps no record. */
function observed(crew: CrewSummary): boolean {
  const stamped = crew.annotations?.[ANNOTATIONS.deployedAt];
  if (!stamped || crew.revisions === undefined) return true;
  return crew.revisions[0]?.deployedAt === stamped;
}

function failedText(crew: CrewSummary, agent?: AgentInfo): string {
  if (agent) return `Agent ${agent.name} is ${agent.phase}`;
  return `Crew ${crew.name} is ${crew.phase}${crew.message ? `: ${crew.message}` : ''}`;
}

export interface WaitDeps {
  read: () => Promise<CrewReadiness>;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  report: (text: string) => void;
  now?: () => number;
}

export type WaitOutcome = { outcome: 'ready' | 'failed' | 'stopped' | 'gave-up'; message: string };

/**
 * Follows a deployed crew until it is ready, it fails, or the developer stops. The
 * limit is a safety net for a crew that never settles, not the way a wait ends.
 */
export async function waitUntilReady(deps: WaitDeps, signal: AbortSignal, intervalMs = 3_000, limitMs = 15 * 60_000): Promise<WaitOutcome> {
  const clock = deps.now ?? Date.now;
  const started = clock();
  let last = 'Waiting for the crew';
  while (!signal.aborted && clock() - started < limitMs) {
    const verdict = readiness(await deps.read());
    last = verdict.message;
    deps.report(last);
    if (verdict.state !== 'waiting') return { outcome: verdict.state, message: last };
    await deps.sleep(intervalMs, signal);
  }
  return { outcome: signal.aborted ? 'stopped' : 'gave-up', message: last };
}
