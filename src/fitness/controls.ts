import * as vscode from 'vscode';
import { KubeError, type KubeTransport } from '../k8s/request';
import { OPENAPI_PATH } from '../schema/kubemootSchema';
import { objectPath, type KubemootKind } from '../source/live';
import { isRunning, type FitnessRun } from './fitness';

/** Which suite controls the installed operator understands, read from the CRD's schema. */
export interface SuiteControls {
  /** spec.suspend: pause between iterations, and resume. */
  suspend: boolean;
  /** spec.cancel: stop the suite; its phase becomes Cancelled. */
  cancel: boolean;
}

type Schema = { properties?: Record<string, Schema>; 'x-kubernetes-group-version-kind'?: { kind?: string }[] };

/** The suite controls a CRD schema (the cluster's OpenAPI v3 for the Kubemoot group) declares. */
export function controlsIn(openapi: { components?: { schemas?: Record<string, Schema> } }): SuiteControls {
  const suite = Object.values(openapi.components?.schemas ?? {}).find((s) => s['x-kubernetes-group-version-kind']?.some((g) => g.kind === 'CrewFitnessSuite'));
  const spec = suite?.properties?.spec?.properties ?? {};
  return { suspend: 'suspend' in spec, cancel: 'cancel' in spec };
}

const NONE: SuiteControls = { suspend: false, cancel: false };

/** Reads the suite controls once per client; none when the schema cannot be read. */
export class ControlsReader {
  private readonly cache = new WeakMap<KubeTransport, Promise<SuiteControls>>();

  read(client: KubeTransport): Promise<SuiteControls> {
    let found = this.cache.get(client);
    if (!found) {
      // A failed read is not kept: the next page read asks again.
      found = client
        .request('GET', OPENAPI_PATH)
        .then((text) => controlsIn(JSON.parse(text)))
        .catch(() => {
          this.cache.delete(client);
          return NONE;
        });
      this.cache.set(client, found);
    }
    return found;
  }
}

/** What a run shows as its phase: a suite asked to pause shows Pausing until its running iteration ends. */
export function shownPhase(run: FitnessRun): string {
  if (run.kind === 'CrewFitnessSuite' && run.suspend && run.phase === 'Running') return 'Pausing';
  if (run.kind === 'CrewFitnessSuite' && run.cancel && isRunning(run)) return 'Stopping';
  return run.phase || 'Pending';
}

/** The controls that apply to a run now: pause or resume a suite, and stop a suite or a single-scenario run. */
export function runControls(run: FitnessRun, controls: SuiteControls): { pause: boolean; resume: boolean; stop: boolean } {
  if (!isRunning(run)) return { pause: false, resume: false, stop: false };
  if (run.kind === 'CrewFitness') return { pause: false, resume: false, stop: run.single === true };
  const suspendable = controls.suspend;
  return { pause: suspendable && !run.suspend, resume: suspendable && run.suspend === true, stop: controls.cancel && !run.cancel };
}

/** Pauses, resumes, or stops a run through its own object, after a confirmation for stop. */
export class RunControls {
  constructor(
    private readonly client: () => KubeTransport,
    private readonly kinds: (client: KubeTransport) => Promise<Map<string, KubemootKind>>,
  ) {}

  pause(run: FitnessRun): Promise<void> {
    return this.patch(run, { spec: { suspend: true } });
  }

  resume(run: FitnessRun): Promise<void> {
    return this.patch(run, { spec: { suspend: false } });
  }

  /**
   * Stops a run: a suite by setting spec.cancel (its phase becomes Cancelled and its
   * results so far are kept), a single CrewFitness by deleting it (the operator's owner
   * references remove its Job).
   */
  async stop(run: FitnessRun): Promise<void> {
    const how = run.kind === 'CrewFitnessSuite' ? 'The running iteration ends and the suite becomes Cancelled; results so far are kept.' : 'The run is deleted with its results; the operator removes its Job.';
    const answer = await vscode.window.showWarningMessage(`Stop ${run.name}?`, { modal: true, detail: how }, 'Stop');
    if (answer !== 'Stop') return;
    if (run.kind === 'CrewFitnessSuite') return this.patch(run, { spec: { cancel: true } });
    const client = this.client();
    try {
      await client.request('DELETE', await this.path(client, run));
    } catch (err) {
      if (!(err instanceof KubeError && err.status === 404)) throw err;
    }
  }

  private async patch(run: FitnessRun, body: unknown): Promise<void> {
    const client = this.client();
    await client.request('PATCH', await this.path(client, run), body);
  }

  private async path(client: KubeTransport, run: FitnessRun): Promise<string> {
    const kind = (await this.kinds(client)).get(run.kind);
    if (!kind) throw new Error(`The cluster does not serve ${run.kind}.`);
    return objectPath(kind, run.namespace, run.name);
  }
}

/**
 * Which crews have a fitness run in progress, by `namespace/crew`, as the views and
 * dashboards last read them. Run Fitness is hidden for such a crew (its tree items carry
 * a `-running` context value) and refuses to start another.
 */
export class FitnessActivity {
  private readonly busy = new Map<string, string[]>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  isBusy(namespace: string, crew: string): boolean {
    return (this.busy.get(`${namespace}/${crew}`) ?? []).length > 0;
  }

  /** Records the runs of one crew as last read. */
  record(namespace: string, crew: string, runs: FitnessRun[]): void {
    this.set(`${namespace}/${crew}`, runs.filter(isRunning).map((r) => r.name));
  }

  /** Marks a run just started, before any read shows it. */
  started(namespace: string, crew: string, name: string): void {
    const key = `${namespace}/${crew}`;
    this.set(key, [...(this.busy.get(key) ?? []), name]);
  }

  private set(key: string, names: string[]): void {
    const going = [...new Set(names)].sort();
    const before = (this.busy.get(key) ?? []).join(',');
    if (going.length) this.busy.set(key, going);
    else this.busy.delete(key);
    if (before !== going.join(',')) this.changed.fire();
  }
}
