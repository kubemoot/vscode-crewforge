import * as vscode from 'vscode';
import type { DeployCommands } from '../deploy/commands';
import type { FitnessCommands } from '../fitness/commands';
import type { CrewSummary } from '../k8s/crews';
import { CrewLinter } from '../lint/linter';
import type { Exec, RenderDeps } from '../source/render';
import type { SourceService } from '../source/service';
import type { SourceTreeProvider } from '../views/sourceTree';
import { DevLoop, type ChatActions, type LoopTarget } from './devLoop';
import { stateText, LoopMemory, LoopStates } from './state';
import { CrewStatusBar } from './statusBar';

export interface LoopParts {
  sources: SourceTreeProvider;
  service: SourceService;
  deploy: DeployCommands;
  fitness: FitnessCommands;
  chat: ChatActions;
  revealLive: (crew: CrewSummary) => Promise<void>;
  deps: RenderDeps & { exec: Exec; readText: (file: string) => Promise<string> };
  /** The Kubemoot JSON Schema as text, from the cluster. */
  schema: () => Promise<string>;
  output: vscode.OutputChannel;
  /** Runs a command body, turning a failure into an error message. */
  guard: (action: () => Promise<void>) => Promise<void>;
}

/**
 * Wires the inner loop into VS Code: Lint Crew with its diagnostics, Deploy (dev) and
 * Redeploy, Ask and Run Fitness from a source, the status bar item, and the on-save lint.
 */
export function registerLoop(context: vscode.ExtensionContext, parts: LoopParts): DevLoop {
  const { sources, guard } = parts;
  const diagnostics = vscode.languages.createDiagnosticCollection('crewforge');
  const linter = new CrewLinter(diagnostics, { ...parts.deps, schema: parts.schema }, parts.output);
  const states = new LoopStates();
  const loop = new DevLoop({
    sources,
    service: parts.service,
    deploy: parts.deploy,
    fitness: parts.fitness,
    linter,
    memory: new LoopMemory(context.workspaceState),
    states,
    chat: parts.chat,
    revealLive: parts.revealLive,
    exec: parts.deps.exec,
  });
  const statusBar = new CrewStatusBar(() => sources.known, states, (entry) => loop.refreshState(entry));
  const activeFile = () => vscode.window.activeTextEditor?.document.uri.fsPath;
  sources.stateOf = (root) => {
    const state = states.get(root);
    return state && { text: stateText(state), changed: state.kind === 'changed' };
  };
  const command = (id: string, run: (target?: LoopTarget) => Promise<unknown>) => vscode.commands.registerCommand(id, (target?: LoopTarget) => guard(async () => void (await run(target))));
  context.subscriptions.push(
    diagnostics,
    linter,
    statusBar,
    states.onDidChange((root) => {
      sources.refreshSource(root);
      statusBar.stateChanged(root);
    }),
    sources.onDidLoadSources(() => statusBar.update(activeFile())),
    vscode.window.onDidChangeActiveTextEditor((editor) => statusBar.update(editor?.document.uri.fsPath)),
    vscode.workspace.onDidSaveTextDocument((document) => loop.onSaved(document.uri.fsPath)),
    command('crewforge.lintCrew', (target) => loop.lint(target)),
    command('crewforge.deployDev', (target) => loop.deployDev(target)),
    command('crewforge.redeployDev', (target) => loop.deployDev(target)),
    command('crewforge.askSource', (target) => loop.ask(target)),
    command('crewforge.crewActions', (target) => loop.actions(target)),
  );
  void guard(async () => void (await sources.entries()));
  return loop;
}

