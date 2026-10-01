import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { crewFolders, crewRootsKey, FOLDER_LIMIT } from '../src/source/crewFolders';
import type { SourceEntry } from '../src/source/service';
import { CREW_ROOTS_KEY, ExplorerCrews, listFolders } from '../src/views/explorer';
import type { SourceNode } from '../src/views/sourceTree';
import { recorded, resetFake, Uri } from './vscodeFake';

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
  contributes: { commands: { command: string; title: string }[]; menus: Record<string, { command: string; when?: string }[]> };
};

beforeEach(resetFake);

describe('the folders of crew sources', () => {
  it('lists each root and every folder under it, without dependencies, git, or build output', async () => {
    const tree: Record<string, string[]> = { '/w/a': ['templates', 'node_modules', '.git', 'fitness'], '/w/a/templates': [], '/w/a/fitness': ['deep'], '/w/a/fitness/deep': [] };
    const listed = await crewFolders(['/w/a', '/w/a'], async (dir) => tree[dir] ?? Promise.reject(new Error('gone')));
    expect(listed).toEqual(['/w/a', '/w/a/templates', '/w/a/fitness', '/w/a/fitness/deep']);
    expect(await crewFolders(['/w/missing'], async () => Promise.reject(new Error('gone')))).toEqual(['/w/missing']);
    expect(await crewFolders([], async () => [])).toEqual([]);
    expect(await crewFolders(['/w/a', '/w/a/templates'], async (dir) => tree[dir] ?? [])).toEqual(['/w/a', '/w/a/templates', '/w/a/fitness', '/w/a/fitness/deep']);
  });

  it('stops at the folder limit', async () => {
    let n = 0;
    const listed = await crewFolders(['/r'], async () => [`d${n++}`, `d${n++}`]);
    expect(listed).toHaveLength(FOLDER_LIMIT);
  });

  it('keys every folder by its file system path and its URI path, for local and remote windows', () => {
    expect(crewRootsKey(['/w/a'], (p) => `/remote${p}`)).toEqual({ '/w/a': true, '/remote/w/a': true });
  });

  it('reads real subfolders from disk', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-folders-'));
    fs.mkdirSync(path.join(dir, 'templates'));
    fs.writeFileSync(path.join(dir, 'Chart.yaml'), 'name: x');
    expect(await listFolders(dir)).toEqual(['templates']);
  });
});

describe('the Explorer menu', () => {
  const entry = { source: { kind: 'helm', root: '/w/demo', label: 'demo' }, identity: { id: 'local:demo' }, crewName: 'demo' } as unknown as SourceEntry;
  const declared: SourceNode = { kind: 'declared', entry, item: { label: 'demo', tooltip: '', icon: 'organization', line: 0, file: '/w/demo/templates/crew.yaml' } };

  it('offers New Kubemoot Crew Here outside crew sources, and View in CrewForge inside them', () => {
    const titles = new Map(manifest.contributes.commands.map((c) => [c.command, c.title]));
    expect(titles.get('crewforge.newCrewHere')).toBe('New Kubemoot Crew Here');
    expect(titles.get('crewforge.viewInCrewForge')).toBe('View in CrewForge');
    const menu = manifest.contributes.menus['explorer/context'];
    expect(menu.find((m) => m.command === 'crewforge.newCrewHere')?.when).toBe(`explorerResourceIsFolder && !(resourcePath in ${CREW_ROOTS_KEY})`);
    expect(menu.find((m) => m.command === 'crewforge.viewInCrewForge')?.when).toBe(`(explorerResourceIsFolder && resourcePath in ${CREW_ROOTS_KEY}) || (!explorerResourceIsFolder && resourceDirname in ${CREW_ROOTS_KEY})`);
  });

  it('sets the context key from the sources loaded', async () => {
    const explorer = new ExplorerCrews({ sources: { known: [entry], nodeForPath: async () => undefined }, reveal: async () => undefined, openDashboard: () => undefined, listFolders: async (dir) => (dir === '/w/demo' ? ['templates'] : []) });
    expect(await explorer.update()).toEqual(['/w/demo', '/w/demo/templates']);
    expect(recorded.contexts.get(CREW_ROOTS_KEY)).toEqual({ '/w/demo': true, '/w/demo/templates': true });
  });

  it('View in CrewForge reveals the matching node and opens the crew dashboard, or says it is not in a crew', async () => {
    const revealed: SourceNode[] = [];
    const opened: SourceNode[] = [];
    const explorer = new ExplorerCrews({
      sources: { known: [entry], nodeForPath: async (p) => (p.startsWith('/w/demo') ? declared : p === '/w/msg' ? { kind: 'message', text: 'x' } : undefined) },
      reveal: async (node) => void revealed.push(node),
      openDashboard: (node) => void opened.push(node),
    });
    await explorer.viewInCrewForge(Uri.file('/w/demo/templates/crew.yaml') as never);
    expect(revealed).toEqual([declared]);
    expect(opened).toEqual([{ kind: 'source', entry }]);
    await explorer.viewInCrewForge(Uri.file('/w/notes') as never);
    await explorer.viewInCrewForge(Uri.file('/w/msg') as never);
    await explorer.viewInCrewForge();
    expect(recorded.info).toHaveLength(3);
    recorded.activeEditor = { document: { uri: Uri.file('/w/demo/values.yaml'), languageId: 'yaml', getText: () => '' }, selection: undefined };
    await explorer.viewInCrewForge();
    expect(revealed).toHaveLength(2);
  });
});
