import * as vscode from 'vscode';
import { titleOf } from '../crew/displayName';
import { liveDeployment } from '../deploy/liveCrew';
import type { CrewSummary } from '../k8s/crews';
import type { DetailNode } from '../views/crewDetailsTree';
import type { CrewNode } from '../views/crewTree';
import { errorText } from '../views/errors';
import type { BatchTarget, FitnessBatches } from './batch';
import type { RunControls } from './controls';
import type { DeployedScenario } from './deployed';
import type { FitnessRun } from './fitness';

export interface LiveFitnessDeps {
  batches: Pick<FitnessBatches, 'runAll' | 'runOne' | 'choose' | 'runChosen'>;
  controls: Pick<RunControls, 'pause' | 'resume' | 'stop'>;
  /** The scenarios a live crew carries, read fresh. */
  scenarios: (crew: CrewSummary) => Promise<DeployedScenario[]>;
  /** Reads the Deployed Crews view again after a run changes. */
  refresh: () => void;
}

type Section = Extract<DetailNode, { kind: 'section' }>;
type Member = Extract<DetailNode, { kind: 'member' }>;

/** The tree nodes a command acts on: the selected ones when several are, else the one clicked. */
export function chosenNodes<T>(clicked: T | undefined, selected: readonly T[] | undefined): T[] {
  if (selected && selected.length > 0) return [...selected];
  return clicked === undefined ? [] : [clicked];
}

/**
 * The Fitness group of a live crew in Deployed Crews: run all of the scenarios deployed
 * with the crew, a batch of them, or one, and pause, resume, or stop a run in progress.
 * Runs use the deployed scenarios, so they need no workspace source.
 */
export class LiveFitness {
  constructor(private readonly deps: LiveFitnessDeps) {}

  /** Runs every deployed scenario of the crew as one suite, once. */
  async runAll(node?: Section): Promise<void> {
    if (node?.kind !== 'section') return;
    await this.deps.batches.runAll(await this.target(node.crew));
  }

  /** Asks which deployed scenarios to run, and how many iterations, then runs them as one suite. */
  async choose(node?: Section): Promise<void> {
    if (node?.kind !== 'section') return;
    await this.deps.batches.choose(await this.target(node.crew));
  }

  /** Runs every deployed scenario of a crew from its own menu; false when it carries none, or they cannot be read (said so). */
  async runCrew(crew: CrewSummary): Promise<boolean> {
    const target = await this.target(crew).catch((err: unknown) => {
      void vscode.window.showWarningMessage(`Cannot read the fitness scenarios ${titleOf(crew)} carries (${errorText(err)}), so CrewForge runs the fitness its source defines.`);
      return undefined;
    });
    if (!target?.scenarios.length) return false;
    await this.deps.batches.runAll(target);
    return true;
  }

  /** Runs one deployed scenario, one iteration. */
  async runOne(node?: Member): Promise<void> {
    const scenario = node?.view.scenario;
    if (!node || !scenario) return;
    await this.deps.batches.runOne(await this.target(node.crew), scenario);
  }

  /** Runs the scenario rows selected in the tree as one suite; they must belong to one crew. */
  async runSelected(clicked?: CrewNode, selected?: readonly CrewNode[]): Promise<void> {
    const rows = chosenNodes(clicked, selected).filter((n): n is Member => n.kind === 'member' && n.view.scenario !== undefined);
    const crews = new Set(rows.map((n) => `${n.crew.namespace}/${n.crew.name}`));
    if (crews.size > 1) {
      void vscode.window.showInformationMessage(`The selected scenarios belong to ${crews.size} crews (${[...crews].join(', ')}). Select the scenarios of one crew: CrewForge runs one crew's batch at a time.`);
      return;
    }
    if (rows.length === 0) {
      void vscode.window.showInformationMessage('No scenarios are selected. Select scenario rows under a Fitness group, then choose Run Selected Scenarios.');
      return;
    }
    await this.deps.batches.runChosen(await this.target(rows[0].crew), rows.map((n) => n.view.scenario as DeployedScenario));
  }

  /** Opens a deployed scenario's script, read-only. */
  async show(node?: Member): Promise<void> {
    const scenario = node?.view.scenario;
    if (!scenario) return;
    const document = await vscode.workspace.openTextDocument({ content: scenario.content, language: 'markdown' });
    await vscode.window.showTextDocument(document, { preview: true });
  }

  pause(node?: Member): Promise<void> {
    return this.control(node, (run) => this.deps.controls.pause(run));
  }

  resume(node?: Member): Promise<void> {
    return this.control(node, (run) => this.deps.controls.resume(run));
  }

  stop(node?: Member): Promise<void> {
    return this.control(node, (run) => this.deps.controls.stop(run));
  }

  /** A live crew as a batch target: its deployment, the name people read, and the scenarios it carries now. */
  private async target(crew: CrewSummary): Promise<BatchTarget> {
    return { deployment: liveDeployment(crew), title: titleOf(crew), scenarios: await this.deps.scenarios(crew) };
  }

  private async control(node: Member | undefined, act: (run: FitnessRun) => Promise<void>): Promise<void> {
    const run = node?.view.run;
    if (!run) return;
    await act(run);
    this.deps.refresh();
  }
}
