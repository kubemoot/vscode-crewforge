// Walks package.json's tree item menus: every action sits in a group, the groups follow one order, and each kind of item has the actions people expect.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DASHBOARD_KINDS } from '../src/views/nodeFacts';
import { SourceTreeProvider } from '../src/views/sourceTree';
import type { SourceEntry, SourceService } from '../src/source/service';
import { resetFake } from './vscodeFake';

interface Entry {
  command: string;
  when?: string;
  group?: string;
}
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
  contributes: { commands: { command: string; title: string }[]; menus: Record<string, Entry[]> };
};
const MENU = manifest.contributes.menus['view/item/context'];

/** The agreed order of the groups of a menu: open, view, crew actions, edit, copy, reveal, destructive. */
const GROUPS = ['1_open', '1_view', '2_crew', '3_edit', '5_copy', '6_reveal', '9_delete'];
const DESTRUCTIVE = ['removeDeployment', 'deleteSource', 'deleteScenario', 'removeFromSource', 'stopRun'];
const COPY = ['copyName', 'copyNamespacedName', 'copyYaml', 'copyPath', 'copyRelativePath'];
const REVEAL = ['revealInExplorerView', 'revealInOS', 'openInSourceControl'];

/** Evaluates a `when` clause against a view, an item's context value, and the settings, as the editor does for these clauses. */
function holds(when: string, view: string, viewItem: string, dashboardUrl: string, multi = false): boolean {
  const js = when
    .replace(/(\w+) =~ \/((?:[^/\\]|\\.)*)\//g, (_m, key: string, re: string) => `new RegExp(${JSON.stringify(re)}).test(ctx.${key})`)
    .replace(/config\.crewforge\.dashboardUrl != ''/g, 'ctx.dashboard !== ""')
    .replace(/(\w+) == ([\w.-]+)/g, (_m, key: string, v: string) => `ctx.${key} === ${JSON.stringify(v)}`)
    .replace(/listMultiSelection/g, 'ctx.multi');
  return new Function('ctx', `return Boolean(${js});`)({ view, viewItem, dashboard: dashboardUrl, multi }) as boolean;
}

/** The menu of an item, in the order the editor shows it: by group, then by the number after the @. */
function menuOf(view: 'sources' | 'crews', viewItem: string, dashboardUrl = 'http://d', multi = false): { group: string; command: string }[] {
  return MENU.filter((m) => holds(m.when ?? '', `crewforge.${view}`, viewItem, dashboardUrl, multi))
    .map((m) => ({ group: m.group ?? '', command: m.command.replace('crewforge.', '') }))
    .sort((a, b) => groupKey(a.group).localeCompare(groupKey(b.group), 'en', { numeric: true }));
}

const groupKey = (g: string) => (g.includes('@') ? g : `${g}@0`);
const groupName = (g: string) => g.split('@')[0];
const inGroup = (menu: ReturnType<typeof menuOf>, group: string) => menu.filter((m) => groupName(m.group) === group).map((m) => m.command);

/** Every kind of tree item, by view and context value, and what its menu must hold. */
const KINDS: { view: 'sources' | 'crews'; item: string; expect: Record<string, string[]> }[] = [
  { view: 'sources', item: 'source-helm', expect: { '1_open': ['openCrewDashboard', 'openChartFile', 'openInTerminal'], '2_crew': ['deployToNamespace', 'redeploy', 'deploySource', 'runFitness', 'lintCrew'], '5_copy': ['copyName', 'copyPath', 'copyRelativePath'], '6_reveal': ['revealInExplorerView', 'revealInOS', 'openInSourceControl'], '9_delete': ['removeDeployment', 'deleteSource'] } },
  { view: 'sources', item: 'source-bundle-ready-changed', expect: { '1_open': ['openCrewDashboard', 'openSourceFile', 'openInTerminal'], '2_crew': ['askSource', 'redeploy'], '3_edit': ['renameCrew'], '5_copy': ['copyName', 'copyPath', 'copyRelativePath'], '6_reveal': ['revealInExplorerView', 'revealInOS'] } },
  { view: 'sources', item: 'deployment-helm', expect: { '1_open': ['openCrewDashboard', 'openInDashboard'], '2_crew': ['updateDeployment', 'deployRevision', 'runFitness'], '5_copy': ['copyName', 'copyNamespacedName'], '9_delete': ['removeDeployment'] } },
  { view: 'sources', item: 'deployment-flux', expect: { '2_crew': ['updateDeployment', 'deployRevision', 'runFitness', 'followRollout'], '5_copy': ['copyName', 'copyNamespacedName'] } },
  { view: 'sources', item: 'resource-changed', expect: { '1_open': ['showDrift', 'showSourceYaml', 'showLiveYaml', 'showLiveYamlRaw'], '2_crew': ['applyResource'], '5_copy': ['copyName', 'copyNamespacedName', 'copyYaml'] } },
  { view: 'sources', item: 'resource-missing', expect: { '1_open': ['showDrift', 'showSourceYaml'], '2_crew': ['applyResource'], '5_copy': ['copyName', 'copyNamespacedName'] } },
  { view: 'sources', item: 'fitness', expect: { '1_open': ['openFitnessDashboard', 'openInDashboard'], '2_crew': ['runFitness', 'runScenarioBatch'], '3_edit': ['addScenario'] } },
  { view: 'sources', item: 'run', expect: { '1_open': ['openFitnessDashboard', 'openInDashboard'], '5_copy': ['copyName', 'copyNamespacedName', 'copyYaml'] } },
  { view: 'sources', item: 'declSection-agents', expect: { '3_edit': ['addAgent'] } },
  { view: 'sources', item: 'declSection-fitness', expect: { '2_crew': ['runScenarioBatch'], '3_edit': ['addScenario'] } },
  { view: 'sources', item: 'declared-scenario', expect: { '1_open': ['openSourceFile'], '2_crew': ['runScenario'], '3_edit': ['renameScenario'], '5_copy': ['copyName', 'copyPath', 'copyRelativePath'], '6_reveal': ['revealInExplorerView', 'revealInOS'], '9_delete': ['deleteScenario'] } },
  { view: 'sources', item: 'declared-object', expect: { '1_open': ['openSourceFile'], '5_copy': ['copyName', 'copyPath', 'copyRelativePath'], '6_reveal': ['revealInExplorerView', 'revealInOS'], '9_delete': ['removeFromSource'] } },
  { view: 'sources', item: 'declared-file', expect: { '1_open': ['openSourceFile'], '5_copy': ['copyName', 'copyPath', 'copyRelativePath'], '6_reveal': ['revealInExplorerView', 'revealInOS'] } },
  { view: 'sources', item: 'declared', expect: { '5_copy': ['copyName'] } },
  { view: 'sources', item: 'sourceFile', expect: { '1_open': ['openSourceFile', 'diffFileWithLive'], '5_copy': ['copyName', 'copyPath', 'copyRelativePath'], '6_reveal': ['revealInExplorerView', 'revealInOS', 'openInSourceControl'] } },
  { view: 'sources', item: 'sourceFolder', expect: { '1_open': ['openInTerminal'], '5_copy': ['copyName', 'copyPath', 'copyRelativePath'], '6_reveal': ['revealInExplorerView', 'revealInOS', 'openInSourceControl'] } },
  { view: 'sources', item: 'sourceFiles', expect: { '1_open': ['openInTerminal'], '6_reveal': ['revealInExplorerView', 'revealInOS', 'openInSourceControl'] } },
  { view: 'crews', item: 'connection', expect: { '1_open': ['showConnectionInfo', 'openCrewsOverview'] } },
  { view: 'crews', item: 'namespace', expect: { '5_copy': ['copyName'] } },
  { view: 'crews', item: 'crew-flux', expect: { '1_open': ['openCrewDashboard', 'openInDashboard', 'openFitnessDashboard', 'openCrewMemory', 'openSourceFile'], '1_view': ['showLiveYaml', 'showCrewBundleYaml', 'showLiveYamlRaw'], '2_crew': ['askCrew', 'updateDeployment', 'deployRevision', 'runFitness', 'followRollout'], '5_copy': ['copyName', 'copyNamespacedName', 'copyYaml'], '6_reveal': ['revealInExplorerView', 'revealInOS'] } },
  { view: 'crews', item: 'crew', expect: { '2_crew': ['askCrew'], '9_delete': ['removeDeployment'] } },
  { view: 'crews', item: 'crewSection-fitness', expect: { '2_crew': ['runDeployedFitness', 'runScenarioBatch'] } },
  { view: 'crews', item: 'liveObject-Agent', expect: { '1_open': ['openInDashboard', 'openSourceFile'], '1_view': ['showLiveYaml', 'showLiveYamlRaw'], '5_copy': ['copyName', 'copyNamespacedName', 'copyYaml'], '6_reveal': ['revealInExplorerView', 'revealInOS'] } },
  { view: 'crews', item: 'liveObject-PromptModule', expect: { '1_open': ['openInDashboard', 'openSourceFile'], '5_copy': ['copyName', 'copyNamespacedName', 'copyYaml'] } },
  { view: 'crews', item: 'liveObject-Model-shared', expect: { '1_open': ['openInDashboard'], '1_view': ['showLiveYaml'], '5_copy': ['copyName', 'copyNamespacedName', 'copyYaml'] } },
  { view: 'crews', item: 'liveObject-CrewFitnessSuite-run-pause-stop', expect: { '1_open': ['openInDashboard'], '2_crew': ['pauseRun'], '5_copy': ['copyName', 'copyYaml'], '9_delete': ['stopRun'] } },
  { view: 'crews', item: 'liveObject-CrewFitness-run-resume-stop', expect: { '2_crew': ['resumeRun'], '9_delete': ['stopRun'] } },
  { view: 'crews', item: 'liveScenario', expect: { '1_open': ['showDeployedScenario'], '2_crew': ['runDeployedScenario'], '5_copy': ['copyName', 'copyNamespacedName'] } },
  { view: 'crews', item: 'tool', expect: { '1_open': ['showToolDetails'], '5_copy': ['copyName'] } },
];

describe('the menus of the tree items', () => {
  it('puts every action of every item in a group, and only in the agreed groups', () => {
    for (const m of MENU) {
      expect(m.group, `${m.command} has no group (${m.when})`).toBeTruthy();
      const name = groupName(m.group ?? '');
      expect(name === 'inline' || GROUPS.includes(name), `${m.command}: group ${m.group} is not one of ${GROUPS.join(', ')}`).toBe(true);
    }
  });

  it('orders the groups so the editor shows open, view, crew actions, edit, copy, reveal, then destructive actions', () => {
    expect([...GROUPS].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))).toEqual(GROUPS);
    for (const { view, item } of KINDS) {
      const order = menuOf(view, item).map((m) => groupName(m.group)).filter((g) => g !== 'inline');
      const seen = [...new Set(order)];
      expect(seen, `${item}`).toEqual(GROUPS.filter((g) => seen.includes(g)));
    }
  });

  it.each(KINDS)('gives $item the actions people expect, each in its group', ({ view, item, expect: expected }) => {
    const menu = menuOf(view, item);
    for (const [group, commands] of Object.entries(expected)) {
      for (const command of commands) expect(inGroup(menu, group), `${item}: ${command} in ${group}`).toContain(command);
    }
  });

  it('keeps copy actions in Copy, reveal actions in Reveal, and destructive actions last and alone', () => {
    for (const m of MENU) {
      const command = m.command.replace('crewforge.', '');
      const name = groupName(m.group ?? '');
      if (name === 'inline') continue;
      if (COPY.includes(command)) expect(name, command).toBe('5_copy');
      if (REVEAL.includes(command)) expect(name, command).toBe('6_reveal');
      if (DESTRUCTIVE.includes(command)) expect(name, command).toBe('9_delete');
      if (name === '9_delete') expect(DESTRUCTIVE, command).toContain(command);
      if (name === '5_copy') expect(COPY, command).toContain(command);
    }
  });

  it('offers no action twice in one menu', () => {
    for (const { view, item } of KINDS) {
      const menu = menuOf(view, item).filter((m) => groupName(m.group) !== 'inline');
      const keys = menu.map((m) => m.command);
      expect(new Set(keys).size, `${item}: ${keys.join(', ')}`).toBe(keys.length);
    }
  });

  it('shows Open in Kubemoot Dashboard only when the setting holds the address, and only on kinds with a page', () => {
    expect(menuOf('crews', 'liveObject-Agent', '').map((m) => m.command)).not.toContain('openInDashboard');
    expect(menuOf('crews', 'liveObject-Agent', 'http://d').map((m) => m.command)).toContain('openInDashboard');
    expect(menuOf('crews', 'liveObject-Skill').map((m) => m.command)).not.toContain('openInDashboard');
    for (const kind of DASHBOARD_KINDS.filter((k) => k !== 'Crew')) expect(menuOf('crews', `liveObject-${kind}`).map((m) => m.command), kind).toContain('openInDashboard');
  });

  it('offers Run Selected Scenarios only with several rows selected', () => {
    expect(menuOf('crews', 'liveScenario').map((m) => m.command)).not.toContain('runSelectedScenarios');
    expect(menuOf('crews', 'liveScenario', 'http://d', true).map((m) => m.command)).toContain('runSelectedScenarios');
  });

  it('keeps menus off the items they do not apply to', () => {
    expect(menuOf('crews', 'crewSection-agents')).toEqual([]);
    expect(menuOf('crews', 'liveObject-ModelServer-shared').map((m) => m.command)).not.toContain('openSourceFile');
    expect(menuOf('crews', 'liveObject-HelmRelease').map((m) => m.command)).not.toContain('revealInOS');
    expect(menuOf('sources', 'source-helm').map((m) => m.command)).not.toContain('copyYaml');
    expect(menuOf('crews', 'liveObject-Agent').map((m) => m.command)).not.toContain('removeDeployment');
  });

  it('hides every standard action from the Command Palette, since each needs the item it was chosen on', () => {
    const hidden = new Set(manifest.contributes.menus.commandPalette.filter((m) => m.when === 'false').map((m) => m.command));
    for (const command of [...COPY, ...REVEAL, 'openInTerminal', 'openSourceFile', 'openChartFile', 'openInDashboard', 'diffFileWithLive']) expect(hidden.has(`crewforge.${command}`), command).toBe(true);
  });
});

describe('Ask on a crew source', () => {
  it('shows Ask, inline and in the menu, only on a source whose crew is deployed and Ready', () => {
    for (const item of ['source-helm', 'source-bundle', 'source-helm-changed', 'source-bundle-running']) {
      const menu = menuOf('sources', item);
      expect(menu.map((m) => m.command), item).not.toContain('askSource');
    }
    for (const item of ['source-helm-ready', 'source-bundle-ready-changed', 'source-helm-ready-running']) {
      const menu = menuOf('sources', item);
      expect(menu.filter((m) => m.command === 'askSource').map((m) => groupName(m.group)).sort(), item).toEqual(['2_crew', 'inline']);
    }
  });

  it('leaves Deploy as the only inline action of an undeployed source', () => {
    expect(menuOf('sources', 'source-bundle').filter((m) => groupName(m.group) === 'inline').map((m) => m.command)).toEqual(['deployToNamespace']);
  });

  it('puts "ready" in the context value of a source only when its state says Ready', () => {
    resetFake();
    const provider = new SourceTreeProvider({} as SourceService, () => ({}) as never);
    const node = { kind: 'source', entry: { source: { kind: 'bundle', root: '/w/hello', label: 'hello' }, identity: { id: 'x' } } as unknown as SourceEntry } as const;
    const value = (state?: { text: string; changed: boolean; ready?: boolean }) => {
      provider.stateOf = () => state;
      return provider.getTreeItem(node).contextValue;
    };
    expect(value()).toBe('source-bundle');
    expect(value({ text: 'not deployed', changed: false })).toBe('source-bundle');
    expect(value({ text: 'deployed in a, in sync', changed: false, ready: false })).toBe('source-bundle');
    expect(value({ text: 'deployed in a, in sync', changed: false, ready: true })).toBe('source-bundle-ready');
    expect(value({ text: 'deployed in a, changed', changed: true, ready: true })).toBe('source-bundle-ready-changed');
  });
});
