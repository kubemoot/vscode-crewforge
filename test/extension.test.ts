import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { activate, Commands, deactivate } from '../src/extension';
import { newConversation } from '../src/store/conversation';
import { ConversationStore } from '../src/store/conversations';
import { startFakeApi, type FakeApi } from './fakeApiServer';
import { CrewTreeProvider } from '../src/views/crewTree';
import { recorded, resetFake, Uri, workspaceState, type FakeTreeView } from './vscodeFake';

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
  contributes: { commands: { command: string }[] };
};

let api: FakeApi;
let storage: string;
let subscriptions: { dispose(): unknown }[];

beforeAll(async () => (api = await startFakeApi()));
afterAll(() => api.close());

beforeEach(() => {
  resetFake();
  recorded.settings.set('crewforge.kubeconfig', api.kubeconfig);
  storage = fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-ext-'));
  subscriptions = [];
  activate({ globalStorageUri: Uri.file(storage), extensionUri: Uri.file('/ext'), subscriptions, workspaceState } as never);
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
    await new Promise((r) => setTimeout(r, 30));
    expect(panel.webview.posted.find((m) => (m as { type: string }).type === 'prefill')).toEqual({ type: 'prefill', text: 'From src/app.ts:\n\n```typescript\nconst a = 1;\n```\n\n' });
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

  it('routes Undeploy, Delete Crew Source, and Rename Crew on a source, and ignores anything else', async () => {
    const entry = { source: { kind: 'helm', root: '/w/none', label: 'none' }, identity: { id: 'local:none' } };
    await run('crewforge.removeDeployment', { kind: 'source', entry });
    await run('crewforge.deleteSource', { kind: 'message', text: 'x' });
    await run('crewforge.renameCrew', { kind: 'source', entry });
    await run('crewforge.deleteSource');
    expect(recorded.info).toEqual(['none is not deployed in this context.']);
    expect(recorded.warnings).toEqual([]);
  });

  it('showLiveYamlRaw opens the raw YAML of a crew and ignores anything else', async () => {
    await run('crewforge.showLiveYamlRaw', { kind: 'crew', crew: { name: 'lab-ops', namespace: 'team-a', ready: true, phase: 'Ready' } });
    await run('crewforge.showLiveYamlRaw', { kind: 'message', text: 'x' });
    await run('crewforge.showLiveYamlRaw');
    expect(recorded.shownDocuments).toEqual(['crewforge-live:/team-a/Crew/lab-ops.raw.yaml (yaml)']);
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
  const tick = () => new Promise((r) => setTimeout(r, 30));

  it('adds a status bar item and the Problems collection, and follows the active editor and saves', async () => {
    expect(recorded.statusBarItems).toHaveLength(1);
    expect(recorded.diagnostics.map((d) => d.name)).toEqual(['crewforge']);
    await loadBundle();
    const source = await loadBundle();
    const provider = recorded.treeViews[1].options.treeDataProvider as { getTreeItem: (n: unknown) => { description?: string; contextValue?: string }; onDidChangeTreeData: (l: (n: unknown) => void) => void };
    const redrawn: unknown[] = [];
    provider.onDidChangeTreeData((n) => redrawn.push(n));
    recorded.editorListeners.forEach((l) => l({ document: { uri: Uri.file(path.join(BUNDLE, '02-crew.yaml')) } }));
    expect(recorded.statusBarItems[0]).toMatchObject({ visible: true, text: expect.stringContaining('demo: ') });
    await tick();
    expect(recorded.statusBarItems[0].text).toBe('$(organization) demo: not deployed');
    expect(provider.getTreeItem(source)).toMatchObject({ description: 'crew demo · bundle · not deployed', contextValue: 'source-bundle' });
    expect(redrawn).toContain(source);
    recorded.editorListeners.forEach((l) => l(undefined));
    expect(recorded.statusBarItems[0].visible).toBe(false);
    recorded.saveListeners.forEach((l) => l({ uri: Uri.file('/nowhere/x.yaml') }));
    await tick();
  });

  it('lints a bundle source from its node, without helm', async () => {
    const source = await loadBundle();
    await run('crewforge.lintCrew', source);
    expect(recorded.info.at(-1)).toMatch(/^Lint Crew: crew has /);
  });

  it('asks for the dev namespace on the first deploy, and says when the crew is not deployed for Ask and Run Fitness', async () => {
    const source = await loadBundle();
    await run('crewforge.deployDev', source);
    await run('crewforge.redeployDev', source);
    await run('crewforge.askSource', source);
    await run('crewforge.runFitness', source);
    expect(recorded.info.filter((m) => m === 'demo is not deployed in fake. Deploy it to a dev namespace first.')).toHaveLength(2);
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
    await tick();
    const states = recorded.panels[0].webview.posted as { type: string; links?: { agents: string[] } }[];
    expect(states.at(-1)?.links?.agents).toEqual([]);
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
