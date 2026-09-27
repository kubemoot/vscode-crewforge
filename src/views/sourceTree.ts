import * as vscode from 'vscode';
import { connect, namespaceFilter, type Connection } from '../connection';
import { listCrews } from '../k8s/crews';
import { deploymentDescription, type Deployment } from '../source/deployments';
import { summarize, type ResourceDrift } from '../source/drift';
import { isRunning, runSummary, type FitnessRun } from '../fitness/fitness';
import type { SourceEntry, SourceService } from '../source/service';
import { errorLabel, errorText } from './errors';

export type SourceNode =
  | { kind: 'source'; entry: SourceEntry }
  | { kind: 'deployment'; entry: SourceEntry; deployment: Deployment; drift?: ResourceDrift[]; error?: string }
  | { kind: 'resource'; entry: SourceEntry; deployment: Deployment; drift: ResourceDrift }
  | { kind: 'fitness'; entry: SourceEntry; deployment: Deployment }
  | { kind: 'run'; entry: SourceEntry; deployment: Deployment; run: FitnessRun }
  | { kind: 'message'; text: string; detail?: string; icon?: string };

/** The Crew Sources view: crew charts and bundles in the workspace, where each is deployed, and how each deployment differs from its source. */
export class SourceTreeProvider implements vscode.TreeDataProvider<SourceNode> {
  private readonly changed = new vscode.EventEmitter<SourceNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private entries: SourceEntry[] = [];
  connection?: Connection;

  constructor(
    private readonly service: SourceService,
    private readonly connectTo: () => Connection = () => connect(),
  ) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  /** The sources from the last load, for pickers. */
  get known(): SourceEntry[] {
    return this.entries;
  }

  async getChildren(node?: SourceNode): Promise<SourceNode[]> {
    if (!node) return this.loadRoot();
    if (node.kind === 'source') return this.loadDeployments(node.entry);
    if (node.kind === 'deployment') return deploymentChildren(node);
    if (node.kind === 'fitness') return this.loadRuns(node);
    return [];
  }

  getTreeItem(node: SourceNode): vscode.TreeItem {
    switch (node.kind) {
      case 'source':
        return sourceItem(node.entry);
      case 'deployment':
        return deploymentItem(node);
      case 'resource':
        return resourceItem(node);
      case 'fitness':
        return fitnessItem();
      case 'run':
        return runItem(node);
      default:
        return messageItem(node);
    }
  }

  private async loadRoot(): Promise<SourceNode[]> {
    try {
      this.entries = await this.service.load();
    } catch (err) {
      this.entries = [];
      return [errorMessage(err)];
    }
    if (this.entries.length === 0) return [{ kind: 'message', text: 'No crew charts or bundles in this workspace', icon: 'info' }];
    return this.entries.map((entry) => ({ kind: 'source', entry }));
  }

  private async loadDeployments(entry: SourceEntry): Promise<SourceNode[]> {
    if (entry.error) return [{ kind: 'message', text: entry.error }];
    try {
      this.connection = this.connectTo();
      const connection = this.connection;
      const deployments = this.service.deployments(entry, await listCrews(connection.client, namespaceFilter()));
      if (deployments.length === 0) return [{ kind: 'message', text: `Not deployed in ${connection.context}`, icon: 'circle-slash' }];
      return Promise.all(deployments.map((deployment) => this.withDrift(entry, deployment, connection)));
    } catch (err) {
      return [errorMessage(err)];
    }
  }

  private async loadRuns(node: Extract<SourceNode, { kind: 'fitness' }>): Promise<SourceNode[]> {
    try {
      const connection = this.connection ?? this.connectTo();
      const runs = await this.service.runs(node.deployment, connection.client);
      if (runs.length === 0) return [{ kind: 'message', text: 'No fitness runs yet', icon: 'info' }];
      return runs.map((run) => ({ kind: 'run', entry: node.entry, deployment: node.deployment, run }));
    } catch (err) {
      return [errorMessage(err)];
    }
  }

  private async withDrift(entry: SourceEntry, deployment: Deployment, connection: Connection): Promise<SourceNode> {
    try {
      return { kind: 'deployment', entry, deployment, drift: await this.service.drift(entry, deployment, connection.client) };
    } catch (err) {
      return { kind: 'deployment', entry, deployment, error: errorText(err) };
    }
  }
}

function deploymentChildren(node: Extract<SourceNode, { kind: 'deployment' }>): SourceNode[] {
  const fitness: SourceNode = { kind: 'fitness', entry: node.entry, deployment: node.deployment };
  if (node.error) return [{ kind: 'message', text: node.error }, fitness];
  return [...(node.drift ?? []).map((drift): SourceNode => ({ kind: 'resource', entry: node.entry, deployment: node.deployment, drift })), fitness];
}

function fitnessItem(): vscode.TreeItem {
  const item = new vscode.TreeItem('Fitness', vscode.TreeItemCollapsibleState.Collapsed);
  item.iconPath = new vscode.ThemeIcon('beaker');
  item.contextValue = 'fitness';
  return item;
}

const RUN_ICONS: Record<string, [string, string?]> = {
  Passed: ['pass', 'testing.iconPassed'],
  Completed: ['pass', 'testing.iconPassed'],
  Failed: ['error', 'testing.iconFailed'],
  Error: ['error', 'testing.iconErrored'],
};

function runItem(node: Extract<SourceNode, { kind: 'run' }>): vscode.TreeItem {
  const { run } = node;
  const item = new vscode.TreeItem(run.name, vscode.TreeItemCollapsibleState.None);
  item.description = runSummary(run);
  item.tooltip = `${run.kind} ${run.namespace}/${run.name}\n${runSummary(run)}${run.error ? `\n${run.error}` : ''}`;
  const [icon, color] = isRunning(run) ? ['sync~spin'] : (RUN_ICONS[run.phase] ?? ['circle-outline']);
  item.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
  item.contextValue = 'run';
  item.command = { command: 'crewforge.showRun', title: 'Show Fitness Run', arguments: [node] };
  return item;
}

function sourceItem(entry: SourceEntry): vscode.TreeItem {
  const item = new vscode.TreeItem(entry.source.label, vscode.TreeItemCollapsibleState.Collapsed);
  item.description = entry.crewName ? `crew ${entry.crewName} · ${entry.source.kind}` : entry.source.kind;
  item.tooltip = [entry.source.root, entry.identity.id, entry.identity.revision ? `revision ${entry.identity.revision}` : ''].filter(Boolean).join('\n');
  item.iconPath = new vscode.ThemeIcon(entry.source.kind === 'helm' ? 'package' : 'files');
  item.contextValue = `source-${entry.source.kind}`;
  return item;
}

function deploymentItem(node: Extract<SourceNode, { kind: 'deployment' }>): vscode.TreeItem {
  const { deployment } = node;
  const item = new vscode.TreeItem(deployment.namespace, vscode.TreeItemCollapsibleState.Collapsed);
  const drift = node.error ? 'cannot compare' : summarize(node.drift ?? []);
  item.description = deploymentDescription(deployment, drift);
  item.tooltip = deploymentTooltip(deployment, drift, node.error);
  const inSync = drift === 'in sync';
  item.iconPath = new vscode.ThemeIcon(inSync ? 'pass' : 'diff', new vscode.ThemeColor(inSync ? 'testing.iconPassed' : 'list.warningForeground'));
  item.contextValue = `deployment-${deployment.channel}`;
  return item;
}

function deploymentTooltip(d: Deployment, drift: string, error?: string): string {
  const lines = [`${d.namespace}/${d.crew.name} via ${d.channel}`, `Phase: ${d.crew.phase}`, `Source: ${drift}`];
  if (d.owner) lines.push(`Owner: ${d.owner}`);
  if (d.revision) lines.push(`Revision: ${d.revision}`);
  if (!d.linked) lines.push('This Crew does not name this source; it may come from another copy of the crew.');
  if (error) lines.push(error);
  return lines.join('\n');
}

const RESOURCE_ICONS: Record<ResourceDrift['state'], [string, string]> = {
  'in-sync': ['check', 'testing.iconPassed'],
  changed: ['diff-modified', 'gitDecoration.modifiedResourceForeground'],
  missing: ['diff-added', 'gitDecoration.addedResourceForeground'],
  extra: ['diff-removed', 'gitDecoration.deletedResourceForeground'],
};

const STATE_TEXT: Record<ResourceDrift['state'], string> = {
  'in-sync': 'in sync',
  changed: 'changed in source',
  missing: 'in source, not deployed',
  extra: 'deployed, not in source',
};

function resourceItem(node: Extract<SourceNode, { kind: 'resource' }>): vscode.TreeItem {
  const { drift } = node;
  const item = new vscode.TreeItem(`${drift.kind}/${drift.name}`, vscode.TreeItemCollapsibleState.None);
  item.description = STATE_TEXT[drift.state];
  item.tooltip = drift.paths.length ? `${STATE_TEXT[drift.state]}:\n${drift.paths.join('\n')}` : STATE_TEXT[drift.state];
  const [icon, color] = RESOURCE_ICONS[drift.state];
  item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
  item.contextValue = `resource-${drift.state}`;
  item.command = { command: 'crewforge.showDrift', title: 'Compare with Live', arguments: [node] };
  return item;
}

function messageItem(node: Extract<SourceNode, { kind: 'message' }>): vscode.TreeItem {
  const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
  item.tooltip = node.detail ?? node.text;
  item.iconPath = new vscode.ThemeIcon(node.icon ?? 'warning');
  return item;
}

function errorMessage(err: unknown): SourceNode {
  const message = errorText(err);
  return { kind: 'message', text: errorLabel(message), detail: message };
}
