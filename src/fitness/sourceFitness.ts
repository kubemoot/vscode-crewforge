import * as vscode from 'vscode';
import { sourceTitle, type SourceEntry } from '../source/service';
import type { DeploymentNode, SourceNode } from '../views/sourceTree';
import type { BatchTarget, FitnessBatches, Scenario } from './batch';
import { chosenNodes } from './liveFitness';

export interface SourceFitnessDeps {
  batches: Pick<FitnessBatches, 'choose' | 'runChosen' | 'runOne'>;
  /** The scenario scripts a source defines for a namespace. */
  scenarioScripts: (entry: SourceEntry, namespace: string) => Promise<Scenario[]>;
  /** The deployment of a source Redeploy goes to, or undefined after saying why there is none. */
  redeployTarget: (node: SourceNode) => Promise<DeploymentNode | undefined>;
}

/**
 * Batches of a source's fitness scenarios in Crew Sources: pick several to run as one
 * suite against the source's deployment, or run the scenario rows selected in the tree.
 */
export class SourceFitness {
  constructor(private readonly deps: SourceFitnessDeps) {}

  /** Asks which of the source's scenarios to run, and how many iterations, then runs them as one suite. */
  async choose(node?: SourceNode): Promise<void> {
    const target = node && (await this.target(node));
    if (target) await this.deps.batches.choose(target);
  }

  /** Runs one scenario row against the source's deployment, one iteration, as the deployed crews' scenarios run. */
  async runOne(node?: SourceNode): Promise<void> {
    const name = node?.kind === 'declared' ? node.item.scenario?.name : undefined;
    const target = name && node ? await this.target(node) : undefined;
    if (!name || !target) return;
    const scenario = target.scenarios.find((s) => s.name === name);
    if (scenario) await this.deps.batches.runOne(target, scenario);
    else void vscode.window.showErrorMessage(`CrewForge: ${target.title} no longer defines the scenario ${name}.`);
  }

  /** Runs the scenario rows selected in the tree as one suite; they must belong to one source. */
  async runSelected(clicked?: SourceNode, selected?: readonly SourceNode[]): Promise<void> {
    const rows = chosenNodes(clicked, selected).filter((n): n is Extract<SourceNode, { kind: 'declared' }> => n.kind === 'declared' && n.item.scenario !== undefined);
    const roots = new Set(rows.map((n) => n.entry.source.root));
    if (roots.size > 1) {
      void vscode.window.showInformationMessage(`The selected scenarios belong to ${roots.size} crew sources. Select the scenarios of one source: CrewForge runs one crew's batch at a time.`);
      return;
    }
    if (rows.length === 0) {
      void vscode.window.showInformationMessage('No scenarios are selected. Select scenario rows under Fitness Scenarios, then choose Run Selected Scenarios.');
      return;
    }
    const target = await this.target(rows[0]);
    if (!target) return;
    const names = new Set(rows.map((n) => n.item.scenario?.name));
    await this.deps.batches.runChosen(target, target.scenarios.filter((s) => names.has(s.name)));
  }

  /** A source's deployment as a batch target, with the scenarios it defines; undefined after saying why there is none. */
  private async target(node: SourceNode): Promise<BatchTarget | undefined> {
    const deployment = node.kind === 'fitness' || node.kind === 'deployment' ? node : await this.deps.redeployTarget(node);
    if (!deployment) return undefined;
    const scenarios = await this.deps.scenarioScripts(deployment.entry, deployment.deployment.namespace);
    return { deployment: deployment.deployment, title: sourceTitle(deployment.entry), scenarios };
  }
}
