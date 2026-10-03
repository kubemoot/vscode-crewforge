import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { activate, Commands, deactivate, type CrewForgeApi } from '../src/extension';
import { PagePanel } from '../src/dashboard/pagePanel';
import { newConversation } from '../src/store/conversation';
import { ConversationStore } from '../src/store/conversations';
import { startFakeApi, type FakeApi } from './fakeApiServer';
import { CrewTreeProvider } from '../src/views/crewTree';
import { FakeCluster, seedCrew, seedInfrastructure } from './fakeCluster';
import { recorded, resetFake, Uri, workspaceState, type FakeTreeView } from './vscodeFake';

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
  contributes: { commands: { command: string }[] };
};

let api: FakeApi;
let storage: string;
let subscriptions: { dispose(): unknown }[];
let exported: CrewForgeApi;

beforeAll(async () => (api = await startFakeApi()));
afterAll(() => api.close());

beforeEach(() => {
  resetFake();
  recorded.settings.set('crewforge.kubeconfig', api.kubeconfig);
  storage = fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-ext-'));
  subscriptions = [];
  exported = activate({ globalStorageUri: Uri.file(storage), extensionUri: Uri.file('/ext'), subscriptions, workspaceState } as never);
});

afterEach(() => {
  for (const p of recorded.panels) p.dispose();
  for (const s of subscriptions) s.dispose();
  deactivate();
});

const run = (id: string, ...args: unknown[]) => recorded.commands.get(id)!(...args);

describe('activate', () => {
  it('registers every command the manifest contributes, and the Deployed Crews view', () => {
    const declared = manifest.contributes.commands.map((c) => c.command).sort();
    expect([...recorded.commands.keys()].sort()).toEqual(declared);
    expect(recorded.treeViews.map((v) => v.id)).toEqual(['crewforge.crews', 'crewforge.sources']);
  });

  it('lists Deployed Crews flat until Group by Namespace, remembers the choice, and switches the title bar toggle', async () => {
    expect(exported.crews.grouped).toBe(false);
    expect(recorded.contexts.get('crewforge.groupByNamespace')).toBe(false);
    await run('crewforge.groupByNamespace');
    expect(exported.crews.grouped).toBe(true);
    expect(recorded.contexts.get('crewforge.groupByNamespace')).toBe(true);
    expect(workspaceState.get('crewforge.groupByNamespace')).toBe(true);
    for (const s of subscriptions) s.dispose();
    deactivate();
    const again = activate({ globalStorageUri: Uri.file(storage), extensionUri: Uri.file('/ext'), subscriptions: [], workspaceState } as never);
    expect(again.crews.grouped).toBe(true);
    await run('crewforge.listFlat');
    expect(again.crews.grouped).toBe(false);
    expect(workspaceState.get('crewforge.groupByNamespace')).toBe(false);
  });

  it('refreshes the Deployed Crews view on the command and on a CrewForge setting change', () => {
    const view = recorded.treeViews[0];
    const provider = view.options.treeDataProvider as { onDidChangeTreeData: (l: () => void) => void };
    let refreshed = 0;
    provider.onDidChangeTreeData(() => refreshed++);
    run('crewforge.refreshCrews');
    recorded.configListeners.forEach((l) => l({ affectsConfiguration: (s) => s === 'crewforge' }));
    recorded.configListeners.forEach((l) => l({ affectsConfiguration: () => false }));
    expect(refreshed).toBe(2);
  });
});

describe('what CrewForge hands other code', () => {
  it('is its views and what each open page and chat shows', async () => {
    expect(exported.crewsView).toBe(recorded.treeViews[0]);
    expect(exported.sourcesView).toBe(recorded.treeViews[1]);
    expect(exported.crews).toBe(recorded.treeViews[0].options.treeDataProvider);
    expect(exported.sources).toBe(recorded.treeViews[1].options.treeDataProvider);
    expect(exported.pages()).toEqual([]);
    expect(exported.chats()).toEqual([]);
    await run('crewforge.openCrewsOverview');
    expect(exported.pages().map((p) => p.key)).toEqual(['overview']);
    expect(PagePanel.host.readingFrom()).toBe('fake');
    PagePanel.host.log('a page problem');
    expect(recorded.output).toContain('a page problem');
  });
});

describe('commands', () => {
  it('askCrew opens a chat for the crew clicked in the view', async () => {
    await run('crewforge.askCrew', { kind: 'crew', crew: { name: 'lab-ops', namespace: 'team-a', ready: true, phase: 'Ready' } });
    expect(recorded.panels.map((p) => p.title)).toEqual(['Ask lab-ops']);
  });

  it('askCrew without a crew offers the loaded crews, and does nothing when none is picked', async () => {
    const provider = recorded.treeViews[0].options.treeDataProvider as { getChildren: () => Promise<unknown> };
    await provider.getChildren();
    recorded.quickPicks.push((items: { crew: unknown }[]) => items[0]);
    await run('crewforge.askCrew');
    expect(recorded.panels).toHaveLength(1);
    recorded.quickPicks.push(undefined);
    await run('crewforge.askCrew');
    expect(recorded.panels).toHaveLength(1);
  });

  it('askAboutSelection opens the picked crew with the selection fenced in the input', async () => {
    const provider = recorded.treeViews[0].options.treeDataProvider as { getChildren: () => Promise<unknown> };
    await provider.getChildren();
    recorded.workspaceFolders = [{ name: 'w', uri: Uri.file('/w') }];
    recorded.activeEditor = {
      document: { uri: Uri.file('/w/src/app.ts'), languageId: 'typescript', getText: (range) => (range === 'sel' ? 'const a = 1;' : 'everything') },
      selection: 'sel',
    };
    recorded.quickPicks.push((items: { crew: unknown }[]) => items[0]);
    await run('crewforge.askAboutSelection');
    const panel = recorded.panels[0];
    expect(panel.title).toMatch(/^Ask /);
    await panel.webview.receive({ type: 'ready' });
    await vi.waitFor(() =>
      expect(panel.webview.posted.find((m) => (m as { type: string }).type === 'prefill')).toEqual({ type: 'prefill', text: 'From src/app.ts:\n\n```typescript\nconst a = 1;\n```\n\n' }),
    );
  });

  it('askAboutSelection needs a selection, and does nothing when no crew is picked', async () => {
    await run('crewforge.askAboutSelection');
    recorded.activeEditor = { document: { uri: Uri.file('/x.go'), languageId: 'go', getText: () => '' }, selection: 'sel' };
    await run('crewforge.askAboutSelection');
    recorded.activeEditor = { document: { uri: Uri.file('/x.go'), languageId: 'go', getText: () => '  \n ' }, selection: 'sel' };
    await run('crewforge.askAboutSelection');
    expect(recorded.info).toEqual(Array(3).fill('Select some text in an editor first.'));
    recorded.activeEditor = { document: { uri: Uri.file('/x.go'), languageId: 'go', getText: () => 'x' }, selection: 'sel' };
    recorded.quickPicks.push(undefined);
    await run('crewforge.askAboutSelection');
    expect(recorded.panels).toHaveLength(0);
  });

  it('continueConversation says when there is nothing saved, and reopens a saved one', async () => {
    await run('crewforge.continueConversation');
    expect(recorded.info[0]).toMatch(/No saved conversations/);

    const store = new ConversationStore(path.join(storage, 'conversations'));
    const saved = newConversation('fake', 'team-a', 'lab-ops');
    saved.title = 'Earlier';
    await store.save(saved);
    recorded.quickPicks.push((items: unknown[]) => items[0]);
    await run('crewforge.continueConversation');
    expect(recorded.panels.map((p) => p.title)).toEqual(['Ask lab-ops']);
  });

  it('exportConversation needs an open chat', async () => {
    await run('crewforge.exportConversation');
    expect(recorded.info[0]).toMatch(/Open a crew chat first/);
  });

  it('selectContext stores the chosen context', async () => {
    recorded.quickPicks.push((items: { label: string }[]) => items[0]);
    await run('crewforge.selectContext');
    expect(recorded.settings.get('crewforge.context')).toBe('fake');
    expect(recorded.treeViews[0].description).toBe('fake');
  });

  it('selectKubeconfig stores the file and clears the context', async () => {
    recorded.settings.set('crewforge.context', 'old');
    recorded.openDialog = [Uri.file('/home/me/dev2next.yaml')];
    await run('crewforge.selectKubeconfig');
    expect(recorded.settings.get('crewforge.kubeconfig')).toBe('/home/me/dev2next.yaml');
    expect(recorded.settings.get('crewforge.context')).toBe('');
    recorded.openDialog = undefined;
    await run('crewforge.selectKubeconfig');
    expect(recorded.settings.get('crewforge.kubeconfig')).toBe('/home/me/dev2next.yaml');
  });

  it('openConversationsFolder creates the folder and reveals it', async () => {
    await run('crewforge.openConversationsFolder');
    const folder = path.join(storage, 'conversations');
    expect(fs.existsSync(folder)).toBe(true);
    expect(recorded.executed[0].id).toBe('revealFileInOS');
  });

  it('reports a failure as an error message', async () => {
    recorded.settings.set('crewforge.kubeconfig', '/no/such/kubeconfig');
    await run('crewforge.selectContext');
    expect(recorded.errors[0]).toMatch(/^CrewForge: /);
  });

  it('showDrift opens the diff for a resource and ignores anything else', async () => {
    const drift = { kind: 'Crew', name: 'demo', state: 'missing', paths: [] };
    const entry = { source: { kind: 'bundle', root: '/w/demo', label: 'demo' }, identity: { id: 'local:demo' } };
    await run('crewforge.showDrift', { kind: 'resource', entry, deployment: { namespace: 'ns', crew: { name: 'demo', namespace: 'ns' } }, drift });
    await run('crewforge.showDrift', { kind: 'message', text: 'x' });
    await run('crewforge.showDrift');
    expect(recorded.executed.map((e) => e.id)).toEqual(['vscode.diff']);
    expect(recorded.documentProviders.has('crewforge-manifest')).toBe(true);
    await run('crewforge.showSourceYaml', { kind: 'resource', entry, deployment: { namespace: 'ns', crew: { name: 'demo', namespace: 'ns' } }, drift });
    await run('crewforge.showSourceYaml', { kind: 'message', text: 'x' });
    await run('crewforge.showSourceYaml');
    expect(recorded.shownDocuments).toEqual(['crewforge-manifest:/rendered/ns/Crew-demo.yaml (yaml)']);
  });

  it('routes Undeploy, Delete Crew Source, and Rename Crew on a source, and says why when there is nothing to act on', async () => {
    const entry = { source: { kind: 'helm', root: '/w/none', label: 'none' }, identity: { id: 'local:none' } };
    await run('crewforge.removeDeployment', { kind: 'source', entry });
    await run('crewforge.deleteSource', { kind: 'message', text: 'x' });
    await run('crewforge.renameCrew', { kind: 'source', entry });
    await run('crewforge.deleteSource');
    expect(recorded.info).toEqual([
      'none is not deployed in this context.',
      'There is no crew source in this workspace to delete.',
      'none declares no Crew to rename.',
      'There is no crew source in this workspace to delete.',
    ]);
    expect(recorded.warnings).toEqual([]);
  });

  it('opens the dashboards and the connection info, and routes the scenario commands', async () => {
    const crew = { name: 'lab-ops', namespace: 'team-a', ready: true, phase: 'Ready' };
    await run('crewforge.openCrewsOverview');
    await run('crewforge.openCrewDashboard', { kind: 'crew', crew });
    await run('crewforge.openFitnessDashboard', { kind: 'crew', crew });
    await run('crewforge.openCrewDashboard');
    await run('crewforge.openFitnessDashboard', { kind: 'message', text: 'x' });
    expect(recorded.panels.map((p) => p.title)).toEqual(['Crews Overview', 'lab-ops', 'lab-ops fitness']);
    recorded.quickPicks.push(undefined);
    await run('crewforge.showConnectionInfo');
    for (const id of ['crewforge.addScenario', 'crewforge.renameScenario', 'crewforge.deleteScenario', 'crewforge.runScenario']) await run(id, { kind: 'message', text: 'x' });
    expect(recorded.errors).toEqual([]);
  });

  it('follows fitness runs a view reads: the crew is marked busy and both views redraw', async () => {
    const sources = recorded.treeViews[1].options.treeDataProvider as { onRuns: (ns: string, crew: string, runs: unknown[]) => void; fitnessBusy: (ns: string, crew: string) => boolean };
    const crews = recorded.treeViews[0].options.treeDataProvider as { fitnessBusy: (ns: string, crew: string) => boolean; onDidChangeTreeData: (l: () => void) => void };
    let redrawn = 0;
    crews.onDidChangeTreeData(() => redrawn++);
    sources.onRuns('team-a', 'lab-ops', [{ name: 'r', phase: 'Running' }]);
    expect(sources.fitnessBusy('team-a', 'lab-ops')).toBe(true);
    expect(crews.fitnessBusy('team-a', 'lab-ops')).toBe(true);
    expect(redrawn).toBe(1);
  });

  it('showLiveYamlRaw opens the raw YAML of a crew and ignores anything else', async () => {
    await run('crewforge.showLiveYamlRaw', { kind: 'crew', crew: { name: 'lab-ops', namespace: 'team-a', ready: true, phase: 'Ready' } });
    await run('crewforge.showLiveYamlRaw', { kind: 'message', text: 'x' });
    await run('crewforge.showLiveYamlRaw');
    expect(recorded.shownDocuments).toEqual(['crewforge-live:/team-a/Crew/lab-ops.raw.yaml (yaml)']);
  });

  it('runs the live Fitness group commands only on their own nodes, and compares scenarios only with an open source', async () => {
    for (const id of ['crewforge.runDeployedFitness', 'crewforge.runDeployedScenario', 'crewforge.showDeployedScenario', 'crewforge.pauseRun', 'crewforge.resumeRun', 'crewforge.stopRun', 'crewforge.runScenarioBatch']) {
      await run(id);
      await run(id, { kind: 'message', text: 'x' });
    }
    await run('crewforge.runSelectedScenarios');
    await run('crewforge.runSelectedScenarios', { kind: 'fitness', entry: {}, deployment: {} }, []);
    expect(recorded.info).toEqual([
      'No scenarios are selected. Select scenario rows under a Fitness group, then choose Run Selected Scenarios.',
      'No scenarios are selected. Select scenario rows under Fitness Scenarios, then choose Run Selected Scenarios.',
    ]);
    expect(recorded.errors).toEqual([]);
    expect(recorded.shownDocuments).toEqual([]);
    expect(await exported.crews.sourceScenarios?.({ name: 'lab-ops', namespace: 'team-a', ready: true, phase: 'Ready' })).toBeUndefined();
  });

  it('runs the lifecycle commands on a live crew from the Deployed Crews view', async () => {
    const crew = { name: 'lab-ops', namespace: 'team-a', ready: true, phase: 'Ready' };
    await run('crewforge.followRollout', { kind: 'crew', crew });
    expect(recorded.info[0]).toBe('lab-ops in team-a is not managed by a Flux HelmRelease.');
    await run('crewforge.updateDeployment', { kind: 'crew', crew });
    await run('crewforge.deployRevision', { kind: 'crew', crew });
    await run('crewforge.runFitness', { kind: 'crew', crew });
    expect(recorded.info.slice(1).every((m) => m.startsWith('CrewForge does not know the source of lab-ops in team-a'))).toBe(true);
    expect(recorded.info).toHaveLength(4);
    await run('crewforge.removeDeployment', { kind: 'crew', crew: { ...crew, labels: { 'helm.toolkit.fluxcd.io/name': 'lab' } } });
    expect(recorded.info[4]).toContain('the HelmRelease lab manages lab-ops');
    await run('crewforge.updateDeployment', { kind: 'message', text: 'x' });
    expect(recorded.info).toHaveLength(5);
  });

  it('opens live YAML for a crew, its bundle, and a leaf with an object, and ignores anything else', async () => {
    const crew = { name: 'lab-ops', namespace: 'team-a', ready: true, phase: 'Ready' };
    expect(recorded.documentProviders.has('crewforge-live')).toBe(true);
    await run('crewforge.showLiveYaml', { kind: 'crew', crew });
    await run('crewforge.showCrewBundleYaml', { kind: 'crew', crew });
    await run('crewforge.showLiveYaml', { kind: 'member', crew, view: { label: 'k8s', tooltip: '', icon: 'x', ref: { kind: 'Agent', name: 'k8s', namespace: 'team-a' } } });
    await run('crewforge.showLiveYaml', { kind: 'member', crew, view: { label: 'tool', tooltip: '', icon: 'x' } });
    await run('crewforge.showLiveYaml');
    await run('crewforge.showCrewBundleYaml', { kind: 'message', text: 'x' });
    expect(recorded.shownDocuments).toEqual([
      'crewforge-live:/team-a/Crew/lab-ops.yaml (yaml)',
      'crewforge-live:/team-a/lab-ops.bundle.yaml (yaml)',
      'crewforge-live:/team-a/Agent/k8s.yaml (yaml)',
    ]);
  });

  it('refreshes Crew Sources on its command, and finds sources through the workspace', async () => {
    const view = recorded.treeViews[1];
    const provider = view.options.treeDataProvider as { onDidChangeTreeData: (l: () => void) => void; getChildren: () => Promise<{ kind: string }[]> };
    let refreshed = 0;
    provider.onDidChangeTreeData(() => refreshed++);
    run('crewforge.refreshSources');
    recorded.configListeners.forEach((l) => l({ affectsConfiguration: (s) => s === 'crewforge' }));
    expect(refreshed).toBe(2);
    recorded.files.set('**/*.{yaml,yml}', [path.join(__dirname, 'fixtures', 'sources', 'bundles', 'demo', 'crew', '02-crew.yaml'), '/w/Chart.yaml']);
    const roots = await provider.getChildren();
    expect(roots.map((r) => r.kind)).toEqual(['source']);
  });
});

describe('the inner loop in the extension', () => {
  const BUNDLE = path.join(__dirname, 'fixtures', 'sources', 'bundles', 'demo', 'crew');
  const loadBundle = async () => {
    recorded.files.set('**/*.{yaml,yml}', [path.join(BUNDLE, '02-crew.yaml')]);
    const provider = recorded.treeViews[1].options.treeDataProvider as { getChildren: () => Promise<{ kind: string; entry: unknown }[]> };
    return (await provider.getChildren())[0];
  };

  it('marks the crew folders for the Explorer menu, and View in CrewForge selects the Crew and opens the dashboard', async () => {
    await loadBundle();
    await vi.waitFor(() => expect(recorded.contexts.get('crewforge.crewRoots')).toMatchObject({ [BUNDLE]: true }));
    await run('crewforge.viewInCrewForge', Uri.file(path.join(BUNDLE, '02-crew.yaml')));
    expect(recorded.revealed.at(-1)).toMatchObject({ view: 'crewforge.sources', node: { kind: 'declared', item: { label: 'demo' } }, options: { select: true, expand: false } });
    expect(recorded.panels.map((p) => p.title)).toEqual(['demo']);
    await run('crewforge.viewInCrewForge', Uri.file(BUNDLE));
    expect(recorded.revealed.at(-1)).toMatchObject({ node: { kind: 'source' }, options: { expand: true } });
  });

  it('says on a live crew whether its source is open', async () => {
    const tree = recorded.treeViews[0].options.treeDataProvider as CrewTreeProvider;
    await loadBundle();
    expect(tree.sourceOpen?.({ name: 'demo', namespace: 'somewhere', ready: true, phase: 'Ready' })).toBe(true);
    expect(tree.sourceOpen?.({ name: 'other', namespace: 'somewhere', ready: true, phase: 'Ready' })).toBe(false);
  });

  it('adds a status bar item and the Problems collection, and follows the active editor and saves', async () => {
    expect(recorded.statusBarItems).toHaveLength(2);
    expect(recorded.statusBarItems[1].command).toMatchObject({ command: 'crewforge.selectContext' });
    expect(recorded.diagnostics.map((d) => d.name)).toEqual(['crewforge']);
    await loadBundle();
    const source = await loadBundle();
    const provider = recorded.treeViews[1].options.treeDataProvider as { getTreeItem: (n: unknown) => { description?: string; contextValue?: string } };
    // Every source's state is read when the sources load, before any of its files is open.
    await vi.waitFor(() => expect(provider.getTreeItem(source)).toMatchObject({ description: 'not deployed · bundle in crew' }));
    recorded.editorListeners.forEach((l) => l({ document: { uri: Uri.file(path.join(BUNDLE, '02-crew.yaml')) } }));
    expect(recorded.statusBarItems[0]).toMatchObject({ visible: true, text: expect.stringContaining('demo: ') });
    await vi.waitFor(() => expect(recorded.statusBarItems[0].text).toBe('$(organization) demo: not deployed'));
    expect(provider.getTreeItem(source)).toMatchObject({ description: 'not deployed · bundle in crew', contextValue: 'source-bundle' });
    recorded.editorListeners.forEach((l) => l(undefined));
    expect(recorded.statusBarItems[0].visible).toBe(false);
    // The save listener is wired; what a save does is covered in loop.test.ts.
    expect(recorded.saveListeners).toHaveLength(1);
    expect(() => recorded.saveListeners.forEach((l) => l({ uri: Uri.file('/nowhere/x.yaml') }))).not.toThrow();
  });

  it('lints a bundle source from its node, without helm', async () => {
    const source = await loadBundle();
    await run('crewforge.lintCrew', source);
    expect(recorded.info.at(-1)).toMatch(/^Lint: demo has /);
  });

  it('asks for the namespace on the first deploy, and says when the crew is not deployed for Ask and Run Fitness', async () => {
    const source = await loadBundle();
    await run('crewforge.deployToNamespace', source);
    await run('crewforge.redeploy', source);
    await run('crewforge.askSource', source);
    await run('crewforge.runFitness', source);
    expect(recorded.info.filter((m) => m === 'demo is not deployed in fake. Deploy it to a namespace first.')).toHaveLength(2);
    recorded.quickPicks.push(undefined);
    await run('crewforge.crewActions', source);
    expect(recorded.errors).toEqual([]);
  });

  it('creates a crew in the Explorer folder, and reports a missing kmctl before asking anything', async () => {
    const saved = process.env.PATH;
    process.env.PATH = '';
    try {
      await run('crewforge.newCrewHere', Uri.file('/w/crews'));
      await run('crewforge.createCrew');
    } finally {
      process.env.PATH = saved;
    }
    expect(recorded.modalErrors).toHaveLength(2);
    expect(recorded.modalErrors[0]).toContain('needs kmctl');
  });

  it('links a chat to the agents of the crew source open in the workspace', async () => {
    await loadBundle();
    await run('crewforge.askCrew', { kind: 'crew', crew: { name: 'demo', namespace: 'somewhere', ready: true, phase: 'Ready' } });
    const states = () => recorded.panels[0].webview.posted as { type: string; links?: { agents: string[] } }[];
    await vi.waitFor(() => expect(states().at(-1)?.links?.agents).toEqual([]));
  });
});

describe('defining a crew in the extension', () => {
  const FIXTURE = path.join(__dirname, 'fixtures', 'sources', 'bundles', 'demo', 'crew');
  type Node = { kind: string; section?: string; item?: { label: string }; entry?: unknown };
  const provider = () => recorded.treeViews[1].options.treeDataProvider as { getChildren: (n?: Node) => Promise<Node[]> };

  it('adds an object to a bundle from its group, removes it again, and reveals a group from the dashboard', async () => {
    const dir = path.join(storage, 'demo');
    fs.cpSync(FIXTURE, dir, { recursive: true });
    recorded.files.set('**/*.{yaml,yml}', [path.join(dir, '02-crew.yaml')]);
    const [source] = await provider().getChildren();
    const sinks = (await provider().getChildren(source)).find((n) => n.kind === 'declSection' && n.section === 'notifications')!;
    recorded.inputs.push('pager', 'https://ntfy.example.com/lab');
    await run('crewforge.addNotificationSink', sinks);
    const file = path.join(dir, 'notificationsink-pager.yaml');
    expect(fs.readFileSync(file, 'utf8')).toContain('kind: NotificationSink');
    expect(recorded.executed.map((e) => e.id)).toEqual(['vscode.open', 'crewforge.lintCrew']);
    expect(recorded.revealed.at(-1)).toMatchObject({ view: 'crewforge.sources', node: { kind: 'declared', item: { label: 'pager' } } });

    const [reloaded] = await provider().getChildren();
    const group = (await provider().getChildren(reloaded)).find((n) => n.kind === 'declSection' && n.section === 'notifications')!;
    const [pager] = await provider().getChildren(group);
    recorded.warningAnswers.push('Remove');
    await run('crewforge.removeFromSource', pager);
    expect(recorded.trashed).toEqual([`${file} (trash)`]);

    await run('crewforge.openCrewDashboard', reloaded);
    expect(await exported.press(`crew:${dir}`, 'group', 'models')).toBe(true);
    expect(recorded.revealed.at(-1)).toMatchObject({ view: 'crewforge.sources', node: { kind: 'declSection', section: 'models' }, options: { expand: true } });
    await exported.press(`crew:${dir}`, 'group', 'deployment');
    expect(recorded.revealed.at(-1)).toMatchObject({ node: { kind: 'source' } });
    const count = recorded.revealed.length;
    await exported.press(`crew:${dir}`, 'group', 'not-a-group');
    expect(recorded.revealed).toHaveLength(count);
  });

  it("reveals a live crew's group in Deployed Crews, and shows a tool's details", async () => {
    const cluster = seedInfrastructure(seedCrew(new FakeCluster()));
    const live = await startFakeApi({ cluster });
    try {
      recorded.settings.set('crewforge.kubeconfig', live.kubeconfig);
      const crew = { name: 'lab-ops', namespace: 'team-a', ready: true, phase: 'Ready' };
      await run('crewforge.openCrewDashboard', { kind: 'crew', crew });
      // The first press reads the crew, as the page does when its script starts.
      await exported.press('crew:team-a/lab-ops', 'refresh');
      await exported.press('crew:team-a/lab-ops', 'group', 'rag');
      expect(recorded.revealed.at(-1)).toMatchObject({ view: 'crewforge.crews', node: { kind: 'section', section: 'rag' }, options: { select: true, expand: true } });
      const tool = { kind: 'member', crew, view: { label: 't', tooltip: '', icon: 'wrench', tool: { info: { name: 't', agents: ['k8s'] } } } };
      await run('crewforge.showToolDetails', tool);
      expect(recorded.shownDocuments.at(-1)).toBe('crewforge-live:/team-a/lab-ops/tools/t.md (markdown)');
    } finally {
      await live.close();
    }
  });
});

describe('Commands', () => {
  const tree = () => new CrewTreeProvider();
  const view = (id = 'crewforge.crews') => ({ id, reveal: (node: unknown, options?: unknown) => (recorded.revealed.push({ view: id, node, options }), Promise.resolve()) }) as unknown as FakeTreeView;

  it('reveals a live crew in the Deployed Crews view, or says its namespace is not listed', async () => {
    const commands = new Commands(Uri.file('/ext') as never, tree(), view() as never, new ConversationStore(path.join(storage, 'c')));
    await commands.revealLive({ name: 'lab-ops', namespace: 'team-a', ready: true, phase: 'Ready' });
    expect(recorded.revealed).toMatchObject([{ view: 'crewforge.crews', node: { kind: 'crew', crew: { name: 'lab-ops' } }, options: { select: true, expand: true } }]);
    await commands.revealLive({ name: 'lab-ops', namespace: 'elsewhere', ready: true, phase: 'Ready' });
    expect(recorded.info.at(-1)).toContain('does not list elsewhere');
  });

  it('asks the last question again from the newest saved conversation, or says there is none', async () => {
    const store = new ConversationStore(path.join(storage, 'c'));
    const commands = new Commands(Uri.file('/ext') as never, tree(), view() as never, store);
    const crew = { name: 'lab-ops', namespace: 'team-a', ready: true, phase: 'Ready' };
    await commands.reaskLast(crew);
    expect(recorded.info.at(-1)).toBe('There is no earlier question for lab-ops to ask again. Ask it one in the chat.');
    for (const p of recorded.panels) p.dispose();
    const saved = newConversation('fake', 'team-a', 'lab-ops');
    saved.messages.push({ role: 'user', content: 'Which nodes have a GPU?', timestamp: saved.startedAt });
    await store.save(saved);
    await commands.reaskLast(crew);
    expect(api.posts.map((p) => JSON.parse(p.body).message)).toContain('Which nodes have a GPU?');
    await commands.reaskLast(crew);
    expect(recorded.panels.filter((p) => p.title === 'Ask lab-ops')).toHaveLength(2);
  });
});
