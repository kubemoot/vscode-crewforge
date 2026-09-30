import * as vscode from 'vscode';
import { keyOf } from '../source/manifests';
import { kubemootObjects, type ObjectPosition } from '../source/positions';
import { sourceOf } from '../source/service';
import type { DeploymentNode, SourceTreeProvider } from './sourceTree';

/**
 * Lenses on a crew source's manifests: above the Crew, one Ask per live deployment;
 * above any other object, its state in each deployment, opening the live-versus-source
 * diff. They use what the Crew Sources view last loaded, so opening a file costs no
 * extra API calls.
 */
export class CrewCodeLens implements vscode.CodeLensProvider {
  readonly onDidChangeCodeLenses: vscode.Event<void>;

  constructor(private readonly sources: SourceTreeProvider) {
    this.onDidChangeCodeLenses = sources.onDidLoadDeployments;
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const entry = sourceOf(this.sources.known, document.uri.fsPath);
    if (!entry) return [];
    const deployments = this.sources.deploymentsOf(entry.source.root);
    return kubemootObjects(document.getText()).flatMap((object) => lensesFor(object, deployments));
  }
}

function lensesFor(object: ObjectPosition, deployments: DeploymentNode[]): vscode.CodeLens[] {
  const range = new vscode.Range(object.line, 0, object.line, 0);
  if (object.kind === 'Crew') {
    return deployments.map((d) => new vscode.CodeLens(range, { title: `Ask in ${d.deployment.namespace}`, command: 'crewforge.askCrew', arguments: [{ kind: 'crew', crew: d.deployment.crew }] }));
  }
  if (!object.name) return [];
  const key = keyOf(object.kind, object.name);
  return deployments.flatMap((d) => {
    const drift = d.drift?.find((r) => keyOf(r.kind, r.name) === key);
    if (!drift) return [];
    const node = { kind: 'resource', entry: d.entry, deployment: d.deployment, drift };
    return [new vscode.CodeLens(range, { title: `${d.deployment.namespace}: ${drift.state.replace('-', ' ')}`, command: 'crewforge.showDrift', arguments: [node] })];
  });
}
