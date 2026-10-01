import * as vscode from 'vscode';
import { connect, type Connection } from '../connection';
import { CREW_LABEL, toAgent } from '../crew/details';
import type { DeployCommands } from '../deploy/commands';
import type { DeployRequest } from '../deploy/deployer';
import { channelOptions, existingCrew, ownershipWarnings, releaseOf, type TargetState } from '../deploy/plan';
import { readTarget } from '../deploy/target';
import type { FitnessCommands } from '../fitness/commands';
import { sleep as abortableSleep } from '../gitops/follow';
import { listCrews, type CrewSummary } from '../k8s/crews';
import { nameProblem } from '../k8s/paths';
import type { CrewLinter } from '../lint/linter';
import { identify } from '../source/identity';
import { listKind } from '../source/live';
import type { Exec } from '../source/render';
import { sourceOf, type SourceEntry, type SourceService } from '../source/service';
import { confirmModal } from '../views/confirm';
import type { DeploymentNode, SourceNode, SourceTreeProvider } from '../views/sourceTree';
import { waitUntilReady, type CrewReadiness, type WaitOutcome } from './ready';
import { showError } from '../views/notify';
import { pickSource } from '../views/pickSource';
import { stateFrom, stateText, type CrewState, type LoopMemory, type LoopStates } from './state';

/** The chat, as the inner loop uses it: ask a crew, or ask its last question again. */
export interface ChatActions {
  ask(crew: CrewSummary): Promise<void>;
  reaskLast(crew: CrewSummary): Promise<void>;
}

export interface DevLoopDeps {
  sources: Pick<SourceTreeProvider, 'entries' | 'known' | 'loadDeployments' | 'refresh'>;
  service: Pick<SourceService, 'kinds'>;
  deploy: Pick<DeployCommands, 'apply'>;
  fitness: Pick<FitnessCommands, 'runFitness'>;
  linter: Pick<CrewLinter, 'lintCommand' | 'lintOnSave'>;
  memory: LoopMemory;
  states: LoopStates;
  chat: ChatActions;
  /** Shows a live crew in the Deployed Crews view. */
  revealLive: (crew: CrewSummary) => Promise<void>;
  exec: Exec;
  connectTo?: () => Connection;
  /** How the readiness wait pauses between reads; tests pass a quick one. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** A command's argument: a Crew Sources node, a file, or nothing (the active editor's crew). */
export type LoopTarget = SourceNode | vscode.Uri | undefined;

type Deployable = SourceEntry & { crewName: string };

/** The next steps the status bar offers, by what the loop knows about the crew. */
export type ActionId = 'deploy' | 'redeploy' | 'ask' | 'fitness' | 'reveal' | 'lint' | 'namespace' | 'refresh';

const NEXT: Record<CrewState['kind'], ActionId[]> = {
  'not-deployed': ['deploy', 'lint', 'namespace'],
  changed: ['redeploy', 'lint', 'ask', 'fitness', 'namespace'],
  'in-sync': ['ask', 'fitness', 'reveal', 'lint', 'namespace'],
  unknown: ['refresh', 'deploy', 'lint', 'namespace'],
};

const LABELS: Record<ActionId, string> = {
  deploy: '$(cloud-upload) Deploy to Namespace...',
  redeploy: '$(sync) Redeploy',
  ask: '$(comment-discussion) Ask',
  fitness: '$(beaker) Run Fitness',
  reveal: '$(eye) Show in the Deployed Crews view',
  lint: '$(checklist) Lint',
  namespace: '$(edit) Change the Namespace Redeploy Uses...',
  refresh: '$(refresh) Check the state again',
};

export function nextActions(state: CrewState): ActionId[] {
  return NEXT[state.kind];
}

const ASK = 'Ask';
const RUN = 'Run Fitness';
const REASK = 'Re-ask last question';
const RERUN = 'Rerun fitness';
const DEPLOY = 'Deploy to Namespace...';

/**
 * The inner loop: deploy a source to a namespace, redeploy it there with one click, wait until the
 * crew is ready, and ask it or run its fitness; on save, lint the crew and mark it
 * changed since deploy; redeploy, then ask again or rerun fitness. It never touches git.
 */
export class DevLoop {
  private readonly connectTo: () => Connection;

  constructor(private readonly deps: DevLoopDeps) {
    this.connectTo = deps.connectTo ?? (() => connect());
  }

  /** The source a command acts on: the node's, the file's, the active editor's, or the one the developer picks. */
  async entryFor(target?: LoopTarget): Promise<SourceEntry | undefined> {
    if (target && 'entry' in target) return target.entry;
    const entries = await this.deps.sources.entries();
    const file = target instanceof vscode.Uri ? target.fsPath : vscode.window.activeTextEditor?.document.uri.fsPath;
    const found = file ? sourceOf(entries, file) : undefined;
    return found ?? pickSource(entries, 'Which crew source?', 'No crew charts or bundles in this workspace');
  }

  /**
   * Deploys to a namespace the developer picks (the last one, else `crew-<name>`, is
   * offered), remembers it for Redeploy, and waits until the crew is ready. A crew already
   * deployed may go to another namespace too; each deployment shows under its source.
   */
  deployToNamespace(target?: LoopTarget): Promise<void> {
    return this.shipTo(target, (entry, last) => askNamespace(entry, this.connectTo().context, last));
  }

  /** Redeploys to the namespace the source was last deployed to from here (asked when there is none) and waits until the crew is ready. */
  redeploy(target?: LoopTarget): Promise<void> {
    return this.shipTo(target, async (entry, last) => last ?? (await askNamespace(entry, this.connectTo().context)));
  }

  /** Deploys the target's source to the namespace `pick` settles on, given the one Redeploy goes to; none stops. */
  private async shipTo(target: LoopTarget | undefined, pick: (entry: Deployable, last?: string) => Promise<string | undefined>): Promise<void> {
    const entry = deployable(await this.entryFor(target));
    const namespace = entry && (await pick(entry, this.deps.memory.redeployNamespace(entry.source.root)));
    if (entry && namespace) await this.ship(entry, namespace);
  }

  /** Lints the source's chart and every object it renders; findings go to the Problems panel. */
  async lint(target?: LoopTarget): Promise<void> {
    const entry = await this.entryFor(target);
    if (entry) await this.deps.linter.lintCommand(entry);
  }

  /** Opens the chat with the source's deployment (the one Redeploy goes to). */
  async ask(target?: LoopTarget): Promise<void> {
    const entry = deployable(await this.entryFor(target));
    const node = entry && (await this.deploymentOf(entry));
    if (node) await this.deps.chat.ask(node.deployment.crew);
  }

  /** The target source's deployment Redeploy goes to, or undefined after saying why there is none. */
  async redeployTargetOf(target?: LoopTarget): Promise<DeploymentNode | undefined> {
    const entry = deployable(await this.entryFor(target));
    return entry && this.deploymentOf(entry);
  }

  /** Runs a fitness definition against the source's deployment; `rerun` starts the last one again without asking. */
  async runFitness(target?: LoopTarget, rerun = false): Promise<void> {
    const entry = deployable(await this.entryFor(target));
    const node = entry && (await this.deploymentOf(entry));
    if (!entry || !node) return;
    const root = entry.source.root;
    const started = await this.deps.fitness.runFitness(node, rerun ? this.deps.memory.lastFitness(root) : undefined);
    if (started) await this.deps.memory.setLastFitness(root, started);
  }

  /** The status bar's menu: the next steps for the crew in its current state. */
  async actions(target?: LoopTarget): Promise<void> {
    const entry = deployable(await this.entryFor(target));
    if (!entry) return;
    const state = this.deps.states.get(entry.source.root) ?? (await this.refreshState(entry));
    const choice = await vscode.window.showQuickPick(
      nextActions(state).map((id) => ({ label: LABELS[id], id })),
      { placeHolder: `${entry.crewName}: ${stateText(state)}` },
    );
    if (choice) await this.run(choice.id, entry, state);
  }

  private run(id: ActionId, entry: Deployable, state: CrewState): Promise<void> {
    const node: SourceNode = { kind: 'source', entry };
    const handlers: Record<ActionId, () => Promise<unknown>> = {
      deploy: () => this.deployToNamespace(node),
      redeploy: () => this.redeploy(node),
      ask: () => this.ask(node),
      fitness: () => this.runFitness(node),
      reveal: () => ('deployment' in state ? this.deps.revealLive(state.deployment.deployment.crew) : Promise.resolve()),
      lint: () => this.lint(node),
      namespace: () => this.changeNamespace(entry),
      refresh: () => this.refreshState(entry),
    };
    return handlers[id]().then(() => undefined);
  }

  /** Reads the source's deployments and drift again and records where it stands. */
  async refreshState(entry: SourceEntry): Promise<CrewState> {
    const nodes = await this.deps.sources.loadDeployments(entry);
    const state = stateFrom(nodes, this.deps.memory.redeployNamespace(entry.source.root));
    this.deps.states.set(entry.source.root, state);
    return state;
  }

  /** A crew file was saved: mark the crew changed since deploy, then lint it and check its drift once saves settle. */
  onSaved(file: string): void {
    const entry = sourceOf(this.deps.sources.known, file);
    if (!entry?.crewName) return;
    this.deps.states.markChanged(entry.source.root);
    this.deps.linter.lintOnSave(entry, () => {
      this.deps.sources.refresh();
      void this.refreshState(entry);
    });
  }

  private async changeNamespace(entry: Deployable): Promise<void> {
    const namespace = await askNamespace(entry, this.connectTo().context, this.deps.memory.redeployNamespace(entry.source.root));
    if (!namespace) return;
    await this.deps.memory.setRedeployNamespace(entry.source.root, namespace);
    await this.refreshState(entry);
  }

  /** The source's deployment Redeploy goes to, or a message saying why there is none. */
  private async deploymentOf(entry: Deployable): Promise<DeploymentNode | undefined> {
    const state = await this.refreshState(entry);
    if ('deployment' in state) return state.deployment;
    if (state.kind === 'unknown') {
      void vscode.window.showErrorMessage(`CrewForge cannot tell where ${entry.crewName} is deployed: ${state.reason}`);
      return undefined;
    }
    void vscode.window.showInformationMessage(`${entry.crewName} is not deployed in ${this.connectTo().context}. Deploy it to a namespace first.`, DEPLOY).then((choice) => {
      if (choice === DEPLOY) void this.deployToNamespace({ kind: 'source', entry });
    });
    return undefined;
  }

  private async ship(entry: Deployable, namespace: string): Promise<void> {
    const connection = this.connectTo();
    const target = await readTarget(connection.client, namespace);
    const request = await this.request(entry, target);
    if (!request) return;
    await this.deps.memory.setRedeployNamespace(entry.source.root, namespace);
    const redeploy = existingCrew(target, entry.crewName) !== undefined;
    try {
      await this.deps.deploy.apply(connection, request, false);
    } finally {
      await this.refreshState(entry);
    }
    const result = await this.waitForCrew(connection, namespace, entry.crewName);
    await this.refreshState(entry);
    await this.report(entry, namespace, result, redeploy);
  }

  /** The deploy request, after checking the namespace can take this crew and confirming anything to confirm. */
  private async request(entry: Deployable, target: TargetState): Promise<DeployRequest | undefined> {
    const channel = entry.source.kind === 'helm' ? 'helm' : 'bundle';
    const option = channelOptions(entry.source, entry.crewName, target).find((o) => o.channel === channel);
    if (!option?.enabled) {
      void vscode.window.showInformationMessage(`${entry.crewName} cannot go to ${target.namespace} with one click: ${option?.reason}. Pick another namespace with Deploy to Namespace..., or use Deploy with a Channel....`);
      return undefined;
    }
    const identity = await identify(entry.source, this.deps.exec);
    const warnings = ownershipWarnings(identity, entry.crewName, target);
    if (warnings.length && !(await confirmModal(warnings.join('\n\n'), 'Deploy anyway'))) return undefined;
    return { entry, identity, namespace: target.namespace, channel, release: releaseOf(target, entry.crewName) };
  }

  /** Follows the crew until its Crew and agents are ready, with progress the developer can cancel. */
  private async waitForCrew(connection: Connection, namespace: string, crew: string): Promise<WaitOutcome & { crew?: CrewSummary }> {
    const { client } = connection;
    const kinds = await this.deps.service.kinds(client);
    let latest: CrewSummary | undefined;
    const read = async (): Promise<CrewReadiness> => {
      latest = (await listCrews(client, [namespace])).find((c) => c.name === crew);
      const agentKind = kinds.get('Agent');
      if (!agentKind) return { crew: latest };
      const agents = await listKind(client, agentKind, namespace);
      return { crew: latest, agents: agents.filter((a) => a.metadata.labels?.[CREW_LABEL] === crew).map(toAgent) };
    };
    const title = `${crew} in ${namespace}`;
    const outcome = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, (progress, token) => {
      const stop = new AbortController();
      token.onCancellationRequested(() => stop.abort());
      return waitUntilReady({ read, sleep: this.deps.sleep ?? abortableSleep, report: (message) => progress.report({ message }) }, stop.signal);
    });
    return { ...outcome, crew: latest };
  }

  private async report(entry: Deployable, namespace: string, result: WaitOutcome & { crew?: CrewSummary }, redeploy: boolean): Promise<void> {
    const where = `${entry.crewName} in ${namespace}`;
    if (result.outcome !== 'ready' || !result.crew) return notReady(where, result);
    const crew = result.crew;
    await this.deps.revealLive(crew);
    const text = redeploy ? `${where} is redeployed and ready.` : `${where} is ready.`;
    const actions = redeploy ? [REASK, RERUN] : [ASK, RUN];
    void vscode.window.showInformationMessage(text, ...actions).then((choice) => this.follow(choice, entry, crew));
  }

  /** What the developer picked from the notification after a deploy. */
  private async follow(choice: string | undefined, entry: Deployable, crew: CrewSummary): Promise<void> {
    const node: SourceNode = { kind: 'source', entry };
    const next: Record<string, () => Promise<void>> = {
      [ASK]: () => this.deps.chat.ask(crew),
      [RUN]: () => this.runFitness(node),
      [REASK]: () => this.deps.chat.reaskLast(crew),
      [RERUN]: () => this.runFitness(node, true),
    };
    try {
      await next[choice ?? '']?.();
    } catch (err) {
      void showError(err);
    }
  }
}

function notReady(where: string, result: WaitOutcome): void {
  if (result.outcome === 'failed') void vscode.window.showErrorMessage(`${where} did not come up: ${result.message}. See its agents in the Deployed Crews view.`);
  else if (result.outcome === 'stopped') void vscode.window.showInformationMessage(`Stopped waiting. ${where} keeps deploying; the Deployed Crews view shows its state.`);
  else void vscode.window.showWarningMessage(`${where} is not ready yet: ${result.message}. See its agents in the Deployed Crews view.`);
}

/** The source when it renders a Crew; otherwise says why it cannot be deployed. */
function deployable(entry?: SourceEntry): Deployable | undefined {
  if (!entry) return undefined;
  if (entry.crewName) return entry as Deployable;
  void vscode.window.showErrorMessage(`CrewForge: ${entry.source.label} cannot be deployed: ${entry.error ?? 'it renders no Crew'}.`);
  return undefined;
}


/** Asks for the namespace to deploy to, the last one or `crew-<name>` by default; CrewForge remembers it for Redeploy. */
async function askNamespace(entry: Deployable, context: string, current?: string): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    title: `Deploy ${entry.crewName} to which namespace?`,
    prompt: `A namespace in ${context}. CrewForge remembers it, and Redeploy goes there.`,
    value: current ?? `crew-${entry.crewName}`,
    validateInput: (v) => nameProblem('namespace', v),
  });
  return value?.trim() || undefined;
}
