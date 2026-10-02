import * as vscode from 'vscode';
import { connect, type Connection } from '../connection';
import type { Deployment } from '../source/deployments';
import type { Manifest } from '../source/manifests';
import type { SourceService } from '../source/service';
import type { SourceNode } from '../views/sourceTree';
import { confirmModal } from '../views/confirm';
import type { KubeTransport } from '../k8s/request';
import type { KubemootKind } from '../source/live';
import type { FitnessActivity } from './controls';
import { isRunning, listRuns, runReport, runsInProgress, startRun } from './fitness';

/** Run a crew's fitness from the Crew Sources view, and read a run's report. */
export class FitnessCommands {
  constructor(
    private readonly service: SourceService,
    private readonly afterStart: () => void,
    private readonly connectTo: () => Connection = () => connect(),
    private readonly activity?: FitnessActivity,
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
    const connection = this.connectTo();
    const kinds = await this.service.kinds(connection.client);
    if (await this.refuseWhileRunning(connection.client, kinds, deployment)) return undefined;
    const definition = definitions.find((d) => d.metadata.name === preferred) ?? (await this.pick(definitions, deployment));
    if (!definition || !(await this.start(connection.client, kinds, deployment, definition))) return undefined;
    return definition.metadata.name;
  }

  /**
   * Starts a run of a definition built elsewhere, such as a suite of the scenarios a live
   * crew carries, after the same checks as any run. Resolves to the name of the run
   * started, or undefined when none was.
   */
  async runDefinition(deployment: Deployment, definition: Manifest): Promise<string | undefined> {
    const connection = this.connectTo();
    const kinds = await this.service.kinds(connection.client);
    if (await this.refuseWhileRunning(connection.client, kinds, deployment)) return undefined;
    return this.start(connection.client, kinds, deployment, definition);
  }

  /** Refuses, saying why, when a fitness run of this crew is in progress. */
  private async refuseWhileRunning(client: KubeTransport, kinds: Map<string, KubemootKind>, deployment: Deployment): Promise<boolean> {
    const mine = (await listRuns(client, kinds, deployment.namespace, deployment.crew.name)).filter(isRunning);
    this.activity?.record(deployment.namespace, deployment.crew.name, mine);
    if (mine.length === 0) return false;
    void vscode.window.showInformationMessage(`A fitness run of ${deployment.crew.name} is in progress (${mine.map((r) => r.name).join(', ')}). Wait for it, or stop it from its Fitness dashboard, before starting another.`);
    return true;
  }

  /** Starts a run after warning about runs of other crews on the shared GPUs; the run's name, or undefined when the developer declines. */
  private async start(client: KubeTransport, kinds: Map<string, KubemootKind>, deployment: Deployment, definition: Manifest): Promise<string | undefined> {
    const busy = await runsInProgress(client, kinds, deployment.namespace);
    if (busy.length && !(await this.confirmBusy(busy.map((r) => `${r.namespace}/${r.name}`)))) return undefined;
    const name = await startRun(client, kinds, deployment.namespace, definition);
    this.activity?.started(deployment.namespace, deployment.crew.name, name);
    void vscode.window.showInformationMessage(`Started ${name} in ${deployment.namespace}. Its Fitness dashboard follows it.`);
    this.afterStart();
    return name;
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
