import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Connection } from '../connection';
import type { Exec } from '../source/render';
import type { SourceNode } from '../views/sourceTree';
import { kmctlProblem, scaffoldCrew, type CreateCrewRequest } from './scaffold';
import { crewNameProblem, deriveCrewName, displayNameProblem } from '../crew/displayName';

/** The families kmctl's scaffold has model sizes for. */
const MODEL_FAMILIES = ['qwen', 'gemma', 'llama', 'mistral'];

/**
 * The sizes of kmctl's starter crew, a read-only guide to its own namespace. Each size adds
 * the next specialist, in kmctl's order: workloads, events, networking, config, reviewer.
 */
export const CREW_SIZES: readonly { label: string; description: string }[] = [
  { label: '1', description: 'workloads: pods, Deployments, ReplicaSets, StatefulSets, Jobs' },
  { label: '2', description: 'adds events: Warning events, restarts, recent failures' },
  { label: '3', description: 'adds networking: Services, endpoints, routes, NetworkPolicies' },
  { label: '4', description: 'adds config: ConfigMaps, ServiceAccounts, Secret references' },
  { label: '5', description: 'adds a reviewer that checks the answer against the gathered data' },
];

/**
 * Checks kmctl first, then asks for a display name and the technical name it suggests, a size, and a model family, and scaffolds
 * the crew as a chart in `folder` (New Kubemoot Crew Here in the Explorer) or in a folder the
 * developer picks. A missing or old kmctl, or a failed scaffold, is a modal error, so it
 * is seen before or instead of a toast that fades. `afterCreate` gets the new chart's folder.
 */
export async function createCrewCommand(exec: Exec, connection: Pick<Connection, 'source' | 'context'> | undefined, afterCreate: (root: string) => Promise<void>, folder?: string): Promise<void> {
  const problem = await kmctlProblem(exec);
  if (problem) {
    void vscode.window.showErrorMessage(problem, { modal: true });
    return;
  }
  const request = await askRequest(folder);
  if (!request) return;
  let created: { root: string; warnings: string };
  try {
    created = await scaffoldCrew(exec, request, connection);
  } catch (err) {
    void vscode.window.showErrorMessage(`CrewForge could not create ${request.displayName}. ${err instanceof Error ? err.message : String(err)}`, { modal: true });
    return;
  }
  if (created.warnings) void vscode.window.showWarningMessage(created.warnings);
  await afterCreate(created.root);
}

export interface CreatedDeps {
  /** Loads Crew Sources again and gives its source nodes. */
  reload: () => Promise<SourceNode[]>;
  /** Selects a source in Crew Sources. */
  reveal: (node: SourceNode) => Thenable<void>;
}

export const DEPLOY_NEXT = 'Deploy to Namespace...';

/**
 * After scaffolding: selects the new crew in Crew Sources, opens its README with
 * `templates/crew.yaml` beside it, and offers the loop's next step, deploying it to a
 * namespace.
 */
export async function showCreatedCrew(root: string, deps: CreatedDeps): Promise<void> {
  const node = (await deps.reload()).find((n) => n.kind === 'source' && n.entry.source.root === root);
  if (node) await deps.reveal(node);
  await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, 'README.md')), { preview: false });
  await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, 'templates', 'crew.yaml')), { viewColumn: vscode.ViewColumn.Beside, preview: false });
  if (!node) {
    void vscode.window.showInformationMessage(`Created ${root}. It is outside this workspace's folders, so Crew Sources does not list it; add its folder to the workspace to deploy it from there.`);
    return;
  }
  void vscode.window.showInformationMessage(`Created the crew ${path.basename(root)}. Next: deploy it to a namespace and ask it something.`, DEPLOY_NEXT).then((choice) => {
    if (choice === DEPLOY_NEXT) void vscode.commands.executeCommand('crewforge.deployToNamespace', node);
  });
}

async function askRequest(folder?: string): Promise<CreateCrewRequest | undefined> {
  const parent = folder ?? (await pickParent());
  if (!parent) return;
  const names = await askNames(parent);
  if (!names) return;
  const size = await vscode.window.showQuickPick(CREW_SIZES, { placeHolder: 'How many specialists beside the coordinator? Each size is a working crew that reads its own namespace.' });
  if (!size) return;
  const family = await vscode.window.showQuickPick([...MODEL_FAMILIES.map((f) => ({ label: f })), { label: 'none', description: 'add Models yourself' }], {
    placeHolder: 'Which model family should its Models use?',
  });
  if (!family) return;
  return { ...names, parent, members: Number(size.label), modelFamily: family.label === 'none' ? undefined : family.label };
}

/**
 * Asks for the name people read, any text, then for the technical name, suggested from it
 * the way a deploy suggests its namespace, and editable.
 */
async function askNames(parent: string): Promise<{ displayName: string; name: string } | undefined> {
  const display = await vscode.window.showInputBox({
    title: `Create a crew in ${parent}`,
    prompt: 'Crew name, as people will read it: any text, such as "Homelab Health Guide"',
    validateInput: displayNameProblem,
  });
  const displayName = display?.trim();
  if (!displayName) return undefined;
  const name = await vscode.window.showInputBox({
    title: `Kubernetes name for ${displayName}`,
    prompt: "Use lowercase letters, digits and hyphens; it becomes the Kubernetes name of the crew's objects and its chart's folder.",
    value: deriveCrewName(displayName),
    validateInput: crewNameProblem,
  });
  return name?.trim() ? { displayName, name: name.trim() } : undefined;
}

const BROWSE = '$(folder-opened) Browse...';

/**
 * Asks where the crew goes. The first choice is the folder of the active file when it is
 * in the workspace, else the first workspace folder; the workspace folders follow, then
 * a folder picker.
 */
async function pickParent(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showInformationMessage('Open a folder first; the new crew is created inside it.');
    return undefined;
  }
  const active = activeFolder(folders.map((f) => f.uri.fsPath));
  const choices = [...new Set([active ?? folders[0].uri.fsPath, ...folders.map((f) => f.uri.fsPath)])];
  const items = [
    ...choices.map((dir, i) => ({ label: `$(folder) ${vscode.workspace.asRelativePath(dir)}`, description: i === 0 && active ? "the active file's folder" : undefined, detail: dir, dir })),
    { label: BROWSE, dir: undefined },
  ];
  const choice = await vscode.window.showQuickPick(items, { placeHolder: 'Create the crew in which folder? Its chart becomes a subfolder named after the crew.' });
  if (!choice) return undefined;
  if (choice.dir) return choice.dir;
  const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, defaultUri: vscode.Uri.file(choices[0]), openLabel: 'Create the crew here' });
  return picked?.[0]?.fsPath;
}

/** The folder of the active editor's file, when that file is inside one of the workspace folders. */
function activeFolder(roots: string[]): string | undefined {
  const file = vscode.window.activeTextEditor?.document.uri;
  if (file?.scheme !== 'file') return undefined;
  const dir = path.dirname(file.fsPath);
  return roots.some((root) => dir === root || dir.startsWith(root + path.sep)) ? dir : undefined;
}
