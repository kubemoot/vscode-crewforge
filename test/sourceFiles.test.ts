import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CrewSummary } from '../src/k8s/crews';
import type { ResourceDrift } from '../src/source/drift';
import { SourceService, type SourceEntry } from '../src/source/service';
import { ContextCommands, type ContextDeps } from '../src/views/contextCommands';
import { liveTextForFile } from '../src/views/fileDiff';
import { ManifestDocuments, MANIFEST_SCHEME } from '../src/views/manifestDocuments';
import { fileItem, listDir } from '../src/views/sourceFiles';
import { SourceTreeProvider, type SourceNode } from '../src/views/sourceTree';
import { commands, recorded, resetFake, Uri } from './vscodeFake';

const ROOT = '/w/lab-ops';
const entry = (id = 'repo//lab-ops'): SourceEntry =>
  ({ source: { kind: 'helm', root: ROOT, label: 'lab-ops' }, identity: { id }, crewName: 'lab-ops', rendered: [] }) as unknown as SourceEntry;

beforeEach(resetFake);

describe('the files of a crew source', () => {
  it('lists real files and folders, folders first, without dependencies and git files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-files-'));
    fs.mkdirSync(path.join(dir, 'templates'));
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, 'values.yaml'), '');
    fs.writeFileSync(path.join(dir, 'Chart.yaml'), '');
    expect(await listDir(dir)).toEqual([
      { name: 'templates', folder: true },
      { name: 'Chart.yaml', folder: false },
      { name: 'values.yaml', folder: false },
    ]);
  });

  it('gives a file a resource URI, so the editor draws its icon and Git marks, and opens it in the normal editor', () => {
    const file = fileItem(`${ROOT}/values.yaml`, false);
    expect(file).toMatchObject({ label: 'values.yaml', contextValue: 'sourceFile', collapsibleState: 0, command: { command: 'vscode.open' } });
    expect((file.resourceUri as unknown as Uri).fsPath).toBe(`${ROOT}/values.yaml`);
    expect((file.command?.arguments?.[0] as Uri).fsPath).toBe(`${ROOT}/values.yaml`);
    const folder = fileItem(`${ROOT}/templates`, true);
    expect(folder).toMatchObject({ label: 'templates', contextValue: 'sourceFolder', collapsibleState: 1, command: undefined });
    expect((folder.resourceUri as unknown as Uri).fsPath).toBe(`${ROOT}/templates`);
  });

  function tree(list: (dir: string) => Promise<{ name: string; folder: boolean }[]>): SourceTreeProvider {
    const provider = new SourceTreeProvider({} as SourceService, () => ({}) as never);
    provider.listDir = list;
    return provider;
  }

  it('expands a Files group and its folders to the real entries', async () => {
    const provider = tree(async (dir) => (dir === ROOT ? [{ name: 'templates', folder: true }, { name: 'Chart.yaml', folder: false }] : [{ name: 'crew.yaml', folder: false }]));
    const files: SourceNode = { kind: 'files', entry: entry() };
    expect(provider.getTreeItem(files)).toMatchObject({ label: 'Files', contextValue: 'sourceFiles', collapsibleState: 1 });
    const top = await provider.getChildren(files);
    expect(top.map((n) => provider.getTreeItem(n).resourceUri?.fsPath)).toEqual([`${ROOT}/templates`, `${ROOT}/Chart.yaml`]);
    const inner = await provider.getChildren(top[0]);
    expect(inner.map((n) => provider.getTreeItem(n).label)).toEqual(['crew.yaml']);
    expect(await provider.getChildren(inner[0])).toEqual([]);
    expect(provider.getParent(inner[0])).toMatchObject({ kind: 'file', path: `${ROOT}/templates` });
  });

  it('shows a folder it cannot read as a message', async () => {
    const provider = tree(async () => Promise.reject(new Error('EACCES')));
    const children = await provider.getChildren({ kind: 'files', entry: entry() });
    expect(children[0].kind).toBe('message');
  });
});

describe('Compare with Live on a file', () => {
  const crew = { name: 'lab-ops', namespace: 'team-a' } as CrewSummary;
  const drift = [{ kind: 'Agent', name: 'triage', live: { apiVersion: 'v1', kind: 'Agent', metadata: { name: 'triage' }, spec: { a: 1 } } }, { kind: 'Skill', name: 's' }] as unknown as ResourceDrift[];
  const located = [
    { manifest: { kind: 'Agent', metadata: { name: 'triage' } }, file: '/w/a.yaml', line: 0 },
    { manifest: { kind: 'Skill', metadata: { name: 's' } }, file: '/w/a.yaml', line: 5 },
    { manifest: { kind: 'Agent', metadata: { name: 'other' } }, file: '/w/b.yaml', line: 0 },
  ] as never;

  it('renders the live objects a file declares, and nothing for one that declares none deployed', () => {
    expect(liveTextForFile('/w/a.yaml', located, drift)).toContain('name: triage');
    expect(liveTextForFile('/w/b.yaml', located, drift)).toBeUndefined();
    expect(liveTextForFile('/w/none.yaml', located, drift)).toBeUndefined();
  });

  it('opens the diff editor with the live document on the left and the file itself on the right', async () => {
    const documents = new ManifestDocuments();
    await documents.showFileDiff('/w/a.yaml', 'kind: Agent\n', 'team-a');
    const [call] = recorded.executed;
    expect(call.id).toBe('vscode.diff');
    const [left, right, title] = call.args as [Uri, Uri, string];
    expect(left.scheme).toBe(MANIFEST_SCHEME);
    expect(documents.provideTextDocumentContent(left as never)).toContain('kind: Agent');
    expect(right.fsPath).toBe('/w/a.yaml');
    expect(title).toBe('a.yaml: live in team-a vs file');
  });

  function commands(live: { text: string; namespace: string } | undefined) {
    const shown: unknown[][] = [];
    const deps = { liveForFile: async () => live, showFileDiff: async (...a: unknown[]) => void shown.push(a), entryForCrew: () => undefined, located: async () => [], yamlOf: async () => '', dashboardBase: () => '' } as ContextDeps;
    void crew;
    return { shown, commands: new ContextCommands(deps) };
  }

  it('passes the file and its live text to the diff editor', async () => {
    const { shown, commands: c } = commands({ text: 'kind: Agent\n', namespace: 'team-a' });
    await c.diffFileWithLive({ kind: 'file', entry: entry(), path: '/w/a.yaml', folder: false });
    expect(shown).toEqual([['/w/a.yaml', 'kind: Agent\n', 'team-a']]);
  });

  it('says so when nothing of the file is deployed, and ignores folders and other nodes', async () => {
    const { shown, commands: c } = commands(undefined);
    await c.diffFileWithLive({ kind: 'file', entry: entry(), path: '/w/a.yaml', folder: false });
    await c.diffFileWithLive({ kind: 'file', entry: entry(), path: '/w', folder: true });
    await c.diffFileWithLive(undefined);
    expect(shown).toEqual([]);
    expect(recorded.info).toHaveLength(1);
  });
});

describe('Open in Source Control', () => {
  const deps = { liveForFile: async () => undefined, showFileDiff: async () => undefined, entryForCrew: () => undefined, located: async () => [], yamlOf: async () => '', dashboardBase: () => '' } as ContextDeps;
  const file = (id?: string): SourceNode => ({ kind: 'file', entry: entry(id), path: `${ROOT}/values.yaml`, folder: false });

  it('opens the change of a file in a Git repository', async () => {
    await new ContextCommands(deps).openInSourceControl(file());
    expect(recorded.executed.map((e) => e.id)).toEqual(['git.openChange']);
  });

  it('falls back to the Source Control view when the Git extension does not answer', async () => {
    const original = commands.executeCommand;
    commands.executeCommand = (id: string, ...args: unknown[]) => (id === 'git.openChange' ? Promise.reject(new Error('no git')) : original(id, ...args));
    try {
      await new ContextCommands(deps).openInSourceControl(file());
    } finally {
      commands.executeCommand = original;
    }
    expect(recorded.executed.map((e) => e.id)).toEqual(['workbench.view.scm']);
  });

  it('opens the Source Control view for a folder or a source', async () => {
    await new ContextCommands(deps).openInSourceControl({ kind: 'source', entry: entry() });
    await new ContextCommands(deps).openInSourceControl({ kind: 'files', entry: entry() });
    expect(recorded.executed.map((e) => e.id)).toEqual(['workbench.view.scm', 'workbench.view.scm']);
  });

  it('says so outside a Git repository, and for a node with no source', async () => {
    await new ContextCommands(deps).openInSourceControl(file('local:/w/lab-ops'));
    await new ContextCommands(deps).openInSourceControl({ kind: 'crew', crew: {} as CrewSummary });
    expect(recorded.executed).toEqual([]);
    expect(recorded.info).toEqual(['This is not in a Git repository.', 'This is not in a Git repository.']);
  });
});
