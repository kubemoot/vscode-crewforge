import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crewOf, parseManifests, type Manifest } from '../src/source/manifests';
import { crewYamlFiles, renameCrewFiles, renameCrewText } from '../src/source/rename';
import type { SourceEntry } from '../src/source/service';
import { SourceActions } from '../src/source/sourceActions';
import type { DeploymentNode, SourceNode } from '../src/views/sourceTree';
import { recorded, resetFake } from './vscodeFake';

const SCAFFOLD = path.join(__dirname, 'fixtures', 'kmctl', 'test');
let work: string;

beforeEach(() => {
  resetFake();
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-actions-'));
});
afterEach(() => fs.rmSync(work, { recursive: true, force: true }));

/** A copy of the kmctl scaffold named `test` in a scratch folder. */
function copyScaffold(): string {
  const root = path.join(work, 'test');
  fs.cpSync(SCAFFOLD, root, { recursive: true });
  return root;
}

function objectsIn(root: string): Manifest[] {
  const files = ['agents', 'crew', 'models', 'promptmodules'].map((n) => path.join(root, 'templates', `${n}.yaml`));
  return [...files, path.join(root, 'fitness', 'fitness.yaml')].flatMap((f) => parseManifests(fs.readFileSync(f, 'utf8')));
}

describe('renameCrewText', () => {
  it('renames the values of name and reference keys, and names built on the crew', () => {
    const text = [
      'name: test',
      '  crewRef: "test"',
      "    kubemoot.ai/crew: 'test' # the crew",
      '  promptRefs: [test-tooler-1-system, test, shared]',
      '  coordinatorRef: test-coordinator',
      '  promptRefs:',
      '    - test-rules',
      '    # a comment',
      '',
      '    - shared',
      '  other:',
      '    - test-not-a-ref',
      '  - name: test-coordinator',
    ].join('\n');
    expect(renameCrewText(text, 'test', 'lab')).toBe(
      [
        'name: lab',
        '  crewRef: "lab"',
        "    kubemoot.ai/crew: 'lab' # the crew",
        '  promptRefs: [lab-tooler-1-system, lab, shared]',
        '  coordinatorRef: lab-coordinator',
        '  promptRefs:',
        '    - lab-rules',
        '    # a comment',
        '',
        '    - shared',
        '  other:',
        '    - test-not-a-ref',
        '  - name: lab-coordinator',
      ].join('\n'),
    );
  });

  it('leaves other keys, prose, longer names, and block scalar text alone', () => {
    const text = [
      'description: The test crew answers tests',
      'namespace: test',
      'image: test-server:1',
      'name: testing',
      'name: mytest-a',
      'name: "test\'',
      'content: |',
      '  name: test',
      '',
      '  DEFINE DOMAIN test-tooler-1',
      'testContent: >-',
      '  crewRef: test',
      'name: test',
    ].join('\n');
    const out = renameCrewText(text, 'test', 'lab').split('\n');
    expect(out.slice(0, -1)).toEqual(text.split('\n').slice(0, -1));
    expect(out.at(-1)).toBe('name: lab');
  });

  it('keeps CRLF line endings, and skips the text of a list item block scalar', () => {
    expect(renameCrewText('name: test\r\ncrewRef: test-x\r\n', 'test', 'lab')).toBe('name: lab\r\ncrewRef: lab-x\r\n');
    const text = 'scripts:\n  - |\n    name: test\n  - name: test\n';
    expect(renameCrewText(text, 'test', 'lab')).toBe('scripts:\n  - |\n    name: test\n  - name: lab\n');
  });

  it('ends a list of names at the next key', () => {
    expect(renameCrewText('promptRefs:\n  - test-a\nextra: x\n  - test-b\n', 'test', 'lab')).toBe('promptRefs:\n  - lab-a\nextra: x\n  - test-b\n');
  });

  it('renames once when the new name starts with the old one, and treats special characters as text', () => {
    expect(renameCrewText('name: demo\nname: demo-coordinator\npromptRefs: [demo-x]', 'demo', 'demo-2')).toBe('name: demo-2\nname: demo-2-coordinator\npromptRefs: [demo-2-x]');
    expect(renameCrewText('name: a.b\nname: axb', 'a.b', 'c')).toBe('name: c\nname: axb');
  });

  it('reads quoted keys and list items with any whitespace, and only keys made of key characters', () => {
    expect(renameCrewText('"name": test\n\'crewRef\':\ttest-x\n"name\': test\n', 'test', 'lab')).toBe('"name": lab\n\'crewRef\':\tlab-x\n"name\': test\n');
    expect(renameCrewText('- \tname: test\n-name: test\n: test\nname : test\n', 'test', 'lab')).toBe('- \tname: lab\n-name: test\n: test\nname : test\n');
    expect(renameCrewText('Refs: test\nRef: test\nxRefs: test\nRefz: test\nx1Ref: test\n', 'test', 'lab')).toBe('Refs: lab\nRef: lab\nxRefs: lab\nRefz: test\nx1Ref: test\n');
    expect(renameCrewText('promptRefs:\n  -\ttest\n  -test\n', 'test', 'lab')).toBe('promptRefs:\n  - lab\n  -test\n');
  });

  it('leaves a line alone when a line separator falls inside its value, as a YAML key line ends there', () => {
    expect(renameCrewText('name: test\u2028x\nname: test \u2028\nname: test\n', 'test', 'lab')).toBe('name: test\u2028x\nname: test \u2028\nname: lab\n');
    expect(renameCrewText('promptRefs:\n  - test\u2028x\n', 'test', 'lab')).toBe('promptRefs:\n  - test\u2028x\n');
  });

  it('takes linear time on long lines that almost match', () => {
    const long = `${' '.repeat(50_000)}-${' '.repeat(50_000)}${'a'.repeat(50_000)}`;
    const started = Date.now();
    expect(renameCrewText(`${long}\n${'aRef'.repeat(30_000)}x: test`, 'test', 'lab')).toBe(`${long}\n${'aRef'.repeat(30_000)}x: test`);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('renameCrewFiles', () => {
  it('renames a kmctl scaffold consistently: every promptRef still resolves, and prose stays', async () => {
    const root = copyScaffold();
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'node_modules', 'x.yaml'), 'name: test\n');
    const changed = await renameCrewFiles(root, 'test', 'lab');
    expect(changed.map((f) => path.relative(root, f)).sort()).toEqual(['Chart.yaml', 'fitness/fitness.yaml', 'templates/agents.yaml', 'templates/crew.yaml', 'templates/models.yaml', 'templates/promptmodules.yaml']);
    const objects = objectsIn(root);
    expect(crewOf(objects)?.metadata.name).toBe('lab');
    const agents = objects.filter((o) => o.kind === 'Agent');
    expect(agents.map((a) => a.metadata.name)).toEqual(['lab-coordinator', 'lab-tooler-1', 'lab-tooler-2']);
    const modules = new Set(objects.filter((o) => o.kind === 'PromptModule').map((m) => m.metadata.name));
    for (const agent of agents) for (const ref of (agent.spec as { promptRefs: string[] }).promptRefs) expect(modules.has(ref)).toBe(true);
    expect(objects.every((o) => !o.metadata.labels || o.metadata.labels['kubemoot.ai/crew'] === 'lab')).toBe(true);
    expect(objects.filter((o) => 'spec' in o && (o.spec as { crewRef?: string }).crewRef).every((o) => (o.spec as { crewRef: string }).crewRef === 'lab')).toBe(true);
    const chart = fs.readFileSync(path.join(root, 'Chart.yaml'), 'utf8');
    expect(chart).toContain('name: lab\n');
    expect(chart).toContain('The test Kubemoot crew');
    expect(fs.readFileSync(path.join(root, 'node_modules', 'x.yaml'), 'utf8')).toBe('name: test\n');
    expect(await renameCrewFiles(root, 'test', 'lab')).toEqual([]);
  });

  it('lists YAML at any depth, but not in dependencies, git, or subcharts', async () => {
    const root = copyScaffold();
    fs.mkdirSync(path.join(root, 'templates', 'charts'));
    fs.writeFileSync(path.join(root, 'templates', 'charts', 'kept.yaml'), '');
    for (const skip of ['.git', 'charts']) {
      fs.mkdirSync(path.join(root, skip));
      fs.writeFileSync(path.join(root, skip, 'a.yaml'), '');
    }
    const files = (await crewYamlFiles(root)).map((f) => path.relative(root, f));
    expect(files).toContain('templates/agents.yaml');
    expect(files).not.toContain('README.md');
    expect(files.some((f) => f.startsWith('.git') || f.startsWith('charts'))).toBe(false);
    expect(files).toContain('templates/charts/kept.yaml');
  });

  it('reports the files renamed before a failure', async () => {
    const root = copyScaffold();
    const locked = path.join(root, 'templates', 'promptmodules.yaml');
    fs.chmodSync(locked, 0o444);
    const changed: string[] = [];
    await expect(renameCrewFiles(root, 'test', 'lab', [path.join(work, 'missing')], changed)).rejects.toThrow();
    fs.chmodSync(locked, 0o644);
    expect(changed.map((f) => path.relative(root, f))).toEqual(['Chart.yaml', 'fitness/fitness.yaml', 'templates/agents.yaml', 'templates/crew.yaml', 'templates/models.yaml']);
  });
});

function entryAt(root: string, kind: 'helm' | 'bundle' = 'helm'): SourceEntry {
  return { source: { kind, root, label: path.basename(root) }, identity: { id: 'local:test' }, crewName: 'test' };
}

function deploymentAt(entry: SourceEntry, namespace: string): DeploymentNode {
  return { kind: 'deployment', entry, deployment: { namespace, crew: { name: 'test', namespace, ready: true, phase: 'Ready' }, channel: 'helm', linked: true } };
}

function actionsWith(deployments: (entry: SourceEntry) => DeploymentNode[]) {
  const removed: string[] = [];
  const sources = {
    known: [] as SourceEntry[],
    loadDeployments: vi.fn(async (entry: SourceEntry): Promise<SourceNode[]> => {
      const nodes = deployments(entry);
      return nodes.length ? nodes : [{ kind: 'message', text: 'Not deployed in dev', icon: 'circle-slash' }];
    }),
    reload: vi.fn(async () => []),
  };
  const deploy = { removeDeployment: vi.fn(async (node?: SourceNode) => void removed.push(node?.kind === 'deployment' ? node.deployment.namespace : 'none')) };
  return { actions: new SourceActions({ sources, deploy }), removed, sources };
}

describe('SourceActions.undeploy', () => {
  it('removes the only deployment, asks which of several, and says when there is none', async () => {
    const entry = entryAt('/w/test');
    let namespaces = ['crew-test'];
    const { actions, removed } = actionsWith((e) => namespaces.map((ns) => deploymentAt(e, ns)));
    await actions.undeploy({ kind: 'source', entry });
    namespaces = ['a', 'b'];
    recorded.quickPicks.push((items: { label: string }[]) => items[1]);
    await actions.undeploy({ kind: 'source', entry });
    recorded.quickPicks.push(undefined);
    await actions.undeploy({ kind: 'source', entry });
    await actions.undeploy(deploymentAt(entry, 'direct'));
    namespaces = [];
    await actions.undeploy({ kind: 'source', entry });
    await actions.undeploy({ kind: 'source', entry: { ...entry, crewName: undefined } });
    await actions.undeploy({ kind: 'message', text: 'x' });
    await actions.undeploy();
    expect(removed).toEqual(['crew-test', 'b', 'direct']);
    expect(recorded.info).toEqual(['test is not deployed in this context.', 'test is not deployed in this context.']);
  });
});

describe('SourceActions.deleteSource', () => {
  it('moves the folder to the trash after a confirmation that names it', async () => {
    const root = copyScaffold();
    const { actions, sources } = actionsWith(() => []);
    recorded.warningAnswers.push('Move to Trash');
    await actions.deleteSource({ kind: 'source', entry: entryAt(root) });
    expect(recorded.warnings).toEqual(['Delete the crew source test?']);
    expect(recorded.trashed).toEqual([`${root} (trash)`]);
    expect(fs.existsSync(root)).toBe(false);
    expect(sources.reload).toHaveBeenCalledTimes(1);
    expect(recorded.info).toEqual([`Moved ${root} to the trash.`]);
  });

  it('keeps the folder when the confirmation is dismissed, and ignores anything but a source', async () => {
    const root = copyScaffold();
    const { actions } = actionsWith(() => []);
    await actions.deleteSource({ kind: 'source', entry: entryAt(root) });
    await actions.deleteSource({ kind: 'message', text: 'x' });
    expect(fs.existsSync(root)).toBe(true);
    expect(recorded.trashed).toEqual([]);
  });

  it('refuses a workspace folder or a folder that holds another source', async () => {
    const root = copyScaffold();
    const { actions, sources } = actionsWith(() => []);
    recorded.workspaceFolders = [{ name: 'test', uri: { fsPath: root } as never }];
    await actions.deleteSource({ kind: 'source', entry: entryAt(root) });
    recorded.workspaceFolders = undefined;
    sources.known = [entryAt(path.join(root, 'nested'))];
    await actions.deleteSource({ kind: 'source', entry: entryAt(root) });
    expect(recorded.errors).toEqual([`CrewForge: ${root} is a workspace folder; remove it from the workspace instead of deleting it here.`, `CrewForge: ${root} holds another crew source, nested; delete that one first.`]);
    expect(fs.existsSync(root)).toBe(true);
  });

  it('names the fitness folder beside the source as staying', async () => {
    const root = copyScaffold();
    const { actions } = actionsWith(() => []);
    recorded.warningAnswers.push('Move to Trash');
    fs.mkdirSync(path.join(work, 'fitness'));
    await actions.deleteSource({ kind: 'source', entry: entryAt(root, 'bundle') });
    expect(recorded.warnings).toEqual(['Delete the crew source test?']);
    expect(fs.existsSync(path.join(work, 'fitness'))).toBe(true);
  });

  it('stops when a deployment is still there after undeploying, as when a removal is cancelled or Flux owns it', async () => {
    const root = copyScaffold();
    const { actions, removed } = actionsWith((e) => [deploymentAt(e, 'a'), deploymentAt(e, 'b')]);
    recorded.warningAnswers.push('Undeploy First');
    await actions.deleteSource({ kind: 'source', entry: entryAt(root) });
    expect(removed).toEqual(['a', 'b']);
    expect(recorded.info).toEqual(['test is still deployed in a, b, so nothing else was changed.']);
    expect(fs.existsSync(root)).toBe(true);
  });

  it('offers to undeploy a deployed crew first, and stops when that question is dismissed', async () => {
    const root = copyScaffold();
    const { actions, removed } = actionsWith((e) => [deploymentAt(e, 'a'), deploymentAt(e, 'b')]);
    await actions.deleteSource({ kind: 'source', entry: entryAt(root) });
    expect(recorded.warnings).toEqual(['This crew is deployed in a, b. Undeploy it before deleting its source?']);
    expect(fs.existsSync(root)).toBe(true);
    recorded.warningAnswers.push('Keep It Deployed', 'Move to Trash');
    await actions.deleteSource({ kind: 'source', entry: entryAt(root) });
    expect(removed).toEqual([]);
    expect(fs.existsSync(root)).toBe(false);
    const again = copyScaffold();
    const undeploying = actionsWith((e) => (undeploying.removed.length ? [] : [deploymentAt(e, 'a'), deploymentAt(e, 'b')]));
    recorded.warningAnswers.push('Undeploy First', 'Move to Trash');
    await undeploying.actions.deleteSource({ kind: 'source', entry: entryAt(again) });
    expect(undeploying.removed).toEqual(['a', 'b']);
    expect(fs.existsSync(again)).toBe(false);
  });
});

describe('SourceActions.rename', () => {
  it('renames the crew and its folder, reloads, and says to redeploy', async () => {
    const root = copyScaffold();
    const { actions, sources } = actionsWith(() => []);
    recorded.inputs.push('lab');
    await actions.rename({ kind: 'source', entry: entryAt(root) });
    const moved = path.join(work, 'lab');
    expect(fs.existsSync(moved)).toBe(true);
    expect(crewOf(objectsIn(moved))?.metadata.name).toBe('lab');
    expect(sources.reload).toHaveBeenCalledTimes(1);
    expect(recorded.info).toEqual([`Renamed crew test to lab in 6 files and its folder to ${moved}. Redeploy to deploy it as lab.`]);
  });

  it('keeps the folder when its name is not the crew name or the new name is taken', async () => {
    const root = copyScaffold();
    fs.mkdirSync(path.join(work, 'lab'));
    const { actions } = actionsWith(() => []);
    recorded.inputs.push(' lab ');
    await actions.rename({ kind: 'source', entry: entryAt(root) });
    expect(fs.existsSync(root)).toBe(true);
    expect(recorded.info[0]).toBe('Renamed crew test to lab in 6 files. Redeploy to deploy it as lab.');
  });

  it('renames a bundle and the fitness folder beside it', async () => {
    const bundle = path.join(work, 'demo', 'crew');
    fs.mkdirSync(path.join(work, 'demo', 'fitness'), { recursive: true });
    fs.mkdirSync(bundle);
    fs.writeFileSync(path.join(bundle, 'crew.yaml'), 'kind: Crew\nmetadata:\n  name: test\n');
    fs.writeFileSync(path.join(work, 'demo', 'fitness', 'suite.yaml'), 'spec:\n  crewRef: test\n');
    const { actions } = actionsWith(() => []);
    recorded.inputs.push('lab');
    await actions.rename({ kind: 'source', entry: entryAt(bundle, 'bundle') });
    expect(fs.readFileSync(path.join(work, 'demo', 'fitness', 'suite.yaml'), 'utf8')).toBe('spec:\n  crewRef: lab\n');
    expect(recorded.info[0]).toBe('Renamed crew test to lab in 2 files. Redeploy to deploy it as lab.');
    const lonely = path.join(work, 'solo');
    fs.mkdirSync(lonely);
    fs.writeFileSync(path.join(lonely, 'crew.yaml'), 'name: test\n');
    recorded.inputs.push('lab');
    await actions.rename({ kind: 'source', entry: entryAt(lonely, 'bundle') });
    expect(recorded.info[1]).toBe('Renamed crew test to lab in 1 file. Redeploy to deploy it as lab.');
  });

  it('refuses while a file of the crew is unsaved, and keeps a workspace folder in place', async () => {
    const root = copyScaffold();
    const { actions } = actionsWith(() => []);
    recorded.textDocuments = [{ uri: { fsPath: path.join(root, 'templates', 'crew.yaml') } as never, getText: () => '', isDirty: true }];
    await actions.rename({ kind: 'source', entry: entryAt(root) });
    expect(recorded.errors[0]).toMatch(/^CrewForge: save or close .*crew\.yaml before renaming the crew/);
    fs.mkdirSync(path.join(work, 'fitness'));
    recorded.textDocuments = [
      { uri: { fsPath: path.join(root, 'node_modules', 'x.yaml') } as never, getText: () => '', isDirty: true },
      { uri: { fsPath: path.join(work, 'fitness', 'suite.yaml') } as never, getText: () => '', isDirty: true },
    ];
    await actions.rename({ kind: 'source', entry: entryAt(root) });
    expect(recorded.errors[1]).toMatch(/^CrewForge: save or close .*fitness\/suite\.yaml before renaming/);
    recorded.textDocuments = [{ uri: { fsPath: path.join(root, 'node_modules', 'x.yaml') } as never, getText: () => '', isDirty: true }];
    recorded.workspaceFolders = [{ name: 'test', uri: { fsPath: root } as never }];
    recorded.inputs.push('lab');
    await actions.rename({ kind: 'source', entry: entryAt(root) });
    expect(fs.existsSync(root)).toBe(true);
    expect(recorded.info[0]).toBe('Renamed crew test to lab in 6 files. Redeploy to deploy it as lab.');
  });

  it('says what it renamed when the folder cannot move, and reloads anyway', async () => {
    const root = copyScaffold();
    const { actions, sources } = actionsWith(() => []);
    recorded.applyEditResult = false;
    recorded.inputs.push('lab');
    await actions.rename({ kind: 'source', entry: entryAt(root) });
    expect(recorded.errors[0]).toBe(`CrewForge: renaming test stopped after changing 6 files: could not move ${root} to ${path.join(work, 'lab')}. git checkout restores them.`);
    expect(sources.reload).toHaveBeenCalledTimes(1);
  });

  it('rejects the same or an invalid name, and does nothing when cancelled or for a source without a crew', async () => {
    const root = copyScaffold();
    const { actions } = actionsWith(() => []);
    for (const answer of ['test', 'Not Valid', undefined]) {
      recorded.inputs.push(answer);
      await actions.rename({ kind: 'source', entry: entryAt(root) });
    }
    await actions.rename({ kind: 'source', entry: { ...entryAt(root), crewName: undefined } });
    await actions.rename({ kind: 'message', text: 'x' });
    expect(recorded.info).toEqual([]);
    expect(crewOf(objectsIn(root))?.metadata.name).toBe('test');
  });

  it('offers to undeploy a deployed crew before renaming it', async () => {
    const root = copyScaffold();
    const { actions, removed } = actionsWith((e) => (removed.length ? [] : [deploymentAt(e, 'crew-test')]));
    recorded.inputs.push('lab');
    await actions.rename({ kind: 'source', entry: entryAt(root) });
    expect(recorded.warnings).toEqual(['test is deployed in crew-test. Undeploy it before renaming?']);
    expect(fs.existsSync(root)).toBe(true);
    recorded.inputs.push('lab');
    recorded.warningAnswers.push('Undeploy, Then Rename');
    await actions.rename({ kind: 'source', entry: entryAt(root) });
    expect(removed).toEqual(['crew-test']);
    expect(fs.existsSync(path.join(work, 'lab'))).toBe(true);
    const other = copyScaffold();
    recorded.inputs.push('ops');
    recorded.warningAnswers.push('Rename Only');
    await actions.rename({ kind: 'source', entry: entryAt(other) });
    expect(removed).toEqual(['crew-test']);
    expect(fs.existsSync(path.join(work, 'ops'))).toBe(true);
  });
});
