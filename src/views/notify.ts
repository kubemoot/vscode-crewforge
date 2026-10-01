import * as vscode from 'vscode';
import { isConnectionProblem } from '../k8s/request';
import { errorText, SELECT_CONTEXT } from './errors';

/** Shows an error as a notification; one that means the cluster could not be reached offers Select Kubernetes Context. */
export async function showError(err: unknown): Promise<void> {
  const message = `CrewForge: ${errorText(err)}`;
  if (!isConnectionProblem(err)) return void vscode.window.showErrorMessage(message);
  const choice = await vscode.window.showErrorMessage(message, SELECT_CONTEXT.title);
  if (choice === SELECT_CONTEXT.title) await vscode.commands.executeCommand(SELECT_CONTEXT.command);
}
