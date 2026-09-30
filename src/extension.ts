import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { connect, type Connection } from './connection';
import { loadKubeconfig } from './k8s/kubeconfig';
import type { CrewSummary } from './k8s/crews';
import { ChatPanel } from './panels/chatPanel';
import { selectionPrompt } from './panels/selectionPrompt';
import { createCrewCommand } from './create/createCrew';
import { DeployCommands } from './deploy/commands';
import { FitnessCommands } from './fitness/commands';
import { followDeployment, followRolloutCommand } from './gitops/commands';
import { LiveCrewActions } from './deploy/liveCrew';
import { LIVE_SCHEME, LiveDocuments } from './views/liveDocuments';
import { execProgram, readText, readYamlFiles } from './source/nodeDeps';
import { SourceService } from './source/service';
import { ConversationStore } from './store/conversations';
import { CrewTreeProvider, type CrewNode } from './views/crewTree';
import { MANIFEST_SCHEME, ManifestDocuments } from './views/manifestDocuments';
import { SchemaProvider } from './schema/schemaProvider';
import { CrewCodeLens } from './views/codeLens';
import { SourceTreeProvider, type SourceNode } from './views/sourceTree';

const REFRESH_MS = 30_000;

export function activate(context: vscode.ExtensionContext): void {
  const store = new ConversationStore(path.join(context.globalStorageUri.fsPath, 'conversations'));
  const tree = new CrewTreeProvider();
  const view = vscode.window.createTreeView('crewforge.crews', { treeDataProvider: tree, showCollapseAll: true });
  const commands = new Commands(context.extensionUri, tree, view, store);
  const service = new SourceService({ exec: execProgram, readText, readYamlFiles, listFiles: listWorkspaceFiles });
  const sources = new SourceTreeProvider(service);
  const fitness = new FitnessCommands(service, () => sources.refresh());
  const sourcesView = vscode.window.createTreeView('crewforge.sources', { treeDataProvider: sources, showCollapseAll: true });
  const documents = new ManifestDocuments();
  const output = vscode.window.createOutputChannel('CrewForge');
  void new SchemaProvider(() => currentConnection(tree)?.client).register();
  const deploy = new DeployCommands(sources, { exec: execProgram, readYamlFiles }, output, () => {
    sources.refresh();
    tree.refresh();
  });
  const liveDocuments = new LiveDocuments(() => tree.connection ?? connect());
  const live = new LiveCrewActions({
    sources: async () => (sources.known.length ? sources.known : service.load()),
    deploy,
    fitness,
    details: (crew) => tree.detailsOf(crew),
    follow: (deployment) => followDeployment(deployment, () => tree.refresh()),
  });
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
      }
    }),
    sourcesView,
    vscode.languages.registerCodeLensProvider({ language: 'yaml' }, new CrewCodeLens(sources)),
    vscode.workspace.registerTextDocumentContentProvider(MANIFEST_SCHEME, documents),
    vscode.commands.registerCommand('crewforge.refreshSources', () => sources.refresh()),
    vscode.commands.registerCommand('crewforge.showDrift', (node?: SourceNode) => showDrift(documents, node)),
    output,
    vscode.commands.registerCommand('crewforge.createCrew', () => guard(() => createCrewCommand(execProgram, currentConnection(tree), () => sources.refresh()))),
    vscode.commands.registerCommand('crewforge.deploySource', (node?: SourceNode) => guard(() => deploy.deploySource(node))),
    vscode.commands.registerCommand('crewforge.updateDeployment', either((crew) => live.update(crew), (node) => deploy.updateDeployment(node))),
    vscode.commands.registerCommand('crewforge.applyResource', (node?: SourceNode) => guard(() => deploy.applyResource(node))),
    vscode.commands.registerCommand('crewforge.deployRevision', either((crew) => live.deployRevision(crew), (node) => deploy.deployRevision(node))),
    vscode.commands.registerCommand('crewforge.runFitness', either((crew) => live.runFitness(crew), (node) => fitness.runFitness(node))),
    vscode.commands.registerCommand('crewforge.showRun', (node?: SourceNode) => guard(() => fitness.showRun(node))),
    vscode.commands.registerCommand('crewforge.followRollout', either((crew) => live.followRollout(crew), (node) => followRolloutCommand(node, () => sources.refresh()))),
    vscode.commands.registerCommand('crewforge.removeDeployment', either((crew) => live.remove(crew), (node) => deploy.removeDeployment(node))),
    vscode.workspace.registerTextDocumentContentProvider(LIVE_SCHEME, liveDocuments),
    vscode.commands.registerCommand('crewforge.showLiveYaml', (node?: CrewNode) => guard(() => showLiveYaml(liveDocuments, node))),
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
}

export function deactivate(): void {
  // Panels dispose with the window; nothing else holds resources.
}

class Commands {
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly tree: CrewTreeProvider,
    private readonly view: vscode.TreeView<CrewNode>,
    private readonly store: ConversationStore,
  ) {}

  async askCrew(node?: CrewNode): Promise<void> {
    await guard(async () => void (await this.openChat(node)));
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
    return ChatPanel.show(this.extensionUri, this.tree.connection ?? connect(), crew, this.store);
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
      { placeHolder: this.tree.known.length ? 'Ask which crew?' : 'No crews loaded; refresh the Crews view first' },
    );
    return choice?.crew;
  }
}

/** The connection the Crews view uses, or one from the settings; undefined when there is no usable kubeconfig. */
function currentConnection(tree: CrewTreeProvider): Connection | undefined {
  try {
    return tree.connection ?? connect();
  } catch {
    return undefined;
  }
}

const IGNORED_FOLDERS = '{**/node_modules/**,**/.git/**,**/dist/**}';

/** Chart.yaml files and every other YAML file in the workspace, as paths. */
async function listWorkspaceFiles(): Promise<{ charts: string[]; yamls: string[] }> {
  const [charts, yamls] = await Promise.all([
    vscode.workspace.findFiles('**/Chart.yaml', IGNORED_FOLDERS),
    vscode.workspace.findFiles('**/*.{yaml,yml}', IGNORED_FOLDERS),
  ]);
  return { charts: charts.map((u) => u.fsPath), yamls: yamls.map((u) => u.fsPath).filter((p) => !p.endsWith('Chart.yaml')) };
}

/** The live YAML of a crew, or of the object behind one of its leaves. */
async function showLiveYaml(documents: LiveDocuments, node?: CrewNode): Promise<void> {
  if (node?.kind === 'crew') return documents.show({ kind: 'object', ref: { kind: 'Crew', name: node.crew.name, namespace: node.crew.namespace } });
  if (node?.kind === 'member' && node.view.ref) return documents.show({ kind: 'object', ref: node.view.ref });
}

async function showCrewBundleYaml(documents: LiveDocuments, node?: CrewNode): Promise<void> {
  if (node?.kind === 'crew') return documents.show({ kind: 'bundle', namespace: node.crew.namespace, crew: node.crew.name });
}

async function showDrift(documents: ManifestDocuments, node?: SourceNode): Promise<void> {
  if (node?.kind !== 'resource') return;
  await guard(() => documents.showDrift(node.deployment.namespace, node.drift));
}

/** A crew known only from a saved conversation, before the Crews view has loaded it. */
function placeholderCrew(name: string, namespace: string): CrewSummary {
  return { name, namespace, ready: true, phase: 'Unknown' };
}

async function guard(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (err) {
    void vscode.window.showErrorMessage(`CrewForge: ${err instanceof Error ? err.message : String(err)}`);
  }
}
