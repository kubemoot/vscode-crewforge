import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Connection } from '../connection';
import type { Exec } from '../source/render';
import { scaffoldCrew } from './scaffold';
import { nameProblem } from '../k8s/paths';

/** The families kmctl's scaffold has model sizes for. */
const MODEL_FAMILIES = ['qwen', 'gemma', 'llama', 'mistral'];

/** Asks for a name, a size, and a model family, then scaffolds the crew in the workspace. */
export async function createCrewCommand(exec: Exec, connection: Pick<Connection, 'source' | 'context'> | undefined, afterCreate: () => void): Promise<void> {
  const parent = await pickParent();
  if (!parent) return;
  const name = await vscode.window.showInputBox({ title: 'Create a crew', prompt: 'Crew name (lowercase letters, digits, hyphens)', validateInput: (value) => nameProblem('crew', value) });
  if (!name) return;
  const size = await vscode.window.showQuickPick(
    ['1', '2', '3', '4'].map((n) => ({ label: n, description: n === '1' ? 'specialist, beside the coordinator' : 'specialists, beside the coordinator' })),
    { placeHolder: 'How many specialists to start with?' },
  );
  if (!size) return;
  const family = await vscode.window.showQuickPick([...MODEL_FAMILIES.map((f) => ({ label: f })), { label: 'none', description: 'add Models yourself' }], {
    placeHolder: 'Which model family should its Models use?',
  });
  if (!family) return;
  const request = { name, parent, members: Number(size.label), modelFamily: family.label === 'none' ? undefined : family.label };
  const { root, warnings } = await scaffoldCrew(exec, request, connection);
  afterCreate();
  if (warnings) void vscode.window.showWarningMessage(warnings);
  await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, 'README.md')));
}

async function pickParent(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showInformationMessage('Open a folder first; the new crew is created inside it.');
    return undefined;
  }
  if (folders.length === 1) return folders[0].uri.fsPath;
  const choice = await vscode.window.showQuickPick(
    folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
    { placeHolder: 'Create the crew in which folder?' },
  );
  return choice?.folder.uri.fsPath;
}
