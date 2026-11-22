import { beforeEach, describe, expect, it } from 'vitest';
import type { CrewSummary } from '../src/k8s/crews';
import type { SourceEntry } from '../src/source/service';
import { ContextCommands, registerContextCommands, workspaceRoots, type ContextDeps } from '../src/views/contextCommands';
import { dashboardUrlOf, fileOf, mainFileOf, namedOf, namespacedNameText, nameText, relativePathOf, type AnyNode } from '../src/views/nodeFacts';
import { recorded, resetFake, Uri } from './vscodeFake';

const crew: CrewSummary = { name: 'lab-ops', namespace: 'team-a', ready: true, phase: 'Ready', agents: 2, labels: {} };
const entry = (kind: 'helm' | 'bundle' = 'helm'): SourceEntry =>
  ({
    source: { kind, root: '/w/charts/lab-ops', label: 'lab-ops' },
    identity: { id: 'x' },
    crewName: 'lab-ops',
    rendered: [{ manifest: { kind: 'Crew', metadata: { name: 'lab-ops' } }, file: '/w/charts/lab-ops/templates/crew.yaml' }],
  }) as unknown as SourceEntry;
const deployment = { namespace: 'team-a', channel: 'helm', crew } as never;
const sourceNode = (kind: 'helm' | 'bundle' = 'helm'): AnyNode => ({ kind: 'source', entry: entry(kind) });
const crewNode: AnyNode = { kind: 'crew', crew };
const memberNode = (ref?: { kind: string; name: string; namespace: string }): AnyNode =>
  ({ kind: 'member', crew, view: { label: 'x', icon: 'x', tooltip: '', ref } }) as unknown as AnyNode;
const declared = (extra: object = {}): AnyNode => ({ kind: 'declared', entry: entry(), item: { label: 'triage', tooltip: '', icon: 'x', line: 4, file: '/w/charts/lab-ops/templates/agents.yaml', ...extra } });

describe('relativePathOf', () => {
  const one = [{ name: 'w', fsPath: '/w' }];
  const two = [
    { name: 'app', fsPath: '/w/app' },
    { name: 'charts', fsPath: '/w/charts' },
  ];

  it('is relative to the only workspace folder, without its name', () => {
    expect(relativePathOf('/w/charts/lab-ops/Chart.yaml', one)).toBe('charts/lab-ops/Chart.yaml');
    expect(relativePathOf('/w', one)).toBe('.');
  });

  it('puts the folder name in front in a multi-root workspace, as VS Code does', () => {
    expect(relativePathOf('/w/charts/lab-ops/Chart.yaml', two)).toBe('charts/lab-ops/Chart.yaml');
    expect(relativePathOf('/w/app/src/main.ts', two)).toBe('app/src/main.ts');
    expect(relativePathOf('/w/charts', two)).toBe('charts');
  });

  it('uses the innermost folder when folders nest', () => {
    const nested = [...two, { name: 'lab', fsPath: '/w/charts/lab-ops' }];
    expect(relativePathOf('/w/charts/lab-ops/Chart.yaml', nested)).toBe('lab/Chart.yaml');
  });

  it('does not take a sibling with the same prefix for a child, and leaves a file outside every folder absolute', () => {
    expect(relativePathOf('/w/charts-old/x.yaml', two)).toBe('/w/charts-old/x.yaml');
    expect(relativePathOf('/elsewhere/x.yaml', one)).toBe('/elsewhere/x.yaml');
    expect(relativePathOf('/elsewhere/x.yaml', [])).toBe('/elsewhere/x.yaml');
  });
});

describe('what a node stands for', () => {
  it('names the object of each kind of node', () => {
    expect(namedOf(crewNode)).toEqual({ kind: 'Crew', name: 'lab-ops', namespace: 'team-a' });
    expect(namedOf({ kind: 'namespace', group: { namespace: 'team-a' } } as never)).toEqual({ kind: 'Namespace', name: 'team-a' });
    expect(namedOf(memberNode({ kind: 'Agent', name: 'triage', namespace: 'team-a' }))).toEqual({ kind: 'Agent', name: 'triage', namespace: 'team-a' });
    expect(namedOf(memberNode({ kind: 'Model', name: 'big', namespace: '' }))).toEqual({ kind: 'Model', name: 'big', namespace: undefined });
    expect(namedOf(memberNode())).toBeUndefined();
    expect(namedOf({ kind: 'member', crew, view: { scenario: { name: 'pods' } } } as never)).toEqual({ kind: 'Scenario', name: 'pods', namespace: 'team-a' });
    expect(namedOf({ kind: 'member', crew, view: { tool: { info: { name: 'pods_list' } } } } as never)).toEqual({ kind: 'Tool', name: 'pods_list' });
    expect(namedOf(sourceNode())).toEqual({ kind: 'Crew', name: 'lab-ops' });
    expect(namedOf({ kind: 'source', entry: { ...entry(), crewName: undefined } })).toBeUndefined();
    expect(namedOf({ kind: 'deployment', entry: entry(), deployment } as never)).toEqual({ kind: 'Crew', name: 'lab-ops', namespace: 'team-a' });
    expect(namedOf({ kind: 'resource', entry: entry(), deployment, drift: { kind: 'Agent', name: 'triage' } } as never)).toEqual({ kind: 'Agent', name: 'triage', namespace: 'team-a' });
    expect(namedOf({ kind: 'run', entry: entry(), deployment, run: { kind: 'CrewFitness', name: 'r1', namespace: 'team-a' } } as never)).toEqual({ kind: 'CrewFitness', name: 'r1', namespace: 'team-a' });
    expect(namedOf(declared({ object: { kind: 'Agent', name: 'triage' } }))).toEqual({ kind: 'Agent', name: 'triage' });
    expect(namedOf(declared())).toEqual({ name: 'triage' });
    expect(namedOf({ kind: 'file', entry: entry(), path: '/w/a/values.yaml', folder: false })).toEqual({ kind: 'File', name: 'values.yaml' });
    expect(namedOf({ kind: 'file', entry: entry(), path: '/w/a/templates', folder: true })).toEqual({ kind: 'Folder', name: 'templates' });
    expect(fileOf({ kind: 'file', entry: entry(), path: '/w/a/values.yaml', folder: false })).toEqual({ fsPath: '/w/a/values.yaml', folder: false });
  });

  it('names nothing for a message, a section, or no node', () => {
    expect(namedOf(undefined)).toBeUndefined();
    expect(namedOf({ kind: 'message', text: 'x' } as never)).toBeUndefined();
    expect(namedOf({ kind: 'section', crew, section: 'agents' } as never)).toBeUndefined();
  });

  it('writes the name alone, and with its namespace', () => {
    expect(nameText({ name: 'a', namespace: 'n' })).toBe('a');
    expect(namespacedNameText({ name: 'a', namespace: 'n' })).toBe('n/a');
    expect(namespacedNameText({ name: 'a' })).toBe('a');
  });

  it('finds the folder of a source and the file and line of a declared item, and nothing else', () => {
    expect(fileOf(sourceNode())).toEqual({ fsPath: '/w/charts/lab-ops', folder: true });
    expect(fileOf(declared())).toEqual({ fsPath: '/w/charts/lab-ops/templates/agents.yaml', folder: false, line: 4 });
    expect(fileOf(declared({ file: undefined }))).toBeUndefined();
    expect(fileOf(crewNode)).toBeUndefined();
    expect(fileOf(undefined)).toBeUndefined();
  });

  it('takes Chart.yaml as the main file of a chart and the Crew file of a bundle', () => {
    expect(mainFileOf(entry('helm'))).toBe('/w/charts/lab-ops/Chart.yaml');
    expect(mainFileOf(entry('bundle'))).toBe('/w/charts/lab-ops/templates/crew.yaml');
    expect(mainFileOf({ source: { kind: 'bundle', root: '/r' } })).toBeUndefined();
  });
});

describe('the dashboard address of an object', () => {
  it('gives each kind its page, with the namespace in the query', () => {
    expect(dashboardUrlOf('http://d/dashboard/', { kind: 'Crew', name: 'lab ops', namespace: 'team-a' })).toBe('http://d/dashboard/crews/lab%20ops?namespace=team-a');
    expect(dashboardUrlOf('http://d', { kind: 'Agent', name: 'triage', namespace: 'team-a' })).toBe('http://d/agents/triage?namespace=team-a');
    expect(dashboardUrlOf('http://d', { kind: 'PromptModule', name: 'p' })).toBe('http://d/promptmodules/p');
    expect(dashboardUrlOf('http://d', { kind: 'CrewFitnessSuite', name: 's', namespace: 'n' })).toBe('http://d/fitness');
  });

  it('gives nothing without a setting, a kind, or a page for the kind', () => {
    expect(dashboardUrlOf('', { kind: 'Crew', name: 'a' })).toBeUndefined();
    expect(dashboardUrlOf('http://d', { name: 'a' })).toBeUndefined();
    expect(dashboardUrlOf('http://d', { kind: 'Skill', name: 'a' })).toBeUndefined();
  });
});

describe('the standard menu commands', () => {
  let deps: ContextDeps & { yamls: unknown[] };
  let commands: ContextCommands;
  beforeEach(() => {
    resetFake();
    recorded.workspaceFolders = [
      { name: 'app', uri: Uri.file('/w/app') },
      { name: 'charts', uri: Uri.file('/w/charts') },
    ];
    const yamls: unknown[] = [];
    deps = {
      yamls,
      entryForCrew: () => entry(),
      located: async () => [
        { manifest: { kind: 'Crew', metadata: { name: 'lab-ops' } }, file: '/w/charts/lab-ops/templates/crew.yaml', line: 2 },
        { manifest: { kind: 'Agent', metadata: { name: 'triage' } }, file: '/w/charts/lab-ops/templates/agents.yaml', line: 9 },
        { manifest: { kind: 'Skill', metadata: { name: 'nofile' } }, line: 0 },
      ],
      yamlOf: async (ref: unknown) => {
        yamls.push(ref);
        return '# Normalized.\n# More.\nkind: Agent\nmetadata:\n  name: triage\n';
      },
      dashboardBase: () => 'http://d/dashboard',
    } as never;
    commands = new ContextCommands(deps);
  });

  it('copies names', async () => {
    await commands.copyName(crewNode);
    await commands.copyNamespacedName(crewNode);
    await commands.copyName(memberNode());
    await commands.copyNamespacedName(undefined);
    expect(recorded.clipboard).toEqual(['lab-ops', 'team-a/lab-ops']);
  });

  it('copies the live YAML without its note lines, and nothing for an object without a kind', async () => {
    await commands.copyYaml(memberNode({ kind: 'Agent', name: 'triage', namespace: 'team-a' }));
    expect(recorded.clipboard).toEqual(['kind: Agent\nmetadata:\n  name: triage\n']);
    expect(deps.yamls).toEqual([{ kind: 'Agent', name: 'triage', namespace: 'team-a' }]);
    await commands.copyYaml(declared());
    await commands.copyYaml({ kind: 'namespace', group: { namespace: 'n' } } as never);
    expect(deps.yamls).toHaveLength(2);
  });

  it('asks the cluster for a cluster-scoped object with an empty namespace', async () => {
    await commands.copyYaml(memberNode({ kind: 'Model', name: 'big', namespace: '' }));
    expect(deps.yamls).toEqual([{ kind: 'Model', name: 'big', namespace: '' }]);
  });

  it('copies the absolute path, and the relative one with the folder name in a multi-root workspace', async () => {
    await commands.copyPath(sourceNode());
    await commands.copyRelativePath(sourceNode());
    await commands.copyPath(declared());
    await commands.copyRelativePath(declared());
    expect(recorded.clipboard).toEqual([
      '/w/charts/lab-ops',
      'charts/lab-ops',
      '/w/charts/lab-ops/templates/agents.yaml',
      'charts/lab-ops/templates/agents.yaml',
    ]);
  });

  it('copies the relative path of a single-root workspace without the folder name', async () => {
    recorded.workspaceFolders = [{ name: 'w', uri: Uri.file('/w') }];
    await commands.copyRelativePath(sourceNode());
    expect(recorded.clipboard).toEqual(['charts/lab-ops']);
    expect(workspaceRoots()).toEqual([{ name: 'w', fsPath: '/w' }]);
    recorded.workspaceFolders = undefined;
    expect(workspaceRoots()).toEqual([]);
  });

  it('reveals in the Explorer view and the operating system with the editor\'s own commands', async () => {
    await commands.revealInExplorerView(sourceNode());
    await commands.revealInOS(declared());
    expect(recorded.executed.map((e) => [e.id, (e.args[0] as Uri).fsPath])).toEqual([
      ['revealInExplorer', '/w/charts/lab-ops'],
      ['revealFileInOS', '/w/charts/lab-ops/templates/agents.yaml'],
    ]);
  });

  it('reveals the source of a deployed crew and of one of its objects', async () => {
    await commands.revealInExplorerView(crewNode);
    await commands.revealInOS(memberNode({ kind: 'Agent', name: 'triage', namespace: 'team-a' }));
    expect(recorded.executed.map((e) => (e.args[0] as Uri).fsPath)).toEqual(['/w/charts/lab-ops/templates/crew.yaml', '/w/charts/lab-ops/templates/agents.yaml']);
  });

  it('says so when no open source holds the item', async () => {
    deps.entryForCrew = () => undefined;
    await commands.revealInOS(crewNode);
    await commands.openSourceFile(memberNode({ kind: 'Agent', name: 'triage', namespace: 'team-a' }));
    await commands.openInTerminal({ kind: 'message', text: 'x' } as never);
    expect(recorded.executed).toEqual([]);
    expect(recorded.info[0]).toContain('No source file for lab-ops');
    expect(recorded.info[1]).toContain('No source file for triage');
    expect(recorded.info[2]).toContain('No source file for this item');
  });

  it('says so when the source does not hold the object, or holds it with no file', async () => {
    await commands.openSourceFile(memberNode({ kind: 'Skill', name: 'nofile', namespace: 'team-a' }));
    await commands.openSourceFile(memberNode({ kind: 'Agent', name: 'other', namespace: 'team-a' }));
    expect(recorded.executed).toEqual([]);
    expect(recorded.info).toHaveLength(2);
  });

  it('opens a terminal in the folder of a source, or beside a file', async () => {
    await commands.openInTerminal(sourceNode());
    await commands.openInTerminal(declared());
    expect(recorded.executed.map((e) => [e.id, (e.args[0] as Uri).fsPath])).toEqual([
      ['openInTerminal', '/w/charts/lab-ops'],
      ['openInTerminal', '/w/charts/lab-ops/templates'],
    ]);
  });

  it('opens a source at its main file, and a declared item or a deployed object at its line', async () => {
    await commands.openChartFile(sourceNode('helm'));
    await commands.openSourceFile(sourceNode('bundle'));
    await commands.openSourceFile(declared());
    await commands.openSourceFile(memberNode({ kind: 'Agent', name: 'triage', namespace: 'team-a' }));
    expect(recorded.executed.map((e) => [e.id, (e.args[0] as Uri).fsPath, (e.args[1] as { selection?: { startLine: number } } | undefined)?.selection?.startLine])).toEqual([
      ['vscode.open', '/w/charts/lab-ops/Chart.yaml', undefined],
      ['vscode.open', '/w/charts/lab-ops/templates/crew.yaml', undefined],
      ['vscode.open', '/w/charts/lab-ops/templates/agents.yaml', 4],
      ['vscode.open', '/w/charts/lab-ops/templates/agents.yaml', 9],
    ]);
  });

  it('opens Chart.yaml only for a chart', async () => {
    await commands.openChartFile(sourceNode('bundle'));
    await commands.openChartFile(crewNode);
    await commands.openChartFile(undefined);
    expect(recorded.executed).toEqual([]);
  });

  it('opens the object in the dashboard, and the Fitness page for a Fitness group', async () => {
    await commands.openInDashboard(memberNode({ kind: 'Agent', name: 'triage', namespace: 'team-a' }));
    await commands.openInDashboard({ kind: 'fitness', entry: entry(), deployment } as never);
    await commands.openInDashboard(memberNode({ kind: 'Skill', name: 's', namespace: 'team-a' }));
    expect(recorded.opened).toEqual(['http://d/dashboard/agents/triage?namespace=team-a', 'http://d/dashboard/fitness']);
  });

  it('registers one command per action, each guarded', async () => {
    const ran: string[] = [];
    const disposables = registerContextCommands(commands, async (action) => {
      ran.push('guarded');
      await action();
    });
    expect(disposables).toHaveLength(13);
    const copy = recorded.commands.get('crewforge.copyName') as (node: AnyNode) => Promise<void>;
    await copy(crewNode);
    expect(ran).toEqual(['guarded']);
    expect(recorded.clipboard).toEqual(['lab-ops']);
    for (const id of [...recorded.commands.keys()].filter((k) => k.startsWith('crewforge.'))) await (recorded.commands.get(id) as (n: AnyNode) => Promise<void>)(crewNode);
    expect(ran).toHaveLength(14);
  });
});
