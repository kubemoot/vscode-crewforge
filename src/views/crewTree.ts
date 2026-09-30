import * as vscode from 'vscode';
import { connect, namespaceFilter, type Connection } from '../connection';
import { loadCrewDetails, type CrewDetails } from '../crew/details';
import { listCrews, type CrewSummary } from '../k8s/crews';
import { channelOf } from '../source/deployments';
import { discoverKinds, type KubemootKind } from '../source/live';
import { memberItem, membersOf, readyIcon, sectionItem, sectionsOf, type DetailNode } from './crewDetailsTree';
import { errorLabel, errorText } from './errors';
import { crewDescription, crewTooltip, groupByNamespace, type NamespaceGroup } from './treeModel';

export type CrewNode =
  | { kind: 'namespace'; group: NamespaceGroup }
  | { kind: 'crew'; crew: CrewSummary }
  | DetailNode
  | { kind: 'message'; text: string; detail?: string };

export type LiveCrewNode = Extract<CrewNode, { kind: 'crew' }>;

const crewKey = (crew: CrewSummary) => `${crew.namespace}/${crew.name}`;

/** The Crews view: namespaces, the crews in each with their readiness, and what each crew is made of. */
export class CrewTreeProvider implements vscode.TreeDataProvider<CrewNode> {
  private readonly changed = new vscode.EventEmitter<CrewNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private crews: CrewSummary[] = [];
  private kinds?: Promise<Map<string, KubemootKind>>;
  private readonly details = new Map<string, CrewDetails>();
  connection?: Connection;

  constructor(private readonly connectTo: () => Connection = () => connect()) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  /** The crews from the last load, for pickers. */
  get known(): CrewSummary[] {
    return this.crews;
  }

  async getChildren(node?: CrewNode): Promise<CrewNode[]> {
    if (!node) return this.loadRoot();
    if (node.kind === 'namespace') return node.group.crews.map((crew) => ({ kind: 'crew', crew }));
    if (node.kind === 'crew') return this.loadCrew(node.crew);
    if (node.kind === 'section') return membersOf(node);
    return [];
  }

  /** A crew's namespace, so a crew can be revealed; namespaces and messages are roots. */
  getParent(node: CrewNode): CrewNode | undefined {
    if (node.kind !== 'crew') return undefined;
    const group = groupByNamespace(this.crews).find((g) => g.namespace === node.crew.namespace);
    return group && { kind: 'namespace', group };
  }

  /** The crew's node after reading the crews again; undefined when the view does not list it, as with a namespace filter. */
  async nodeFor(namespace: string, name: string): Promise<LiveCrewNode | undefined> {
    await this.loadRoot();
    const crew = this.crews.find((c) => c.namespace === namespace && c.name === name);
    return crew && { kind: 'crew', crew };
  }

  getTreeItem(node: CrewNode): vscode.TreeItem {
    switch (node.kind) {
      case 'namespace':
        return namespaceItem(node.group);
      case 'crew':
        return crewItem(node.crew, this.details.get(crewKey(node.crew))?.archetype);
      case 'section':
        return sectionItem(node);
      case 'member':
        return memberItem(node);
      default:
        return messageItem(node);
    }
  }

  /** Fills a crew's tooltip on hover with what only its details tell, such as its archetype. */
  async resolveTreeItem(item: vscode.TreeItem, node: CrewNode): Promise<vscode.TreeItem> {
    if (node.kind !== 'crew') return item;
    try {
      item.tooltip = crewTooltip(node.crew, (await this.detailsOf(node.crew)).archetype);
    } catch {
      // The tooltip keeps what the Crew alone says; expanding the crew shows the error.
    }
    return item;
  }

  /** The crew's Agents, PromptModules, Skills, and so on, read fresh from the cluster. */
  async detailsOf(crew: CrewSummary): Promise<CrewDetails> {
    const connection = this.connection ?? this.connectTo();
    this.kinds ??= discoverKinds(connection.client);
    const kinds = this.kinds;
    kinds.catch(() => {
      if (this.kinds === kinds) this.kinds = undefined;
    });
    const details = await loadCrewDetails(connection.client, await kinds, crew.namespace, crew.name);
    this.details.set(crewKey(crew), details);
    return details;
  }

  private async loadCrew(crew: CrewSummary): Promise<CrewNode[]> {
    try {
      const details = await this.detailsOf(crew);
      const problems = details.problems.map((p): CrewNode => ({ kind: 'message', text: errorLabel(`Cannot read ${p}`), detail: p }));
      return [...sectionsOf(crew, details), ...problems];
    } catch (err) {
      const message = errorText(err);
      return [{ kind: 'message', text: errorLabel(message), detail: message }];
    }
  }

  private async loadRoot(): Promise<CrewNode[]> {
    try {
      this.connection = this.connectTo();
      this.kinds = undefined;
      this.crews = await listCrews(this.connection.client, namespaceFilter());
    } catch (err) {
      this.crews = [];
      const message = errorText(err);
      return [{ kind: 'message', text: errorLabel(message), detail: message }];
    }
    return groupByNamespace(this.crews).map((group) => ({ kind: 'namespace', group }));
  }
}

function namespaceItem(group: NamespaceGroup): vscode.TreeItem {
  const item = new vscode.TreeItem(group.namespace, vscode.TreeItemCollapsibleState.Expanded);
  item.id = `namespace:${group.namespace}`;
  item.iconPath = new vscode.ThemeIcon('symbol-namespace');
  item.contextValue = 'namespace';
  return item;
}

function messageItem(node: Extract<CrewNode, { kind: 'message' }>): vscode.TreeItem {
  const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
  item.tooltip = node.detail ?? node.text;
  item.iconPath = new vscode.ThemeIcon('warning');
  return item;
}

/** The context value that picks a crew's menu: Flux-managed crews change through git. */
export function crewContext(crew: CrewSummary): string {
  return channelOf(crew) === 'flux' ? 'crew-flux' : 'crew';
}

function crewItem(crew: CrewSummary, archetype?: string): vscode.TreeItem {
  const item = new vscode.TreeItem(crew.name, vscode.TreeItemCollapsibleState.Collapsed);
  item.id = `crew:${crew.namespace}/${crew.name}`;
  item.description = crewDescription(crew);
  item.tooltip = crewTooltip(crew, archetype);
  item.contextValue = crewContext(crew);
  const { icon, color } = readyIcon(crew.ready);
  item.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
  item.command = { command: 'crewforge.askCrew', title: 'Ask Crew', arguments: [{ kind: 'crew', crew }] };
  return item;
}
