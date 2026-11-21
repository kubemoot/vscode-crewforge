import * as vscode from 'vscode';

/** A modal warning, with `detail` under it when there is some; true only when the developer picks the action. */
export async function confirmModal(message: string, action: string, detail?: string): Promise<boolean> {
  return (await vscode.window.showWarningMessage(message, { modal: true, ...(detail ? { detail } : {}) }, action)) === action;
}
