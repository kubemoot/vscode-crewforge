import * as path from 'node:path';
import * as vscode from 'vscode';
import { IGNORED_PATH } from './ignored';

/**
 * True, after saying which, when an unsaved editor holds a file an action would rewrite:
 * one of `paths`, or a file inside one of them (dependencies left out).
 */
export function refuseIfDirty(paths: string[], what: string): boolean {
  const holds = (file: string) => paths.some((p) => file === p || file.startsWith(p + path.sep));
  const dirty = vscode.workspace.textDocuments.find((d) => d.isDirty && !IGNORED_PATH.test(d.uri.fsPath) && holds(d.uri.fsPath));
  if (dirty) void vscode.window.showErrorMessage(`CrewForge: save or close ${vscode.workspace.asRelativePath(dirty.uri)} before ${what}.`);
  return dirty !== undefined;
}

/** Moves a file or folder with a workspace edit, so editors open on it follow it. */
export async function renameWithEdit(from: string, to: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.renameFile(vscode.Uri.file(from), vscode.Uri.file(to));
  if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`could not move ${from} to ${to}`);
}
