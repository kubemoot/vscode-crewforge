import * as vscode from 'vscode';

/** A modal warning; true only when the developer picks the action. */
export async function confirmModal(message: string, action: string): Promise<boolean> {
  return (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action;
}
