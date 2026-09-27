import * as vscode from 'vscode';
import type { ResourceDrift } from '../source/drift';
import { toYaml } from '../source/manifests';

export const MANIFEST_SCHEME = 'crewforge-manifest';

/** Read-only documents holding one object's YAML, live or rendered, for the diff editor. */
export class ManifestDocuments implements vscode.TextDocumentContentProvider {
  private readonly texts = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.texts.get(uri.toString()) ?? '';
  }

  /** Opens the diff editor: the live object on the left, the source's on the right. */
  async showDrift(namespace: string, drift: ResourceDrift): Promise<void> {
    const name = `${drift.kind}-${drift.name}.yaml`;
    const live = this.put(`/live/${namespace}/${name}`, drift.live ? toYaml(drift.live) : '# not deployed\n');
    const source = this.put(`/source/${namespace}/${name}`, drift.rendered ? toYaml(drift.rendered) : '# not in the source\n');
    await vscode.commands.executeCommand('vscode.diff', live, source, `${drift.kind}/${drift.name}: live in ${namespace} vs source`);
  }

  private put(path: string, text: string): vscode.Uri {
    const uri = vscode.Uri.parse(`${MANIFEST_SCHEME}:${path}`);
    this.texts.set(uri.toString(), text);
    this.changed.fire(uri);
    return uri;
  }
}
