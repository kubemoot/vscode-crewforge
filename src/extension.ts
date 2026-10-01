import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { connect, type Connection } from './connection';
import { loadKubeconfig } from './k8s/kubeconfig';
import type { CrewSummary } from './k8s/crews';
import { ChatPanel, type ChatLinks } from './panels/chatPanel';
import { selectionPrompt } from './panels/selectionPrompt';
import { createCrewCommand, showCreatedCrew } from './create/createCrew';
import { DeployCommands } from './deploy/commands';
import { FitnessCommands } from './fitness/commands';
import { followDeployment, followRolloutCommand } from './gitops/commands';
import { LiveCrewActions, sourceForCrew } from './deploy/liveCrew';
import { registerLoop } from './loop/register';
import { agentSourceMap } from './source/declared';
import { readAvailability } from './discussion/availability';
import { LIVE_SCHEME, LiveDocuments } from './views/liveDocuments';
import { execProgram, listScripts, readText, readYamlFiles } from './source/nodeDeps';
import { connectionLines } from './connectionInfo';
import { Dashboards } from './dashboard/register';
import { PagePanel, type PageState } from './dashboard/pagePanel';
import { FitnessActivity } from './fitness/controls';
import { registerScenarioCommands } from './fitness/scenarioCommands';
import { ScenarioFiles } from './fitness/scenarios';
import { LoopMemory } from './loop/state';
import { SourceService } from './source/service';
import { SourceWatcher } from './source/watcher';
import { IGNORED_GLOB } from './source/ignored';
import { SourceActions } from './source/sourceActions';
import { ConversationStore } from './store/conversations';
import { CrewTreeProvider, type CrewNode } from './views/crewTree';
import { ExplorerCrews } from './views/explorer';
import { MANIFEST_SCHEME, ManifestDocuments } from './views/manifestDocuments';
import { SchemaProvider } from './schema/schemaProvider';
import { CrewCodeLens } from './views/codeLens';
import { SourceTreeProvider, type SourceNode } from './views/sourceTree';
import { YamlCommands, type YamlTarget } from './views/yamlCommands';
import { showError } from './views/notify';

const REFRESH_MS = 30_000;

/**
 * What CrewForge hands other code once it is active: its views and what each open page
 * shows. The integration tests read it to check what a person would see.
 */
export interface CrewForgeApi {
  crews: CrewTreeProvider;
  sources: SourceTreeProvider;
  crewsView: vscode.TreeView<CrewNode>;
  sourcesView: vscode.TreeView<SourceNode>;
  pages: () => PageState[];
  /** Runs a button of an open page as if pressed on it. */
  press: (key: string, action: string, arg?: string) => Promise<boolean>;
  chats: () => ReturnType<typeof ChatPanel.states>;
}

export function activate(context: vscode.ExtensionContext): CrewForgeApi {
  const store = new ConversationStore(path.join(context.globalStorageUri.fsPath, 'conversations'));
  const tree = new CrewTreeProvider();
  const view = vscode.window.createTreeView('crewforge.crews', { treeDataProvider: tree, showCollapseAll: true });
  const service = new SourceService({ exec: execProgram, readText, readYamlFiles, listFiles: listWorkspaceFiles, listScripts });
  const sources = new SourceTreeProvider(service);
  const links: ChatLinks = {
    agentSources: async (crew) => {
      const entry = sourceForCrew(crew, await sources.entries());
      return entry ? agentSourceMap(await service.located(entry)) : new Map();
    },
    availability: async (crew) => {
      const { client } = tree.connection ?? connect();
      return readAvailability(client, await service.kinds(client), crew.namespace, crew.name);
    },
  };
  const commands = new Commands(context.extensionUri, tree, view, store, links);
  const activity = new FitnessActivity();
  const fitness = new FitnessCommands(service, () => sources.refresh(), undefined, activity);
  const busy = (namespace: string, crew: string) => activity.isBusy(namespace, crew);
  sources.fitnessBusy = busy;
  tree.fitnessBusy = busy;
  tree.sourceOpen = (crew) => (sources.hasLoaded ? sourceForCrew(crew, sources.known) !== undefined : undefined);
  sources.onRuns = (namespace, crew, runs) => activity.record(namespace, crew, runs);
  const sourcesView = vscode.window.createTreeView('crewforge.sources', { treeDataProvider: sources, showCollapseAll: true });
  tree.onMessage = (text) => (view.message = text);
  sources.onMessage = (text) => (sourcesView.message = text);
  const documents = new ManifestDocuments();
  const output = vscode.window.createOutputChannel('CrewForge');
  PagePanel.useHost({ log: (line) => output.appendLine(line), readingFrom: () => (tree.connection ?? connect()).context });
  const schemas = new SchemaProvider(() => currentConnection(tree)?.client);
  void schemas.register();
  const deploy = new DeployCommands(sources, { exec: execProgram, readYamlFiles }, output, () => {
    sources.refresh();
    tree.refresh();
  });
  const actions = new SourceActions({ sources, deploy });
  const liveDocuments = new LiveDocuments(() => tree.connection ?? connect());
  const yaml = new YamlCommands(documents, liveDocuments, service);
  const live = new LiveCrewActions({
    sources: async () => (sources.known.length ? sources.known : service.load()),
    deploy,
    fitness,
    details: (crew) => tree.detailsOf(crew),
    follow: (deployment) => followDeployment(deployment, () => tree.refresh()),
  });
  const loop = registerLoop(context, {
    sources,
    service,
    deploy,
    fitness,
    chat: { ask: (crew) => commands.askCrew({ kind: 'crew', crew }), reaskLast: (crew) => commands.reaskLast(crew) },
    revealLive: (crew) => commands.revealLive(crew),
    deps: { exec: execProgram, readText, readYamlFiles },
    schema: () => schemas.schemaText(),
    output,
    guard,
  });
  const dashboards = new Dashboards({
    extensionUri: context.extensionUri,
    crewforgeVersion: (context.extension?.packageJSON as { version?: string } | undefined)?.version ?? 'dev',
    connect: () => tree.connection ?? connect(),
    sources,
    service,
    details: (crew) => tree.detailsOf(crew),
    store,
    memory: new LoopMemory(context.workspaceState),
    exec: execProgram,
    activity,
  });
  tree.connectionItem = () => {
    const info = dashboards.status.latest;
    return info && { label: info.context ?? 'Not connected', tooltip: [...connectionLines(info), '', 'Click for the Crews Overview.'].join('\n') };
  };
  const updateStatus = () => void dashboards.status.update().then(() => tree.refresh());
  updateStatus();
  const explorer = new ExplorerCrews({
    sources,
    reveal: (node) => sourcesView.reveal(node, { select: true, focus: true, expand: node.kind === 'source' }),
    openDashboard: (node) => {
      dashboards.openCrew(node);
    },
  });
  const created = (root: string) =>
    showCreatedCrew(root, { reload: () => sources.reload(), reveal: (node) => sourcesView.reveal(node, { select: true, focus: true, expand: true }) });
  /** A lifecycle command from either view: a live crew goes through the adapter, a Crew Sources node straight on. */
  const either = (onCrew: (crew: CrewSummary) => Promise<void>, onSource: (node?: SourceNode) => Promise<void>) => (node?: SourceNode | CrewNode) =>
    guard(() => (node?.kind === 'crew' ? onCrew(node.crew) : onSource(node as SourceNode | undefined)));

  let timer: ReturnType<typeof setInterval> | undefined;
  const followVisibility = () => {
    if (timer) clearInterval(timer);
    timer = view.visible ? setInterval(() => tree.refresh(), REFRESH_MS) : undefined;
  };
  followVisibility();

  context.subscriptions.push(
    view,
    view.onDidChangeVisibility(followVisibility),
    { dispose: () => timer && clearInterval(timer) },
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('crewforge')) {
        tree.refresh();
        sources.refresh();
        updateStatus();
      }
    }),
    dashboards,
    activity.onDidChange(() => {
      sources.redraw();
      tree.refresh();
    }),
    sources.onDidLoadSources(() => {
      void explorer.update();
      tree.refresh();
    }),
    vscode.commands.registerCommand('crewforge.viewInCrewForge', (uri?: vscode.Uri) => guard(() => explorer.viewInCrewForge(uri))),
    vscode.commands.registerCommand('crewforge.openCrewDashboard', (node?: SourceNode | CrewNode) =>
      guard(async () => {
        dashboards.openCrew(node);
      }),
    ),
    vscode.commands.registerCommand('crewforge.openCrewsOverview', () =>
      guard(async () => {
        dashboards.openOverview();
      }),
    ),
    vscode.commands.registerCommand('crewforge.openFitnessDashboard', (node?: SourceNode | CrewNode) =>
      guard(async () => {
        dashboards.openFitness(node);
      }),
    ),
    vscode.commands.registerCommand('crewforge.showConnectionInfo', () => guard(() => dashboards.showConnection())),
    ...registerScenarioCommands({ files: new ScenarioFiles(), fitness, redeployTarget: (node) => loop.redeployTargetOf(node), readText, reload: () => sources.reload(), guard }),
    sourcesView,
    new SourceWatcher(() => sources.known.map((e) => e.source.root), () => sources.reload()),
    vscode.languages.registerCodeLensProvider({ language: 'yaml' }, new CrewCodeLens(sources)),
    vscode.workspace.registerTextDocumentContentProvider(MANIFEST_SCHEME, documents),
    vscode.commands.registerCommand('crewforge.refreshSources', () => sources.refresh()),
    vscode.commands.registerCommand('crewforge.showDrift', (target?: YamlTarget) => guard(() => yaml.compare(target))),
    vscode.commands.registerCommand('crewforge.showSourceYaml', (target?: YamlTarget) => guard(() => yaml.showSource(target))),
    vscode.commands.registerCommand('crewforge.showLiveYamlRaw', (target?: YamlTarget) => guard(() => yaml.showLive(target, true))),
    output,
    vscode.commands.registerCommand('crewforge.createCrew', () => guard(() => createCrewCommand(execProgram, currentConnection(tree), created))),
    vscode.commands.registerCommand('crewforge.newCrewHere', (folder?: vscode.Uri) => guard(() => createCrewCommand(execProgram, currentConnection(tree), created, folder?.fsPath))),
    vscode.commands.registerCommand('crewforge.deploySource', (node?: SourceNode) => guard(() => deploy.deploySource(node))),
    vscode.commands.registerCommand('crewforge.updateDeployment', either((crew) => live.update(crew), (node) => deploy.updateDeployment(node))),
    vscode.commands.registerCommand('crewforge.applyResource', (node?: SourceNode) => guard(() => deploy.applyResource(node))),
    vscode.commands.registerCommand('crewforge.deployRevision', either((crew) => live.deployRevision(crew), (node) => deploy.deployRevision(node))),
    vscode.commands.registerCommand(
      'crewforge.runFitness',
      either(
        (crew) => live.runFitness(crew),
        async (node) => {
          if (node?.kind === 'source') await loop.runFitness(node);
          else await fitness.runFitness(node);
        },
      ),
    ),
    vscode.commands.registerCommand('crewforge.showRun', (node?: SourceNode) => guard(() => fitness.showRun(node))),
    vscode.commands.registerCommand('crewforge.followRollout', either((crew) => live.followRollout(crew), (node) => followRolloutCommand(node, () => sources.refresh()))),
    vscode.commands.registerCommand('crewforge.removeDeployment', either((crew) => live.remove(crew), (node) => actions.undeploy(node))),
    vscode.commands.registerCommand('crewforge.deleteSource', (node?: SourceNode) => guard(() => actions.deleteSource(node))),
    vscode.commands.registerCommand('crewforge.renameCrew', (node?: SourceNode) => guard(() => actions.rename(node))),
    vscode.workspace.registerTextDocumentContentProvider(LIVE_SCHEME, liveDocuments),
    vscode.commands.registerCommand('crewforge.showLiveYaml', (target?: YamlTarget) => guard(() => yaml.showLive(target))),
    vscode.commands.registerCommand('crewforge.showCrewBundleYaml', (node?: CrewNode) => guard(() => showCrewBundleYaml(liveDocuments, node))),
    vscode.commands.registerCommand('crewforge.refreshCrews', () => tree.refresh()),
    vscode.commands.registerCommand('crewforge.askCrew', (node?: CrewNode) => commands.askCrew(node)),
    vscode.commands.registerCommand('crewforge.askAboutSelection', () => commands.askAboutSelection()),
    vscode.commands.registerCommand('crewforge.continueConversation', () => commands.continueConversation()),
    vscode.commands.registerCommand('crewforge.exportConversation', () => commands.exportConversation()),
    vscode.commands.registerCommand('crewforge.selectContext', () => commands.selectContext()),
    vscode.commands.registerCommand('crewforge.selectKubeconfig', () => commands.selectKubeconfig()),
    vscode.commands.registerCommand('crewforge.openConversationsFolder', () => commands.openConversationsFolder()),
  );
  return { crews: tree, sources, crewsView: view, sourcesView, pages: () => PagePanel.states(), press: (key, action, arg) => PagePanel.press(key, action, arg), chats: () => ChatPanel.states() };
}

export function deactivate(): void {
  // Panels dispose with the window; nothing else holds resources.
}

export class Commands {
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly tree: CrewTreeProvider,
    private readonly view: vscode.TreeView<CrewNode>,
    private readonly store: ConversationStore,
    private readonly links?: ChatLinks,
  ) {}

  async askCrew(node?: CrewNode): Promise<void> {
    await guard(async () => {
      await this.openChat(node);
    });
  }

  /** Opens a chat with a crew the person picks, with the editor's selection in the input, fenced, for their question. */
  async askAboutSelection(): Promise<void> {
    await guard(async () => {
      const editor = vscode.window.activeTextEditor;
      const text = editor?.document.getText(editor.selection);
      if (!editor || !text?.trim()) {
        void vscode.window.showInformationMessage('Select some text in an editor first.');
        return;
      }
      const panel = await this.openChat();
      panel?.prefill(selectionPrompt(vscode.workspace.asRelativePath(editor.document.uri), editor.document.languageId, text));
    });
  }

  /** Opens a chat with the crew clicked in the view, or with one the person picks. */
  private async openChat(node?: CrewNode): Promise<ChatPanel | undefined> {
    const crew = node?.kind === 'crew' ? node.crew : await this.pickCrew();
    if (!crew) return undefined;
    return ChatPanel.show(this.extensionUri, this.tree.connection ?? connect(), crew, this.store, undefined, this.links);
  }

  /**
   * Asks a crew its last question again, after a redeploy: from its open chat, else from
   * its newest saved conversation, which opens.
   */
  async reaskLast(crew: CrewSummary): Promise<void> {
    const connection = this.tree.connection ?? connect();
    let panel = ChatPanel.find(connection.context, crew);
    if (!panel) {
      const [latest] = await this.store.list(connection.context, crew.namespace, crew.name);
      const conversation = latest && (await this.store.load(latest));
      panel = ChatPanel.show(this.extensionUri, connection, crew, this.store, conversation, this.links);
    }
    if (!(await panel.reaskLast())) void vscode.window.showInformationMessage(`There is no earlier question for ${crew.name} to ask again. Ask it one in the chat.`);
  }

  /** Selects a live crew in the Deployed Crews view, reading the crews again first. */
  async revealLive(crew: CrewSummary): Promise<void> {
    this.tree.refresh();
    const node = await this.tree.nodeFor(crew.namespace, crew.name);
    if (node) await this.view.reveal(node, { select: true, focus: false, expand: true });
    else void vscode.window.showInformationMessage(`The Deployed Crews view does not list ${crew.namespace}; add it to the crewforge.namespaces setting to see ${crew.name} there.`);
  }

  async continueConversation(): Promise<void> {
    await guard(async () => {
      const saved = await this.store.listAll();
      if (saved.length === 0) {
        void vscode.window.showInformationMessage('No saved conversations yet. Ask a crew first.');
        return;
      }
      const choice = await vscode.window.showQuickPick(
        saved.map((m) => ({ label: m.title, description: `${m.namespace}/${m.crewName}`, detail: `${m.context} · ${m.startedAt}`, meta: m })),
        { placeHolder: 'Continue which conversation?', matchOnDescription: true, matchOnDetail: true },
      );
      if (!choice) return;
      const conversation = await this.store.load(choice.meta);
      const connection = connect(choice.meta.context);
      const crew = this.tree.known.find((c) => c.name === conversation.crewName && c.namespace === conversation.namespace) ?? placeholderCrew(conversation.crewName, conversation.namespace);
      ChatPanel.show(this.extensionUri, connection, crew, this.store, conversation);
    });
  }

  async exportConversation(): Promise<void> {
    const panel = ChatPanel.active;
    if (!panel) {
      void vscode.window.showInformationMessage('Open a crew chat first.');
      return;
    }
    await guard(() => panel.export());
  }

  async selectContext(): Promise<void> {
    await guard(async () => {
      const settings = vscode.workspace.getConfiguration('crewforge');
      const { config, source } = loadKubeconfig(settings.get<string>('kubeconfig', ''), '');
      const current = this.tree.connection?.context ?? config.getCurrentContext();
      const choice = await vscode.window.showQuickPick(
        config.getContexts().map((c) => ({ label: c.name, description: c.name === current ? 'current' : c.cluster })),
        { placeHolder: `Context from ${source}` },
      );
      if (!choice) return;
      await settings.update('context', choice.label, vscode.ConfigurationTarget.Global);
      this.view.description = choice.label;
    });
  }

  async selectKubeconfig(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Use this kubeconfig', title: 'Select a kubeconfig file' });
    if (!picked?.[0]) return;
    const settings = vscode.workspace.getConfiguration('crewforge');
    await settings.update('kubeconfig', picked[0].fsPath, vscode.ConfigurationTarget.Global);
    await settings.update('context', '', vscode.ConfigurationTarget.Global);
  }

  async openConversationsFolder(): Promise<void> {
    await fs.mkdir(this.store.root, { recursive: true });
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(this.store.root));
  }

  private async pickCrew(): Promise<CrewSummary | undefined> {
    const choice = await vscode.window.showQuickPick(
      this.tree.known.map((crew) => ({ label: crew.name, description: `${crew.namespace} · ${crew.phase}`, crew })),
      { placeHolder: this.tree.known.length ? 'Ask which crew?' : 'No crews loaded; refresh the Deployed Crews view first' },
    );
    return choice?.crew;
  }
}

/** The connection the Deployed Crews view uses, or one from the settings; undefined when there is no usable kubeconfig. */
function currentConnection(tree: CrewTreeProvider): Connection | undefined {
  try {
    return tree.connection ?? connect();
  } catch {
    return undefined;
  }
}

/** Chart.yaml files and every other YAML file in the workspace, as paths. */
async function listWorkspaceFiles(): Promise<{ charts: string[]; yamls: string[] }> {
  const [charts, yamls] = await Promise.all([
    vscode.workspace.findFiles('**/Chart.yaml', IGNORED_GLOB),
    vscode.workspace.findFiles('**/*.{yaml,yml}', IGNORED_GLOB),
  ]);
  return { charts: charts.map((u) => u.fsPath), yamls: yamls.map((u) => u.fsPath).filter((p) => !p.endsWith('Chart.yaml')) };
}

async function showCrewBundleYaml(documents: LiveDocuments, node?: CrewNode): Promise<void> {
  if (node?.kind === 'crew') return documents.show({ kind: 'bundle', namespace: node.crew.namespace, crew: node.crew.name });
}

/** A crew known only from a saved conversation, before the Deployed Crews view has loaded it. */
function placeholderCrew(name: string, namespace: string): CrewSummary {
  return { name, namespace, ready: true, phase: 'Unknown' };
}

async function guard(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (err) {
    void showError(err);
  }
}

