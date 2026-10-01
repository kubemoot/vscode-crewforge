import * as vscode from 'vscode';
import { connect, type Connection } from '../connection';
import type { Deployment } from '../source/deployments';
import type { Manifest } from '../source/manifests';
import type { SourceEntry, SourceService } from '../source/service';
import type { DeploymentNode, SourceNode } from '../views/sourceTree';
import { confirmModal } from '../views/confirm';
import type { KubeTransport } from '../k8s/request';
import type { ScenarioRef } from '../source/declared';
import type { KubemootKind } from '../source/live';
import type { FitnessActivity } from './controls';
import { isRunning, listRuns, runReport, runsInProgress, SINGLE_SCENARIO, startRun } from './fitness';

/** A CrewFitness that runs one loose script file. */
export function scriptFitness(crew: string, name: string, content: string): Manifest {
  return {
    apiVersion: 'kubemoot.ai/v1alpha1',
    kind: 'CrewFitness',
    metadata: { name: `${crew}-${name}`, labels: { 'kubemoot.ai/crew': crew }, annotations: { [SINGLE_SCENARIO]: 'true' } },
    spec: { crewRef: crew, testRef: name, testContent: content },
  };
}

/** A definition cut down to one scenario: a suite with only that script and one iteration, or a CrewFitness as it is; marked as a single-scenario run. */
export function singleScenario(owner: Manifest, scenario: ScenarioRef): Manifest | undefined {
  const annotations = { ...owner.metadata.annotations, [SINGLE_SCENARIO]: 'true' };
  if (scenario.kind === 'fitness') return { ...owner, metadata: { ...owner.metadata, annotations } };
  const spec = owner.spec as { scripts?: { testRef?: string }[] } | undefined;
  const script = spec?.scripts?.find((s) => s.testRef === scenario.name);
  if (!script) return undefined;
  return { ...owner, metadata: { ...owner.metadata, name: `${owner.metadata.name}-${scenario.name}`, annotations }, spec: { ...spec, iterations: 1, scripts: [script] } };
}

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
   * Runs one scenario against a deployment: a suite's script as a suite of that one
   * script, a CrewFitness as itself, a loose script file as a CrewFitness holding it.
   * Each runs one iteration, and is marked so its dashboard offers Stop.
   */
  async runScenario(node: DeploymentNode, scenario: ScenarioRef, readText: (file: string) => Promise<string>): Promise<string | undefined> {
    const { entry, deployment } = node;
    const connection = this.connectTo();
    const kinds = await this.service.kinds(connection.client);
    if (await this.refuseWhileRunning(connection.client, kinds, deployment)) return undefined;
    const definition = await this.scenarioDefinition(entry, deployment, scenario, readText);
    if (!definition) {
      void vscode.window.showErrorMessage(`CrewForge: ${entry.source.label} no longer defines the scenario ${scenario.name}.`);
      return undefined;
    }
    return (await this.start(connection.client, kinds, deployment, definition)) ? definition.metadata.name : undefined;
  }

  private async scenarioDefinition(entry: SourceEntry, deployment: Deployment, scenario: ScenarioRef, readText: (file: string) => Promise<string>): Promise<Manifest | undefined> {
    if (scenario.kind === 'script-file') return scriptFitness(deployment.crew.name, scenario.name, await readText(scenario.file));
    const owner = (await this.service.fitnessDefinitions(entry, deployment.namespace)).find((d) => d.metadata.name === scenario.owner);
    return owner && singleScenario(owner, scenario);
  }

  /** Refuses, saying why, when a fitness run of this crew is in progress. */
  private async refuseWhileRunning(client: KubeTransport, kinds: Map<string, KubemootKind>, deployment: Deployment): Promise<boolean> {
    const mine = (await listRuns(client, kinds, deployment.namespace, deployment.crew.name)).filter(isRunning);
    this.activity?.record(deployment.namespace, deployment.crew.name, mine);
    if (mine.length === 0) return false;
    void vscode.window.showInformationMessage(`A fitness run of ${deployment.crew.name} is in progress (${mine.map((r) => r.name).join(', ')}). Wait for it, or stop it from its Fitness dashboard, before starting another.`);
    return true;
  }

  /** Starts a run after warning about runs of other crews on the shared GPUs; false when the developer declines. */
  private async start(client: KubeTransport, kinds: Map<string, KubemootKind>, deployment: Deployment, definition: Manifest): Promise<boolean> {
    const busy = await runsInProgress(client, kinds, deployment.namespace);
    if (busy.length && !(await this.confirmBusy(busy.map((r) => `${r.namespace}/${r.name}`)))) return false;
    const name = await startRun(client, kinds, deployment.namespace, definition);
    this.activity?.started(deployment.namespace, deployment.crew.name, name);
    void vscode.window.showInformationMessage(`Started ${name} in ${deployment.namespace}. Its Fitness dashboard follows it.`);
    this.afterStart();
    return true;
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
