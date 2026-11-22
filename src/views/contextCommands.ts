import * as vscode from 'vscode';
import type { CrewSummary } from '../k8s/crews';
import type { Located } from '../source/locate';
import type { SourceEntry } from '../source/service';
import { dashboardUrlOf, fileOf, mainFileOf, namedOf, namespacedNameText, nameText, relativePathOf, type AnyNode, type FileTarget, type Named } from './nodeFacts';
import type { ObjectRef } from './crewDetailsTree';

export interface ContextDeps {
  /** The open source that renders a deployed crew. */
  entryForCrew: (crew: CrewSummary) => SourceEntry | undefined;
  /** Where each object of a source starts in its files. */
  located: (entry: SourceEntry) => Promise<Located[]>;
  /** The live object as clean YAML, as Show Live YAML shows it. */
  yamlOf: (ref: ObjectRef) => Promise<string>;
  /** The Kubemoot dashboard URL from the setting, or empty. */
  dashboardBase: () => string;
  /** The live objects the file declares as YAML, and the namespace they are in; nothing when none is deployed. */
  liveForFile: (entry: SourceEntry, file: string) => Promise<{ text: string; namespace: string } | undefined>;
  /** Opens the diff editor with the live text on the left and the file on the right. */
  showFileDiff: (file: string, text: string, namespace: string) => Promise<void>;
}

/** The standard menu items of a tree item: copy it, find it on disk, open its file, open it in the dashboard. */
export class ContextCommands {
  constructor(private readonly deps: ContextDeps) {}

  async copyName(node?: AnyNode): Promise<void> {
    const named = namedOf(node);
    if (named) await vscode.env.clipboard.writeText(nameText(named));
  }

  async copyNamespacedName(node?: AnyNode): Promise<void> {
    const named = namedOf(node);
    if (named) await vscode.env.clipboard.writeText(namespacedNameText(named));
  }

  async copyYaml(node?: AnyNode): Promise<void> {
    const named = namedOf(node);
    if (!named?.kind) return;
    const text = await this.deps.yamlOf({ kind: named.kind, name: named.name, namespace: named.namespace ?? '' });
    await vscode.env.clipboard.writeText(text.replace(/^(#[^\n]*\n)+/, ''));
  }

  async copyPath(node?: AnyNode): Promise<void> {
    const target = await this.target(node);
    if (target) await vscode.env.clipboard.writeText(target.fsPath);
  }

  async copyRelativePath(node?: AnyNode): Promise<void> {
    const target = await this.target(node);
    if (target) await vscode.env.clipboard.writeText(relativePathOf(target.fsPath, workspaceRoots()));
  }

  async revealInExplorerView(node?: AnyNode): Promise<void> {
    await this.withUri(node, (uri) => vscode.commands.executeCommand('revealInExplorer', uri));
  }

  async revealInOS(node?: AnyNode): Promise<void> {
    await this.withUri(node, (uri) => vscode.commands.executeCommand('revealFileInOS', uri));
  }

  /** Opens a terminal in the folder of a source, or of the file's folder. */
  async openInTerminal(node?: AnyNode): Promise<void> {
    const target = await this.target(node);
    if (!target) return this.missing(node);
    const folder = target.folder ? target.fsPath : target.fsPath.replace(/[\\/][^\\/]*$/, '');
    await vscode.commands.executeCommand('openInTerminal', vscode.Uri.file(folder));
  }

  /** Opens the file a node stands for, at its object: a declared object's file, a deployed object's source, a source's main file. */
  async openSourceFile(node?: AnyNode): Promise<void> {
    const target = await this.target(node, true);
    if (!target) return this.missing(node);
    const options = target.line === undefined ? undefined : { selection: new vscode.Range(target.line, 0, target.line, 0) };
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target.fsPath), options);
  }

  /** Opens Chart.yaml of a chart source. */
  async openChartFile(node?: AnyNode): Promise<void> {
    if (node?.kind !== 'source' || node.entry.source.kind !== 'helm') return;
    await this.openSourceFile(node);
  }

  /** Opens Source Control: the file's change when it is in a Git repository, else the view. */
  async openInSourceControl(node?: AnyNode): Promise<void> {
    const target = await this.target(node);
    const entry = node && 'entry' in node ? node.entry : undefined;
    if (!target || !entry || entry.identity.id.startsWith('local:')) {
      void vscode.window.showInformationMessage('This is not in a Git repository.');
      return;
    }
    if (!target.folder) {
      try {
        await vscode.commands.executeCommand('git.openChange', vscode.Uri.file(target.fsPath));
        return;
      } catch {
        // Git is not installed or not enabled: the view below still opens.
      }
    }
    await vscode.commands.executeCommand('workbench.view.scm');
  }

  /** Opens the diff editor on a source file against the live objects it declares. */
  async diffFileWithLive(node?: AnyNode): Promise<void> {
    if (node?.kind !== 'file' || node.folder) return;
    const live = await this.deps.liveForFile(node.entry, node.path);
    if (!live) {
      void vscode.window.showInformationMessage('Nothing in this file is deployed in this context, so there is no live object to compare.');
      return;
    }
    await this.deps.showFileDiff(node.path, live.text, live.namespace);
  }

  async openInDashboard(node?: AnyNode): Promise<void> {
    const named = node?.kind === 'fitness' ? { kind: 'CrewFitnessSuite', name: node.deployment.crew.name, namespace: node.deployment.namespace } : namedOf(node);
    const url = named && dashboardUrlOf(this.deps.dashboardBase(), named);
    if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  private async withUri(node: AnyNode | undefined, act: (uri: vscode.Uri) => Thenable<unknown>): Promise<void> {
    const target = await this.target(node);
    if (!target) return this.missing(node);
    await act(vscode.Uri.file(target.fsPath));
  }

  private missing(node?: AnyNode): void {
    const name = namedOf(node)?.name ?? 'this item';
    void vscode.window.showInformationMessage(`No source file for ${name} is open in this workspace. Add the folder that holds its chart or bundle to the workspace.`);
  }

  /** The file or folder of a node; `file` asks for a file even on a source, which stands for its folder otherwise. */
  private async target(node: AnyNode | undefined, file = false): Promise<FileTarget | undefined> {
    if (node?.kind === 'source' && file) return mainTarget(node.entry);
    return fileOf(node) ?? (await this.deployed(node));
  }

  /** The source of a deployed crew or one of its objects. */
  private deployed(node: AnyNode | undefined): Promise<FileTarget | undefined> {
    if (node?.kind === 'crew') return this.deployedTarget(node.crew, { kind: 'Crew', name: node.crew.name });
    if (node?.kind === 'member' && node.view.ref) return this.deployedTarget(node.crew, node.view.ref);
    return Promise.resolve(undefined);
  }

  /** Where the open source declares a deployed object. */
  private async deployedTarget(crew: CrewSummary, object: Pick<Named, 'kind' | 'name'>): Promise<FileTarget | undefined> {
    const entry = this.deps.entryForCrew(crew);
    if (!entry) return undefined;
    const found = (await this.deps.located(entry)).find((l) => l.file && l.manifest.kind === object.kind && l.manifest.metadata.name === object.name);
    return found?.file ? { fsPath: found.file, folder: false, line: found.line } : undefined;
  }
}

/** The folders of the workspace, by name and path. */
export function workspaceRoots(): { name: string; fsPath: string }[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => ({ name: f.name, fsPath: f.uri.fsPath }));
}

/** The command ids of the standard menu items, each with what it does to a node. */
export function registerContextCommands(commands: ContextCommands, guard: (action: () => Promise<void>) => Promise<void>): vscode.Disposable[] {
  const table: [string, (node?: AnyNode) => Promise<void>][] = [
    ['copyName', (n) => commands.copyName(n)],
    ['copyNamespacedName', (n) => commands.copyNamespacedName(n)],
    ['copyYaml', (n) => commands.copyYaml(n)],
    ['copyPath', (n) => commands.copyPath(n)],
    ['copyRelativePath', (n) => commands.copyRelativePath(n)],
    ['revealInExplorerView', (n) => commands.revealInExplorerView(n)],
    ['revealInOS', (n) => commands.revealInOS(n)],
    ['openInTerminal', (n) => commands.openInTerminal(n)],
    ['openSourceFile', (n) => commands.openSourceFile(n)],
    ['openChartFile', (n) => commands.openChartFile(n)],
    ['openInDashboard', (n) => commands.openInDashboard(n)],
    ['openInSourceControl', (n) => commands.openInSourceControl(n)],
    ['diffFileWithLive', (n) => commands.diffFileWithLive(n)],
  ];
  return table.map(([id, run]) => vscode.commands.registerCommand(`crewforge.${id}`, (node?: AnyNode) => guard(() => run(node))));
}

function mainTarget(entry: SourceEntry): FileTarget | undefined {
  const main = mainFileOf(entry);
  return main ? { fsPath: main, folder: false } : undefined;
}
