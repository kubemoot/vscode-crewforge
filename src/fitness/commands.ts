import * as vscode from 'vscode';
import { connect, type Connection } from '../connection';
import type { Deployment } from '../source/deployments';
import type { Manifest } from '../source/manifests';
import type { SourceService } from '../source/service';
import type { SourceNode } from '../views/sourceTree';
import { confirmModal } from '../views/confirm';
import { runReport, runsInProgress, startRun } from './fitness';

/** Run a crew's fitness from the Crew Sources view, and read a run's report. */
export class FitnessCommands {
  constructor(
    private readonly service: SourceService,
    private readonly afterStart: () => void,
    private readonly connectTo: () => Connection = () => connect(),
  ) {}

  /**
   * Starts a fitness run against a deployment: the definition named `preferred` when the
   * source still has it (a rerun), else the one the developer picks. Resolves to the
   * definition started, or undefined when none was.
   */
  async runFitness(node?: SourceNode, preferred?: string): Promise<string | undefined> {
    if (node?.kind !== 'deployment' && node?.kind !== 'fitness') return undefined;
    const { entry, deployment } = node;
    const definitions = await this.service.fitnessDefinitions(entry, deployment.namespace);
    if (definitions.length === 0) {
      void vscode.window.showInformationMessage(`${entry.source.label} has no CrewFitness or CrewFitnessSuite; add one under fitness/.`);
      return undefined;
    }
    const definition = definitions.find((d) => d.metadata.name === preferred) ?? (await this.pick(definitions, deployment));
    if (!definition) return undefined;
    const connection = this.connectTo();
    const kinds = await this.service.kinds(connection.client);
    const busy = await runsInProgress(connection.client, kinds, deployment.namespace);
    if (busy.length && !(await this.confirmBusy(busy.map((r) => `${r.namespace}/${r.name}`)))) return undefined;
    const name = await startRun(connection.client, kinds, deployment.namespace, definition);
    void vscode.window.showInformationMessage(`Started ${name} in ${deployment.namespace}. Refresh Crew Sources to follow it.`);
    this.afterStart();
    return definition.metadata.name;
  }

  private async pick(definitions: Manifest[], deployment: Deployment): Promise<Manifest | undefined> {
    const choice = await vscode.window.showQuickPick(
      definitions.map((d) => ({ label: d.metadata.name, description: d.kind, definition: d })),
      { placeHolder: `Run which fitness against ${deployment.crew.name} in ${deployment.namespace}?` },
    );
    return choice?.definition;
  }

  async showRun(node?: SourceNode): Promise<void> {
    if (node?.kind !== 'run') return;
    const document = await vscode.workspace.openTextDocument({ content: runReport(node.run), language: 'markdown' });
    await vscode.window.showTextDocument(document, { preview: true });
  }

  private async confirmBusy(runs: string[]): Promise<boolean> {
    const message = `A fitness run is already in progress (${runs.join(', ')}). Crews share the GPUs, so two runs at once measure contention, not the crew. Start anyway?`;
    return confirmModal(message, 'Start anyway');
  }
}
