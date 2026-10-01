import { noRelated } from '../src/crew/related';
import { describe, expect, it } from 'vitest';
import { loadCrewDetails, type CrewDetails } from '../src/crew/details';
import type { CrewSummary } from '../src/k8s/crews';
import { discoverKinds } from '../src/source/live';
import { GROUP_ORDER } from '../src/crew/groups';
import { agentView, memberItem, membersOf, promptView, sectionItem, sectionsOf, serverView, skillView, type DetailNode } from '../src/views/crewDetailsTree';
import { FakeCluster, obj, seedCrew } from './fakeCluster';
import { ThemeIcon, TreeItemCollapsibleState } from './vscodeFake';

const summary: CrewSummary = {
  name: 'lab-ops',
  namespace: 'team-a',
  ready: true,
  phase: 'Ready',
  labels: { 'helm.sh/chart': 'lab-crew-0.4.0', 'helm.toolkit.fluxcd.io/name': 'lab', 'helm.toolkit.fluxcd.io/namespace': 'flux-system' },
};

async function details(): Promise<CrewDetails> {
  const cluster = seedCrew(new FakeCluster());
  return loadCrewDetails(cluster, await discoverKinds(cluster), 'team-a', 'lab-ops');
}

type Section = Extract<DetailNode, { kind: 'section' }>;
type Member = Extract<DetailNode, { kind: 'member' }>;

describe('crew sections', () => {
  it('lists every group in order, each with a summary, an id, and its relationship rule', async () => {
    const sections = sectionsOf(summary, await details()) as Section[];
    expect(sections.map((s) => s.section)).toEqual([...GROUP_ORDER]);
    const items = sections.map(sectionItem);
    expect(items.map((i) => `${i.label}|${i.description ?? ''}`)).toEqual([
      'Agents|1 of 2 ready',
      'Prompts|4, 1 ADL',
      'Skills|1',
      'Models|none',
      'RAG Sources|none',
      'MCP Servers|2',
      'Tools|2',
      'Policies|2',
      'Notifications|none',
      'Fitness|none',
      'Deployment|',
    ]);
    expect(items[0]).toMatchObject({ contextValue: 'crewSection-agents', id: 'section:team-a/lab-ops:agents', collapsibleState: TreeItemCollapsibleState.Collapsed });
    expect(items[3]).toMatchObject({ collapsibleState: TreeItemCollapsibleState.None, tooltip: expect.stringContaining('scheduler may bind') });
  });

  it('shows an empty group as none, not as an empty folder', () => {
    const empty: CrewDetails = { crew: obj('Crew', 'x', 'n'), agents: [], skills: [], promptModules: [], mcpServers: [], tools: [], related: noRelated(), problems: [] };
    const sections = sectionsOf(summary, empty) as Section[];
    expect(sections).toHaveLength(GROUP_ORDER.length);
    const skills = sectionItem(sections[2]);
    expect(skills.collapsibleState).toBe(TreeItemCollapsibleState.None);
    expect(skills.description).toBe('none');
    expect(membersOf(sections[0])).toEqual([]);
  });

  it('shows each member with its facts, and opens a live object on click', async () => {
    const sections = sectionsOf(summary, await details()) as Section[];
    const leaves = (i: number) => (membersOf(sections[i]) as Member[]).map((m) => memberItem(m));
    const agents = leaves(0);
    expect(agents.map((i) => `${i.label}|${i.description}`)).toEqual(['coordinator|coordinator · reasoning', 'k8s|tooler · tool-calling, kubernetes · Pending']);
    expect((agents[0].iconPath as ThemeIcon).id).toBe('pass-filled');
    expect((agents[1].iconPath as ThemeIcon).id).toBe('circle-large-outline');
    expect(agents[0].command?.command).toBe('crewforge.showLiveYaml');
    expect(agents[0].contextValue).toBe('liveObject');
    expect((agents[0].command?.arguments?.[0] as Member).view.ref).toEqual({ kind: 'Agent', name: 'coordinator', namespace: 'team-a' });
    expect(agents[1].tooltip).toContain('PromptModules: rules, shared, gone');

    const prompts = leaves(1);
    expect(prompts.map((i) => `${i.label}|${i.description}`)).toEqual(['rules|order 5 · ADL · 2 agents', 'shared|order 50 · prose · 1 agent', 'gone|missing · 1 agent', 'style|order 100 · prose · 1 agent']);
    expect(prompts[1].tooltip).toContain('outside this crew');
    expect(prompts[2].command).toBeUndefined();
    expect((prompts[0].iconPath as ThemeIcon).id).toBe('symbol-structure');
    expect((prompts[3].iconPath as ThemeIcon).id).toBe('symbol-text');

    expect(leaves(2).map((i) => `${i.label}|${i.description}`)).toEqual(['runbook|order 10']);
    expect(leaves(5).map((i) => `${i.label}|${i.description}`)).toEqual(['kubernetes|ready · 2 tools', 'web|undefined']);
    const tools = leaves(6);
    expect(tools.map((i) => `${i.label}|${i.description}`)).toEqual(['helm_list|from kubernetes · k8s', 'pods_list|from kubernetes · k8s']);
    expect(tools[0]).toMatchObject({ contextValue: 'tool', command: { command: 'crewforge.showToolDetails' } });

    const deployment = (membersOf(sections[10]) as Member[]).map((m) => m.view);
    expect(deployment.map((v) => `${v.label}: ${v.description}`)).toEqual(['Channel: GitOps (Flux)', 'Chart: lab-crew 0.4.0', 'Flux HelmRelease: flux-system/lab']);
    expect(deployment[0].ref).toEqual({ kind: 'Crew', name: 'lab-ops', namespace: 'team-a' });
    expect(deployment[2].ref).toEqual({ kind: 'HelmRelease', name: 'lab', namespace: 'flux-system' });
  });
});

describe('member views', () => {
  it('describes agents without a role or capabilities, and a not-ready agent without a phase', () => {
    const view = agentView(summary, { name: 'a', capabilities: [], ready: false, promptRefs: [], object: obj('Agent', 'a', 'n') });
    expect(view.description).toBe('no role · no capabilities declared · not ready');
    expect(view.tooltip).toBe('Agent a\nRole: not set\nCapabilities: no capabilities declared\nState: not ready');
  });

  it('marks a skill that is not ready, and a server named but missing or not ready', () => {
    expect(skillView(summary, { name: 's', order: 1, ready: false, object: obj('Skill', 's', 'n') })).toMatchObject({ description: 'order 1 · not ready', icon: 'warning' });
    const missing = serverView(summary, { name: 'm', reason: 'named by an agent or skill, but not found' });
    expect(missing).toMatchObject({ description: 'missing', icon: 'warning' });
    expect(missing.ref).toBeUndefined();
    expect(serverView(summary, { name: 'm', ready: false, reason: 'labeled for this crew', object: obj('MCPServer', 'm', 'n') })).toMatchObject({ description: 'not ready', icon: 'circle-large-outline' });
    expect(promptView(summary, { name: 'p', order: 1, usedBy: ['a'], shared: false }).tooltip).toBe('PromptModule p is named by a but does not exist.');
  });
});
