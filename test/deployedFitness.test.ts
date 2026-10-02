import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrewDetails } from '../src/crew/details';
import { LiveCrewActions } from '../src/deploy/liveCrew';
import { uniqueByName, readDeployedScenarios, scenariosDiffer, scenariosIn, scenariosSelector, scriptsOf, type DeployedScenario } from '../src/fitness/deployed';
import type { FitnessRun } from '../src/fitness/fitness';
import { chosenNodes, LiveFitness } from '../src/fitness/liveFitness';
import { crewPath } from '../src/k8s/paths';
import { isSourceNode } from '../src/extension';
import type { CrewSummary } from '../src/k8s/crews';
import type { KubeClient } from '../src/k8s/request';
import { CrewTreeProvider, type CrewNode } from '../src/views/crewTree';
import { fitnessRunView, memberItem, membersOf, scenarioView, sectionItem, type DetailNode } from '../src/views/crewDetailsTree';
import { FakeCluster, obj } from './fakeCluster';
import { SourceService, sourceTitle, type SourceEntry } from '../src/source/service';
import { recorded, resetFake } from './vscodeFake';

beforeEach(resetFake);

const SUITE = [
  'apiVersion: kubemoot.ai/v1alpha1',
  'kind: CrewFitnessSuite',
  'metadata:',
  '  name: test-starter',
  'spec:',
  '  crewRef: "test"',
  '  scripts:',
  '    - testRef: pods',
  '      testContent: |',
  '        DESCRIPTION pods',
  '    - testRef: broken',
  '    - testRef: deployment',
  '      testContent: |',
  '        DESCRIPTION deployment',
  '---',
  'apiVersion: kubemoot.ai/v1alpha1',
  'kind: CrewFitness',
  'metadata:',
  '  name: single',
  'spec:',
  '  testContent: DESCRIPTION single',
  '---',
  'apiVersion: kubemoot.ai/v1alpha1',
  'kind: CrewFitness',
  'metadata:',
  '  name: other-crew',
  'spec:',
  '  crewRef: other',
  '  testRef: x',
  '  testContent: DESCRIPTION x',
  '---',
  'apiVersion: v1',
  'kind: ConfigMap',
  'metadata:',
  '  name: unrelated',
].join('\n');

const configMap = (name: string, data: Record<string, string>, crew = 'test') =>
  ({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name, namespace: 'crew-test', labels: { 'kubemoot.ai/crew': crew, 'kubemoot.ai/fitness-kind': 'scenarios' } }, data }) as never;

const crew: CrewSummary = { name: 'test', namespace: 'crew-test', ready: true, phase: 'Ready' };

describe('the scenarios a crew carries', () => {
  it('reads suite scripts, CrewFitness scripts, and loose script keys, for this crew only, sorted, first of a name kept', () => {
    const scenarios = scenariosIn(
      [
        { metadata: { name: 'test-fitness' }, data: { 'fitness.yaml': SUITE, 'zeta.adl': 'DESCRIPTION zeta', 'notes.md': 'DESCRIPTION notes', 'README.md': 'not a scenario', 'readme.md': 'not one either', 'other.txt': 'skip', 'bad.yaml': 'a: [' } },
        { metadata: { name: 'more' }, data: { 'pods.adl': 'DESCRIPTION another pods' } },
        { metadata: { name: 'empty' } },
      ],
      'test',
    );
    expect(scenarios.map((s) => [s.name, s.from])).toEqual([
      ['deployment', 'test-fitness/fitness.yaml'],
      ['notes', 'test-fitness/notes.md'],
      ['pods', 'test-fitness/fitness.yaml'],
      ['single', 'test-fitness/fitness.yaml'],
      ['zeta', 'test-fitness/zeta.adl'],
    ]);
    expect(scenarios[2].content).toBe('DESCRIPTION pods\n');
  });

  it('names a CrewFitness by its testRef, else its own name', () => {
    expect(scriptsOf([obj('CrewFitness', 'f', 'ns', { testRef: 'ref', testContent: 'x' }), obj('CrewFitness', 'g', 'ns', { testContent: 'y' }), obj('CrewFitness', 'h', 'ns', {})], 'c')).toEqual([
      { name: 'ref', content: 'x' },
      { name: 'g', content: 'y' },
    ]);
  });

  it('lists them from the ConfigMaps labeled for the crew', async () => {
    const cluster = new FakeCluster().add(configMap('test-fitness', { 'a.adl': 'A' }), configMap('other-fitness', { 'b.adl': 'B' }, 'other'));
    expect(scenariosSelector('test')).toBe('kubemoot.ai/crew=test,kubemoot.ai/fitness-kind=scenarios');
    expect(await readDeployedScenarios(cluster as never, 'crew-test', 'test')).toEqual([{ name: 'a', content: 'A', from: 'test-fitness/a.adl' }]);
    expect(await readDeployedScenarios(new FakeCluster() as never, 'crew-test', 'test')).toEqual([]);
  });

  it('tells when a source differs from what is deployed', () => {
    const deployed: DeployedScenario[] = [{ name: 'a', content: 'A', from: 'x' }];
    expect(scenariosDiffer(deployed, [{ name: 'a', content: 'A' }])).toBe(false);
    expect(scenariosDiffer(deployed, [{ name: 'a', content: 'A2' }])).toBe(true);
    expect(scenariosDiffer(deployed, [{ name: 'b', content: 'A' }])).toBe(true);
    expect(scenariosDiffer(deployed, [])).toBe(true);
    expect(scenariosDiffer([], [])).toBe(false);
  });
});

/** Details with these scenarios and runs, the rest empty. */
function details(scenarios: DeployedScenario[], runs: ReturnType<typeof obj>[] = [], changed?: boolean): CrewDetails {
  const empty = { models: [], rag: [], mcp: [], policies: [], notifications: [], operator: [] };
  const fitness = runs.map((o) => ({ kind: o.kind, name: o.metadata.name, namespace: 'crew-test', object: o, reason: 'its crewRef names this crew' }));
  return { crew: obj('Crew', 'test', 'crew-test'), agents: [], skills: [], promptModules: [], mcpServers: [], tools: [], related: { ...empty, fitness }, problems: [], scenarios, scenariosChanged: changed } as CrewDetails;
}

const suiteRun = (name: string, phase: string, spec: Record<string, unknown> = {}) => {
  const o = obj('CrewFitnessSuite', name, 'crew-test', { crewRef: 'test', ...spec });
  (o as { status?: unknown }).status = { phase };
  return o;
};

describe('the live Fitness group', () => {
  const scenario: DeployedScenario = { name: 'pods', content: 'DESCRIPTION pods', from: 'test-fitness/fitness.yaml' };

  it('lists the deployed scenarios, then the runs, and says when the source changed them', () => {
    const d = details([scenario], [suiteRun('s-1', 'Running'), suiteRun('s-0', 'Succeeded')], true);
    const section = { kind: 'section', crew, section: 'fitness', details: d } as Extract<DetailNode, { kind: 'section' }>;
    const item = sectionItem(section);
    expect(item.description).toBe('1 scenario · 2 runs · changed since deploy');
    expect(item.contextValue).toBe('crewSection-fitness');
    expect(String(item.tooltip)).toContain('which runs from here always use');
    const members = membersOf(section) as Extract<DetailNode, { kind: 'member' }>[];
    expect(members.map((m) => memberItem(m).label)).toEqual(['pods', 's-1', 's-0']);
    const pods = memberItem(members[0]);
    expect(pods).toMatchObject({ contextValue: 'liveScenario', description: 'scenario', command: { command: 'crewforge.showDeployedScenario' } });
    expect(String(pods.tooltip)).toContain('Runs from here use this deployed script, not the workspace source.');
    expect(memberItem(members[1]).contextValue).toBe('liveObject-run-pause-stop');
    expect(memberItem(members[2]).contextValue).toBe('liveObject-run');
    const d1 = details([], [suiteRun('only', 'Succeeded')]);
    expect(sectionItem({ ...section, details: d1 }).description).toBe('0 scenarios · 1 run');
  });

  it('marks a paused suite resumable, and a single-scenario CrewFitness stoppable', () => {
    expect(memberItem({ kind: 'member', crew, view: fitnessRunView({ kind: 'CrewFitnessSuite', name: 'p', object: suiteRun('p', 'Paused', { suspend: true }), reason: 'r' }) }).contextValue).toBe('liveObject-run-resume-stop');
    const single = obj('CrewFitness', 'one', 'crew-test', { crewRef: 'test' });
    single.metadata.annotations = { 'crewforge.kubemoot.ai/single-scenario': 'true' };
    (single as { status?: unknown }).status = { phase: 'Running' };
    expect(memberItem({ kind: 'member', crew, view: fitnessRunView({ kind: 'CrewFitness', name: 'one', object: single, reason: 'r' }) }).contextValue).toBe('liveObject-run-stop');
    expect(fitnessRunView({ kind: 'CrewFitness', name: 'gone', reason: 'r' }).run).toBeUndefined();
    expect(scenarioView(scenario).scenario).toBe(scenario);
  });
});

describe('LiveFitness', () => {
  const scenario: DeployedScenario = { name: 'pods', content: 'DESCRIPTION pods', from: 'cm/fitness.yaml' };
  function make(scenarios: () => Promise<DeployedScenario[]> = async () => [scenario]) {
    const batches = { runAll: vi.fn(async () => undefined), runOne: vi.fn(async () => undefined), choose: vi.fn(async () => undefined), runChosen: vi.fn(async () => undefined) };
    const controls = { pause: vi.fn(async () => undefined), resume: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };
    const refresh = vi.fn();
    return { live: new LiveFitness({ batches, controls, scenarios, refresh }), batches, controls, refresh };
  }
  const section = (c = crew) => ({ kind: 'section', crew: c, section: 'fitness', details: details([scenario]) }) as Extract<DetailNode, { kind: 'section' }>;
  const member = (view: Extract<DetailNode, { kind: 'member' }>['view'], c = crew) => ({ kind: 'member', crew: c, view }) as Extract<DetailNode, { kind: 'member' }>;
  const target = { deployment: expect.objectContaining({ namespace: 'crew-test', crew }), title: 'test', scenarios: [scenario] };

  it('runs all, a chosen batch, or one deployed scenario against the live crew, reading its scenarios fresh', async () => {
    const { live, batches } = make();
    await live.runAll(section());
    await live.choose(section());
    await live.runOne(member(scenarioView(scenario)));
    expect(batches.runAll).toHaveBeenCalledWith(target);
    expect(batches.choose).toHaveBeenCalledWith(target);
    expect(batches.runOne).toHaveBeenCalledWith(target, scenario);
    await live.runAll(undefined);
    await live.choose(undefined);
    await live.runOne(member({ label: 'x', tooltip: 'x', icon: 'x' }));
    expect(batches.runAll).toHaveBeenCalledTimes(1);
    expect(batches.choose).toHaveBeenCalledTimes(1);
    expect(batches.runOne).toHaveBeenCalledTimes(1);
  });

  it('runs the selected scenario rows of one crew as one batch, the clicked row when nothing else is selected', async () => {
    const { live, batches } = make();
    const other: DeployedScenario = { name: 'events', content: 'DESCRIPTION events', from: 'cm/fitness.yaml' };
    await live.runSelected(member(scenarioView(scenario)), [member(scenarioView(scenario)), member(scenarioView(other)), section()]);
    expect(batches.runChosen).toHaveBeenCalledWith(target, [scenario, other]);
    await live.runSelected(member(scenarioView(other)), []);
    expect((batches.runChosen.mock.calls[1] as unknown[])[1]).toEqual([other]);
  });

  it('refuses scenarios of two crews, and an empty selection, saying why', async () => {
    const { live, batches } = make();
    const elsewhere = { ...crew, namespace: 'team-b' };
    await live.runSelected(undefined, [member(scenarioView(scenario)), member(scenarioView(scenario), elsewhere)]);
    expect(recorded.info[0]).toBe("The selected scenarios belong to 2 crews (crew-test/test, team-b/test). Select the scenarios of one crew: CrewForge runs one crew's batch at a time.");
    await live.runSelected(section(), [section()]);
    await live.runSelected(undefined, undefined);
    expect(recorded.info.slice(1)).toEqual([
      'No scenarios are selected. Select scenario rows under a Fitness group, then choose Run Selected Scenarios.',
      'No scenarios are selected. Select scenario rows under a Fitness group, then choose Run Selected Scenarios.',
    ]);
    expect(batches.runChosen).not.toHaveBeenCalled();
  });

  it('shows a scenario script, and ignores a node without one', async () => {
    const { live } = make();
    await live.show(member(scenarioView(scenario)));
    await live.show(undefined);
    expect(recorded.shownDocuments).toEqual(['DESCRIPTION pods']);
  });

  it('pauses, resumes, and stops a run, then refreshes; ignores a leaf without one', async () => {
    const { live, controls, refresh } = make();
    const run = fitnessRunView({ kind: 'CrewFitnessSuite', name: 's', object: suiteRun('s', 'Running'), reason: 'r' });
    await live.pause(member(run));
    await live.resume(member(run));
    await live.stop(member(run));
    await live.stop(member({ label: 'x', tooltip: 'x', icon: 'x' }));
    expect([controls.pause, controls.resume, controls.stop].map((f) => (f.mock.calls[0] as unknown as [FitnessRun])[0].name)).toEqual(['s', 's', 's']);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it('runs a crew from its own menu with the scenarios it carries; none, or unreadable, falls back to the source', async () => {
    expect(await make().live.runCrew(crew)).toBe(true);
    expect(await make(async () => []).live.runCrew(crew)).toBe(false);
    expect(await make(async () => Promise.reject(new Error('forbidden'))).live.runCrew(crew)).toBe(false);
    expect(recorded.warnings.at(-1)).toBe('Cannot read the fitness scenarios test carries (forbidden), so CrewForge runs the fitness its source defines.');
    const runFitness = vi.fn(async () => undefined);
    const actions = (deployedFitness: (c: CrewSummary) => Promise<boolean>) =>
      new LiveCrewActions({ sources: async () => [], deploy: {} as never, fitness: { runFitness }, details: async () => ({}) as never, follow: async () => undefined, deployedFitness });
    await actions(async () => true).runFitness(crew);
    expect(recorded.info).toEqual([]);
    await actions(async () => false).runFitness(crew);
    expect(recorded.info[0]).toContain('CrewForge does not know the source of test');
  });
});

describe('Deployed Crews compares the deployed scenarios with the open source', () => {
  const cluster = () => {
    const c = obj('Crew', 'test', 'crew-test');
    (c as { status?: unknown }).status = { ready: true, phase: 'Ready' };
    return new FakeCluster().add(c, configMap('test-fitness', { 'a.adl': 'A' }));
  };
  const tree = (source?: () => Promise<{ name: string; content: string }[] | undefined>) => {
    const t = new CrewTreeProvider(() => ({ source: '/k', context: 'lab', client: cluster() as unknown as KubeClient }));
    t.sourceScenarios = source;
    return t;
  };

  it('marks the Fitness group changed only when an open source differs, and unknown when it cannot be read', async () => {
    expect((await tree(async () => [{ name: 'a', content: 'A' }]).detailsOf(crew)).scenariosChanged).toBe(false);
    expect((await tree(async () => [{ name: 'a', content: 'B' }]).detailsOf(crew)).scenariosChanged).toBe(true);
    expect((await tree(async () => undefined).detailsOf(crew)).scenariosChanged).toBeUndefined();
    expect((await tree(async () => Promise.reject(new Error('render failed'))).detailsOf(crew)).scenariosChanged).toBeUndefined();
    const d = await tree().detailsOf(crew);
    expect(d.scenarios).toEqual([{ name: 'a', content: 'A', from: 'test-fitness/a.adl' }]);
    expect(d.scenariosChanged).toBeUndefined();
  });

  it('lists the scenarios under the crew with no source at all', async () => {
    const t = tree();
    const [crewNode] = (await t.getChildren()) as CrewNode[];
    const fitness = (await t.getChildren(crewNode)).find((n) => n.kind === 'section' && n.section === 'fitness')!;
    expect((await t.getChildren(fitness)).map((n) => t.getTreeItem(n).label)).toEqual(['a']);
  });
});

describe('SourceService.scenarioScripts', () => {
  it('gives the scripts of the fitness manifests, then the loose script files, by name', async () => {
    const service = new SourceService({ exec: async () => ({ code: 0, stdout: '', stderr: '' }), readText: async (file) => `text of ${file}`, readYamlFiles: async () => [], listFiles: async () => ({ charts: [], yamls: [] }) });
    vi.spyOn(service, 'fitnessDefinitions').mockResolvedValue([obj('CrewFitnessSuite', 's', 'ns', { crewRef: 'test', scripts: [{ testRef: 'pods', testContent: 'P' }] })]);
    vi.spyOn(service, 'scripts').mockResolvedValue(['/w/test/fitness/extra.adl']);
    const entry = { source: { kind: 'helm', root: '/w/test', label: 'test' }, identity: { id: 'local:test' }, crewName: 'test' } as SourceEntry;
    expect(await service.scenarioScripts(entry, 'crew-test')).toEqual([
      { name: 'pods', content: 'P' },
      { name: 'extra', content: 'text of /w/test/fitness/extra.adl' },
    ]);
    expect(await service.scenarioScripts({ ...entry, crewName: undefined }, 'crew-test')).toEqual([{ name: 'extra', content: 'text of /w/test/fitness/extra.adl' }]);
  });
});

describe('small helpers', () => {
  it('uniqueByName keeps the first item of each name, in order', () => {
    expect(uniqueByName([{ name: 'a', n: 1 }, { name: 'b', n: 2 }, { name: 'a', n: 3 }])).toEqual([{ name: 'a', n: 1 }, { name: 'b', n: 2 }]);
  });

  it('chosenNodes takes the selection when there is one, else the clicked node', () => {
    expect(chosenNodes('a', ['b', 'c'])).toEqual(['b', 'c']);
    expect(chosenNodes('a', [])).toEqual(['a']);
    expect(chosenNodes('a', undefined)).toEqual(['a']);
    expect(chosenNodes(undefined, undefined)).toEqual([]);
  });

  it('crewPath names one Crew, refusing a namespace that is not a Kubernetes name', () => {
    expect(crewPath('crew-test', 'test')).toBe('/apis/kubemoot.ai/v1alpha1/namespaces/crew-test/crews/test');
    expect(() => crewPath('Bad NS', 'test')).toThrow('is not a valid Kubernetes name');
  });

  it('sourceTitle reads a source by its display name, its Crew, then its folder', () => {
    const source = { kind: 'helm' as const, root: '/w/x', label: 'folder' };
    expect(sourceTitle({ source, identity: { id: 'i' }, crewName: 'x', displayName: 'X Crew' })).toBe('X Crew');
    expect(sourceTitle({ source, identity: { id: 'i' }, crewName: 'x' })).toBe('x');
    expect(sourceTitle({ source, identity: { id: 'i' } })).toBe('folder');
  });

  it('isSourceNode tells Crew Sources nodes from Deployed Crews nodes', () => {
    expect(isSourceNode({ kind: 'fitness', entry: {} as SourceEntry, deployment: {} as never })).toBe(true);
    expect(isSourceNode({ kind: 'crew', crew })).toBe(false);
    expect(isSourceNode(undefined)).toBe(false);
  });
});
