import { runControls, shownPhase, type SuiteControls } from '../fitness/controls';
import { isRunning, runSummary, scenarioResults, type FitnessRun, type ScenarioResult } from '../fitness/fitness';
import type { SuiteIteration, SuiteScores } from '../kubemoot/dashboardApi';
import { badge, between, buttons, duration, escape, facts, note, section, SELECT_CONTEXT_BUTTON, table, type ButtonSpec } from './html';

/** What the fitness dashboard reads for one deployment. */
export interface FitnessView {
  crew: string;
  namespace: string;
  runs: FitnessRun[];
  /** The run shown in detail: the one asked for, else the newest. */
  selected?: FitnessRun;
  controls: SuiteControls;
  /** The selected suite's iterations still in the cluster. */
  iterations: FitnessRun[];
  /** The selected suite's iterations from the Kubemoot dashboard, once the cluster no longer has them. */
  archived?: SuiteIteration[] | { unavailable: string };
  scores?: SuiteScores | { unavailable: string };
  /** The XLSX download address, when the Kubemoot dashboard URL is set. */
  xlsxUrl?: string;
  /** Why fitness cannot run from here, if it cannot (no source, no definitions). */
  cannotRun?: string;
  error?: string;
}

const TONE: Record<string, 'good' | 'warn' | 'bad'> = { Passed: 'good', Completed: 'good', Failed: 'bad', Error: 'bad', Timeout: 'bad', Cancelled: 'warn', Paused: 'warn', Pausing: 'warn', Stopping: 'warn' };

export function renderFitnessPage(v: FitnessView): string {
  const busy = v.runs.some(isRunning);
  const top: ButtonSpec[] = [
    { action: 'run', label: 'Run Fitness', title: 'Run one of the crew\'s fitness definitions', disabled: busy ? 'A fitness run for this crew is in progress.' : v.cannotRun, primary: true },
    { action: 'refresh', label: 'Refresh', title: 'Read the runs again' },
    ...(v.error ? [SELECT_CONTEXT_BUTTON] : []),
  ];
  const error = v.error ? `<p class="error">${escape(v.error)}</p>` : '';
  return `<h1>Fitness: ${escape(v.crew)}</h1><p class="muted">${escape(v.namespace)}</p>${error}${buttons(top)}${runsSection(v)}${v.selected ? runSection(v, v.selected) : ''}`;
}

function runsSection(v: FitnessView): string {
  const rows = v.runs.map((r) => [
    `<button type="button" class="link" data-action="select" data-arg="${escape(r.name)}" title="Show this run">${escape(r.name)}</button>`,
    escape(r.kind === 'CrewFitnessSuite' ? 'suite' : 'single'),
    phaseBadge(r),
    escape(progressText(r)),
    escape(r.startedAt ?? r.createdAt),
    escape(between(r.startedAt ?? r.createdAt, r.completedAt) ?? ''),
  ]);
  return section('Runs', table(['Run', 'Kind', 'Phase', 'Progress', 'Started', 'Duration'], rows, 'No fitness runs yet.'));
}

function phaseBadge(r: FitnessRun): string {
  const phase = shownPhase(r);
  return badge(phase, TONE[phase] ?? 'plain');
}

function progressText(r: FitnessRun): string {
  if (r.iterationsTotal) return `${r.iterationsCompleted ?? 0} of ${r.iterationsTotal} iterations`;
  return runSummary(r);
}

function runSection(v: FitnessView, r: FitnessRun): string {
  const controls = runControls(r, v.controls);
  const specs: ButtonSpec[] = [];
  if (controls.pause) specs.push({ action: 'pause', arg: r.name, label: 'Pause', title: 'Pause between iterations; the running iteration finishes (spec.suspend)' });
  if (controls.resume) specs.push({ action: 'resume', arg: r.name, label: 'Resume', title: 'Resume the paused suite' });
  if (controls.stop) specs.push({ action: 'stop', arg: r.name, label: 'Stop', title: r.kind === 'CrewFitnessSuite' ? 'Stop the suite; it becomes Cancelled (spec.cancel)' : 'Stop this single-scenario run (deletes it)' });
  if (r.artifact) specs.push({ action: 'xlsx', arg: r.name, label: 'Open XLSX', title: 'Download the results workbook from the Kubemoot dashboard', disabled: v.xlsxUrl ? undefined : 'Set crewforge.dashboardUrl to download the XLSX.' });
  const progress = r.iterationsTotal ? `<progress max="${r.iterationsTotal}" value="${r.iterationsCompleted ?? 0}"></progress>` : '';
  const body = [facts(runFacts(r)), progress, buttons(specs), r.kind === 'CrewFitnessSuite' ? suiteDetail(v, r) : singleDetail(r)].join('');
  return section(`Run ${r.name}`, body);
}

function runFacts(r: FitnessRun): [string, unknown][] {
  return [
    ['Phase', shownPhase(r)],
    ['Progress', progressText(r)],
    ['Passed / failed / errored', r.passed === undefined ? undefined : `${r.passed ?? 0} / ${r.failed ?? 0} / ${r.errored ?? 0}`],
    ['Started', r.startedAt ?? r.createdAt],
    ['Completed', r.completedAt],
    ['Duration', duration(r.durationMs) ?? between(r.startedAt, r.completedAt)],
    ['Run id', r.runId],
    ['Results workbook', r.artifact && `${r.artifact.bucket}/${r.artifact.objectKey}`],
    ['Error', r.error],
  ];
}

function suiteDetail(v: FitnessView, r: FitnessRun): string {
  const live = v.iterations.map((i) => ({ scenario: i.testRef ?? i.name, status: i.phase, durationMs: i.durationMs }));
  const archived = Array.isArray(v.archived) ? v.archived.map((i) => ({ scenario: i.scenario, status: i.status, durationMs: i.durationMs })) : [];
  const results = scenarioResults(r.scripts ?? [], live.length ? live : archived);
  const scores = v.scores && 'unavailable' in v.scores ? undefined : v.scores?.scores;
  const rows = results.map((s) => scenarioRow(s, scores?.[s.scenario]));
  const where = live.length ? 'From the iterations in the cluster.' : archivedNote(v.archived);
  return `<h3>Scenarios</h3>${table(['Scenario', 'Done', 'Passed', 'Failed', 'Errored', 'Mean duration', 'Score'], rows, 'No iterations yet.')}${note(where)}<p>${escape(`Judge: ${judgeText(r, v.scores)}`)}</p>`;
}

function scenarioRow(s: ScenarioResult, score?: number): string[] {
  const running = s.running ? ` (+${s.running} running)` : '';
  return [escape(s.scenario), escape(`${s.done}${running}`), escape(s.passed), escape(s.failed), escape(s.errored), escape(duration(s.meanMs) ?? ''), escape(score ?? '')];
}

function archivedNote(archived: FitnessView['archived']): string {
  if (!archived) return 'The cluster no longer holds the iterations.';
  return 'unavailable' in archived ? `The cluster no longer holds the iterations. ${archived.unavailable}` : 'From the iteration transcripts the Kubemoot dashboard keeps.';
}

/** Where the deferred judge stands for a suite run. */
export function judgeText(r: FitnessRun, scores?: SuiteScores | { unavailable: string }): string {
  if (r.phase === 'Cancelled') return 'skipped, since the suite was cancelled';
  if (isRunning(r)) return 'waits for the suite to finish';
  if (!scores) return 'unknown';
  if ('unavailable' in scores) return `unknown (${scores.unavailable})`;
  const total = r.scripts?.length ?? 0;
  if (scores.complete) return `done, ${scores.judged ?? 0} scenarios scored`;
  return `judging, ${scores.judged ?? 0} of ${total} scenarios scored`;
}

function singleDetail(r: FitnessRun): string {
  const rows = r.assertions.map((a) => [a.passed ? badge('pass', 'good') : badge('fail', 'bad'), escape(a.raw), escape(a.message)]);
  return `<h3>Assertions</h3>${table(['', 'Assertion', 'Result'], rows, isRunning(r) ? 'Running...' : 'No assertions reported.')}`;
}
