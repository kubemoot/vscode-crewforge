import * as vscode from 'vscode';

/**
 * The Kubemoot mark as a webview tab's icon: the brand's small form (the table as a solid
 * disc, for sizes below 24 px), whose keyline lets one file serve light and dark themes.
 */
export function tabIcon(extensionUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, 'media', 'kubemoot-favicon-small.svg');
}
