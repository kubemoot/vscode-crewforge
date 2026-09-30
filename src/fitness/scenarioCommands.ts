import * as vscode from 'vscode';
import type { ScenarioRef } from '../source/declared';
import type { SourceEntry } from '../source/service';
import type { DeploymentNode, SourceNode } from '../views/sourceTree';
import type { FitnessCommands } from './commands';
import type { ScenarioFiles } from './scenarios';

export interface ScenarioCommandDeps {
  files: ScenarioFiles;
  fitness: Pick<FitnessCommands, 'runScenario'>;
  /** The dev deployment of a source, or undefined after saying why there is none. */
  devDeployment: (node: SourceNode) => Promise<DeploymentNode | undefined>;
  readText: (file: string) => Promise<string>;
  /** Reloads Crew Sources after a scenario file changes. */
  reload: () => Promise<unknown>;
  guard: (action: () => Promise<void>) => Promise<void>;
}

/** The scenario a node stands for: a declared fitness scenario of Crew Sources. */
export function scenarioOf(node?: SourceNode): ScenarioRef | undefined {
  return node?.kind === 'declared' ? node.item.scenario : undefined;
}

/** The source a Fitness node, a Fitness Scenarios section, a scenario, or a source belongs to. */
export function entryOf(node?: SourceNode): SourceEntry | undefined {
  return node && 'entry' in node ? node.entry : undefined;
}

/** Add Scenario, Rename Scenario, Delete Scenario, and Run Scenario, from the Fitness nodes of Crew Sources. */
export function registerScenarioCommands(deps: ScenarioCommandDeps): vscode.Disposable[] {
  const command = (id: string, run: (node?: SourceNode) => Promise<unknown>) => vscode.commands.registerCommand(id, (node?: SourceNode) => deps.guard(async () => void (await run(node))));
  const edit = (change: (scenario: ScenarioRef) => Promise<void>) => async (node?: SourceNode) => {
    const scenario = scenarioOf(node);
    if (!scenario) return;
    await change(scenario);
    await deps.reload();
  };
  return [
    command('crewforge.addScenario', async (node) => {
      const entry = entryOf(node);
      if (entry && (await deps.files.add(entry))) await deps.reload();
    }),
    command('crewforge.renameScenario', edit((s) => deps.files.rename(s))),
    command('crewforge.deleteScenario', edit((s) => deps.files.delete(s))),
    command('crewforge.runScenario', async (node) => {
      const scenario = scenarioOf(node);
      const deployment = scenario && node && (await deps.devDeployment(node));
      if (scenario && deployment) await deps.fitness.runScenario(deployment, scenario, deps.readText);
    }),
  ];
}
