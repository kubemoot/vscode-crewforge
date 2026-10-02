import type { KubeTransport } from '../k8s/request';
import { byCodeUnits, trimEnd } from '../text';
import { objectPath, type KubemootKind } from '../source/live';
import type { Manifest } from '../source/manifests';

export const FITNESS_KINDS = ['CrewFitness', 'CrewFitnessSuite'] as const;
export type FitnessKind = (typeof FITNESS_KINDS)[number];

export interface Assertion {
  raw: string;
  passed: boolean;
  message: string;
}

/** A condition on a fitness run's status. */
export interface FitnessCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
}

/** The judge's verdict on one scenario, as a suite's status.judge.scores lists it. */
export interface JudgeScore {
  scenario: string;
  /** 0 to 100, rounded. */
  score: number;
  /** The judge's rationale on one line, up to 200 characters. */
  reason?: string;
}

/** Where the deferred judge stands for a suite run: the suite's status.judge. */
export interface SuiteJudge {
  /** Pending, Judging, Complete, or Skipped. */
  phase: string;
  judged: number;
  total: number;
  /** The mean scenario score, absent until a scenario is judged. */
  mean?: number;
  zeros: number;
  completedAt?: string;
  scores: JudgeScore[];
}

/** One scenario's finished iterations: an entry of a suite's status.scenarios. */
export interface SuiteScenario {
  name: string;
  iterations: number;
  passed: number;
  failed: number;
  errored: number;
  meanDurationMs?: number;
}

/** One fitness run of a crew, as its status reports it. */
export interface FitnessRun {
  kind: FitnessKind;
  name: string;
  namespace: string;
  crew: string;
  phase: string;
  createdAt: string;
  passed?: number;
  failed?: number;
  errored?: number;
  assertions: Assertion[];
  error?: string;
  /** A suite's planned and finished iterations. */
  iterationsTotal?: number;
  iterationsCompleted?: number;
  startedAt?: string;
  completedAt?: string;
  /** A single CrewFitness's own duration. */
  durationMs?: number;
  /** A suite's run id, and where its XLSX is once written. */
  runId?: string;
  artifact?: { bucket: string; objectKey: string };
  conditions?: FitnessCondition[];
  /** A suite's spec.suspend and spec.cancel, as set. */
  suspend?: boolean;
  cancel?: boolean;
  /** A suite's scripts, by testRef, in order. */
  scripts?: string[];
  /** Started by CrewForge's Run Scenario: one scenario, one iteration. */
  single?: boolean;
  /** For an iteration a suite ran: the suite's name, and the scenario it ran. */
  iterationOf?: string;
  testRef?: string;
  /** A suite's judge pass, as the operator records it. */
  judge?: SuiteJudge;
  /** A suite's per-scenario rollup, kept after the operator removes the iterations. */
  scenarios?: SuiteScenario[];
}

/** Marks a run CrewForge started for one scenario, so its dashboard offers Stop. */
export const SINGLE_SCENARIO = 'crewforge.kubemoot.ai/single-scenario';

/** The label the operator puts on each iteration a suite runs, naming the suite. */
export const SUITE_LABEL = 'kubemoot.ai/fitness-suite';

/** Phases of a run still going: waiting, running, or paused between iterations. */
const RUNNING = new Set(['', 'Pending', 'Running', 'Paused']);

/** The scenario a CrewFitness runs, by name: its testRef, else its own name. */
export function fitnessScenarioName(m: Manifest): string {
  const ref = (m.spec as { testRef?: unknown } | undefined)?.testRef;
  return typeof ref === 'string' && ref !== '' ? ref : m.metadata.name;
}

/** The scenario names of a CrewFitnessSuite: the testRef of each of its scripts. */
export function suiteScriptRefs(m: Manifest): string[] {
  const scripts = (m.spec as { scripts?: unknown } | undefined)?.scripts;
  return Array.isArray(scripts) ? scripts.map((s: { testRef?: unknown } | null) => s?.testRef).filter((r): r is string => typeof r === 'string') : [];
}

export function isFitness(m: Manifest): boolean {
  return (FITNESS_KINDS as readonly string[]).includes(m.kind);
}

export function isRunning(run: FitnessRun): boolean {
  return RUNNING.has(run.phase);
}

interface FitnessStatus {
  phase?: string;
  passed?: number;
  failed?: number;
  errored?: number;
  assertions?: Assertion[];
  error?: string;
  iterationsTotal?: number;
  iterationsCompleted?: number;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  runId?: string;
  artifactRef?: { bucket: string; objectKey: string };
  conditions?: FitnessCondition[];
  judge?: unknown;
  scenarios?: unknown;
}

interface FitnessObject extends Manifest {
  spec?: { crewRef?: string; testRef?: string; suspend?: boolean; cancel?: boolean; scripts?: { testRef?: string }[] };
  status?: FitnessStatus;
}

export function toRun(kind: FitnessKind, m: FitnessObject): FitnessRun {
  const status = m.status ?? {};
  return {
    kind,
    name: m.metadata.name,
    namespace: m.metadata.namespace ?? '',
    crew: m.spec?.crewRef ?? '',
    phase: status.phase ?? '',
    createdAt: typeof m.metadata.creationTimestamp === 'string' ? m.metadata.creationTimestamp : '',
    passed: status.passed,
    failed: status.failed,
    errored: status.errored,
    assertions: status.assertions ?? [],
    error: status.error || undefined,
    ...progressOf(status),
    ...controlsOf(m),
    judge: judgeOf(status.judge),
    scenarios: scenariosOf(status.scenarios),
  };
}

type Fields = Record<string, unknown>;

const isObject = (v: unknown): v is Fields => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A count the operator may omit when it is 0. */
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const optionalNumber = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

const optionalText = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** Reads status.judge; undefined when the status has none (an operator that does not record it). */
export function judgeOf(raw: unknown): SuiteJudge | undefined {
  if (!isObject(raw) || typeof raw.phase !== 'string') return undefined;
  const scores = Array.isArray(raw.scores) ? raw.scores.filter(isObject).filter(validScore) : [];
  return {
    phase: raw.phase,
    judged: count(raw.judged),
    total: count(raw.total),
    mean: optionalNumber(raw.mean),
    zeros: count(raw.zeros),
    completedAt: optionalText(raw.completedAt),
    scores: scores.map((s) => ({ scenario: s.scenario as string, score: count(s.score), reason: optionalText(s.reason) })),
  };
}

/** A score entry names its scenario, and its score is a number or absent (the operator omits a 0). */
function validScore(s: Fields): boolean {
  return typeof s.scenario === 'string' && (s.score === undefined || optionalNumber(s.score) !== undefined);
}

/** Reads status.scenarios; undefined when the status has none. */
export function scenariosOf(raw: unknown): SuiteScenario[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .filter(isObject)
    .filter((s) => typeof s.name === 'string')
    .map((s) => ({ name: s.name as string, iterations: count(s.iterations), passed: count(s.passed), failed: count(s.failed), errored: count(s.errored), meanDurationMs: optionalNumber(s.meanDurationMs) }));
}

function progressOf(status: FitnessStatus): Partial<FitnessRun> {
  const { iterationsTotal, iterationsCompleted, startedAt, completedAt, durationMs, runId, conditions } = status;
  return { iterationsTotal, iterationsCompleted, startedAt, completedAt, durationMs, runId, artifact: status.artifactRef, conditions };
}

function controlsOf(m: FitnessObject): Partial<FitnessRun> {
  const scripts = m.spec?.scripts?.map((s) => s?.testRef).filter((r): r is string => typeof r === 'string');
  return {
    suspend: m.spec?.suspend === true,
    cancel: m.spec?.cancel === true,
    scripts,
    single: m.metadata.annotations?.[SINGLE_SCENARIO] === 'true',
    iterationOf: m.metadata.labels?.[SUITE_LABEL],
    testRef: m.spec?.testRef,
  };
}

/** The fitness runs of one crew in a namespace, newest first. */
export async function listRuns(client: KubeTransport, kinds: Map<string, KubemootKind>, namespace: string, crew: string): Promise<FitnessRun[]> {
  const lists = await Promise.all(FITNESS_KINDS.filter((k) => kinds.has(k)).map((k) => listKind(client, kinds.get(k) as KubemootKind, k, namespace)));
  return lists
    .flat()
    .filter((run) => run.crew === crew && !run.iterationOf)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.name.localeCompare(b.name));
}

/** The iterations a suite has run so far, as CrewFitness objects the operator labels with the suite; it removes them after the run. */
export async function listIterations(client: KubeTransport, kinds: Map<string, KubemootKind>, namespace: string, suite: string): Promise<FitnessRun[]> {
  const kind = kinds.get('CrewFitness');
  if (!kind) return [];
  return (await listKind(client, kind, 'CrewFitness', namespace)).filter((run) => run.iterationOf === suite);
}

/** One scenario of a suite run: how its iterations went. */
export interface ScenarioResult {
  scenario: string;
  done: number;
  passed: number;
  failed: number;
  errored: number;
  running: number;
  /** The mean duration of its finished iterations. */
  meanMs?: number;
}

const OUTCOME: Record<string, keyof Pick<ScenarioResult, 'passed' | 'failed' | 'errored'>> = { Passed: 'passed', Failed: 'failed', Error: 'errored', Timeout: 'errored' };

/** The suite's scripts in order, then any other scenario by name. */
function scenarioOrder(scripts: string[], names: string[]): string[] {
  return [...scripts, ...[...new Set(names)].filter((s) => !scripts.includes(s)).sort(byCodeUnits)];
}

/** The mean of the durations that were measured (above 0); undefined when none was. */
function meanDuration(ms: number[]): number | undefined {
  const timed = ms.filter((m) => m > 0);
  return timed.length ? timed.reduce((a, b) => a + b, 0) / timed.length : undefined;
}

/** Groups iterations by scenario, in the suite's script order, then any other scenario by name. */
export function scenarioResults(scripts: string[], iterations: { scenario: string; status: string; durationMs?: number }[]): ScenarioResult[] {
  return scenarioOrder(scripts, iterations.map((i) => i.scenario)).map((scenario) => {
    const mine = iterations.filter((i) => i.scenario === scenario);
    const finished = mine.filter((i) => OUTCOME[i.status]);
    const result: ScenarioResult = { scenario, done: finished.length, passed: 0, failed: 0, errored: 0, running: mine.length - finished.length };
    for (const i of finished) result[OUTCOME[i.status]]++;
    const meanMs = meanDuration(finished.map((i) => i.durationMs ?? 0));
    if (meanMs !== undefined) result.meanMs = meanMs;
    return result;
  });
}

/**
 * The same results from the per-scenario rollup the operator keeps in a suite's status
 * once its iterations are gone, in the same order; none of them is still running.
 */
export function scenarioResultsFromStatus(scripts: string[], scenarios: SuiteScenario[]): ScenarioResult[] {
  const byName = new Map(scenarios.map((s) => [s.name, s]));
  return scenarioOrder(scripts, scenarios.map((s) => s.name)).map((scenario) => {
    const s = byName.get(scenario) ?? { name: scenario, iterations: 0, passed: 0, failed: 0, errored: 0 };
    const result: ScenarioResult = { scenario, done: s.iterations, passed: s.passed, failed: s.failed, errored: s.errored, running: 0 };
    const meanMs = meanDuration([s.meanDurationMs ?? 0]);
    if (meanMs !== undefined) result.meanMs = meanMs;
    return result;
  });
}

async function listKind(client: KubeTransport, kind: KubemootKind, fitnessKind: FitnessKind, namespace: string): Promise<FitnessRun[]> {
  const body = JSON.parse(await client.request('GET', objectPath(kind, namespace))) as { items?: FitnessObject[] };
  return (body.items ?? []).map((m) => toRun(fitnessKind, m));
}

/**
 * Fitness runs in progress anywhere the account can see: across the cluster, or in
 * `namespace` when listing across the cluster is not allowed. Crews share the GPUs,
 * so a second run at once measures contention, not the crew.
 */
export async function runsInProgress(client: KubeTransport, kinds: Map<string, KubemootKind>, namespace: string): Promise<FitnessRun[]> {
  const found: FitnessRun[] = [];
  for (const fitnessKind of FITNESS_KINDS) {
    const kind = kinds.get(fitnessKind);
    if (!kind) continue;
    found.push(...(await listAnywhere(client, kind, fitnessKind, namespace)));
  }
  return found.filter(isRunning);
}

async function listAnywhere(client: KubeTransport, kind: KubemootKind, fitnessKind: FitnessKind, namespace: string): Promise<FitnessRun[]> {
  try {
    const body = JSON.parse(await client.request('GET', `/apis/kubemoot.ai/v1alpha1/${kind.plural}`)) as { items?: FitnessObject[] };
    return (body.items ?? []).map((m) => toRun(fitnessKind, m));
  } catch {
    return listKind(client, kind, fitnessKind, namespace);
  }
}

/** Starts a run from a fitness definition: a new object named after it with a timestamp, so every run is kept. */
export async function startRun(client: KubeTransport, kinds: Map<string, KubemootKind>, namespace: string, definition: Manifest, now = new Date()): Promise<string> {
  const kind = kinds.get(definition.kind);
  if (!kind) throw new Error(`The cluster does not serve ${definition.kind}; is the Kubemoot operator installed?`);
  const name = runName(definition.metadata.name, now);
  const { labels, annotations } = definition.metadata;
  const body = { ...definition, metadata: { name, namespace, labels, annotations } };
  await client.request('POST', objectPath(kind, namespace), body);
  return name;
}

/** `<definition>-<yyyymmdd-hhmmss>`, cut so it stays a valid name. */
export function runName(definition: string, now: Date): string {
  const stamp = now.toISOString().replaceAll(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${trimEnd(definition.slice(0, 63 - stamp.length - 1), '-')}-${stamp}`;
}

/** The line under a run in the tree. */
export function runSummary(run: FitnessRun): string {
  if (run.kind === 'CrewFitnessSuite' && run.passed !== undefined) {
    return `${run.phase || 'Pending'} · ${run.passed ?? 0} passed, ${run.failed ?? 0} failed, ${run.errored ?? 0} errored`;
  }
  if (run.assertions.length) {
    const passed = run.assertions.filter((a) => a.passed).length;
    return `${run.phase} · ${passed}/${run.assertions.length} assertions`;
  }
  return run.phase || 'Pending';
}

/** A Markdown report of one run. */
export function runReport(run: FitnessRun): string {
  const lines = [`# ${run.name}`, '', `${run.kind} of crew \`${run.crew}\` in \`${run.namespace}\``, '', `**${runSummary(run)}**`];
  if (run.createdAt) lines.push('', `Started ${run.createdAt}`);
  if (run.error) lines.push('', `Error: ${run.error}`);
  if (run.assertions.length) {
    lines.push('', '| | Assertion | Result |', '|---|---|---|');
    for (const a of run.assertions) lines.push(`| ${a.passed ? 'pass' : 'FAIL'} | ${cell(a.raw)} | ${cell(a.message)} |`);
  }
  return lines.join('\n') + '\n';
}

function cell(text: string): string {
  return text.replaceAll('|', String.raw`\|`).replaceAll('\n', ' ');
}
