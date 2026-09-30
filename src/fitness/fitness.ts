import type { KubeTransport } from '../k8s/request';
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
}

const RUNNING = new Set(['', 'Pending', 'Running']);

export function isFitness(m: Manifest): boolean {
  return (FITNESS_KINDS as readonly string[]).includes(m.kind);
}

export function isRunning(run: FitnessRun): boolean {
  return RUNNING.has(run.phase);
}

interface FitnessObject extends Manifest {
  spec?: { crewRef?: string };
  status?: { phase?: string; passed?: number; failed?: number; errored?: number; assertions?: Assertion[]; error?: string };
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
  };
}

/** The fitness runs of one crew in a namespace, newest first. */
export async function listRuns(client: KubeTransport, kinds: Map<string, KubemootKind>, namespace: string, crew: string): Promise<FitnessRun[]> {
  const lists = await Promise.all(FITNESS_KINDS.filter((k) => kinds.has(k)).map((k) => listKind(client, kinds.get(k) as KubemootKind, k, namespace)));
  return lists
    .flat()
    .filter((run) => run.crew === crew)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.name.localeCompare(b.name));
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
  return `${definition.slice(0, 63 - stamp.length - 1).replace(/-+$/, '')}-${stamp}`;
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
