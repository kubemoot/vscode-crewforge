import * as vscode from 'vscode';

/** The Kubemoot logo as a webview tab's icon, in a light and a dark theme variant. */
export function tabIcon(extensionUri: vscode.Uri): { light: vscode.Uri; dark: vscode.Uri } {
  return { light: vscode.Uri.joinPath(extensionUri, 'media', 'logo-light.svg'), dark: vscode.Uri.joinPath(extensionUri, 'media', 'logo-dark.svg') };
}
