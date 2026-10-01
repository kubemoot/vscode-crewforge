import { describe, expect, it } from 'vitest';
import {
  archetypeOf,
  bundleObjects,
  loadCrewDetails,
  mcpServersOf,
  promptForm,
  promptModulesOf,
  removableObjects,
  toAgent,
  toolsOf,
  toSkill,
} from '../src/crew/details';
import { KubeError } from '../src/k8s/request';
import { discoverKinds } from '../src/source/live';
import { FakeCluster, obj, seedCrew } from './fakeCluster';

const PATH = '/apis/kubemoot.ai/v1alpha1/namespaces/team-a';

async function load(cluster = seedCrew(new FakeCluster())) {
  return loadCrewDetails(cluster, await discoverKinds(cluster), 'team-a', 'lab-ops');
}

describe('promptForm', () => {
  it('calls a module ADL when any line opens with an ADL keyword, and prose otherwise', () => {
    expect(promptForm('## Heading\n\nDEFINE COMPONENT x\nDESCRIPTION y')).toBe('ADL');
    expect(promptForm('  WHEN asked\n  THEN answer')).toBe('ADL');
    expect(promptForm('ASSERT the answer is grounded')).toBe('ADL');
    expect(promptForm('DESCRIPTION Triage questions')).toBe('ADL');
    expect(promptForm('FOREACH agent CONTAINED WITHIN the crew')).toBe('ADL');
    expect(promptForm('DEFER synthesis KEYWORD "ref"')).toBe('ADL');
    expect(promptForm('THEN on its own continues nothing')).toBe('prose');
    expect(promptForm('When asked, answer. Never guess. Always cite.')).toBe('prose');
    expect(promptForm('Use DEFINE to name a thing mid-sentence.')).toBe('prose');
    expect(promptForm('')).toBe('prose');
  });

  it('reads every kind of line break and indent, and whole keywords only', () => {
    expect(promptForm('intro\r\n\t \u00a0NEVER guess')).toBe('ADL');
    expect(promptForm('intro\rALWAYS cite')).toBe('ADL');
    expect(promptForm('intro\u2028WHEN asked')).toBe('ADL');
    expect(promptForm('WHENEVER asked\nDEFINED terms')).toBe('prose');
    expect(promptForm('ASSERT')).toBe('ADL');
  });

  it('takes linear time on a module of blank lines', () => {
    const started = Date.now();
    expect(promptForm(`${'\n '.repeat(100_000)}x`)).toBe('prose');
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('member parsing', () => {
  it('reads an agent: role, capabilities, readiness, and prompts, tolerating missing and odd fields', () => {
    const agent = obj('Agent', 'a', 'n', { discussRole: 'tooler', capabilities: ['tool-calling', 7], promptRefs: ['p'], description: 'Does things' });
    agent.status = { ready: true, phase: 'Running' };
    expect(toAgent(agent)).toMatchObject({ name: 'a', role: 'tooler', capabilities: ['tool-calling'], ready: true, phase: 'Running', description: 'Does things', promptRefs: ['p'] });
    const bare = toAgent({ apiVersion: 'kubemoot.ai/v1alpha1', kind: 'Agent', metadata: { name: 'b' } });
    expect(bare).toMatchObject({ role: undefined, capabilities: [], ready: false, phase: undefined, promptRefs: [] });
    expect(toAgent(obj('Agent', 'c', 'n', { discussRole: '', capabilities: 'reasoning' })).role).toBeUndefined();
  });

  it('reads a skill with the default order and its Ready condition', () => {
    const skill = obj('Skill', 's', 'n', { description: 'Restart' });
    expect(toSkill(skill)).toMatchObject({ order: 100, ready: undefined, description: 'Restart' });
    skill.status = { conditions: [{ type: 'Ready', status: 'False' }] };
    expect(toSkill(skill).ready).toBe(false);
    skill.status = { conditions: [{ type: 'Other', status: 'True' }] };
    expect(toSkill(skill).ready).toBeUndefined();
    skill.status = { conditions: [{ type: 'Ready', status: 'True' }] };
    expect(toSkill({ ...skill, spec: { order: 3 } })).toMatchObject({ order: 3, ready: true });
  });
});

describe('promptModulesOf', () => {
  it('lists the modules the agents compose in composition order, with users, form, missing ones, and sharing', () => {
    const agents = [toAgent(obj('Agent', 'b', 'n', { promptRefs: ['late', 'early', 'gone'] })), toAgent(obj('Agent', 'a', 'n', { promptRefs: ['late'] }))];
    const modules = [obj('PromptModule', 'late', 'n', { content: 'prose' }), obj('PromptModule', 'early', 'n', { order: 1, content: 'ASSERT x' }), obj('PromptModule', 'unused', 'n', {})];
    const result = promptModulesOf(agents, modules, new Set(['late']));
    expect(result.map((m) => [m.name, m.order, m.form, m.usedBy.join(','), m.shared, m.object !== undefined])).toEqual([
      ['early', 1, 'ADL', 'b', false, true],
      ['gone', 100, undefined, 'b', false, false],
      ['late', 100, 'prose', 'a,b', true, true],
    ]);
    expect(promptModulesOf([], modules)).toEqual([]);
  });
});

describe('mcpServersOf and toolsOf', () => {
  const crew = obj('Crew', 'c', 'n', {}, { 'app.kubernetes.io/instance': 'rel' });

  it('keeps servers the crew names, labels, or installed, and flags names that resolve to nothing', () => {
    const members = [obj('Agent', 'a', 'n', { mcpServers: [{ name: 'named' }, { name: 'ghost' }, {}] }), obj('Skill', 's', 'n', { mcpServers: 'odd' })];
    const named = obj('MCPServer', 'named', 'n', {});
    named.status = { ready: false, tools: [] };
    const servers = [named, obj('MCPServer', 'labeled', 'n', {}, { 'kubemoot.ai/crew': 'c' }), obj('MCPServer', 'released', 'n', {}, { 'app.kubernetes.io/instance': 'rel' }), obj('MCPServer', 'other', 'n', {})];
    const result = mcpServersOf(crew, members, servers);
    expect(result.map((s) => [s.name, s.reason, s.ready, s.toolCount])).toEqual([
      ['ghost', 'named by an agent or skill, but not found', undefined, undefined],
      ['labeled', 'labeled for this crew', undefined, undefined],
      ['named', 'named by an agent or skill', false, 0],
      ['released', 'installed with release rel', undefined, undefined],
    ]);
  });

  it('matches no release when the Crew has none', () => {
    const bare = obj('Crew', 'c', 'n', {});
    expect(mcpServersOf(bare, [], [obj('MCPServer', 'x', 'n', {}, {})])).toEqual([]);
  });

  it('gathers enabled tools with the agents that enable them', () => {
    const tools = toolsOf([obj('Agent', 'b', 'n', { enabledTools: ['x', 'y'] }), obj('Agent', 'a', 'n', { enabledTools: ['x'] }), obj('Agent', 'c', 'n', {})]);
    expect(tools).toEqual([
      { name: 'x', agents: ['a', 'b'] },
      { name: 'y', agents: ['b'] },
    ]);
  });

  it('finds the archetype of the policy for this crew only', () => {
    expect(archetypeOf('c', [obj('CrewSchedulingPolicy', 'p', 'n', { crewRef: 'other', archetypeRef: 'x' }), obj('CrewSchedulingPolicy', 'q', 'n', { crewRef: 'c', archetypeRef: 'consent-3' })])).toBe('consent-3');
    expect(archetypeOf('c', [obj('CrewSchedulingPolicy', 'q', 'n', { crewRef: 'c' })])).toBeUndefined();
    expect(archetypeOf('c', [])).toBeUndefined();
  });
});

describe('loadCrewDetails', () => {
  it('reads the Crew and the objects of its crew from the namespace', async () => {
    const details = await load();
    expect(details.crew).toMatchObject({ apiVersion: 'kubemoot.ai/v1alpha1', kind: 'Crew', metadata: { name: 'lab-ops' } });
    expect(details.agents.map((a) => `${a.name}:${a.role}:${a.ready}`)).toEqual(['coordinator:coordinator:true', 'k8s:tooler:false']);
    expect(details.promptModules.map((m) => `${m.name}:${m.order}:${m.form}:${m.shared}`)).toEqual(['rules:5:ADL:false', 'shared:50:prose:true', 'gone:100:undefined:false', 'style:100:prose:false']);
    expect(details.skills.map((s) => s.name)).toEqual(['runbook']);
    expect(details.mcpServers.map((s) => s.name)).toEqual(['kubernetes', 'web']);
    expect(details.tools.map((t) => t.name)).toEqual(['helm_list', 'pods_list']);
    expect(details.archetype).toBe('consent-3');
    expect(details.problems).toEqual([]);
  });

  it('reports a kind it cannot read, skips kinds the cluster does not serve, and fails when the Crew is unreadable', async () => {
    const cluster = seedCrew(new FakeCluster());
    cluster.failures.set(`${PATH}/promptmodules`, new KubeError('promptmodules is forbidden', 403));
    const kinds = await discoverKinds(cluster);
    kinds.delete('Skill');
    const details = await loadCrewDetails(cluster, kinds, 'team-a', 'lab-ops');
    expect(details.problems).toEqual(['PromptModule: promptmodules is forbidden']);
    expect(details.skills).toEqual([]);
    expect(details.promptModules.every((m) => m.object === undefined)).toBe(true);
    kinds.delete('Crew');
    expect((await loadCrewDetails(cluster, kinds, 'team-a', 'lab-ops')).crew.kind).toBe('Crew');
    await expect(loadCrewDetails(cluster, kinds, 'team-a', 'nope')).rejects.toThrow('not found');
  });

  it('bundles the Crew, Agents, existing PromptModules, and Skills', async () => {
    const keys = bundleObjects(await load()).map((m) => `${m.kind}/${m.metadata.name}`);
    expect(keys).toEqual(['Crew/lab-ops', 'Agent/coordinator', 'Agent/k8s', 'PromptModule/rules', 'PromptModule/shared', 'PromptModule/style', 'Skill/runbook']);
  });

  it('removes the members and the Crew, but not shared or owned objects', async () => {
    const details = await load();
    details.agents[0].object.metadata.ownerReferences = [{ kind: 'Something' }];
    const keys = removableObjects(details).map((m) => `${m.kind}/${m.metadata.name}`);
    expect(keys).toEqual(['Agent/k8s', 'Skill/runbook', 'PromptModule/rules', 'PromptModule/style', 'Crew/lab-ops']);
  });
});
