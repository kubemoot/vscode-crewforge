import { runControls, shownPhase, type SuiteControls } from '../fitness/controls';
import { isRunning, runSummary, scenarioResults, scenarioResultsFromStatus, type FitnessRun, type JudgeScore, type ScenarioResult, type SuiteJudge } from '../fitness/fitness';
import { badge, between, buttons, duration, escape, facts, note, section, SELECT_CONTEXT_BUTTON, table, type ButtonSpec, type Shown } from './html';

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
    { action: 'run', label: 'Run Fitness', title: 'Run one of the crew\'s fitness definitions', disabled: busy ? 'A fitness run for this crew is in progress.' : v.cannotRun, primary: true },
    { action: 'refresh', label: 'Refresh', title: 'Read the runs again' },
    ...(v.error ? [SELECT_CONTEXT_BUTTON] : []),
  ];
  const error = v.error ? `<p class="error">${escape(v.error)}</p>` : '';
  const where = v.title === v.crew ? v.namespace : `${v.crew} · ${v.namespace}`;
  return `<h1>Fitness: ${escape(v.title)}</h1><p class="muted">${escape(where)}</p>${error}${buttons(top)}${runsSection(v)}${v.selected ? runSection(v, v.selected) : ''}`;
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
  const progress = r.iterationsTotal ? `<progress max="${r.iterationsTotal}" value="${r.iterationsCompleted ?? 0}"></progress>` : '';
  const body = [facts(runFacts(r)), progress, buttons(runButtons(v, r)), r.kind === 'CrewFitnessSuite' ? suiteDetail(v, r) : singleDetail(r)].join('');
  return section(`Run ${r.name}`, body);
}

function runButtons(v: FitnessView, r: FitnessRun): ButtonSpec[] {
  const controls = runControls(r, v.controls);
  const specs: ButtonSpec[] = [];
  if (controls.pause) specs.push({ action: 'pause', arg: r.name, label: 'Pause', title: 'Pause between iterations; the running iteration finishes (spec.suspend)' });
  if (controls.resume) specs.push({ action: 'resume', arg: r.name, label: 'Resume', title: 'Resume the paused suite' });
  if (controls.stop) specs.push({ action: 'stop', arg: r.name, label: 'Stop', title: r.kind === 'CrewFitnessSuite' ? 'Stop the suite; it becomes Cancelled (spec.cancel)' : 'Stop this single-scenario run (deletes it)' });
  if (r.artifact) specs.push({ action: 'xlsx', arg: r.name, label: 'Open XLSX', title: 'Download the results workbook from the Kubemoot dashboard', disabled: v.xlsxUrl ? undefined : 'Set crewforge.dashboardUrl to download the XLSX.' });
  if (r.kind === 'CrewFitnessSuite') specs.push({ action: 'openDashboard', arg: r.name, label: 'Open in Kubemoot dashboard', title: "Open the Kubemoot dashboard's Fitness page in your browser, where this run's transcripts are", disabled: v.dashboardRunUrl ? undefined : 'Set crewforge.dashboardUrl to open the Kubemoot dashboard.' });
  return specs;
}

function runFacts(r: FitnessRun): [string, Shown][] {
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
  const results = live.length ? scenarioResults(r.scripts ?? [], live) : scenarioResultsFromStatus(r.scripts ?? [], r.scenarios ?? []);
  const scores = new Map((r.judge?.scores ?? []).map((s) => [s.scenario, s]));
  const rows = withScoredOnly(results, scores).map((s) => scenarioRow(s, scores.get(s.scenario)));
  const where = live.length ? 'From the iterations in the cluster.' : statusNote(r);
  const judge = `Judge: ${judgeText(r)}`;
  return `<h3>Scenarios</h3>${table(['Scenario', 'Done', 'Passed', 'Failed', 'Errored', 'Mean duration', 'Score', 'Judge reason'], rows, 'No iterations yet.')}${note(where)}<p>${escape(judge)}</p>`;
}

/** Adds a row for each judged scenario the results do not list, so no score goes unshown. */
function withScoredOnly(results: ScenarioResult[], scores: Map<string, JudgeScore>): ScenarioResult[] {
  const listed = new Set(results.map((s) => s.scenario));
  const extra = [...scores.keys()].filter((name) => !listed.has(name)).map((scenario) => ({ scenario, done: 0, passed: 0, failed: 0, errored: 0, running: 0 }));
  return [...results, ...extra];
}

function scenarioRow(s: ScenarioResult, score?: JudgeScore): string[] {
  const running = s.running ? ` (+${s.running} running)` : '';
  return [escape(s.scenario), escape(`${s.done}${running}`), escape(s.passed), escape(s.failed), escape(s.errored), escape(duration(s.meanMs) ?? ''), escape(score?.score ?? ''), escape(score?.reason ?? '')];
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
  const rows = r.assertions.map((a) => [a.passed ? badge('pass', 'good') : badge('fail', 'bad'), escape(a.raw), escape(a.message)]);
  return `<h3>Assertions</h3>${table(['', 'Assertion', 'Result'], rows, isRunning(r) ? 'Running...' : 'No assertions reported.')}`;
}
