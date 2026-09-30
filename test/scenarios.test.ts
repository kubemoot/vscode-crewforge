import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FitnessCommands, scriptFitness, singleScenario } from '../src/fitness/commands';
import { registerScenarioCommands, scenarioOf, entryOf } from '../src/fitness/scenarioCommands';
import { adlScript, deletePlan, withRenamedName, folderLayout, newScenario, proseScript, scenarioFolder, ScenarioFiles, suiteFile, withoutScript, withRenamedScript } from '../src/fitness/scenarios';
import type { KubeClient } from '../src/k8s/request';
import type { ScenarioRef } from '../src/source/declared';
import { parseManifests, type Manifest } from '../src/source/manifests';
import { listScripts, readText, readYamlFiles } from '../src/source/nodeDeps';
import { SourceService, type SourceEntry } from '../src/source/service';
import type { DeploymentNode, SourceNode } from '../src/views/sourceTree';
import { FakeCluster } from './fakeCluster';
import { recorded, resetFake } from './vscodeFake';

const SCAFFOLD = path.join(__dirname, 'fixtures', 'kmctl', 'test');
const RENDERED = fs.readFileSync(path.join(__dirname, 'fixtures', 'kmctl', 'rendered.yaml'), 'utf8');
let work: string;

beforeEach(() => {
  resetFake();
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-scenarios-'));
});
afterEach(() => fs.rmSync(work, { recursive: true, force: true }));

function copyScaffold(): string {
  const root = path.join(work, 'test');
  fs.cpSync(SCAFFOLD, root, { recursive: true });
  return root;
}

const entryAt = (root: string, kind: 'helm' | 'bundle' = 'helm'): SourceEntry => ({ source: { kind, root, label: path.basename(root) }, identity: { id: 'local:test' }, crewName: 'test' });

describe('scenario templates', () => {
  it('write ADL and prose in the shape of the existing scenarios', () => {
    expect(adlScript('smoke')).toMatch(/^DESCRIPTION smoke: .*\nDEFINE CONST QUESTION AS .*\n[\s\S]*ASSERT\(DEFER synthesis REFLECTS /);
    expect(proseScript('smoke')).toMatch(/^# smoke: [\s\S]*- synthesis is non-empty\n\n```reflects\n[\s\S]*```\n$/);
  });

  it('write a one-scenario suite that parses, like the kmctl starter suite', () => {
    for (const form of ['ADL', 'prose'] as const) {
      const [suite] = parseManifests(suiteFile('test', 'smoke', form)) as (Manifest & { spec: { crewRef: string; iterations: number; scripts: { testRef: string; testContent: string }[] } })[];
      expect(suite).toMatchObject({ kind: 'CrewFitnessSuite', metadata: { name: 'test-smoke', labels: { 'kubemoot.ai/crew': 'test' } }, spec: { crewRef: 'test', iterations: 1 } });
      expect(suite.spec.scripts[0].testRef).toBe('smoke');
      expect(suite.spec.scripts[0].testContent).toBe(form === 'ADL' ? adlScript('smoke') : proseScript('smoke'));
    }
  });
});

describe('where a scenario goes', () => {
  it('uses the fitness folder that exists, inside or beside the source, else a new one inside', async () => {
    const root = copyScaffold();
    expect(await scenarioFolder(entryAt(root))).toBe(path.join(root, 'fitness'));
    const bundle = path.join(work, 'b', 'crew');
    fs.mkdirSync(bundle, { recursive: true });
    expect(await scenarioFolder(entryAt(bundle, 'bundle'))).toBe(path.join(bundle, 'fitness'));
    fs.mkdirSync(path.join(work, 'b', 'fitness'));
    expect(await scenarioFolder(entryAt(bundle, 'bundle'))).toBe(path.join(work, 'b', 'fitness'));
  });

  it('follows the folder\'s layout: loose scripts, or YAML suites', async () => {
    const folder = path.join(work, 'fitness');
    expect(await folderLayout(folder)).toBe('yaml');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'README.md'), '#');
    expect(await folderLayout(folder)).toBe('yaml');
    fs.writeFileSync(path.join(folder, 'a.adl'), '');
    expect(await folderLayout(folder)).toBe('scripts');
    expect(newScenario(folder, 'scripts', 'test', 'x', 'ADL').file).toBe(path.join(folder, 'x.adl'));
    expect(newScenario(folder, 'scripts', 'test', 'x', 'prose').file).toBe(path.join(folder, 'x.md'));
    expect(newScenario(folder, 'yaml', 'test', 'x', 'prose').file).toBe(path.join(folder, 'x.yaml'));
  });
});

describe('editing suite scripts', () => {
  const suite = fs.readFileSync(path.join(SCAFFOLD, 'fitness', 'fitness.yaml'), 'utf8');

  it('removes one script and keeps the others', () => {
    const out = withoutScript(suite, 'general-knowledge');
    const [parsed] = parseManifests(out) as (Manifest & { spec: { scripts: { testRef: string }[] } })[];
    expect(parsed.spec.scripts.map((s) => s.testRef)).toEqual(['smoke-hello', 'honest-no-fabrication']);
    const last = withoutScript(suite, 'honest-no-fabrication');
    expect((parseManifests(last)[0] as unknown as { spec: { scripts: unknown[] } }).spec.scripts).toHaveLength(2);
    expect(withoutScript(suite, 'missing')).toBe(suite);
    const twoDocs = `${suite}---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\n`;
    expect(parseManifests(withoutScript(twoDocs, 'honest-no-fabrication')).map((m) => m.kind)).toEqual(['CrewFitnessSuite', 'ConfigMap']);
  });

  it('renames a script\'s testRef on its own line', () => {
    const out = withRenamedScript(suite, 'smoke-hello', 'hello');
    expect(out).toContain('    - testRef: hello\n');
    expect(out).toContain('DESCRIPTION Smoke test');
    expect(withRenamedScript(suite, 'missing', 'x')).toBe(suite);
    expect(withRenamedScript('testRef: "a.b"\n', 'a.b', 'c')).toBe('testRef: "c"\n');
  });

  it('renames an object named after its scenario', () => {
    expect(withRenamedName('metadata:\n  name: test-solo\nspec: {}\n', 'solo', 'one')).toBe('metadata:\n  name: test-one\nspec: {}\n');
    expect(withRenamedName('metadata:\n  name: "solo"\n', 'solo', 'one')).toBe('metadata:\n  name: "one"\n');
    expect(withRenamedName('metadata:\n  name: solo-x\n', 'solo', 'one')).toBe('metadata:\n  name: solo-x\n');
  });

  it('plans a deletion: a script file to the trash, a script out of a suite, or a refusal', () => {
    const file = '/f.yaml';
    expect(deletePlan({ kind: 'script-file', name: 'a', file: '/a.adl' }, '')).toEqual({ trash: true });
    expect(deletePlan({ kind: 'suite-script', name: 'smoke-hello', file }, suite)).toMatchObject({ trash: false });
    const one = suiteFile('test', 'x', 'ADL');
    expect(deletePlan({ kind: 'suite-script', name: 'x', file }, one)).toEqual({ trash: true });
    expect(deletePlan({ kind: 'fitness', name: 'x', file }, one)).toEqual({ trash: true });
    expect(deletePlan({ kind: 'fitness', name: 'x', file }, `${one}---\n${one}`)).toEqual({ refuse: '/f.yaml holds other objects too; remove x from it by hand.' });
    expect(deletePlan({ kind: 'fitness', name: 'x', file }, 'a: [')).toEqual({ refuse: '/f.yaml does not parse as YAML; fix it first.' });
  });
});

describe('ScenarioFiles', () => {
  it('adds a scenario in the folder\'s layout and opens it', async () => {
    const root = copyScaffold();
    const files = new ScenarioFiles();
    recorded.quickPicks.push((items: { label: string }[]) => items[1]);
    recorded.inputs.push('capital-city');
    const file = await files.add(entryAt(root));
    expect(file).toBe(path.join(root, 'fitness', 'capital-city.yaml'));
    expect(fs.readFileSync(file!, 'utf8')).toBe(suiteFile('test', 'capital-city', 'prose'));
    expect(recorded.executed.map((e) => e.id)).toEqual(['vscode.open']);
    recorded.quickPicks.push((items: { label: string }[]) => items[0]);
    recorded.inputs.push('capital-city');
    expect(await files.add(entryAt(root))).toBeUndefined();
    expect(recorded.errors[0]).toMatch(/capital-city\.yaml already exists/);
  });

  it('adds nothing when a question is dismissed or the name is invalid, or the source has no crew', async () => {
    const root = copyScaffold();
    const files = new ScenarioFiles();
    recorded.quickPicks.push(undefined);
    expect(await files.add(entryAt(root))).toBeUndefined();
    recorded.quickPicks.push((items: { label: string }[]) => items[0]);
    recorded.inputs.push('Not Valid');
    expect(await files.add(entryAt(root))).toBeUndefined();
    expect(await files.add({ ...entryAt(root), crewName: undefined })).toBeUndefined();
    expect(fs.readdirSync(path.join(root, 'fitness'))).toEqual(['fitness.yaml']);
  });

  it('renames a suite script in place, and a script file with its file', async () => {
    const root = copyScaffold();
    const files = new ScenarioFiles();
    const suiteFileAt = path.join(root, 'fitness', 'fitness.yaml');
    recorded.inputs.push('hello');
    await files.rename({ kind: 'suite-script', name: 'smoke-hello', owner: 'test-starter', file: suiteFileAt });
    expect(fs.readFileSync(suiteFileAt, 'utf8')).toContain('- testRef: hello\n');
    const script = path.join(root, 'fitness', 'weather.adl');
    fs.writeFileSync(script, adlScript('weather'));
    recorded.inputs.push('forecast');
    await files.rename({ kind: 'script-file', name: 'weather', file: script });
    expect(fs.existsSync(path.join(root, 'fitness', 'forecast.adl'))).toBe(true);
    const own = path.join(root, 'fitness', 'solo.yaml');
    fs.writeFileSync(own, 'apiVersion: kubemoot.ai/v1alpha1\nkind: CrewFitness\nmetadata:\n  name: test-solo\nspec:\n  crewRef: test\n  testRef: solo\n');
    recorded.inputs.push('single');
    await files.rename({ kind: 'fitness', name: 'solo', owner: 'test-solo', file: own });
    expect(fs.readFileSync(path.join(root, 'fitness', 'single.yaml'), 'utf8')).toContain('testRef: single');
    expect(fs.readFileSync(path.join(root, 'fitness', 'single.yaml'), 'utf8')).toContain('name: test-single');
    const bare = path.join(root, 'fitness', 'probe.yaml');
    fs.writeFileSync(bare, 'apiVersion: kubemoot.ai/v1alpha1\nkind: CrewFitness\nmetadata:\n  name: probe\nspec:\n  crewRef: test\n');
    recorded.inputs.push('check');
    await files.rename({ kind: 'fitness', name: 'probe', owner: 'probe', file: bare });
    expect(fs.readFileSync(path.join(root, 'fitness', 'check.yaml'), 'utf8')).toContain('  name: check\n');
    const mineFile = path.join(root, 'fitness', 'mine.yaml');
    fs.writeFileSync(mineFile, suiteFile('test', 'mine', 'ADL'));
    recorded.inputs.push('yours');
    await files.rename({ kind: 'suite-script', name: 'mine', owner: 'test-mine', file: mineFile });
    const yours = fs.readFileSync(path.join(root, 'fitness', 'yours.yaml'), 'utf8');
    expect(yours).toContain('name: test-yours');
    expect(yours).toContain('- testRef: yours');
    fs.writeFileSync(path.join(root, 'fitness', 'taken.adl'), '');
    recorded.inputs.push('taken');
    await files.rename({ kind: 'script-file', name: 'forecast', file: path.join(root, 'fitness', 'forecast.adl') });
    expect(recorded.errors.at(-1)).toMatch(/taken\.adl already exists/);
    recorded.inputs.push('x');
    recorded.applyEditResult = false;
    await expect(files.rename({ kind: 'script-file', name: 'forecast', file: path.join(root, 'fitness', 'forecast.adl') })).rejects.toThrow('could not move');
    recorded.inputs.push('forecast', undefined);
    await files.rename({ kind: 'script-file', name: 'forecast', file: path.join(root, 'fitness', 'forecast.adl') });
    await files.rename({ kind: 'script-file', name: 'forecast', file: path.join(root, 'fitness', 'forecast.adl') });
    expect(fs.existsSync(path.join(root, 'fitness', 'forecast.adl'))).toBe(true);
  });

  it('refuses to rename or delete a scenario whose file has unsaved changes', async () => {
    const file = path.join(copyScaffold(), 'fitness', 'fitness.yaml');
    recorded.textDocuments = [{ uri: { fsPath: file } as never, getText: () => '', isDirty: true }];
    const files = new ScenarioFiles();
    const scenario: ScenarioRef = { kind: 'suite-script', name: 'smoke-hello', file };
    await files.rename(scenario);
    await files.delete(scenario);
    expect(recorded.errors).toHaveLength(2);
    expect(recorded.errors[0]).toMatch(/save or close .*fitness\.yaml before renaming the scenario/);
  });

  it('deletes after a confirmation: a script out of its suite, a file to the trash, and refuses a mixed file', async () => {
    const root = copyScaffold();
    const files = new ScenarioFiles();
    const suite = path.join(root, 'fitness', 'fitness.yaml');
    await files.delete({ kind: 'suite-script', name: 'smoke-hello', file: suite });
    expect(fs.readFileSync(suite, 'utf8')).toContain('smoke-hello');
    recorded.warningAnswers.push('Delete');
    await files.delete({ kind: 'suite-script', name: 'smoke-hello', file: suite });
    expect(fs.readFileSync(suite, 'utf8')).not.toContain('smoke-hello');
    const script = path.join(root, 'fitness', 'a.adl');
    fs.writeFileSync(script, '');
    recorded.warningAnswers.push('Delete');
    await files.delete({ kind: 'script-file', name: 'a', file: script });
    expect(recorded.trashed).toEqual([`${script} (trash)`]);
    const mixed = path.join(root, 'fitness', 'mixed.yaml');
    fs.writeFileSync(mixed, `${suiteFile('test', 'm', 'ADL')}---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\n`);
    await files.delete({ kind: 'suite-script', name: 'm', file: mixed });
    expect(recorded.errors).toEqual([`CrewForge: ${mixed} holds other objects too; remove m from it by hand.`]);
  });
});

describe('Run Scenario', () => {
  const service = () =>
    new SourceService({
      exec: async (cmd) => (cmd === 'helm' ? { code: 0, stdout: RENDERED, stderr: '' } : { code: 128, stdout: '', stderr: '' }),
      readText,
      readYamlFiles,
      listFiles: async () => ({ charts: [], yamls: [] }),
      listScripts,
    });

  it('cuts a suite down to one script, keeps a CrewFitness as it is, and wraps a script file; all marked single', () => {
    const owner = parseManifests(fs.readFileSync(path.join(SCAFFOLD, 'fitness', 'fitness.yaml'), 'utf8'))[0];
    const one = singleScenario(owner, { kind: 'suite-script', name: 'general-knowledge', file: '/f' }) as Manifest & { spec: { iterations: number; scripts: { testRef: string }[] } };
    expect(one.metadata.name).toBe('test-starter-general-knowledge');
    expect(one.metadata.annotations).toEqual({ 'crewforge.kubemoot.ai/single-scenario': 'true' });
    expect([one.spec.iterations, one.spec.scripts.map((s) => s.testRef)]).toEqual([1, ['general-knowledge']]);
    expect(singleScenario(owner, { kind: 'suite-script', name: 'missing', file: '/f' })).toBeUndefined();
    const fitness: Manifest = { apiVersion: 'kubemoot.ai/v1alpha1', kind: 'CrewFitness', metadata: { name: 'f' }, spec: {} };
    expect(singleScenario(fitness, { kind: 'fitness', name: 'f', file: '/f' })?.metadata.annotations).toEqual({ 'crewforge.kubemoot.ai/single-scenario': 'true' });
    expect(scriptFitness('test', 'weather', 'ASSERT(x)')).toMatchObject({ kind: 'CrewFitness', metadata: { name: 'test-weather' }, spec: { crewRef: 'test', testRef: 'weather', testContent: 'ASSERT(x)' } });
  });

  it('starts one scenario against the dev deployment, and refuses while a run of the crew is going', async () => {
    const root = copyScaffold();
    fs.writeFileSync(path.join(root, 'fitness', 'weather.adl'), 'ASSERT(x)');
    const cluster = new FakeCluster();
    const connection = () => ({ source: '/k', context: 'lab', client: cluster as unknown as KubeClient });
    const commands = new FitnessCommands(service(), () => undefined, connection);
    const node: DeploymentNode = { kind: 'deployment', entry: entryAt(root), deployment: { namespace: 'crew-test', crew: { name: 'test', namespace: 'crew-test', ready: true, phase: 'Ready' }, channel: 'helm', linked: true } };
    const name = await commands.runScenario(node, { kind: 'suite-script', name: 'smoke-hello', owner: 'test-starter', file: path.join(root, 'fitness', 'fitness.yaml') }, readText);
    expect(name).toBe('test-starter-smoke-hello');
    const posted = cluster.calls.filter((c) => c.method === 'POST').map((c) => c.body as Manifest);
    expect(posted[0].metadata.name).toMatch(/^test-starter-smoke-hello-\d{8}-\d{6}$/);
    expect(await commands.runScenario(node, { kind: 'script-file', name: 'weather', file: path.join(root, 'fitness', 'weather.adl') }, readText)).toBeUndefined();
    expect(recorded.info.at(-1)).toMatch(/^A fitness run of test is in progress/);
    cluster.objects.at(-1)!.status = { phase: 'Completed' };
    expect(await commands.runScenario(node, { kind: 'script-file', name: 'weather', file: path.join(root, 'fitness', 'weather.adl') }, readText)).toBe('test-weather');
    cluster.objects.at(-1)!.status = { phase: 'Completed' };
    expect(await commands.runScenario(node, { kind: 'suite-script', name: 'gone', owner: 'nobody', file: '/x' }, readText)).toBeUndefined();
    expect(recorded.errors.at(-1)).toBe('CrewForge: test no longer defines the scenario gone.');
  });

  it('lists loose scripts in the source\'s fitness folders as scenarios', async () => {
    const root = copyScaffold();
    fs.writeFileSync(path.join(root, 'fitness', 'weather.adl'), '');
    fs.writeFileSync(path.join(root, 'fitness', 'prose.md'), '');
    fs.writeFileSync(path.join(root, 'fitness', 'README.md'), '');
    const [, , , , fitness] = (await service().declarations({ ...entryAt(root), rendered: undefined })).sections;
    expect(fitness.items.map((i) => [i.label, i.description, i.scenario?.kind])).toEqual([
      ['smoke-hello', 'suite test-starter', 'suite-script'],
      ['general-knowledge', 'suite test-starter', 'suite-script'],
      ['honest-no-fabrication', 'suite test-starter', 'suite-script'],
      ['prose', 'prose script', 'script-file'],
      ['weather', 'ADL script', 'script-file'],
    ]);
    expect(await listScripts(path.join(work, 'missing'))).toEqual([]);
    const withoutScripts = new SourceService({ exec: async () => ({ code: 0, stdout: '', stderr: '' }), readText, readYamlFiles, listFiles: async () => ({ charts: [], yamls: [] }) });
    expect(await withoutScripts.scripts(entryAt(root))).toEqual([]);
  });
});

describe('the scenario commands', () => {
  const scenario: ScenarioRef = { kind: 'script-file', name: 'a', file: '/w/fitness/a.adl' };
  const entry = entryAt('/w/test');
  const declared: SourceNode = { kind: 'declared', entry, item: { label: 'a', tooltip: '', icon: 'beaker', line: 0, scenario } };

  it('finds the scenario and source of a node', () => {
    expect(scenarioOf(declared)).toBe(scenario);
    expect(scenarioOf({ kind: 'message', text: 'x' })).toBeUndefined();
    expect(entryOf(declared)).toBe(entry);
    expect(entryOf({ kind: 'message', text: 'x' })).toBeUndefined();
    expect(entryOf()).toBeUndefined();
  });

  it('adds, renames, deletes, and runs from the Fitness nodes, reloading after a file change', async () => {
    const files = { add: vi.fn(async () => '/w/fitness/b.adl' as string | undefined), rename: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) };
    const fitness = { runScenario: vi.fn(async () => 'run') };
    const deployment: DeploymentNode = { kind: 'deployment', entry, deployment: { namespace: 'n', crew: { name: 'test', namespace: 'n', ready: true, phase: 'Ready' }, channel: 'helm', linked: true } };
    const devDeployment = vi.fn(async (): Promise<DeploymentNode | undefined> => deployment);
    const reload = vi.fn(async () => []);
    registerScenarioCommands({ files: files as never, fitness, devDeployment, readText: async () => '', reload, guard: async (a) => a() });
    const run = (id: string, node?: SourceNode) => recorded.commands.get(id)!(node) as Promise<void>;
    await run('crewforge.addScenario', { kind: 'fitness', entry, deployment: deployment.deployment });
    files.add.mockResolvedValueOnce(undefined);
    await run('crewforge.addScenario', { kind: 'declSection', entry, section: 'fitness', items: [] });
    await run('crewforge.addScenario', { kind: 'message', text: 'x' });
    await run('crewforge.renameScenario', declared);
    await run('crewforge.deleteScenario', declared);
    await run('crewforge.deleteScenario', { kind: 'message', text: 'x' });
    expect(reload).toHaveBeenCalledTimes(3);
    await run('crewforge.runScenario', declared);
    expect(fitness.runScenario).toHaveBeenCalledWith(deployment, scenario, expect.any(Function));
    devDeployment.mockResolvedValueOnce(undefined);
    await run('crewforge.runScenario', declared);
    await run('crewforge.runScenario', { kind: 'message', text: 'x' });
    expect(fitness.runScenario).toHaveBeenCalledTimes(1);
  });
});
