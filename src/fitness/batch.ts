import * as vscode from 'vscode';
import { dnsLabel } from '../crew/displayName';
import type { Deployment } from '../source/deployments';
import type { Manifest } from '../source/manifests';
import { LINE_BREAK } from '../text';
import { SINGLE_SCENARIO } from './fitness';

/** A scenario a batch can run: its name and script. */
export interface Scenario {
  name: string;
  content: string;
}

/** The scenarios of one crew deployment, which a batch runs against. */
export interface BatchTarget {
  deployment: Deployment;
  /** The name people read for the crew, for prompts and messages. */
  title: string;
  scenarios: Scenario[];
}

/** What a suite of scenarios is: all of them, a chosen batch, or one scenario. */
export type SuiteKind = 'all' | 'batch' | 'single';

/** The largest number of iterations a batch asks for, so a typo cannot start hours of runs. */
export const MAX_ITERATIONS = 100;

/** The iteration counts offered first. */
export const ITERATION_CHOICES = [1, 3, 5, 10] as const;

/**
 * One CrewFitnessSuite of scenarios, judged together with one XLSX: `<crew>-all` for all
 * of them, `<crew>-batch-<n>` for a chosen batch of n, `<crew>-<scenario>` for one (its
 * name made a DNS label), which is marked as a single-scenario run. A run adds its start
 * time to the name, cut to fit.
 */
export function scenarioSuite(crew: string, scenarios: Scenario[], kind: SuiteKind, iterations = 1): Manifest {
  const single = dnsLabel(scenarios[0]?.name ?? '', 63) || 'scenario';
  const names: Record<SuiteKind, string> = { all: `${crew}-all`, batch: `${crew}-batch-${scenarios.length}`, single: `${crew}-${single}` };
  const annotations = kind === 'single' ? { annotations: { [SINGLE_SCENARIO]: 'true' } } : {};
  return {
    apiVersion: 'kubemoot.ai/v1alpha1',
    kind: 'CrewFitnessSuite',
    metadata: { name: names[kind], labels: { 'kubemoot.ai/crew': crew }, ...annotations },
    spec: {
      crewRef: crew,
      description: `${count(scenarios.length)} run by CrewForge.`,
      iterations,
      scripts: scenarios.map((s) => ({ testRef: s.name, testContent: s.content })),
    },
  };
}

const count = (n: number) => (n === 1 ? '1 scenario' : `${n} scenarios`);

/** A scenario's DESCRIPTION line, for a picker; undefined when it has none. */
export function scenarioDescription(content: string): string | undefined {
  const line = content.split(LINE_BREAK).find((l) => l.trimStart().startsWith('DESCRIPTION '));
  return line?.trimStart().slice('DESCRIPTION '.length).trim() || undefined;
}

/** Why a count of iterations is not one to run, in plain words; undefined when it is. */
export function iterationsProblem(value: string): string | undefined {
  const n = Number(value.trim());
  return Number.isInteger(n) && n >= 1 && n <= MAX_ITERATIONS ? undefined : `Enter a whole number from 1 to ${MAX_ITERATIONS}.`;
}

export interface BatchDeps {
  /** Starts a definition after the usual checks (refusing while a run of the crew is in progress); the run's name, or undefined. */
  runDefinition: (deployment: Deployment, definition: Manifest) => Promise<string | undefined>;
  /** Opens the fitness dashboard of a deployment on a run. */
  openDashboard: (deployment: Deployment, run: string) => void;
}

/**
 * Runs scenarios as one suite against one crew deployment: all of them in one click, a
 * batch the developer picks with how many iterations each, or the rows selected in a tree.
 */
export class FitnessBatches {
  constructor(private readonly deps: BatchDeps) {}

  /** Runs every scenario once. */
  async runAll(target: BatchTarget): Promise<void> {
    await this.start(target, target.scenarios, 'all', 1);
  }

  /** Runs one scenario once. */
  async runOne(target: BatchTarget, scenario: Scenario): Promise<void> {
    await this.start(target, [scenario], 'single', 1);
  }

  /** Asks which scenarios (all checked at first) and how many iterations each, then runs them as one suite. */
  async choose(target: BatchTarget): Promise<void> {
    if (this.refuseEmpty(target, target.scenarios)) return;
    const picked = await vscode.window.showQuickPick(
      target.scenarios.map((s) => ({ label: s.name, description: scenarioDescription(s.content), picked: true, scenario: s })),
      { canPickMany: true, placeHolder: `Run which scenarios of ${target.title} as one batch?` },
    );
    if (!picked) return;
    await this.runChosen(target, picked.map((p) => p.scenario));
  }

  /** Runs the chosen scenarios as one suite, after asking how many iterations each. */
  async runChosen(target: BatchTarget, chosen: Scenario[]): Promise<void> {
    if (this.refuseEmpty(target, chosen)) return;
    const iterations = await askIterations();
    if (iterations === undefined) return;
    await this.start(target, chosen, chosen.length === target.scenarios.length ? 'all' : 'batch', iterations);
  }

  private async start(target: BatchTarget, scenarios: Scenario[], kind: SuiteKind, iterations: number): Promise<void> {
    if (this.refuseEmpty(target, scenarios)) return;
    const run = await this.deps.runDefinition(target.deployment, scenarioSuite(target.deployment.crew.name, scenarios, kind, iterations));
    if (run) this.deps.openDashboard(target.deployment, run);
  }

  /** Says so when there is nothing to run. */
  private refuseEmpty(target: BatchTarget, scenarios: Scenario[]): boolean {
    if (scenarios.length > 0) return false;
    const why = target.scenarios.length === 0 ? `${target.title} has no fitness scenarios to run.` : 'No scenarios were selected, so nothing was run.';
    void vscode.window.showInformationMessage(why);
    return true;
  }
}

/** How many iterations each scenario runs: 1, 3, 5, 10, or a number typed in. */
async function askIterations(): Promise<number | undefined> {
  const CUSTOM = 'Another number...';
  const choice = await vscode.window.showQuickPick([...ITERATION_CHOICES.map((n) => ({ label: String(n), description: n === 1 ? 'iteration each' : 'iterations each' })), { label: CUSTOM, description: `up to ${MAX_ITERATIONS}` }], {
    placeHolder: 'How many iterations of each scenario?',
  });
  if (!choice) return undefined;
  if (choice.label !== CUSTOM) return Number(choice.label);
  const typed = await vscode.window.showInputBox({ prompt: `Iterations of each scenario, 1 to ${MAX_ITERATIONS}`, value: '2', validateInput: iterationsProblem });
  return typed === undefined || iterationsProblem(typed) ? undefined : Number(typed.trim());
}
