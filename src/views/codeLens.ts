import * as path from 'node:path';
import * as vscode from 'vscode';
import { keyOf } from '../source/manifests';
import type { DeploymentNode, SourceTreeProvider } from './sourceTree';

/** Where a Kubemoot object starts in a YAML file, and its kind and name when they are literal. */
export interface ObjectPosition {
  line: number;
  kind: string;
  name?: string;
}

/**
 * Finds the Kubemoot objects in a multi-document YAML text by their apiVersion lines.
 * A name that is a Helm template expression is left out, since only the render knows it.
 */
export function kubemootObjects(text: string): ObjectPosition[] {
  const found: ObjectPosition[] = [];
  const documents = text.split(/^---.*$/m);
  let offset = 0;
  for (const doc of documents) {
    const lines = doc.split('\n');
    const start = lines.findIndex((l) => /^apiVersion:\s*kubemoot\.ai\//.test(l));
    const kind = lines.map((l) => /^kind:\s*(\w+)/.exec(l)?.[1]).find(Boolean);
    if (start >= 0 && kind) found.push({ line: offset + start, kind, name: literalName(lines) });
    offset += lines.length - 1;
  }
  return found;
}

function literalName(lines: string[]): string | undefined {
  const at = lines.findIndex((l) => /^metadata:\s*$/.test(l));
  if (at < 0) return undefined;
  const name = lines.slice(at + 1).map((l) => /^\s+name:\s*["']?([^"'\s]+)["']?\s*$/.exec(l)?.[1]).find(Boolean);
  return name && !name.includes('{{') ? name : undefined;
}

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
    const entry = this.sources.known.find((e) => document.uri.fsPath.startsWith(e.source.root + path.sep));
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
