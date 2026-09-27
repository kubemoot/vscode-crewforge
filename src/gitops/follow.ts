import { rolloutState, type FluxState, type RolloutState } from './flux';

export interface FollowDeps {
  readFlux: () => Promise<FluxState>;
  crewReady: () => Promise<boolean>;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  report: (text: string) => void;
  now?: () => number;
}

export type FollowOutcome = RolloutState | 'stopped' | 'gave-up';

const REPORTS: Record<RolloutState, (s: FluxState) => string> = {
  waiting: (s) => `Waiting for a new chart revision to reach Flux (now ${s.revision ?? 'none'})`,
  reconciling: (s) => `Flux is rolling out ${s.revision ?? 'the new revision'}: ${s.message}`,
  done: (s) => `Rolled out ${s.revision ?? ''}; the crew is Ready`,
  failed: (s) => `Flux failed: ${s.message}`,
  suspended: () => 'The HelmRelease is suspended; Flux will not roll out until it is resumed',
};

const FINAL = new Set<RolloutState>(['done', 'failed', 'suspended']);

async function step(deps: FollowDeps, start: FluxState): Promise<RolloutState> {
  const now = await deps.readFlux();
  const state = rolloutState(start, now, await deps.crewReady());
  deps.report(REPORTS[state](now));
  return state;
}

/**
 * Follows a Flux rollout from the release Flux is at now until a newer revision is
 * installed and the crew is Ready, Flux reports a failure, the release is suspended, or
 * the developer stops. The limit is a safety net, not the way a rollout ends.
 */
export async function followRollout(deps: FollowDeps, signal: AbortSignal, intervalMs = 10_000, limitMs = 30 * 60_000): Promise<FollowOutcome> {
  const clock = deps.now ?? Date.now;
  const started = clock();
  const start = await deps.readFlux();
  deps.report(REPORTS.waiting(start));
  while (!signal.aborted && clock() - started < limitMs) {
    await deps.sleep(intervalMs, signal);
    if (signal.aborted) break;
    const state = await step(deps, start);
    if (FINAL.has(state)) return state;
  }
  return signal.aborted ? 'stopped' : 'gave-up';
}

/** A sleep that ends early, without error, when the signal aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
