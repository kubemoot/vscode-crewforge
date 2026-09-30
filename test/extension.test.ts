import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { activate, deactivate } from '../src/extension';
import { newConversation } from '../src/store/conversation';
import { ConversationStore } from '../src/store/conversations';
import { startFakeApi, type FakeApi } from './fakeApiServer';
import { recorded, resetFake, Uri } from './vscodeFake';

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
  activate({ globalStorageUri: Uri.file(storage), extensionUri: Uri.file('/ext'), subscriptions } as never);
});

afterEach(() => {
  for (const p of recorded.panels) p.dispose();
  for (const s of subscriptions) s.dispose();
  deactivate();
});

const run = (id: string, ...args: unknown[]) => recorded.commands.get(id)!(...args);

describe('activate', () => {
  it('registers every command the manifest contributes, and the Crews view', () => {
    const declared = manifest.contributes.commands.map((c) => c.command).sort();
    expect([...recorded.commands.keys()].sort()).toEqual(declared);
    expect(recorded.treeViews.map((v) => v.id)).toEqual(['crewforge.crews', 'crewforge.sources']);
  });

  it('refreshes the Crews view on the command and on a CrewForge setting change', () => {
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
    expect(panel.webview.posted.at(-1)).toEqual({ type: 'prefill', text: 'From src/app.ts:\n\n```typescript\nconst a = 1;\n```\n\n' });
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
    await run('crewforge.showDrift', { kind: 'resource', deployment: { namespace: 'ns' }, drift });
    await run('crewforge.showDrift', { kind: 'message', text: 'x' });
    await run('crewforge.showDrift');
    expect(recorded.executed.map((e) => e.id)).toEqual(['vscode.diff']);
    expect(recorded.documentProviders.has('crewforge-manifest')).toBe(true);
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
