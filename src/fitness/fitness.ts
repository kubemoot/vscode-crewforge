import type { KubeTransport } from '../k8s/request';
import { trimEnd } from '../text';
import { objectPath, type KubemootKind } from '../source/live';
import type { Manifest } from '../source/manifests';

export const FITNESS_KINDS = ['CrewFitness', 'CrewFitnessSuite'] as const;
export type FitnessKind = (typeof FITNESS_KINDS)[number];

export interface Assertion {
  raw: string;
  passed: boolean;
  message: string;
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
  conditions?: { type: string; status: string; reason?: string; message?: string }[];
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
}

/** Marks a run CrewForge started for one scenario, so its dashboard offers Stop. */
export const SINGLE_SCENARIO = 'crewforge.kubemoot.ai/single-scenario';

/** The label the operator puts on each iteration a suite runs, naming the suite. */
export const SUITE_LABEL = 'kubemoot.ai/fitness-suite';

/** Phases of a run still going: waiting, running, or paused between iterations. */
const RUNNING = new Set(['', 'Pending', 'Running', 'Paused']);

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
  conditions?: FitnessRun['conditions'];
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
  };
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

/** Groups iterations by scenario, in the suite's script order, then any other scenario by name. */
export function scenarioResults(scripts: string[], iterations: { scenario: string; status: string; durationMs?: number }[]): ScenarioResult[] {
  const order = [...scripts, ...[...new Set(iterations.map((i) => i.scenario))].filter((s) => !scripts.includes(s)).sort()];
  return order.map((scenario) => {
    const mine = iterations.filter((i) => i.scenario === scenario);
    const finished = mine.filter((i) => OUTCOME[i.status]);
    const result: ScenarioResult = { scenario, done: finished.length, passed: 0, failed: 0, errored: 0, running: mine.length - finished.length };
    for (const i of finished) result[OUTCOME[i.status]]++;
    const timed = finished.map((i) => i.durationMs ?? 0).filter((ms) => ms > 0);
    if (timed.length) result.meanMs = timed.reduce((a, b) => a + b, 0) / timed.length;
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
