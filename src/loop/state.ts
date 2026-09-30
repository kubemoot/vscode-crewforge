import * as vscode from 'vscode';
import { summarize } from '../source/drift';
import type { DeploymentNode, SourceNode } from '../views/sourceTree';

/** Where a crew source stands against its dev deployment. */
export type CrewState =
  | { kind: 'not-deployed' }
  | { kind: 'in-sync'; deployment: DeploymentNode }
  | { kind: 'changed'; deployment: DeploymentNode }
  | { kind: 'unknown'; reason: string };

const TEXT: Record<CrewState['kind'], string> = {
  'not-deployed': 'not deployed',
  'in-sync': 'deployed, in sync',
  changed: 'changed since deploy',
  unknown: 'state unknown',
};

/** The state in a few words, with the namespace when deployed: "changed since deploy (crew-demo)". */
export function stateText(state: CrewState): string {
  return 'deployment' in state ? `${TEXT[state.kind]} (${state.deployment.deployment.namespace})` : TEXT[state.kind];
}

/**
 * The deployment the inner loop works on: the one in the source's dev namespace, else
 * one that names this source, else the first.
 */
export function devDeployment(deployments: DeploymentNode[], devNamespace?: string): DeploymentNode | undefined {
  return deployments.find((d) => d.deployment.namespace === devNamespace) ?? deployments.find((d) => d.deployment.linked) ?? deployments[0];
}

/** The state of a source from its loaded deployments and their drift, or from why none loaded. */
export function stateFrom(nodes: SourceNode[], devNamespace?: string): CrewState {
  const deployment = devDeployment(nodes.filter((n): n is DeploymentNode => n.kind === 'deployment'), devNamespace);
  if (!deployment) {
    const problem = nodes.find((n) => n.kind === 'message' && n.icon !== 'circle-slash');
    return problem?.kind === 'message' ? { kind: 'unknown', reason: problem.detail ?? problem.text } : { kind: 'not-deployed' };
  }
  if (deployment.error) return { kind: 'unknown', reason: deployment.error };
  return summarize(deployment.drift ?? []) === 'in sync' ? { kind: 'in-sync', deployment } : { kind: 'changed', deployment };
}

/** What the loop remembers for each source in the workspace: its dev namespace and its last fitness run. */
export class LoopMemory {
  constructor(private readonly memento: vscode.Memento) {}

  devNamespace(root: string): string | undefined {
    return this.memento.get<string>(`crewforge.devNamespace:${root}`);
  }

  setDevNamespace(root: string, namespace: string): Thenable<void> {
    return this.memento.update(`crewforge.devNamespace:${root}`, namespace);
  }

  lastFitness(root: string): string | undefined {
    return this.memento.get<string>(`crewforge.lastFitness:${root}`);
  }

  setLastFitness(root: string, definition: string): Thenable<void> {
    return this.memento.update(`crewforge.lastFitness:${root}`, definition);
  }
}

/** The state of each crew source, by folder, for the status bar and the Crew Sources view. */
export class LoopStates {
  private readonly states = new Map<string, CrewState>();
  private readonly changed = new vscode.EventEmitter<string>();
  /** Fires with a source folder whose state changed. */
  readonly onDidChange = this.changed.event;

  get(root: string): CrewState | undefined {
    return this.states.get(root);
  }

  set(root: string, state: CrewState): void {
    const before = this.states.get(root);
    this.states.set(root, state);
    if (!before || stateText(before) !== stateText(state)) this.changed.fire(root);
  }

  /** Marks a deployed source changed at once, when one of its files is saved; the drift check that follows has the last word. */
  markChanged(root: string): void {
    const state = this.states.get(root);
    if (state?.kind === 'in-sync') this.set(root, { kind: 'changed', deployment: state.deployment });
  }
}
