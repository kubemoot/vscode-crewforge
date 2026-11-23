import { runControls, shownPhase, type SuiteControls } from '../fitness/controls';
import { META_SEPARATOR } from '../webview/render';
import { failureOf, gateCounts, hasFailedGates, isRunning, runSummary, scenarioResults, scenarioResultsFromStatus, type FitnessRun, type JudgeScore, type ScenarioResult, type SuiteJudge } from '../fitness/fitness';
import { ACTIONS, GATES_LEGEND, HEADINGS, TERMS } from '../definitions';
import { badge, between, buttons, heading, duration, escape, facts, moment, note, section, SELECT_CONTEXT_BUTTON, table, type ButtonSpec, type Shown } from './html';

/** What the fitness dashboard reads for one deployment. */
export interface FitnessView {
  /** The crew's technical name. */
  crew: string;
  /** The name people read: the crew's display name, else its technical name. */
  title: string;
  namespace: string;
  runs: FitnessRun[];
  /** The run shown in detail: the one asked for, else the newest. */
  selected?: FitnessRun;
  controls: SuiteControls;
  /** The selected suite's iterations still in the cluster. */
  iterations: FitnessRun[];
  /** The XLSX download address, when the Kubemoot dashboard URL is set. */
  xlsxUrl?: string;
  /** The Kubemoot dashboard's Fitness page, for a person to read the transcripts; set when its URL is. */
  dashboardRunUrl?: string;
  /** Why fitness cannot run from here, if it cannot (no source, no definitions). */
  cannotRun?: string;
  error?: string;
}

const TONE: Record<string, 'good' | 'warn' | 'bad'> = { Passed: 'good', Completed: 'good', Failed: 'bad', Error: 'bad', Timeout: 'bad', Cancelled: 'warn', Paused: 'warn', Pausing: 'warn', Stopping: 'warn' };

export function renderFitnessPage(v: FitnessView): string {
  const busy = v.runs.some(isRunning);
  const top: ButtonSpec[] = [
    { action: 'run', label: 'Run Fitness', title: ACTIONS.runFitness, disabled: busy ? 'A fitness run for this crew is in progress.' : v.cannotRun, primary: true },
    { action: 'refresh', label: 'Refresh', title: ACTIONS.refreshRuns },
    ...(v.error ? [SELECT_CONTEXT_BUTTON] : []),
  ];
  const error = v.error ? `<p class="error">${escape(v.error)}</p>` : '';
  const where = v.title === v.crew ? v.namespace : `${v.crew} · ${v.namespace}`;
  const title = heading('h1', `Fitness: ${escape(v.title)}`, TERMS.fitness);
  return `${title}<p class="muted">${escape(where)}</p>${error}${buttons(top)}${runsSection(v)}${v.selected ? runSection(v, v.selected) : ''}`;
}

function runsSection(v: FitnessView): string {
  const rows = v.runs.map((r) => [
    `<button type="button" class="link" data-action="select" data-arg="${escape(r.name)}" title="${escape(ACTIONS.showRun)}">${escape(r.name)}</button>`,
    escape(r.kind === 'CrewFitnessSuite' ? 'suite' : 'single'),
    phaseBadge(r),
    escape(progressText(r)),
    escape(moment(r.startedAt ?? r.createdAt)),
    escape(between(r.startedAt ?? r.createdAt, r.completedAt) ?? ''),
  ]);
  return section('Runs', table(['Run', 'Kind', 'Phase', 'Progress', 'Started', 'Duration'], rows, 'No fitness runs yet.'));
}

/** A suite that Completed with a failed or errored gate is not clean, so it reads warn, not good. */
function toneOf(r: FitnessRun, phase: string): 'good' | 'warn' | 'bad' | 'plain' {
  if (phase === 'Completed' && hasFailedGates(r)) return 'warn';
  return TONE[phase] ?? 'plain';
}

function phaseBadge(r: FitnessRun): string {
  const phase = shownPhase(r);
  const unclean = phase === 'Completed' && hasFailedGates(r) ? ' It finished, but a gate failed or errored.' : '';
  return badge(phase, toneOf(r, phase), `Where the run is: ${phase}.${unclean}`);
}

function progressText(r: FitnessRun): string {
  if (r.iterationsTotal) return `${r.iterationsCompleted ?? 0} of ${r.iterationsTotal} iterations`;
  return runSummary(r);
}

function runSection(v: FitnessView, r: FitnessRun): string {
  const progress = r.iterationsTotal && isRunning(r) ? `<progress max="${r.iterationsTotal}" value="${r.iterationsCompleted ?? 0}" title="${escape(ACTIONS.showProgress)}" aria-label="${escape(ACTIONS.showProgress)}"></progress>` : '';
  const body = [result(r), failureLine(r), progress, buttons(runButtons(v, r)), r.kind === 'CrewFitnessSuite' ? suiteDetail(v, r) : singleDetail(r), facts(runFacts(r))].join('');
  return section(r.name, body, `${TERMS.fitnessRun} This is ${r.name}.`);
}

function runButtons(v: FitnessView, r: FitnessRun): ButtonSpec[] {
  const controls = runControls(r, v.controls);
  const specs: ButtonSpec[] = [];
  if (controls.pause) specs.push({ action: 'pause', arg: r.name, label: 'Pause', title: ACTIONS.pause });
  if (controls.resume) specs.push({ action: 'resume', arg: r.name, label: 'Resume', title: ACTIONS.resume });
  if (controls.stop) specs.push({ action: 'stop', arg: r.name, label: 'Stop', title: r.kind === 'CrewFitnessSuite' ? ACTIONS.stopSuite : ACTIONS.stopSingle });
  if (r.artifact) specs.push({ action: 'xlsx', arg: r.name, label: 'Open XLSX', title: ACTIONS.xlsx, disabled: v.xlsxUrl ? undefined : 'Set crewforge.dashboardUrl to download the XLSX.' });
  if (r.kind === 'CrewFitnessSuite') specs.push({ action: 'openDashboard', arg: r.name, label: 'Open in Kubemoot dashboard', title: ACTIONS.openRunInDashboard, disabled: v.dashboardRunUrl ? undefined : 'Set crewforge.dashboardUrl to open the Kubemoot dashboard.' });
  return specs;
}

/** The result of a run on one line, the first thing the section shows: its phase, the gate counts, the judge's score, and how long it took. */
function result(r: FitnessRun): string {
  const counts = r.passed === undefined ? '' : gateCounts(r);
  const score = r.judge?.mean === undefined ? '' : `judge score ${r.judge.mean}`;
  const took = duration(r.durationMs) ?? between(r.startedAt, r.completedAt);
  const line = [counts, score, isRunning(r) ? progressText(r) : '', took].filter(Boolean).join(META_SEPARATOR);
  return `<p class="summary">${phaseBadge(r)} ${escape(line)}</p>`;
}

/** Why an Error or ToolSmokeFailed run did not execute, as its own line under the result. */
function failureLine(r: FitnessRun): string {
  const why = failureOf(r);
  return why ? `<p class="error">Failure: ${escape(why)}</p>` : '';
}

/** What the result line leaves out: when the run started and finished, and why it failed. */
function runFacts(r: FitnessRun): [string, Shown][] {
  return [
    ['Started', moment(r.startedAt ?? r.createdAt)],
    ['Completed', moment(r.completedAt)],
    ['Error', r.error === failureOf(r) ? undefined : r.error],
  ];
}

function suiteDetail(v: FitnessView, r: FitnessRun): string {
  const live = v.iterations.map((i) => ({ scenario: i.testRef ?? i.name, status: i.phase, durationMs: i.durationMs }));
  const results = live.length ? scenarioResults(r.scripts ?? [], live) : scenarioResultsFromStatus(r.scripts ?? [], r.scenarios ?? []);
  const scores = new Map((r.judge?.scores ?? []).map((s) => [s.scenario, s]));
  const reasons = new Map((r.scenarios ?? []).map((s) => [s.name, s.failureReason]));
  const rows = withScoredOnly(results, scores).map((s) => scenarioRow(s, scores.get(s.scenario), s.failureReason ?? reasons.get(s.scenario)));
  const where = live.length ? 'From the iterations in the cluster.' : statusNote(r);
  const judge = `Judge: ${judgeText(r)}`;
  return `${heading('h3', 'Scenarios', HEADINGS.Scenarios)}${legend()}${table(['Scenario', 'Done', 'Gates passed', 'Gates failed', 'Errored', 'Mean duration', 'Judge score', 'Judge reason', 'Failure reason'], rows, 'No iterations yet.')}${note(where)}<p>${escape(judge)}</p>`;
}

/** Adds a row for each judged scenario the results do not list, so no score goes unshown. */
function withScoredOnly(results: ScenarioResult[], scores: Map<string, JudgeScore>): ScenarioResult[] {
  const listed = new Set(results.map((s) => s.scenario));
  const extra = [...scores.keys()].filter((name) => !listed.has(name)).map((scenario) => ({ scenario, done: 0, passed: 0, failed: 0, errored: 0, running: 0 }));
  return [...results, ...extra];
}

function scenarioRow(s: ScenarioResult, score?: JudgeScore, failure?: string): string[] {
  const running = s.running ? ` (+${s.running} running)` : '';
  return [escape(s.scenario), escape(`${s.done}${running}`), escape(s.passed), escape(s.failed), escape(s.errored), escape(duration(s.meanMs) ?? ''), escape(score?.score ?? ''), escape(score?.reason ?? ''), escape(failure ?? '')];
}

/** An (i) that opens, on click, what the gate and judge score columns mean. */
function legend(): string {
  const label = 'About gates and judge score';
  const lines = GATES_LEGEND.map((line) => '<p>' + escape(line) + '</p>').join('');
  return `<details class="legend"><summary title="${escape(label)}" aria-label="${escape(label)}">i</summary>${lines}</details>`;
}

function statusNote(r: FitnessRun): string {
  if (isRunning(r)) return 'The suite has not finished an iteration yet.';
  if (r.scenarios) return "From the suite's status. The transcripts stay in Kubemoot's object store; open the run in the Kubemoot dashboard to read them.";
  return "The cluster no longer holds the iterations, and the suite's status records no per-scenario results.";
}

/** Where the deferred judge stands for a suite run, from the suite's status.judge. */
export function judgeText(r: FitnessRun): string {
  const j = r.judge;
  if (r.phase === 'Cancelled' || j?.phase === 'Skipped') return 'skipped, since the suite was cancelled';
  if (isRunning(r) || j?.phase === 'Pending') return 'waits for the suite to finish';
  return j ? judgeProgress(j, r.scripts?.length ?? 0) : "not recorded in the suite's status";
}

/** A finished run's judge: done, or how far it has got. */
function judgeProgress(j: SuiteJudge, scripts: number): string {
  const mean = j.mean === undefined ? '' : `, mean ${j.mean}`;
  if (j.phase === 'Complete') return `done, ${j.judged} scenarios scored${mean}`;
  return `judging, ${j.judged} of ${j.total || scripts} scenarios scored${mean}`;
}

function singleDetail(r: FitnessRun): string {
  const rows = r.assertions.map((a) => [a.passed ? badge('pass', 'good', 'The answer met this assertion.') : badge('fail', 'bad', 'The answer did not meet this assertion.'), escape(a.raw), escape(a.message)]);
  return `${heading('h3', 'Assertions', HEADINGS.Assertions)}${table(['', 'Assertion', 'Result'], rows, isRunning(r) ? 'Running...' : 'No assertions reported.')}`;
}
