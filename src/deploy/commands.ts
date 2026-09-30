import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { connect, type Connection } from '../connection';
import { nameProblem } from '../k8s/paths';
import { deployedAtByRevision, stripDirty, type Channel, type Deployment } from '../source/deployments';
import { confirmModal } from '../views/confirm';
import { identify } from '../source/identity';
import type { RenderDeps } from '../source/render';
import type { SourceEntry } from '../source/service';
import type { SourceNode, SourceTreeProvider } from '../views/sourceTree';
import { errorText } from '../views/errors';
import { keyOf, objectKey, type Manifest } from '../source/manifests';
import { listRevisions, materialize } from '../revisions/revisions';
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
    private readonly scratch: string = os.tmpdir(),
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

  /** Deploys an earlier (or later) commit of the source through the deployment's channel: a rollback or a roll forward. */
  async deployRevision(node?: SourceNode): Promise<void> {
    if (node?.kind !== 'deployment') return;
    const { entry, deployment } = node;
    if (deployment.channel === 'flux') return gitOpsGuidance(deployment, 'revert the commit instead');
    const current = stripDirty(deployment.revision);
    const history = deployedAtByRevision(deployment);
    const revisions = await listRevisions(this.deps.exec, entry.source);
    const choice = await vscode.window.showQuickPick(
      revisions.map((r) => ({ label: r.hash, description: revisionNote(r.date, r.hash === current, history.get(r.hash)), detail: r.subject, revision: r })),
      { placeHolder: `Deploy which revision of ${entry.source.label} to ${deployment.namespace}?`, matchOnDetail: true },
    );
    if (!choice) return;
    const { hash, subject } = choice.revision;
    if (!(await confirm([`Deploy ${entry.source.label} as of ${hash} (${subject}) to ${deployment.namespace} via ${deployment.channel}? It replaces what runs there now.`], 'Deploy revision'))) return;
    const source = await materialize(this.deps.exec, entry.source, hash, this.scratch);
    try {
      const identity = { ...(await identify(entry.source, this.deps.exec)), revision: hash };
      await this.run(this.connectTo(), { entry: { ...entry, source }, identity, namespace: deployment.namespace, channel: deployment.channel, release: deployment.release });
    } finally {
      await fs.rm(source.root, { recursive: true, force: true });
    }
  }

  async removeDeployment(node?: SourceNode): Promise<void> {
    if (node?.kind !== 'deployment') return;
    const { entry, deployment } = node;
    if (deployment.channel === 'flux') return gitOpsGuidance(deployment);
    const warnings = [removalWarning(deployment, removalMethod(deployment))];
    if (!deployment.linked) warnings.push(notLinked(deployment));
    await this.confirmAndRemove(deployment, warnings, (deployer) => deployer.remove(entry, deployment));
  }

  /**
   * Removes a live crew whose source CrewForge does not know: a Helm crew by uninstalling
   * its release, any other by deleting the given Kubemoot objects, after the developer
   * confirms with the crew's name and the list of what goes.
   */
  async removeUnsourced(deployment: Deployment, objects: Manifest[]): Promise<void> {
    if (deployment.channel === 'flux') return gitOpsGuidance(deployment);
    const helm = deployment.channel === 'helm';
    const method = helm ? removalMethod(deployment) : `CrewForge deletes these Kubemoot objects: ${objects.map(objectKey).join(', ')}.`;
    await this.confirmAndRemove(deployment, [removalWarning(deployment, method)], (deployer) =>
      helm ? deployer.uninstall(deployment) : deployer.deleteObjects(deployment.namespace, objects),
    );
  }

  private async confirmAndRemove(deployment: Deployment, warnings: string[], remove: (deployer: Deployer) => Promise<string>): Promise<void> {
    if (!(await confirm(warnings, 'Remove'))) return;
    const deployer = this.deployer(this.connectTo());
    await this.withLog(`Removing ${deployment.crew.name} from ${deployment.namespace}`, () => remove(deployer));
  }

  private async run(connection: Connection, request: DeployRequest): Promise<void> {
    await this.apply(connection, request, true);
  }

  /**
   * Deploys through helm or kubectl with progress and a log in the output channel. With
   * `announce` it says when the tool is done; the inner loop, which waits for the crew to
   * be ready, says so itself.
   */
  async apply(connection: Connection, request: DeployRequest, announce: boolean): Promise<void> {
    const what = `${request.only ? 'Applying changes to' : 'Deploying'} ${request.entry.crewName} in ${request.namespace} via ${request.channel}`;
    await this.withLog(what, () => this.deployer(connection).deploy(request), announce);
  }

  private async withLog(title: string, action: () => Promise<string>, announce = true): Promise<void> {
    this.output.appendLine(`> ${title}`);
    try {
      const text = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, action);
      if (text) this.output.appendLine(text);
      if (announce) void vscode.window.showInformationMessage(`${title}: done. The operator reconciles it now.`);
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
  return confirmModal(warnings.join('\n\n'), action);
}

function revisionNote(date: string, current: boolean, deployedAt?: string): string {
  if (current) return `${date} · deployed now`;
  if (deployedAt === undefined) return date;
  const when = deployedAt ? ` (${deployedAt})` : '';
  return `${date} · deployed here before${when}`;
}

/** How a removal happens, for the confirmation. */
function removalMethod(d: Deployment): string {
  return d.channel === 'helm'
    ? `CrewForge runs helm uninstall ${d.release ?? d.crew.name}, which deletes what the release installed.`
    : 'CrewForge deletes the Kubemoot objects the source renders; nothing else.';
}

/** What removing does; a crew marked kubemoot.ai/manage-namespace takes its namespace with it. */
function removalWarning(d: Deployment, method: string): string {
  const base = `Remove the crew ${d.crew.name} from ${d.namespace}? ${method} Its agents stop, and the Kubemoot operator's finalizers clean up what it made for them;`;
  return d.crew.annotations?.['kubemoot.ai/manage-namespace'] === 'true'
    ? `${base} this crew manages its namespace, so the operator deletes ${d.namespace} and everything in it too.`
    : `${base} the namespace stays.`;
}

function notLinked(d: Deployment): string {
  return `${d.crew.name} in ${d.namespace} does not name this source; it may come from another copy of the crew.`;
}

/** Says that Flux owns the crew and how to change it through git; CrewForge does not touch it. */
export function gitOpsGuidance(d: Deployment, rollback?: string): void {
  const release = d.crew.labels?.['helm.toolkit.fluxcd.io/name'];
  const via = release ? `the HelmRelease ${release}` : 'Flux';
  const how = rollback ? `To go back, ${rollback}; merging it deploys it.` : 'Commit and push your change; merging it deploys it, and removing it from git removes the crew.';
  void vscode.window.showInformationMessage(`${via} manages ${d.crew.name} in ${d.namespace}. ${how}`);
}
