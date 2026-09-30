import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DeployCommands } from '../deploy/commands';
import { nameProblem } from '../k8s/paths';
import type { DeploymentNode, SourceNode, SourceTreeProvider } from '../views/sourceTree';
import { errorText } from '../views/errors';
import { refuseIfDirty, renameWithEdit } from './fsEdit';
import { renameCrewFiles } from './rename';
import { fitnessFolders, type SourceEntry } from './service';

export interface SourceActionDeps {
  sources: Pick<SourceTreeProvider, 'loadDeployments' | 'reload' | 'known'>;
  deploy: Pick<DeployCommands, 'removeDeployment'>;
}

const UNDEPLOY_FIRST = 'Undeploy First';
const KEEP_DEPLOYED = 'Keep It Deployed';
const MOVE_TO_TRASH = 'Move to Trash';
const UNDEPLOY_THEN_RENAME = 'Undeploy, Then Rename';
const RENAME_ONLY = 'Rename Only';

/**
 * What a crew source's menu does to the source itself: Undeploy (remove a deployment,
 * through the channel it came by), Delete Crew Source (the folder goes to the trash),
 * and Rename Crew (the chart, the Crew, and the names built on it). CrewForge removes
 * only Kubemoot objects and Helm releases of them; the operator cleans up the rest.
 */
export class SourceActions {
  constructor(private readonly deps: SourceActionDeps) {}

  /** Removes a deployment of the source: the one given, the only one, or the one the developer picks. */
  async undeploy(node?: SourceNode): Promise<void> {
    if (node?.kind === 'deployment') return this.deps.deploy.removeDeployment(node);
    if (node?.kind !== 'source') return;
    const deployments = await this.deploymentsOf(node.entry);
    if (deployments.length === 0) {
      void vscode.window.showInformationMessage(`${label(node.entry)} is not deployed in this context.`);
      return;
    }
    const chosen = deployments.length > 1 ? await pickDeployment(node.entry, deployments) : deployments[0];
    if (chosen) await this.deps.deploy.removeDeployment(chosen);
  }

  /** Moves the source's folder to the trash after a confirmation that names it; a deployed crew is offered undeploy first. */
  async deleteSource(node?: SourceNode): Promise<void> {
    if (node?.kind !== 'source') return;
    const { entry } = node;
    const refusal = this.deleteRefusal(entry);
    if (refusal) {
      void vscode.window.showErrorMessage(`CrewForge: ${refusal}`);
      return;
    }
    if (!(await this.offerUndeploy(entry, deletePrompt, UNDEPLOY_FIRST, KEEP_DEPLOYED))) return;
    const kept = await existing(outsideFitness(entry));
    const beside = kept.length ? ` The fitness folder beside it, ${kept.join(', ')}, stays.` : '';
    const detail = `The folder ${entry.source.root} and everything in it move to the trash.${beside} Nothing in the cluster changes.`;
    const answer = await vscode.window.showWarningMessage(`Delete the crew source ${entry.source.label}?`, { modal: true, detail }, MOVE_TO_TRASH);
    if (answer !== MOVE_TO_TRASH) return;
    await vscode.workspace.fs.delete(vscode.Uri.file(entry.source.root), { recursive: true, useTrash: true });
    await this.deps.sources.reload();
    void vscode.window.showInformationMessage(`Moved ${entry.source.root} to the trash.`);
  }

  /**
   * Renames the crew in its source: the chart's name, the Crew, and every name built on
   * the crew's (its Agents, PromptModules, policy, fitness suites) and the references to
   * them; the folder too when it carries the crew's name. A deployed crew keeps its old
   * name until it is undeployed, so the developer is offered that first.
   */
  async rename(node?: SourceNode): Promise<void> {
    if (node?.kind !== 'source' || !node.entry.crewName || refuseIfDirty([node.entry.source.root, ...outsideFitness(node.entry)], 'renaming the crew; the rename rewrites its files')) return;
    const { entry } = node;
    const from = node.entry.crewName;
    const to = await askNewName(from);
    if (!to) return;
    const prompt = (where: string) => renamePrompt(from, to, where);
    if (await this.offerUndeploy(entry, prompt, UNDEPLOY_THEN_RENAME, RENAME_ONLY)) await this.applyRename(entry, from, to);
  }

  /** Rewrites the files and moves the folder, saying what changed, or how far it got when something failed. */
  private async applyRename(entry: SourceEntry, from: string, to: string): Promise<void> {
    const changed: string[] = [];
    try {
      await renameCrewFiles(entry.source.root, from, to, outsideFitness(entry), changed);
      const moved = isWorkspaceFolder(entry.source.root) ? undefined : await renameFolder(entry.source.root, from, to);
      const folder = moved ? ` and its folder to ${moved}` : '';
      void vscode.window.showInformationMessage(`Renamed crew ${from} to ${to} in ${files(changed.length)}${folder}. Redeploy to deploy it as ${to}.`);
    } catch (err) {
      void vscode.window.showErrorMessage(`CrewForge: renaming ${from} stopped after changing ${files(changed.length)}: ${errorText(err)}. git checkout restores them.`);
    } finally {
      await this.deps.sources.reload();
    }
  }

  /** Why a source's folder must not go to the trash: it is a workspace folder, or holds another crew source. */
  private deleteRefusal(entry: SourceEntry): string | undefined {
    const root = entry.source.root;
    if (isWorkspaceFolder(root)) return `${root} is a workspace folder; remove it from the workspace instead of deleting it here.`;
    const inside = this.deps.sources.known.find((e) => e.source.root.startsWith(root + path.sep));
    return inside && `${root} holds another crew source, ${inside.source.label}; delete that one first.`;
  }

  /**
   * When the source is deployed, asks whether to undeploy it first. Resolves false when
   * the developer cancels, true to go on (after undeploying, when that was the choice).
   */
  private async offerUndeploy(entry: SourceEntry, prompt: (where: string) => { message: string; detail: string }, undeploy: string, keep: string): Promise<boolean> {
    const deployments = await this.deploymentsOf(entry);
    if (deployments.length === 0) return true;
    const { message, detail } = prompt(namespacesOf(deployments));
    const choice = await vscode.window.showWarningMessage(message, { modal: true, detail }, undeploy, keep);
    if (!choice) return false;
    if (choice !== undeploy) return true;
    for (const d of deployments) await this.deps.deploy.removeDeployment(d);
    const left = await this.deploymentsOf(entry);
    if (left.length === 0) return true;
    void vscode.window.showInformationMessage(`${label(entry)} is still deployed in ${namespacesOf(left)}, so nothing else was changed.`);
    return false;
  }

  private async deploymentsOf(entry: SourceEntry): Promise<DeploymentNode[]> {
    if (!entry.crewName) return [];
    const nodes = await this.deps.sources.loadDeployments(entry);
    return nodes.filter((n): n is DeploymentNode => n.kind === 'deployment');
  }
}

const label = (entry: SourceEntry) => entry.crewName ?? entry.source.label;

function deletePrompt(where: string): { message: string; detail: string } {
  return {
    message: `This crew is deployed in ${where}. Undeploy it before deleting its source?`,
    detail: 'Deleting the folder does not change the cluster. Without its source, remove the deployment later from the Deployed Crews view.',
  };
}

function renamePrompt(from: string, to: string, where: string): { message: string; detail: string } {
  return {
    message: `${from} is deployed in ${where}. Undeploy it before renaming?`,
    detail: `A deployed crew keeps its name. After the rename, Redeploy deploys ${to} as a new crew, and ${from} runs until you undeploy it; the operator cleans up after it.`,
  };
}

async function askNewName(from: string): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    title: `Rename crew ${from}`,
    prompt: 'The new crew name. The chart, the Crew, and the names built on it (agents, prompt modules, policy, fitness suites) change with it.',
    value: from,
    validateInput: (v) => (v.trim() === from ? 'Enter a different name.' : nameProblem('crew', v)),
  });
  return value?.trim() || undefined;
}

async function pickDeployment(entry: SourceEntry, deployments: DeploymentNode[]): Promise<DeploymentNode | undefined> {
  const choice = await vscode.window.showQuickPick(
    deployments.map((node) => ({ label: node.deployment.namespace, description: `${node.deployment.channel} · ${node.deployment.crew.phase}`, node })),
    { placeHolder: `Undeploy ${label(entry)} from which namespace?` },
  );
  return choice?.node;
}

/** The fitness folders of a source that are not inside it (the one beside it), which the rename covers too. */
function outsideFitness(entry: SourceEntry): string[] {
  return fitnessFolders(entry.source).filter((f) => !f.startsWith(entry.source.root + path.sep));
}

const files = (n: number) => (n === 1 ? '1 file' : `${n} files`);

function isWorkspaceFolder(root: string): boolean {
  return (vscode.workspace.workspaceFolders ?? []).some((f) => f.uri.fsPath === root);
}

const namespacesOf = (deployments: DeploymentNode[]) => deployments.map((d) => d.deployment.namespace).join(', ');

/** The folders among these that exist. */
async function existing(folders: string[]): Promise<string[]> {
  const found = await Promise.all(folders.map(exists));
  return folders.filter((_, i) => found[i]);
}

/** Renames the source folder when it carries the crew's name and the new name is free; returns the new folder, if moved. */
async function renameFolder(root: string, from: string, to: string): Promise<string | undefined> {
  if (path.basename(root) !== from) return undefined;
  const target = path.join(path.dirname(root), to);
  if (await exists(target)) return undefined;
  await renameWithEdit(root, target);
  return target;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
