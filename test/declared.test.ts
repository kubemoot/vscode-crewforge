import { describe, expect, it } from 'vitest';
import { agentPrompts, agentSourceMap, declarationsOf } from '../src/source/declared';
import { agentLine, agentTooltip, byName, lines, missingPromptTooltip, promptLine, promptTooltip, text, usersText } from '../src/crew/describe';
import { keyLine, locate, scenarioLine, type Located } from '../src/source/locate';
import { objectKey, type Manifest } from '../src/source/manifests';
import { chartDocuments, chartFile, helmErrorLocation, RenderError, renderWithOrigins, type Exec } from '../src/source/render';
import { SourceService, sourceOf, type SourceDeps, type SourceEntry } from '../src/source/service';
import { openAt, SourceTreeProvider, type SourceNode } from '../src/views/sourceTree';
import { FakeCluster } from './fakeCluster';
import { resetFake } from './vscodeFake';

const ROOT = '/w/demo';

/** The chart's files as kmctl writes them: literal names, one file per kind. */
const FILES: Record<string, string> = {
  [`${ROOT}/templates/crew.yaml`]: ['apiVersion: kubemoot.ai/v1alpha1', 'kind: Crew', 'metadata:', '  name: demo', 'spec:', '  description: "Demo"'].join('\n'),
  [`${ROOT}/templates/agents.yaml`]: [
    'apiVersion: kubemoot.ai/v1alpha1',
    'kind: Agent',
    'metadata:',
    '  name: demo-coordinator',
    'spec:',
    '  discussRole: coordinator',
    '  capabilities: [reasoning]',
    '  promptRefs: [rules, style, gone]',
    '---',
    'apiVersion: kubemoot.ai/v1alpha1',
    'kind: Agent',
    'metadata:',
    '  name: {{ .Values.tooler }}',
    'spec:',
    '  capabilities: []',
    '  promptRefs: [rules]',
    '  mcpServers:',
    '    - name: kubernetes',
    '    - name: web',
  ].join('\n'),
  [`${ROOT}/templates/prompts.yaml`]: [
    'apiVersion: kubemoot.ai/v1alpha1',
    'kind: PromptModule',
    'metadata:',
    '  name: rules',
    'spec:',
    '  order: 10',
    '  content: |',
    '    DEFINE DOMAIN rules',
    '---',
    'apiVersion: kubemoot.ai/v1alpha1',
    'kind: PromptModule',
    'metadata:',
    '  name: style',
    'spec:',
    '  content: Be brief.',
    '---',
    'apiVersion: kubemoot.ai/v1alpha1',
    'kind: PromptModule',
    'metadata:',
    '  name: spare',
    'spec:',
    '  content: Unused.',
  ].join('\n'),
  [`${ROOT}/templates/extras.yaml`]: [
    'apiVersion: kubemoot.ai/v1alpha1',
    'kind: Skill',
    'metadata:',
    '  name: runbook',
    'spec:',
    '  order: 5',
    '  description: Restart a pod',
    '---',
    'apiVersion: kubemoot.ai/v1alpha1',
    'kind: MCPServer',
    'metadata:',
    '  name: kubernetes',
    'spec: {}',
    '---',
    'apiVersion: kubemoot.ai/v1alpha1',
    'kind: MCPServer',
    'metadata:',
    '  name: search',
    'spec: {}',
  ].join('\n'),
};

const SUITE = [
  'apiVersion: kubemoot.ai/v1alpha1',
  'kind: CrewFitnessSuite',
  'metadata:',
  '  name: demo-starter',
  'spec:',
  '  crewRef: demo',
  '  description: Starter suite',
  '  scripts:',
  '    - testRef: smoke-hello',
  '      testContent: |',
  '        ASSERT(synthesis is non-empty)',
  '    - testRef: "general-knowledge"',
  '---',
  'apiVersion: kubemoot.ai/v1alpha1',
  'kind: CrewFitness',
  'metadata:',
  '  name: one-off',
  'spec:',
  '  crewRef: demo',
  '  testRef: smoke',
].join('\n');

/** What `helm template` prints for the chart: each document under its `# Source:` line. */
const HELM_OUT = [
  ['crew.yaml', FILES[`${ROOT}/templates/crew.yaml`]],
  ['agents.yaml', FILES[`${ROOT}/templates/agents.yaml`].replace('{{ .Values.tooler }}', 'demo-tooler')],
  ['prompts.yaml', FILES[`${ROOT}/templates/prompts.yaml`]],
  ['extras.yaml', FILES[`${ROOT}/templates/extras.yaml`]],
]
  .flatMap(([file, text]) => text.split('\n---\n').map((doc) => `---\n# Source: demo-chart/templates/${file}\n${doc}\n`))
  .join('');

const helm: Exec = async (cmd) => (cmd === 'helm' ? { code: 0, stdout: HELM_OUT, stderr: '' } : { code: 128, stdout: '', stderr: '' });
const readText = async (file: string) => {
  if (file in FILES) return FILES[file];
  throw new Error(`ENOENT ${file}`);
};

function deps(exec: Exec = helm, fitnessFiles: { file: string; text: string }[] = [{ file: `${ROOT}/fitness/fitness.yaml`, text: SUITE }]): SourceDeps {
  return {
    exec,
    readText: async (file) => fitnessFiles.find((f) => f.file === file)?.text ?? readText(file),
    readYamlFiles: async (dir) => {
      if (dir === `${ROOT}/fitness`) return fitnessFiles;
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    listFiles: async () => ({ charts: [`${ROOT}/Chart.yaml`], yamls: Object.keys(FILES) }),
  };
}

describe('render origins', () => {
  it('splits helm output into objects with the template file each came from', () => {
    const docs = chartDocuments(ROOT, HELM_OUT);
    expect(docs.map((d) => [objectKey(d.manifest), d.file])).toContainEqual(['Agent/demo-tooler', `${ROOT}/templates/agents.yaml`]);
    expect(chartDocuments(ROOT, 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\n')).toEqual([{ manifest: expect.objectContaining({ kind: 'ConfigMap' }), file: undefined }]);
    expect(chartFile(ROOT, 'demo-chart/charts/sub/templates/x.yaml')).toBe(`${ROOT}/charts/sub/templates/x.yaml`);
  });

  it('finds where a helm error points, in either form helm prints', () => {
    expect(helmErrorLocation(ROOT, 'Error: parse error at (demo-chart/templates/crew.yaml:5): function "x" not defined')).toEqual({ file: `${ROOT}/templates/crew.yaml`, line: 4 });
    expect(helmErrorLocation(ROOT, 'Error: YAML parse error on demo-chart/templates/agents.yaml: error converting YAML to JSON: yaml: line 7: bad')).toEqual({ file: `${ROOT}/templates/agents.yaml`, line: 6 });
    expect(helmErrorLocation(ROOT, 'Error: something else')).toBeUndefined();
  });

  it('throws a RenderError that carries the place, for a chart and for a bundle', async () => {
    const broken: Exec = async () => ({ code: 1, stdout: '', stderr: 'Error: parse error at (demo-chart/templates/crew.yaml:3): bad' });
    const chartError = await renderWithOrigins({ kind: 'helm', root: ROOT, label: 'demo' }, { namespace: 'n' }, { exec: broken, readYamlFiles: async () => [] }).catch((e: unknown) => e);
    expect(chartError).toBeInstanceOf(RenderError);
    expect(chartError).toMatchObject({ file: `${ROOT}/templates/crew.yaml`, line: 2, message: expect.stringContaining('helm template failed for demo') });
    const bundleError = await renderWithOrigins({ kind: 'bundle', root: '/b', label: 'b' }, { namespace: 'n' }, { exec: helm, readYamlFiles: async () => [{ file: '/b/a.yaml', text: 'a: 1\n  b: [\n' }] }).catch((e: unknown) => e);
    expect(bundleError).toMatchObject({ name: 'RenderError', file: '/b/a.yaml', message: expect.stringMatching(/^a.yaml: /) });
    expect((bundleError as RenderError).line).toBeGreaterThanOrEqual(0);
    const thrown = await renderWithOrigins({ kind: 'bundle', root: '/b', label: 'b' }, { namespace: 'n' }, {
      exec: helm,
      readYamlFiles: async () => [{ file: '/b/a.yaml', text: 'ok: 1' }],
    });
    expect(thrown).toEqual([]);
  });
});

describe('locate', () => {
  it('matches literal names, gives templated names the next free object of their kind, and falls back to the top', async () => {
    const located = await locate(chartDocuments(ROOT, HELM_OUT), readText);
    const line = (key: string) => located.find((l) => objectKey(l.manifest) === key)?.line;
    expect(line('Crew/demo')).toBe(0);
    expect(line('Agent/demo-coordinator')).toBe(0);
    expect(line('Agent/demo-tooler')).toBe(9);
    expect(line('PromptModule/style')).toBe(9);
    expect(line('MCPServer/search')).toBe(14);
    const extra: Manifest = { apiVersion: 'kubemoot.ai/v1alpha1', kind: 'Agent', metadata: { name: 'third' } };
    const more = await locate([...chartDocuments(ROOT, HELM_OUT), { manifest: extra, file: `${ROOT}/templates/agents.yaml` }], readText);
    expect(more.at(-1)?.line).toBe(0);
    const odd = await locate([{ manifest: { ...extra, kind: 'Model' }, file: `${ROOT}/templates/agents.yaml` }, { manifest: extra, file: '/gone.yaml' }, { manifest: extra }], readText);
    expect(odd.map((l) => [l.file, l.line])).toEqual([[`${ROOT}/templates/agents.yaml`, 0], ['/gone.yaml', 0], [undefined, 0]]);
  });

  it('finds the line of a nested key, skipping list indexes, and stops at the next document', () => {
    const text = FILES[`${ROOT}/templates/agents.yaml`];
    expect(keyLine(text, 9, ['spec', 'mcpServers', '1', 'name'])).toBe(17);
    expect(keyLine(text, 0, ['spec', 'capabilities'])).toBe(6);
    expect(keyLine(text, 0, ['spec', 'mcpServers'])).toBe(4);
    expect(keyLine(text, 0, ['nothing'])).toBe(0);
    expect(keyLine('a.b: 1\nab: 2', 0, ['a.b'])).toBe(0);
  });

  it('finds a scenario by its testRef, quoted or not', () => {
    expect(scenarioLine(SUITE, 0, 'general-knowledge')).toBe(11);
    expect(scenarioLine(SUITE, 0, 'missing')).toBe(0);
  });
});

describe('declarationsOf', () => {
  it('lists the crew, agents, prompt modules, skills, MCP servers, and fitness scenarios with their places', async () => {
    const service = new SourceService(deps());
    const [entry] = await service.load();
    const { crew, sections } = await service.declarations(entry);
    expect(crew).toMatchObject({ label: 'demo', description: 'Crew', file: `${ROOT}/templates/crew.yaml`, line: 0 });
    const shown = Object.fromEntries(sections.map((s) => [s.section, s.items.map((i) => [i.label, i.description, i.line])]));
    expect(shown.agents).toEqual([
      ['demo-coordinator', 'coordinator · reasoning', 0],
      ['demo-tooler', 'no role · no capabilities declared', 9],
    ]);
    expect(shown.prompts).toEqual([
      ['rules', 'order 10 · ADL · 2 agents', 0],
      ['gone', 'not in this source · 1 agent', 0],
      ['style', 'order 100 · prose · 1 agent', 9],
      ['spare', 'order 100 · prose · 0 agents', 16],
    ]);
    expect(shown.skills).toEqual([['runbook', 'order 5', 0]]);
    expect(shown.mcp).toEqual([
      ['kubernetes', 'declared here, named by an agent or skill', 8],
      ['search', 'declared here', 14],
      ['web', 'named, installed elsewhere', 0],
    ]);
    expect(shown.fitness).toEqual([
      ['smoke-hello', 'suite demo-starter', 8],
      ['general-knowledge', 'suite demo-starter', 11],
      ['one-off', 'CrewFitness', 13],
    ]);
    const prompts = sections.find((s) => s.section === 'prompts')!.items;
    expect(prompts[1]).toMatchObject({ warn: true, icon: 'warning' });
    expect(prompts[3].tooltip).toContain('No agent composes it.');
    expect(prompts[1].tooltip).toBe('PromptModule gone is named by demo-coordinator but this source does not declare it.');
    expect(sections[0].items[0].tooltip).toContain('PromptModules: rules, style, gone');
  });

  it('lists nothing for a source without a crew, and a suite without scripts as itself', async () => {
    const suite: Manifest = { apiVersion: 'kubemoot.ai/v1alpha1', kind: 'CrewFitnessSuite', metadata: { name: 'empty' } };
    const d = await declarationsOf([], [{ manifest: suite, line: 3 }], readText);
    expect(d.crew).toBeUndefined();
    expect(d.sections.find((s) => s.section === 'fitness')?.items).toEqual([{ label: 'empty', description: 'CrewFitnessSuite', tooltip: 'CrewFitnessSuite empty', icon: 'beaker', file: undefined, line: 3 }]);
    const unreadable = await declarationsOf([], [{ manifest: { ...suite, spec: { scripts: [{ testRef: 'a' }, {}] } } as Manifest, file: '/gone.yaml', line: 2 }], readText);
    expect(unreadable.sections.at(-1)?.items.map((i) => [i.label, i.line])).toEqual([['a', 2]]);
  });

  it('gives an agent and the prompt modules it composes, for jumping to them', async () => {
    const located = await locate(chartDocuments(ROOT, HELM_OUT), readText);
    expect(agentPrompts(located, 'demo-coordinator').map((l: Located) => objectKey(l.manifest))).toEqual(['Agent/demo-coordinator', 'PromptModule/rules', 'PromptModule/style']);
    expect(agentPrompts(located, 'nobody')).toEqual([]);
  });

  it('renders again for another namespace, and reads loose fitness beside a bundle', async () => {
    let helmCalls = 0;
    const counting: Exec = async (cmd, args, options) => {
      if (cmd === 'helm') helmCalls++;
      return helm(cmd, args, options);
    };
    const service = new SourceService(deps(counting, [{ file: `${ROOT}/fitness/fitness.yaml`, text: SUITE }]));
    const [entry] = await service.load();
    await service.declarations(entry);
    expect(helmCalls).toBe(1);
    const defs = await service.fitnessDefinitions(entry, 'team-a');
    expect(helmCalls).toBe(2);
    expect(defs.map(objectKey)).toEqual(['CrewFitnessSuite/demo-starter', 'CrewFitness/one-off']);
    const fresh = await service.declarations({ ...entry, rendered: undefined });
    expect(fresh.crew?.label).toBe('demo');
  });
});

describe('sourceOf', () => {
  it('picks the innermost source that holds a file', () => {
    const entry = (root: string): SourceEntry => ({ source: { kind: 'helm', root, label: root }, identity: { id: root } });
    const entries = [entry('/w'), entry('/w/demo'), entry('/w/demo-2')];
    expect(sourceOf(entries, '/w/demo/templates/crew.yaml')?.source.root).toBe('/w/demo');
    expect(sourceOf(entries, '/w/other.yaml')?.source.root).toBe('/w');
    expect(sourceOf(entries, '/elsewhere/x.yaml')).toBeUndefined();
  });
});

describe('the node for a path of a crew source', () => {
  const tree = () => new SourceTreeProvider(new SourceService(deps()), () => ({ source: 'fake', context: 'lab', client: new FakeCluster() as never }));

  it('is the object a manifest declares first, the source for its folder or any other file, and none outside', async () => {
    resetFake();
    const provider = tree();
    const crew = await provider.nodeForPath(`${ROOT}/templates/crew.yaml`);
    expect(crew?.kind === 'declared' && crew.item.label).toBe('demo');
    expect(provider.getParent(crew!)).toMatchObject({ kind: 'source' });
    const agent = await provider.nodeForPath(`${ROOT}/templates/agents.yaml`);
    expect(agent?.kind === 'declared' && agent.item.label).toBe('demo-coordinator');
    expect(provider.getParent(agent!)).toMatchObject({ kind: 'declSection', section: 'agents' });
    expect(provider.getTreeItem(provider.getParent(agent!)!).id).toBe(`declSection:${ROOT}:agents`);
    expect(provider.getTreeItem(agent!).id).toMatch(new RegExp(`^declared:${ROOT}:`));
    expect(await provider.nodeForPath(ROOT)).toMatchObject({ kind: 'source' });
    expect(await provider.nodeForPath(`${ROOT}/templates`)).toMatchObject({ kind: 'source' });
    expect(await provider.nodeForPath(`${ROOT}/values.yaml`)).toMatchObject({ kind: 'source' });
    expect(await provider.nodeForPath('/elsewhere/x.yaml')).toBeUndefined();
    expect(sourceOf(provider.known, ROOT)?.source.root).toBe(ROOT);
  });
});

describe('Crew Sources declarations', () => {
  const tree = (d: SourceDeps = deps()) => new SourceTreeProvider(new SourceService(d), () => ({ source: 'fake', context: 'lab', client: new FakeCluster() as never }));

  it('expands a source to what it declares, each opening its file at the object, before its deployments', async () => {
    resetFake();
    const provider = tree();
    const [source] = await provider.getChildren();
    expect(provider.getTreeItem(source)).toMatchObject({ id: `source:${ROOT}` });
    const children = await provider.getChildren(source);
    expect(children.map((c) => provider.getTreeItem(c).label)).toEqual(['demo', 'Agents', 'PromptModules', 'Skills', 'MCP Servers', 'Fitness Scenarios', 'Not deployed in lab']);
    const crew = provider.getTreeItem(children[0]);
    expect(crew.command).toMatchObject({ command: 'vscode.open', arguments: [{ fsPath: `${ROOT}/templates/crew.yaml` }, { selection: { startLine: 0 } }] });
    expect(crew.tooltip).toContain(`${ROOT}/templates/crew.yaml:1`);
    const agents = children[1] as Extract<SourceNode, { kind: 'declSection' }>;
    expect(provider.getTreeItem(agents)).toMatchObject({ description: '2', contextValue: 'declSection-agents' });
    const [, tooler] = await provider.getChildren(agents);
    expect(provider.getTreeItem(tooler).command?.arguments?.[1]).toEqual({ selection: expect.objectContaining({ startLine: 9 }) });
    const prompts = await provider.getChildren(children[2]);
    const gone = provider.getTreeItem(prompts[1]);
    expect(gone.command).toBeUndefined();
    expect((gone.iconPath as { color?: { id: string } }).color?.id).toBe('list.warningForeground');
    expect(provider.getParent(tooler)).toMatchObject({ kind: 'declSection', section: 'agents' });
    expect(provider.getParent({ ...tooler })).toEqual({ kind: 'source', entry: (source as Extract<SourceNode, { kind: 'source' }>).entry });
    expect(provider.getParent(source)).toBeUndefined();
    expect(await provider.getChildren(tooler)).toEqual([]);
    provider.stateOf = () => ({ text: 'deployed in crew-demo, changed', changed: true });
    expect(provider.getTreeItem(source)).toMatchObject({ description: 'deployed in crew-demo, changed · helm', contextValue: 'source-helm-changed' });
    const redrawn: unknown[] = [];
    provider.onDidChangeTreeData((n) => redrawn.push(n));
    provider.refreshSource(ROOT);
    provider.refreshSource('/elsewhere');
    expect(redrawn).toEqual([source]);
    const reloaded = await provider.reload();
    expect(reloaded.map((n) => n.kind)).toEqual(['source']);
    expect(redrawn).toEqual([source, undefined]);
    expect(await provider.entries()).toHaveLength(1);
  });

  it('hides an empty MCP section, shows an empty one of the others as none, and reports what it cannot read', async () => {
    resetFake();
    const bare: Exec = async (cmd) => (cmd === 'helm' ? { code: 0, stdout: `---\n# Source: demo-chart/templates/crew.yaml\n${FILES[`${ROOT}/templates/crew.yaml`]}\n`, stderr: '' } : { code: 128, stdout: '', stderr: '' });
    const provider = tree(deps(bare, []));
    const [source] = await provider.getChildren();
    const children = await provider.getChildren(source);
    const labels = children.map((c) => provider.getTreeItem(c));
    expect(labels.map((i) => i.label)).toEqual(['demo', 'Agents', 'PromptModules', 'Skills', 'Fitness Scenarios', 'Not deployed in lab']);
    expect(labels[1]).toMatchObject({ description: 'none', collapsibleState: 0 });
    const failing = { ...deps(bare, []), readYamlFiles: async () => Promise.reject(new Error('disk gone')) };
    const broken = tree(failing);
    const [brokenSource] = await broken.getChildren();
    const [why] = await broken.getChildren(brokenSource);
    expect(broken.getTreeItem(why).label).toBe('disk gone');
  });
});

describe('shared crew text', () => {
  it('describes agents and prompt modules the same way in both trees', () => {
    const a = { name: 'k8s', role: undefined, capabilities: [], description: 'Reads pods', promptRefs: ['rules'] };
    expect(agentLine(a)).toBe('no role \u00b7 no capabilities declared');
    expect(agentTooltip(a)).toBe('Agent k8s\nRole: not set\nCapabilities: no capabilities declared\nReads pods\nPromptModules: rules');
    expect(agentTooltip({ ...a, role: 'tooler', capabilities: ['kubernetes'], description: undefined, promptRefs: [] }, 'ready')).toBe('Agent k8s\nRole: tooler\nCapabilities: kubernetes\nState: ready');
    const m = { name: 'rules', order: 5, form: 'ADL' as const, usedBy: ['a', 'b'] };
    expect([usersText(m), usersText({ usedBy: ['a'] }), promptLine(m)]).toEqual(['2 agents', '1 agent', 'order 5 \u00b7 ADL \u00b7 2 agents']);
    expect(promptTooltip(m, 'shared')).toBe('PromptModule rules\nOrder: 5\nForm: ADL\nUsed by: a, b\nshared');
    expect(promptTooltip({ ...m, usedBy: [] }, false)).toBe('PromptModule rules\nOrder: 5\nForm: ADL\nNo agent composes it.');
    expect(missingPromptTooltip(m, 'does not exist')).toBe('PromptModule rules is named by a, b but does not exist.');
    expect(lines('a', false, undefined, 'b')).toBe('a\nb');
    expect([text(''), text(3), text('x')]).toEqual([undefined, undefined, 'x']);
    expect([{ name: 'b' }, { name: 'a' }].sort(byName)).toEqual([{ name: 'a' }, { name: 'b' }]);
  });
});

describe('agentSourceMap', () => {
  it('maps each Kubemoot agent to its definition and modules, ignoring other groups of the same kind', async () => {
    const located = await locate(chartDocuments(ROOT, HELM_OUT), readText);
    const foreign: Located = { manifest: { apiVersion: 'other.io/v1', kind: 'Agent', metadata: { name: 'impostor' }, spec: { promptRefs: ['rules'] } } as Manifest, line: 0 };
    const map = agentSourceMap([...located, foreign]);
    expect([...map.keys()]).toEqual(['demo-coordinator', 'demo-tooler']);
    expect(map.get('demo-tooler')!.map((l) => objectKey(l.manifest))).toEqual(['Agent/demo-tooler', 'PromptModule/rules']);
    expect(agentPrompts([foreign], 'impostor')).toEqual([]);
  });
});

describe('loose fitness files', () => {
  it('places each fitness object on its own line even beside other kinds', async () => {
    const mixed = ['apiVersion: v1', 'kind: ConfigMap', 'metadata:', '  name: data', '---', SUITE].join('\n');
    const service = new SourceService(deps(helm, [{ file: `${ROOT}/fitness/fitness.yaml`, text: mixed }]));
    const [entry] = await service.load();
    const fitness = (await service.declarations(entry)).sections.find((s) => s.section === 'fitness')!.items;
    expect(fitness.map((i) => [i.label, i.line])).toEqual([
      ['smoke-hello', 13],
      ['general-knowledge', 16],
      ['one-off', 18],
    ]);
  });
});

describe('SourceTreeProvider loading', () => {
  it('opens a file at a line, loads sources on demand once, and announces each load', async () => {
    resetFake();
    expect(openAt('/w/x.yaml', 4)).toMatchObject({ command: 'vscode.open', arguments: [{ fsPath: '/w/x.yaml' }, { selection: { startLine: 4, endLine: 4 } }] });
    let listed = 0;
    const d = deps();
    const provider = new SourceTreeProvider(new SourceService({ ...d, listFiles: async () => (listed++, d.listFiles()) }), () => ({ source: 'f', context: 'lab', client: new FakeCluster() as never }));
    let loads = 0;
    provider.onDidLoadSources(() => loads++);
    expect((await provider.entries()).map((e) => e.crewName)).toEqual(['demo']);
    await provider.entries();
    expect([listed, loads]).toEqual([1, 1]);
    await provider.reload();
    expect([listed, loads]).toEqual([2, 2]);
  });
});
