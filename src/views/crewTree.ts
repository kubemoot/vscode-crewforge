import * as vscode from 'vscode';
import { connect, namespaceFilter, type Connection } from '../connection';
import { listCrews, type CrewSummary } from '../k8s/crews';
import { errorLabel, errorText } from './errors';
import { crewDescription, crewTooltip, groupByNamespace, type NamespaceGroup } from './treeModel';

export type CrewNode =
  | { kind: 'namespace'; group: NamespaceGroup }
  | { kind: 'crew'; crew: CrewSummary }
  | { kind: 'message'; text: string; detail?: string };

/** The Crews view: namespaces, and the crews in each, with their readiness. */
export class CrewTreeProvider implements vscode.TreeDataProvider<CrewNode> {
  private readonly changed = new vscode.EventEmitter<CrewNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private crews: CrewSummary[] = [];
  connection?: Connection;

  refresh(): void {
    this.changed.fire(undefined);
  }

  /** The crews from the last load, for pickers. */
  get known(): CrewSummary[] {
    return this.crews;
  }

  async getChildren(node?: CrewNode): Promise<CrewNode[]> {
    if (node?.kind === 'namespace') return node.group.crews.map((crew) => ({ kind: 'crew', crew }));
    if (node) return [];
    return this.loadRoot();
  }

  getTreeItem(node: CrewNode): vscode.TreeItem {
    if (node.kind === 'namespace') {
      const item = new vscode.TreeItem(node.group.namespace, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon('symbol-namespace');
      item.contextValue = 'namespace';
      return item;
    }
    if (node.kind === 'message') {
      const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
      item.tooltip = node.detail ?? node.text;
      item.iconPath = new vscode.ThemeIcon('warning');
      return item;
    }
    return crewItem(node.crew);
  }

  private async loadRoot(): Promise<CrewNode[]> {
    try {
      this.connection = connect();
      this.crews = await listCrews(this.connection.client, namespaceFilter());
    } catch (err) {
      this.crews = [];
      const message = errorText(err);
      return [{ kind: 'message', text: errorLabel(message), detail: message }];
    }
    return groupByNamespace(this.crews).map((group) => ({ kind: 'namespace', group }));
  }
}

function crewItem(crew: CrewSummary): vscode.TreeItem {
  const item = new vscode.TreeItem(crew.name, vscode.TreeItemCollapsibleState.None);
  item.description = crewDescription(crew);
  item.tooltip = crewTooltip(crew);
  item.contextValue = 'crew';
  item.iconPath = crew.ready
    ? new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'))
    : new vscode.ThemeIcon('circle-large-outline', new vscode.ThemeColor('list.warningForeground'));
  item.command = { command: 'crewforge.askCrew', title: 'Ask Crew', arguments: [{ kind: 'crew', crew }] };
  return item;
}

