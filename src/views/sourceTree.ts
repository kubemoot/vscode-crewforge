import * as vscode from 'vscode';
import { connect, namespaceFilter, type Connection } from '../connection';
import { listCrews } from '../k8s/crews';
import { deploymentDescription, historyLines, type Deployment } from '../source/deployments';
import { summarize, type ResourceDrift } from '../source/drift';
import { isRunning, runSummary, type FitnessRun } from '../fitness/fitness';
import { fluxSummary, type FluxState } from '../gitops/flux';
import type { DeclaredItem, DeclaredSection } from '../source/declared';
import type { SourceEntry, SourceService } from '../source/service';
import { errorLabel, errorText } from './errors';

export type SourceNode =
  | { kind: 'source'; entry: SourceEntry }
  | { kind: 'deployment'; entry: SourceEntry; deployment: Deployment; drift?: ResourceDrift[]; error?: string; flux?: FluxState; fluxError?: string }
  | { kind: 'resource'; entry: SourceEntry; deployment: Deployment; drift: ResourceDrift }
  | { kind: 'fitness'; entry: SourceEntry; deployment: Deployment }
  | { kind: 'run'; entry: SourceEntry; deployment: Deployment; run: FitnessRun }
  | { kind: 'declSection'; entry: SourceEntry; section: DeclaredSection; items: DeclaredItem[] }
  | { kind: 'declared'; entry: SourceEntry; item: DeclaredItem }
  | { kind: 'message'; text: string; detail?: string; icon?: string };

export type DeploymentNode = Extract<SourceNode, { kind: 'deployment' }>;

/** A source's state as its line shows it: a few words, and whether it changed since its deploy. */
export interface SourceState {
  text: string;
  changed: boolean;
}

/** The Crew Sources view: crew charts and bundles in the workspace, where each is deployed, and how each deployment differs from its source. */
export class SourceTreeProvider implements vscode.TreeDataProvider<SourceNode> {
  private readonly changed = new vscode.EventEmitter<SourceNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private loadedEntries: SourceEntry[] = [];
  private readonly loaded = new Map<string, DeploymentNode[]>();
  private readonly loadedChanged = new vscode.EventEmitter<void>();
  /** Fires when a source's deployments and drift have been (re)loaded. */
  readonly onDidLoadDeployments = this.loadedChanged.event;
  private readonly sourcesLoaded = new vscode.EventEmitter<void>();
  /** Fires when the workspace's sources have been (re)loaded. */
  readonly onDidLoadSources = this.sourcesLoaded.event;
  connection?: Connection;
  /** The source nodes of the last load, so one source's line can be redrawn alone. */
  private roots: SourceNode[] = [];
  /** Where each source stands, by folder, shown on its line; set by the inner loop. */
  stateOf: (root: string) => SourceState | undefined = () => undefined;

  constructor(
    private readonly service: SourceService,
    private readonly connectTo: () => Connection = () => connect(),
  ) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  /** Redraws one source's line, as when its state changes, without loading the workspace again. */
  refreshSource(root: string): void {
    const node = this.roots.find((n) => n.kind === 'source' && n.entry.source.root === root);
    if (node) this.changed.fire(node);
  }

  /** The workspace's sources: those last loaded, or a fresh load when there are none. */
  async entries(): Promise<SourceEntry[]> {
    if (this.loadedEntries.length === 0) await this.loadRoot();
    return this.loadedEntries;
  }

  /** Loads the sources again and redraws the view; resolves to the new source nodes, for revealing one. */
  async reload(): Promise<SourceNode[]> {
    const nodes = await this.loadRoot();
    this.refresh();
    return nodes;
  }

  /** The deployments of a source, with their drift, from the last time it was expanded. */
  deploymentsOf(root: string): DeploymentNode[] {
    return this.loaded.get(root) ?? [];
  }

  /** The sources from the last load, for pickers. */
  get known(): SourceEntry[] {
    return this.loadedEntries;
  }

  async getChildren(node?: SourceNode): Promise<SourceNode[]> {
    if (!node) return this.loadRoot();
    if (node.kind === 'source') return this.loadSource(node.entry);
    if (node.kind === 'deployment') return deploymentChildren(node);
    if (node.kind === 'fitness') return this.loadRuns(node);
    if (node.kind === 'declSection') return node.items.map((item) => ({ kind: 'declared', entry: node.entry, item }));
    return [];
  }

  /** A node's source, so a source can be revealed; sources are the roots. */
  getParent(node: SourceNode): SourceNode | undefined {
    return node.kind === 'source' || node.kind === 'message' ? undefined : { kind: 'source', entry: node.entry };
  }

  getTreeItem(node: SourceNode): vscode.TreeItem {
    switch (node.kind) {
      case 'source':
        return sourceItem(node.entry, this.stateOf(node.entry.source.root));
      case 'deployment':
        return deploymentItem(node);
      case 'resource':
        return resourceItem(node);
      case 'fitness':
        return fitnessItem();
      case 'run':
        return runItem(node);
      case 'declSection':
        return declSectionItem(node);
      case 'declared':
        return declaredItem(node.item);
      default:
        return messageItem(node);
    }
  }

  private async loadRoot(): Promise<SourceNode[]> {
    try {
      this.loadedEntries = await this.service.load();
    } catch (err) {
      this.loadedEntries = [];
      return [errorMessage(err)];
    }
    this.roots = this.loadedEntries.map((entry) => ({ kind: 'source', entry }));
    this.sourcesLoaded.fire();
    return this.roots.length ? this.roots : [{ kind: 'message', text: 'No crew charts or bundles in this workspace', icon: 'info' }];
  }

  /** What a source declares, then where it is deployed. */
  private async loadSource(entry: SourceEntry): Promise<SourceNode[]> {
    if (entry.error) return [{ kind: 'message', text: entry.error }];
    const [declared, deployments] = await Promise.all([this.loadDeclarations(entry), this.loadDeployments(entry)]);
    return [...declared, ...deployments];
  }

  private async loadDeclarations(entry: SourceEntry): Promise<SourceNode[]> {
    try {
      const { crew, sections } = await this.service.declarations(entry);
      const shown = sections.filter((s) => s.items.length > 0 || s.section !== 'mcp');
      const crewNode: SourceNode[] = crew ? [{ kind: 'declared', entry, item: crew }] : [];
      return [...crewNode, ...shown.map((s): SourceNode => ({ kind: 'declSection', entry, ...s }))];
    } catch (err) {
      return [errorMessage(err)];
    }
  }

  /** Loads a source's deployments and their drift, for the tree and for the status bar. */
  async loadDeployments(entry: SourceEntry): Promise<SourceNode[]> {
    try {
      this.connection = this.connectTo();
      const connection = this.connection;
      const deployments = this.service.deployments(entry, await listCrews(connection.client, namespaceFilter()));
      const nodes = await Promise.all(deployments.map((deployment) => this.withDrift(entry, deployment, connection)));
      this.loaded.set(entry.source.root, nodes as DeploymentNode[]);
      this.loadedChanged.fire();
      return nodes.length ? nodes : [{ kind: 'message', text: `Not deployed in ${connection.context}`, icon: 'circle-slash' }];
    } catch (err) {
      this.loaded.delete(entry.source.root);
      this.loadedChanged.fire();
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
    const { flux, fluxError } = await this.fluxOf(deployment, connection);
    try {
      return { kind: 'deployment', entry, deployment, flux, fluxError, drift: await this.service.drift(entry, deployment, connection.client, flux) };
    } catch (err) {
      return { kind: 'deployment', entry, deployment, flux, fluxError, error: errorText(err) };
    }
  }

  /** The HelmRelease state; a workshop account may not read HelmReleases, which is not an error for the tree. */
  private async fluxOf(deployment: Deployment, connection: Connection): Promise<{ flux?: FluxState; fluxError?: string }> {
    if (deployment.channel !== 'flux') return {};
    try {
      return { flux: await this.service.flux(deployment, connection.client) };
    } catch (err) {
      return { fluxError: errorText(err) };
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
  const error = run.error ? `\n${run.error}` : '';
  item.tooltip = `${run.kind} ${run.namespace}/${run.name}\n${runSummary(run)}${error}`;
  const [icon, color] = isRunning(run) ? ['sync~spin'] : (RUN_ICONS[run.phase] ?? ['circle-outline']);
  item.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
  item.contextValue = 'run';
  item.command = { command: 'crewforge.showRun', title: 'Show Fitness Run', arguments: [node] };
  return item;
}

const SECTIONS: Record<DeclaredSection, [string, string]> = {
  agents: ['Agents', 'organization'],
  prompts: ['PromptModules', 'note'],
  skills: ['Skills', 'mortar-board'],
  mcp: ['MCP Servers', 'server-process'],
  fitness: ['Fitness Scenarios', 'beaker'],
};

function declSectionItem(node: Extract<SourceNode, { kind: 'declSection' }>): vscode.TreeItem {
  const [title, icon] = SECTIONS[node.section];
  const empty = node.items.length === 0;
  const item = new vscode.TreeItem(title, empty ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
  item.description = empty ? 'none' : String(node.items.length);
  item.iconPath = new vscode.ThemeIcon(icon);
  item.contextValue = `declSection-${node.section}`;
  return item;
}

/** One declared object; clicking it opens its file at the object. */
function declaredItem(declared: DeclaredItem): vscode.TreeItem {
  const item = new vscode.TreeItem(declared.label, vscode.TreeItemCollapsibleState.None);
  item.description = declared.description;
  item.tooltip = declared.file ? `${declared.tooltip}\n${declared.file}:${declared.line + 1}` : declared.tooltip;
  item.iconPath = new vscode.ThemeIcon(declared.icon, declared.warn ? new vscode.ThemeColor('list.warningForeground') : undefined);
  item.contextValue = 'declared';
  if (declared.file) item.command = openAt(declared.file, declared.line);
  return item;
}

/** The command that opens a file with the cursor at the start of a line. */
export function openAt(file: string, line: number): vscode.Command {
  const at = new vscode.Range(line, 0, line, 0);
  return { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(file), { selection: at }] };
}

function sourceItem(entry: SourceEntry, state?: SourceState): vscode.TreeItem {
  const item = new vscode.TreeItem(entry.source.label, vscode.TreeItemCollapsibleState.Collapsed);
  item.id = `source:${entry.source.root}`;
  const what = entry.crewName ? `crew ${entry.crewName} · ${entry.source.kind}` : entry.source.kind;
  item.description = state ? `${what} · ${state.text}` : what;
  item.tooltip = [entry.source.root, entry.identity.id, entry.identity.revision ? `revision ${entry.identity.revision}` : ''].filter(Boolean).join('\n');
  item.iconPath = new vscode.ThemeIcon(entry.source.kind === 'helm' ? 'package' : 'files');
  item.contextValue = `source-${entry.source.kind}${state?.changed ? '-changed' : ''}`;
  return item;
}

function deploymentItem(node: Extract<SourceNode, { kind: 'deployment' }>): vscode.TreeItem {
  const { deployment } = node;
  const item = new vscode.TreeItem(deployment.namespace, vscode.TreeItemCollapsibleState.Collapsed);
  const drift = node.error ? 'cannot compare' : summarize(node.drift ?? []);
  item.description = deploymentDescription(deployment, drift, node.flux && fluxSummary(node.flux));
  item.tooltip = [deploymentTooltip(deployment, drift, node.error), ...fluxLines(node), ...historyLines(deployment)].join('\n');
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

function fluxLines(node: Extract<SourceNode, { kind: 'deployment' }>): string[] {
  if (node.fluxError) return [`Flux: cannot read the HelmRelease (${node.fluxError})`];
  if (!node.flux) return [];
  const lines = [`HelmRelease ${node.flux.ref.namespace}/${node.flux.ref.name}: ${fluxSummary(node.flux)}`];
  if (node.flux.message) lines.push(node.flux.message);
  if (node.flux.hasValuesFrom) lines.push('Its valuesFrom are not read, so drift may show values Flux sets.');
  return lines;
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
