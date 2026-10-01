import { describe, expect, it } from 'vitest';
import { isTab, renderDiffTab, renderLiveTab, renderSourceTab, tabBar, tabBody, type TabReads } from '../src/dashboard/crewTabs';
import { DEPLOY_TO_NAMESPACE, OPEN_SOURCE_FOLDER } from '../src/dashboard/html';
import type { CrewVitals } from '../src/dashboard/crewVitals';
import type { ResourceDrift } from '../src/source/drift';
import { DIFF_LINE_LIMIT, lineDiff } from '../src/source/lineDiff';
import { crewObjects, discoverKinds } from '../src/source/live';
import type { SourceEntry } from '../src/source/service';
import { FakeCluster, obj, seedCrew } from './fakeCluster';

const entry = { source: { kind: 'helm', root: '/w/demo', label: 'demo' }, identity: { id: 'local:demo' }, crewName: 'demo' } as SourceEntry;
const crew = { name: 'demo', namespace: 'crew-demo', ready: true, phase: 'Ready' };
const deployment = { namespace: 'crew-demo', crew, channel: 'helm' as const, linked: true };
const base = { name: 'demo', context: 'lab', agents: [], agentsFrom: 'none', models: [], conversations: { total: 0, turns: 0, errors: [] }, fitnessRunning: false } as unknown as CrewVitals;

const rendered = obj('Agent', 'demo-coordinator', 'crew-demo', { discussRole: 'coordinator', capabilities: ['reasoning'] });
const live = { ...obj('Agent', 'demo-coordinator', 'crew-demo', { discussRole: 'coordinator', capabilities: ['tool-calling'] }), status: { ready: true } };
const drift: ResourceDrift[] = [
  { kind: 'Agent', name: 'demo-coordinator', state: 'changed', paths: ['spec.capabilities[0]'], rendered, live },
  { kind: 'Crew', name: 'demo', state: 'in-sync', paths: [], rendered: obj('Crew', 'demo', 'crew-demo'), live: obj('Crew', 'demo', 'crew-demo') },
  { kind: 'Skill', name: 'gone', state: 'extra', paths: [], live: obj('Skill', 'gone', 'crew-demo') },
  { kind: 'PromptModule', name: 'new', state: 'missing', paths: [], rendered: obj('PromptModule', 'new', 'crew-demo', { content: '<b>' }) },
];

const reads = (objects = [live]): TabReads & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    located: async () => (calls.push('located'), [{ manifest: rendered, file: '/w/demo/templates/agents.yaml', line: 4 }, { manifest: obj('Crew', 'demo', 'x'), line: 0 }]),
    crewObjects: async (ns, name) => (calls.push(`objects ${ns}/${name}`), objects),
  };
};

describe('a line diff', () => {
  it('keeps common lines and marks the rest removed or added, removals first', () => {
    expect(lineDiff('a\nb\nc\n', 'a\nx\nc\n')).toEqual([
      { op: ' ', text: 'a' },
      { op: '-', text: 'b' },
      { op: '+', text: 'x' },
      { op: ' ', text: 'c' },
    ]);
    expect(lineDiff('', 'a')).toEqual([{ op: '+', text: 'a' }]);
    expect(lineDiff('a\nb', '')).toEqual([{ op: '-', text: 'a' }, { op: '-', text: 'b' }]);
    expect(lineDiff('a\nb', 'b\nc')).toEqual([{ op: '-', text: 'a' }, { op: ' ', text: 'b' }, { op: '+', text: 'c' }]);
  });

  it('compares texts too long to line up as one block each', () => {
    const long = Array.from({ length: DIFF_LINE_LIMIT + 1 }, (_, i) => `l${i}`).join('\n');
    const diff = lineDiff(long, 'x');
    expect(diff.filter((l) => l.op === '-')).toHaveLength(DIFF_LINE_LIMIT + 1);
    expect(diff.at(-1)).toEqual({ op: '+', text: 'x' });
  });
});

describe('the crew dashboard tabs', () => {
  it('names each tab and marks the shown one', () => {
    const bar = tabBar('live');
    expect(bar.match(/data-action="tab"/g)).toHaveLength(4);
    expect(bar).toContain('class="tab selected" role="tab" aria-selected="true" data-action="tab" data-arg="live"');
    expect(isTab('diff')).toBe(true);
    expect(isTab('evil')).toBe(false);
    expect(isTab(undefined)).toBe(false);
  });

  it('Source lists the rendered objects by kind, each a link to its file, and says when there is no source', async () => {
    const r = reads();
    const html = await tabBody('source', { ...base, source: entry }, r, false);
    expect(html).toContain('<h2>Agent (1)</h2>');
    expect(html).toContain('data-action="openAt" data-arg="0" title="Open /w/demo/templates/agents.yaml:5"');
    expect(html).toContain('not in a file');
    expect(renderSourceTab([])).toContain('renders no objects');
    const none = await tabBody('source', base, r, false);
    expect(none).toContain('No local source is open for this crew');
    expect(none).toContain(`data-action="${OPEN_SOURCE_FOLDER.action}"`);
  });

  it('Live shows the live objects normalized or raw, from the drift or by the crew label, and why when not deployed', async () => {
    const r = reads();
    const normalized = await tabBody('live', { ...base, source: entry, deployment, drift }, r, false);
    expect(normalized).toContain('Normalized:');
    expect(normalized).not.toContain('ready: true');
    expect(normalized).toContain('<h2>Skill (1)</h2>');
    expect(normalized).toContain('data-action="raw"');
    expect(r.calls).toEqual([]);
    const raw = await tabBody('live', { ...base, deployment }, r, true);
    expect(raw).toContain('Raw:');
    expect(raw).toContain('ready: true');
    expect(r.calls).toEqual(['objects crew-demo/demo']);
    expect(renderLiveTab([], false)).toContain('No live objects of this crew.');
    const notDeployed = await tabBody('live', { ...base, source: entry }, r, false);
    expect(notDeployed).toContain('demo is not deployed in lab.');
    expect(notDeployed).toContain(`data-action="${DEPLOY_TO_NAMESPACE.action}"`);
    expect(await tabBody('live', base, r, false)).not.toContain('data-action="deploy"');
    const unknown = await tabBody('live', { ...base, deploymentError: 'No response from context lab.' }, r, false);
    expect(unknown).toContain('Cannot tell where demo is deployed: No response from context lab.');
    expect(unknown).toContain('data-action="selectContext"');
  });

  it('Diff shows each differing object with its inline diff and a diff editor button, and why when it cannot', async () => {
    const r = reads();
    const html = await tabBody('diff', { ...base, source: entry, deployment, drift }, r, false);
    expect(html).toContain('3 of 4 objects differ; 1 in sync.');
    expect(html).toContain('Agent/demo-coordinator <span class="badge warn">changed in source</span>');
    expect(html).toContain('<span class="removed">-     - tool-calling</span>');
    expect(html).toContain('<span class="added">+     - reasoning</span>');
    expect(html).toContain('data-action="openDiff" data-arg="Agent/demo-coordinator"');
    expect(html).toContain('in source, not deployed');
    expect(html).toContain('deployed, not in source');
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain('Changed: spec.capabilities[0]');
    expect(renderDiffTab([drift[1]])).toContain('The deployment matches its source.');
    expect(await tabBody('diff', base, r, false)).toContain('No local source is open');
    expect(await tabBody('diff', { ...base, source: entry }, r, false)).toContain('demo is not deployed in lab.');
    expect(await tabBody('diff', { ...base, source: entry, deployment, driftError: 'render failed' }, r, false)).toContain('Cannot compare the source with the deployment: render failed');
    expect(await tabBody('diff', { ...base, source: entry, deployment }, r, false)).toContain('the comparison did not run');
  });
});

describe("a crew's live objects without a source", () => {
  it('are its Crew and the unowned objects with its label, in kind and name order', async () => {
    const cluster = seedCrew(new FakeCluster());
    const owned = obj('PromptModule', 'resume', 'team-a', {}, { 'kubemoot.ai/crew': 'lab-ops' });
    owned.metadata.ownerReferences = [{ kind: 'Crew', name: 'lab-ops' }];
    cluster.add(owned);
    cluster.failures.set('/apis/kubemoot.ai/v1alpha1/namespaces/team-a/models', new Error('forbidden'));
    const objects = await crewObjects(cluster, await discoverKinds(cluster), 'team-a', 'lab-ops');
    expect(objects.map((m) => `${m.kind}/${m.metadata.name}`)).toEqual(['Agent/coordinator', 'Agent/k8s', 'Crew/lab-ops', 'Skill/runbook']);
  });
});
