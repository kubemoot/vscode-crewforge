// @vitest-environment jsdom
// Every term, command, tree item, and page control says what it is or does.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCrewDetails } from '../src/crew/details';
import { GROUP_ORDER, GROUPS } from '../src/crew/groups';
import { noRelated } from '../src/crew/related';
import { toAgent } from '../src/crew/details';
import { renderCrewPage } from '../src/dashboard/crewPage';
import { renderDiffTab, renderLiveTab, renderSourceTab } from '../src/dashboard/crewTabs';
import { gatherVitals, type VitalsDeps } from '../src/dashboard/crewVitals';
import { renderFitnessPage } from '../src/dashboard/fitnessPage';
import { renderMemoryPage } from '../src/dashboard/memoryPage';
import { renderOverview } from '../src/dashboard/overview';
import { ABILITY_TIPS, ACTIONS, conversationTitleTip, openConversationTip, STOP_EFFECTS, CHANNEL_TIPS, CHAT, CHAT_TEXT, COLUMNS, FACTS, HEADINGS, KIND_TERMS, kindTerm, NEXT_STEPS, STATUS_TIPS, TAB_TIPS, TERMS, VIEW_DESCRIPTIONS, withTerm } from '../src/definitions';
import type { CrewSummary } from '../src/k8s/crews';
import { parseExport, parseReport } from '../src/memory/ompi';
import { declarationsOf } from '../src/source/declared';
import { DRIFT_STATES } from '../src/source/driftStates';
import type { SourceEntry } from '../src/source/service';
import { CrewTreeProvider, type CrewNode } from '../src/views/crewTree';
import { memberItem, membersOf, scenarioView, sectionItem, sectionsOf, type DetailNode } from '../src/views/crewDetailsTree';
import { SourceTreeProvider, type SourceNode } from '../src/views/sourceTree';
import { discoverKinds } from '../src/source/live';
import { FakeCluster, obj, seedCrew, seedInfrastructure } from './fakeCluster';
import { controlsWithoutTooltip } from './tooltipCheck';
import { resetFake } from './vscodeFake';

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
  contributes: {
    commands: { command: string; title: string; category?: string; icon?: string }[];
    views: Record<string, { id: string; name: string }[]>;
    menus: Record<string, { command: string; when?: string; group?: string }[]>;
  };
};

/** Every text of the definitions module, with where it lives, for the checks on all of them. */
function allTexts(): [string, string][] {
  const tables: Record<string, Record<string, string>> = { TERMS, KIND_TERMS, HEADINGS, COLUMNS, FACTS, TAB_TIPS, ACTIONS, NEXT_STEPS, ABILITY_TIPS, CHANNEL_TIPS, VIEW_DESCRIPTIONS, STATUS_TIPS, CHAT_TEXT };
  const texts = Object.entries(tables).flatMap(([name, table]) => Object.entries(table).map(([key, text]): [string, string] => [`${name}.${key}`, text]));
  const chat = Object.entries(CHAT).flatMap(([key, a]): [string, string][] => [[`CHAT.${key}.label`, a.label], [`CHAT.${key}.what`, a.what]]);
  const drift = Object.entries(DRIFT_STATES).map(([key, d]): [string, string] => [`DRIFT_STATES.${key}`, d.tip]);
  return [...texts, ...chat, ...drift];
}

describe('the definitions', () => {
  it('has a text for every entry, in plain ASCII', () => {
    for (const [where, text] of allTexts()) {
      expect(text.trim(), where).not.toBe('');
      expect(text, where).toMatch(/^[\x20-\x7e]+$/);
      expect(text, where).not.toMatch(/[–—]/);
    }
  });

  it('keeps the words the product has settled on', () => {
    for (const [where, text] of allTexts()) {
      expect(text, where).not.toMatch(/consultation|production-grade|\bGPUs?\b/i);
    }
  });

  it('defines a kind, and says so for a kind it does not know', () => {
    expect(kindTerm('Agent')).toBe(TERMS.agent);
    expect(kindTerm('Widget')).toBe('Widget is a Kubernetes object the crew uses.');
  });

  it('adds what an item is after the first line of its tooltip, and leaves other tooltips alone', () => {
    expect(withTerm('Agent a\nRole: x')).toBe(`Agent a\n${TERMS.agent}\nRole: x`);
    expect(withTerm('Tool pods_list')).toBe(`Tool pods_list\n${TERMS.tool}`);
    expect(withTerm('Fitness scenario s\nmore')).toContain(TERMS.scenario);
    expect(withTerm('Channel: Helm')).toBe('Channel: Helm');
  });
});

describe('the commands and views in package.json', () => {
  it('gives every command a title with a category', () => {
    for (const c of manifest.contributes.commands) {
      expect(c.title.trim(), c.command).not.toBe('');
      expect(c.category, c.command).toBe('CrewForge');
    }
  });

  it('gives a command shown as an icon a title that reads as its tooltip, not one bare word', () => {
    const asIcon = new Set(manifest.contributes.commands.filter((c) => c.icon).map((c) => c.command));
    const shown = Object.values(manifest.contributes.menus).flat().filter((m) => asIcon.has(m.command) && m.group?.startsWith('inline') || m.group?.startsWith('navigation'));
    expect(shown.length).toBeGreaterThan(10);
    for (const m of shown) {
      const title = manifest.contributes.commands.find((c) => c.command === m.command)?.title ?? '';
      expect(title.split(/\s+/).length, `${m.command}: ${title}`).toBeGreaterThanOrEqual(2);
    }
  });

  it('keeps every menu entry on a contributed command', () => {
    const known = new Set(manifest.contributes.commands.map((c) => c.command));
    for (const [menu, entries] of Object.entries(manifest.contributes.menus)) {
      for (const e of entries) expect(known.has(e.command), `${menu}: ${e.command}`).toBe(true);
    }
  });

  it('describes every view CrewForge adds', () => {
    const views = Object.values(manifest.contributes.views).flat();
    expect(views.map((v) => v.id.replace('crewforge.', '')).sort()).toEqual(Object.keys(VIEW_DESCRIPTIONS).sort());
    for (const v of views) expect(v.name.trim()).not.toBe('');
  });
});

const crewOf = (): CrewSummary => ({ name: 'lab-ops', namespace: 'team-a', ready: true, phase: 'Ready', agents: 2, labels: { 'helm.sh/chart': 'lab-crew-0.4.0' } });

/** Fails with the item's label when a tree item has no tooltip, or none that says what it is. */
function expectDefined(items: { label?: unknown; tooltip?: unknown }[], terms: string[]): void {
  for (const item of items) {
    const tooltip = typeof item.tooltip === 'string' ? item.tooltip : '';
    expect(tooltip.trim(), `${String(item.label)} has no tooltip`).not.toBe('');
    expect(terms.some((t) => tooltip.includes(t)), `${String(item.label)} does not say what it is: ${tooltip}`).toBe(true);
  }
}

const groupRules = Object.values(GROUPS).map((g) => g.rule);
const everyTerm = [...Object.values(TERMS), ...Object.values(KIND_TERMS), ...Object.values(HEADINGS), ...groupRules, 'The fitness scenarios the source declares'];

describe('the Deployed Crews tree', () => {
  it('gives every kind of item a tooltip that says what it is', async () => {
    resetFake();
    const cluster = seedInfrastructure(seedCrew(new FakeCluster()));
    const details = await loadCrewDetails(cluster, await discoverKinds(cluster), 'team-a', 'lab-ops');
    const crew = crewOf();
    const tree = new CrewTreeProvider(() => ({ client: cluster, context: 'lab', source: 't' }) as never);
    const nodes: CrewNode[] = [
      { kind: 'connection', label: 'lab', tooltip: 'context lab' },
      { kind: 'namespace', group: { namespace: 'team-a', crews: [crew] } },
      { kind: 'crew', crew },
    ];
    expectDefined(nodes.map((n) => tree.getTreeItem(n)), everyTerm);

    const sections = sectionsOf(crew, details) as Extract<DetailNode, { kind: 'section' }>[];
    expect(sections.map((s) => s.section)).toEqual([...GROUP_ORDER]);
    expectDefined(sections.map(sectionItem), groupRules);
    const members = sections.flatMap((s) => membersOf(s) as Extract<DetailNode, { kind: 'member' }>[]);
    members.push({ kind: 'member', crew, view: scenarioView({ name: 's', content: 'c', from: 'cm' }) });
    expect(members.length).toBeGreaterThan(15);
    expectDefined(members.map(memberItem), everyTerm.concat(['A fact about how the crew was deployed']));
    const kinds = new Set(members.map((m) => memberItem(m).tooltip as string).map((t) => t.split(/[\s/]/)[0]));
    for (const kind of ['Agent', 'PromptModule', 'Skill', 'MCPServer', 'Tool', 'CrewSchedulingPolicy', 'Model', 'RAGSource']) expect(kinds.has(kind), kind).toBe(true);
  });
});

const entry: SourceEntry = { source: { kind: 'helm', root: '/w/lab', label: 'lab' }, identity: { id: 'local:lab' }, crewName: 'lab-ops', chart: { name: 'lab', version: '0.1.0', appVersion: '1', description: '' } };

describe('the Crew Sources tree', () => {
  it('gives every kind of item a tooltip that says what it is', async () => {
    const crew = crewOf();
    const deployment = { namespace: 'team-a', crew, channel: 'helm' as const, release: 'lab', linked: true };
    const located = [
      obj('Crew', 'lab-ops', 'team-a', { description: 'd' }),
      obj('Agent', 'coordinator', 'team-a', { discussRole: 'coordinator', capabilities: ['reasoning'], promptRefs: ['rules'], enabledTools: ['pods_list'], mcpServers: [{ name: 'kubernetes' }] }, { 'kubemoot.ai/crew': 'lab-ops' }),
      obj('PromptModule', 'rules', 'team-a', { order: 1, content: 'Be brief.' }),
      obj('Skill', 'runbook', 'team-a', { description: 'Restart', order: 1 }, { 'kubemoot.ai/crew': 'lab-ops' }),
      obj('MCPServer', 'kubernetes', 'team-a', {}),
      obj('NotificationSink', 'sink', 'team-a', {}),
      obj('CrewSchedulingPolicy', 'lab-ops', 'team-a', { crewRef: 'lab-ops' }),
      obj('CrewFitnessSuite', 'suite', 'team-a', { crewRef: 'lab-ops', scripts: [{ name: 'one', ref: 'one' }] }),
    ].map((manifest) => ({ manifest, file: '/w/lab/templates/x.yaml', line: 0 }));
    const declared = await declarationsOf(located, [], async () => '', ['/w/lab/fitness/nodes.adl']);
    const tree = new SourceTreeProvider({} as never, () => ({}) as never);
    const run = { kind: 'CrewFitnessSuite' as const, name: 'suite-1', namespace: 'team-a', crew: 'lab-ops', phase: 'Completed', createdAt: '2026-11-20T10:00:00Z', assertions: [] };
    const nodes: SourceNode[] = [
      { kind: 'source', entry },
      { kind: 'deployment', entry, deployment, drift: [] },
      ...Object.keys(DRIFT_STATES).map((state): SourceNode => ({ kind: 'resource', entry, deployment, drift: { kind: 'Agent', name: 'a', state, paths: [] } as never })),
      { kind: 'fitness', entry, deployment },
      { kind: 'run', entry, deployment, run },
      ...declared.sections.map((s): SourceNode => ({ kind: 'declSection', entry, section: s.section, items: s.items })),
      ...declared.sections.flatMap((s) => s.items.map((item): SourceNode => ({ kind: 'declared', entry, item }))),
      ...(declared.crew ? [{ kind: 'declared', entry, item: declared.crew } as SourceNode] : []),
    ];
    expect(nodes.length).toBeGreaterThan(20);
    const own = nodes.map((n) => tree.getTreeItem(n));
    expectDefined(own, everyTerm.concat(Object.values(DRIFT_STATES).map((d) => d.tip)));
  });
});

const crew = (over: Partial<CrewSummary> = {}): CrewSummary => ({
  name: 'helpdesk', namespace: 'crew-helpdesk', ready: true, phase: 'Ready', agents: 3,
  labels: { 'app.kubernetes.io/managed-by': 'Helm', 'helm.sh/chart': 'helpdesk-0.46.0' },
  annotations: { 'meta.helm.sh/release-name': 'helpdesk', 'crewforge.kubemoot.ai/deployed-at': '2026-11-20T10:00:00Z', 'crewforge.kubemoot.ai/owner': 'me@example.com' },
  conditions: [{ type: 'Ready', status: 'True', reason: 'AgentsReady', message: 'all agents ready' }],
  created: '2026-11-19T10:00:00Z', ...over,
});

function agentObj(name: string, role: string, ready: boolean) {
  const a = obj('Agent', name, 'crew-helpdesk', { discussRole: role, capabilities: ['tool-calling'] }, { 'kubemoot.ai/crew': 'helpdesk' });
  a.status = { ready, phase: ready ? 'Running' : 'Pending' };
  return a;
}

const pageEntry: SourceEntry = { source: { kind: 'helm', root: '/w/helpdesk', label: 'helpdesk' }, identity: { id: 'local:helpdesk' }, crewName: 'helpdesk', chart: { name: 'helpdesk', version: '0.2.2', appVersion: '1.0', description: '' } };
const deps: VitalsDeps = {
  context: () => 'homelab',
  deploymentOf: async (e) => ({ kind: 'deployment', entry: e, deployment: { namespace: 'crew-helpdesk', crew: crew(), channel: 'helm', release: 'helpdesk', linked: true } }),
  liveCrew: async () => crew(),
  located: async () => [{ manifest: obj('Crew', 'helpdesk', 'default', { description: 'Answers questions.' }), file: '/w/helpdesk/templates/crew.yaml', line: 0 }],
  liveDetails: async () => ({ crew: obj('Crew', 'helpdesk', 'crew-helpdesk'), agents: [toAgent(agentObj('helpdesk-coordinator', 'coordinator', true)), toAgent(agentObj('helpdesk-k8s', 'tooler', false))], skills: [], promptModules: [], mcpServers: [], tools: [], related: noRelated(), problems: [] }),
  helm: async () => ({ firstDeployed: '2026-11-19T10:00:00Z', lastDeployed: '2026-11-20T10:00:00Z', revision: 3, status: 'deployed' }),
  conversations: async () => ({ total: 4, turns: 9, active: undefined, errors: [{ at: '2026-11-21T10:05:00Z', text: 'Agent helpdesk-docs failed' }] }),
  fitnessRunning: () => false,
};

/** Parses a page's HTML as the page script shows it. */
const parse = (html: string): HTMLElement => {
  const root = document.createElement('main');
  root.innerHTML = html;
  return root;
};

const suite = {
  kind: 'CrewFitnessSuite', name: 'helpdesk-suite-1', namespace: 'crew-helpdesk', crew: 'helpdesk', phase: 'Running', createdAt: '2026-11-20T09:00:00Z', startedAt: '2026-11-20T09:00:00Z',
  iterationsTotal: 4, iterationsCompleted: 2, passed: 1, failed: 1, errored: 0, assertions: [], runId: 'r1', artifact: { bucket: 'fitness', objectKey: 'k' }, scripts: ['nodes'],
  judge: { phase: 'Pending', judged: 0, total: 1, scores: [] }, scenarios: [{ name: 'nodes', iterations: 2, passed: 1, failed: 1, errored: 0, meanDurationMs: 41000 }], suspend: false,
} as never;
const single = { kind: 'CrewFitness', name: 'one', namespace: 'crew-helpdesk', crew: 'helpdesk', phase: 'Failed', createdAt: '2026-11-20T09:00:00Z', assertions: [{ raw: 'contains "x"', passed: false, message: 'no x' }, { raw: 'ok', passed: true, message: '' }] } as never;

describe('the dashboard pages', () => {
  it('give every heading, column, label, badge, and button a tooltip', async () => {
    const deployed = await gatherVitals({ entry: pageEntry }, deps);
    const none = await gatherVitals({ entry: pageEntry }, { ...deps, deploymentOf: async () => undefined });
    const failed = await gatherVitals({ entry: pageEntry }, { ...deps, deploymentOf: async () => { throw new Error('no connection'); } });
    const zip = fs.readFileSync(path.join(__dirname, 'fixtures', 'memory-export.zip'));
    const report = parseReport(fs.readFileSync(path.join(__dirname, 'fixtures', 'memory-report.json'), 'utf8'))!;
    const live = obj('Agent', 'helpdesk-k8s', 'crew-helpdesk', {});
    const connection = { context: 'homelab', source: 'kubeconfig', crewforge: '0.97.0', kubernetes: 'v1.34', kubemoot: { version: '0.96.0', namespace: 'kubemoot' } } as never;
    const pages: Record<string, string> = {
      crew: renderCrewPage(deployed),
      crewNone: renderCrewPage(none),
      crewFailed: renderCrewPage(failed),
      source: renderCrewPage(deployed, 'source', renderSourceTab([{ manifest: live, file: '/w/a.yaml', line: 0 }, { manifest: obj('Crew', 'x', 'n'), line: 0 }])),
      sourceMissing: renderCrewPage(deployed, 'source', renderSourceTab({ why: 'none', action: { action: 'deploy', label: 'Deploy', title: ACTIONS.deploy } })),
      live: renderCrewPage(deployed, 'live', renderLiveTab([live], false)),
      liveRaw: renderCrewPage(deployed, 'live', renderLiveTab([live], true)),
      diff: renderCrewPage(deployed, 'diff', renderDiffTab(Object.keys(DRIFT_STATES).map((state) => ({ kind: 'Agent', name: state, state, paths: ['spec.x'], live, rendered: obj('Agent', 'helpdesk-k8s', 'n', { a: 1 }) })) as never)),
      overview: renderOverview({ connection, rows: [{ crew: crew(), agentsReady: 2, agentsTotal: 3, chartVersion: '0.46.0', channel: 'helm', lastDeploy: '2026-11-20T10:00:00Z', problems: 1, sourceOpen: true, active: 'Which nodes?' }] }),
      overviewDown: renderOverview({ connection: { ...(connection as object), unreachable: true } as never, rows: [] }),
      fitness: renderFitnessPage({ crew: 'helpdesk', title: 'Help Desk', namespace: 'crew-helpdesk', runs: [suite, single], selected: suite, controls: { suspend: true, cancel: true }, iterations: [], xlsxUrl: 'http://d/x', dashboardRunUrl: 'http://d/f' }),
      fitnessSingle: renderFitnessPage({ crew: 'helpdesk', title: 'Help Desk', namespace: 'crew-helpdesk', runs: [single], selected: single, controls: { suspend: true, cancel: true }, iterations: [], error: 'cannot read' }),
      memory: renderMemoryPage({ crew: 'helpdesk', title: 'Help Desk', namespace: 'crew-helpdesk', context: 'homelab', parsed: parseExport(zip), report }),
      memoryFailed: renderMemoryPage({ crew: 'helpdesk', title: 'Help Desk', namespace: 'crew-helpdesk', context: 'homelab', error: 'no', contextProblem: true }),
    };
    for (const [name, html] of Object.entries(pages)) expect(controlsWithoutTooltip(parse(html)), name).toEqual([]);
  });

  it('opens the page with the definition of its term', async () => {
    const deployed = await gatherVitals({ entry: pageEntry }, deps);
    expect(parse(renderCrewPage(deployed)).querySelector('h1')?.getAttribute('title')).toBe(TERMS.crew);
    expect(parse(renderMemoryPage({ crew: 'h', title: 'H', namespace: 'n', context: 'c', error: 'x' })).querySelector('h1')?.getAttribute('title')).toBe(TERMS.memory);
  });
});

describe('the checker', () => {
  it('finds a control without a tooltip, one that repeats its text, and an icon with no name', () => {
    const html = '<button>Go</button><button title="Go">Go</button><button title="Does a thing"></button><button title="Does it" aria-label="Do">x</button><h2>T</h2><span class="badge">ok</span>';
    expect(controlsWithoutTooltip(parse(`${html}<table><tr><th>c</th></tr></table>`))).toEqual([
      '<button> "Go" has no tooltip',
      '<button> "Go" has a tooltip that only repeats its text',
      '<button> "" is icon-only and has no aria-label',
      '<h2> "T" has no tooltip',
      '<span> "ok" has no tooltip',
      '<th> "c" has no tooltip',
    ]);
  });

  it('passes a control with a tooltip, text, and a name', () => {
    expect(controlsWithoutTooltip(parse('<button title="Does it" aria-label="Do"><svg></svg></button><a id="x" title="Opens it">Open</a>'))).toEqual([]);
  });
});

describe('the shared wording', () => {
  it('says one thing for the same action everywhere', () => {
    expect(NEXT_STEPS.ask).toBe(ACTIONS.ask);
    expect(NEXT_STEPS.deploy).toBe(ACTIONS.deployShort);
    expect(ACTIONS.stopSuite).toContain(STOP_EFFECTS.suite);
    expect(ACTIONS.stopSingle).toContain(STOP_EFFECTS.single);
  });

  it('names the crew and the conversation in the chat page tooltips', () => {
    expect(conversationTitleTip('lab-ops')).toBe(`Crew lab-ops. ${TERMS.crew}`);
    expect(openConversationTip('Which nodes?', '5m ago')).toBe('Open the conversation "Which nodes?", started 5m ago');
  });
});

describe('the chat icons', () => {
  it('each say what they do and what they affect', () => {
    expect(CHAT.erase.what).toContain('asks first');
    expect(CHAT.delete.what).toContain('saved copy only');
  });
});
