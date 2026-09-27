import * as vscode from 'vscode';
import { connect, type Connection } from '../connection';
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

  async runFitness(node?: SourceNode): Promise<void> {
    if (node?.kind !== 'deployment' && node?.kind !== 'fitness') return;
    const { entry, deployment } = node;
    const definitions = await this.service.fitnessDefinitions(entry, deployment.namespace);
    if (definitions.length === 0) {
      void vscode.window.showInformationMessage(`${entry.source.label} has no CrewFitness or CrewFitnessSuite; add one under fitness/.`);
      return;
    }
    const choice = await vscode.window.showQuickPick(
      definitions.map((d) => ({ label: d.metadata.name, description: d.kind, definition: d })),
      { placeHolder: `Run which fitness against ${deployment.crew.name} in ${deployment.namespace}?` },
    );
    if (!choice) return;
    const connection = this.connectTo();
    const kinds = await this.service.kinds(connection.client);
    const busy = await runsInProgress(connection.client, kinds, deployment.namespace);
    if (busy.length && !(await this.confirmBusy(busy.map((r) => `${r.namespace}/${r.name}`)))) return;
    const name = await startRun(connection.client, kinds, deployment.namespace, choice.definition);
    void vscode.window.showInformationMessage(`Started ${name} in ${deployment.namespace}. Refresh Crew Sources to follow it.`);
    this.afterStart();
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
