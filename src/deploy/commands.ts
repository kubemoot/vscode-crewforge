import * as vscode from 'vscode';
import { connect, type Connection } from '../connection';
import { nameProblem } from '../k8s/paths';
import type { Channel, Deployment } from '../source/deployments';
import { identify } from '../source/identity';
import type { RenderDeps } from '../source/render';
import type { SourceEntry } from '../source/service';
import type { SourceNode, SourceTreeProvider } from '../views/sourceTree';
import { errorText } from '../views/errors';
import { keyOf } from '../source/manifests';
import { Deployer, isDeployable, KubeTools, type DeployChannel, type DeployRequest } from './deployer';
import { channelOptions, ownershipWarnings, releaseOf, type ChannelOption } from './plan';
import { readTarget } from './target';

const CHANNEL_LABELS: Record<Channel, string> = {
  helm: 'Helm: helm upgrade --install',
  bundle: 'Bundle: kubectl apply --server-side',
  flux: 'Flux: commit and push; Flux applies it',
};

/** Deploy, update, remove, and apply-one-resource, from the Crew Sources view. */
export class DeployCommands {
  constructor(
    private readonly sources: SourceTreeProvider,
    private readonly deps: RenderDeps,
    private readonly output: vscode.OutputChannel,
    private readonly afterChange: () => void,
    private readonly connectTo: () => Connection = () => connect(),
  ) {}

  /** Deploys a source into a namespace the developer names, through a channel that suits it. */
  async deploySource(node?: SourceNode): Promise<void> {
    const entry = node?.kind === 'source' ? node.entry : await this.pickSource();
    if (!entry?.crewName) return;
    const connection = this.connectTo();
    const namespace = await askNamespace(entry.source.label, entry.crewName, connection.context);
    if (!namespace) return;
    const target = await readTarget(connection.client, namespace);
    const channel = await pickChannel(channelOptions(entry.source, entry.crewName, target));
    if (!channel) return;
    const identity = await identify(entry.source, this.deps.exec);
    if (!(await confirm(ownershipWarnings(identity, entry.crewName, target), 'Deploy anyway'))) return;
    await this.run(connection, { entry, identity, namespace, channel, release: releaseOf(target, entry.crewName) });
  }

  /** Brings a deployment up to its source through the channel it came through; a bundle applies only what differs. */
  async updateDeployment(node?: SourceNode): Promise<void> {
    if (node?.kind !== 'deployment') return;
    const { entry, deployment } = node;
    if (deployment.channel === 'flux') return gitOpsGuidance(deployment);
    if (!deployment.linked && !(await confirm([notLinked(deployment)], 'Update anyway'))) return;
    const only = deployment.channel === 'bundle' && node.drift ? new Set(node.drift.filter((d) => d.state === 'changed' || d.state === 'missing').map((d) => keyOf(d.kind, d.name))) : undefined;
    if (only?.size === 0) {
      void vscode.window.showInformationMessage(`${deployment.crew.name} in ${deployment.namespace} already matches its source.`);
      return;
    }
    const identity = await identify(entry.source, this.deps.exec);
    await this.run(this.connectTo(), { entry, identity, namespace: deployment.namespace, channel: deployment.channel, release: deployment.release, only });
  }

  /** Applies one changed or missing object of a bundle deployment. */
  async applyResource(node?: SourceNode): Promise<void> {
    if (node?.kind !== 'resource') return;
    const { entry, deployment, drift } = node;
    if (deployment.channel !== 'bundle') {
      void vscode.window.showInformationMessage(`${deployment.crew.name} in ${deployment.namespace} came through ${deployment.channel}; update the whole deployment instead.`);
      return;
    }
    const identity = await identify(entry.source, this.deps.exec);
    await this.run(this.connectTo(), { entry, identity, namespace: deployment.namespace, channel: 'bundle', only: new Set([keyOf(drift.kind, drift.name)]) });
  }

  async removeDeployment(node?: SourceNode): Promise<void> {
    if (node?.kind !== 'deployment') return;
    const { entry, deployment } = node;
    if (deployment.channel === 'flux') return gitOpsGuidance(deployment);
    const warnings = [removalWarning(deployment)];
    if (!deployment.linked) warnings.push(notLinked(deployment));
    if (!(await confirm(warnings, 'Remove'))) return;
    const connection = this.connectTo();
    await this.withLog(`Removing ${deployment.crew.name} from ${deployment.namespace}`, () => this.deployer(connection).remove(entry, deployment));
  }

  private async run(connection: Connection, request: DeployRequest): Promise<void> {
    const what = `${request.only ? 'Applying changes to' : 'Deploying'} ${request.entry.crewName} in ${request.namespace} via ${request.channel}`;
    await this.withLog(what, () => this.deployer(connection).deploy(request));
  }

  private async withLog(title: string, action: () => Promise<string>): Promise<void> {
    this.output.appendLine(`> ${title}`);
    try {
      const text = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, action);
      if (text) this.output.appendLine(text);
      void vscode.window.showInformationMessage(`${title}: done. The operator reconciles it now.`);
    } catch (err) {
      this.output.appendLine(errorText(err));
      this.output.show(true);
      throw err;
    } finally {
      this.afterChange();
    }
  }

  private deployer(connection: Connection): Deployer {
    return new Deployer(new KubeTools(this.deps.exec, connection.source, connection.context), connection.client, this.deps);
  }

  private async pickSource(): Promise<SourceEntry | undefined> {
    const deployable = this.sources.known.filter((e) => e.crewName);
    const choice = await vscode.window.showQuickPick(
      deployable.map((entry) => ({ label: entry.source.label, description: `crew ${entry.crewName} · ${entry.source.kind}`, entry })),
      { placeHolder: deployable.length ? 'Deploy which crew source?' : 'No crew sources loaded; open the Crew Sources view first' },
    );
    return choice?.entry;
  }
}

function askNamespace(source: string, crew: string, context: string): Thenable<string | undefined> {
  return vscode.window.showInputBox({
    title: `Deploy ${crew} from ${source}`,
    prompt: `Namespace in ${context}; <team>-<crew> reads well`,
    value: crew,
    validateInput: (value) => nameProblem('namespace', value),
  });
}

/** The deployable channel the developer picks; undefined when cancelled, unavailable, or Flux. */
async function pickChannel(options: ChannelOption[]): Promise<DeployChannel | undefined> {
  const choice = await vscode.window.showQuickPick(
    options.map((option) => ({ label: `${option.enabled ? '' : '$(circle-slash) '}${CHANNEL_LABELS[option.channel]}`, description: option.reason, option })),
    { placeHolder: 'Deploy through which channel?' },
  );
  if (!choice) return undefined;
  if (!choice.option.enabled) {
    void vscode.window.showInformationMessage(choice.option.reason ?? 'That channel is not available here.');
    return undefined;
  }
  if (!isDeployable(choice.option.channel)) {
    void vscode.window.showInformationMessage('Commit and push the change; merging it to the branch Flux watches deploys it.');
    return undefined;
  }
  return choice.option.channel;
}

async function confirm(warnings: string[], action: string): Promise<boolean> {
  if (warnings.length === 0) return true;
  const answer = await vscode.window.showWarningMessage(warnings.join('\n\n'), { modal: true }, action);
  return answer === action;
}

/** What removing does; a crew marked kubemoot.ai/manage-namespace takes its namespace with it. */
function removalWarning(d: Deployment): string {
  const base = `Remove ${d.crew.name} from ${d.namespace}? Its agents stop and its Kubemoot objects are deleted;`;
  return d.crew.annotations?.['kubemoot.ai/manage-namespace'] === 'true'
    ? `${base} this crew manages its namespace, so the operator deletes ${d.namespace} and everything in it too.`
    : `${base} the namespace stays.`;
}

function notLinked(d: Deployment): string {
  return `${d.crew.name} in ${d.namespace} does not name this source; it may come from another copy of the crew.`;
}

function gitOpsGuidance(d: Deployment): void {
  const release = d.crew.labels?.['helm.toolkit.fluxcd.io/name'];
  const via = release ? `the HelmRelease ${release}` : 'Flux';
  void vscode.window.showInformationMessage(`${via} manages ${d.crew.name} in ${d.namespace}. Commit and push your change; merging it deploys it, and removing it from git removes the crew.`);
}
