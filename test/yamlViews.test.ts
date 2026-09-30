import { beforeEach, describe, expect, it } from 'vitest';
import type { KubeClient } from '../src/k8s/request';
import type { Manifest } from '../src/source/manifests';
import { chartVersionBanner, normalizeForDiff, normalizedYaml, sortKeys } from '../src/source/normalize';
import { readChart, type SourceEntry } from '../src/source/service';
import type { Located } from '../src/source/locate';
import { LiveDocuments } from '../src/views/liveDocuments';
import { MANIFEST_SCHEME, ManifestDocuments } from '../src/views/manifestDocuments';
import type { SourceNode } from '../src/views/sourceTree';
import { YamlCommands } from '../src/views/yamlCommands';
import { FakeCluster, obj, seedCrew } from './fakeCluster';
import { recorded, resetFake, Uri } from './vscodeFake';

beforeEach(resetFake);

/** An Agent as the source renders it. */
function rendered(): Manifest {
  return {
    apiVersion: 'kubemoot.ai/v1alpha1',
    kind: 'Agent',
    metadata: { name: 'coordinator', namespace: 'crew-demo', labels: { 'kubemoot.ai/crew': 'demo', 'app.kubernetes.io/managed-by': 'Helm' } },
    spec: { promptRefs: ['rules'], discussRole: 'coordinator', capabilities: ['reasoning'] },
  };
}

/** The same Agent as the cluster holds it after a Flux-driven Helm release and the operator. */
function live(spec: Record<string, unknown> = rendered().spec as Record<string, unknown>): Manifest {
  return {
    kind: 'Agent',
    apiVersion: 'kubemoot.ai/v1alpha1',
    status: { ready: true, phase: 'Running' },
    spec: { capabilities: ['reasoning'], discussRole: 'coordinator', ...spec },
    metadata: {
      uid: 'u-1',
      resourceVersion: '991',
      generation: 4,
      creationTimestamp: '2026-09-30T10:00:00Z',
      managedFields: [{ manager: 'helm-controller' }],
      finalizers: ['kubemoot.ai/agent'],
      namespace: 'crew-demo',
      name: 'coordinator',
      annotations: {
        'meta.helm.sh/release-name': 'demo',
        'meta.helm.sh/release-namespace': 'crew-demo',
        'kubectl.kubernetes.io/last-applied-configuration': '{}',
        'crewforge.kubemoot.ai/deployed-at': 'T',
      },
      labels: {
        'helm.toolkit.fluxcd.io/name': 'demo',
        'helm.toolkit.fluxcd.io/namespace': 'flux-system',
        'helm.sh/chart': 'demo-0.46.0-rc.0',
        'app.kubernetes.io/version': '0.46.0-rc.0',
        'kubemoot.ai/crew-version': '0.46.0-rc.0',
        'app.kubernetes.io/managed-by': 'Helm',
        'kubemoot.ai/crew': 'demo',
      },
    },
  };
}

describe('normalizeForDiff', () => {
  it('removes what the cluster, Helm, Flux, the operator, and CrewForge add, so an unchanged object compares equal', () => {
    expect(normalizedYaml(live())).toBe(normalizedYaml(rendered()));
    const n = normalizeForDiff(live()) as { metadata: Record<string, unknown> };
    expect(Object.keys(n)).toEqual(['apiVersion', 'kind', 'metadata', 'spec']);
    expect(n.metadata).toEqual({ labels: { 'app.kubernetes.io/managed-by': 'Helm', 'kubemoot.ai/crew': 'demo' }, name: 'coordinator', namespace: 'crew-demo' });
  });

  it('keeps real spec drift and a label or annotation a person set', () => {
    const drifted = live({ promptRefs: ['rules', 'extra'] });
    drifted.metadata.annotations = { ...drifted.metadata.annotations, 'team.example/owner': 'ops' };
    const text = normalizedYaml(drifted);
    expect(text).not.toBe(normalizedYaml(rendered()));
    expect(text).toContain('- extra');
    expect(text).toContain('team.example/owner: ops');
  });

  it('sorts keys at every depth and keeps array order', () => {
    expect(JSON.stringify(sortKeys({ b: 1, a: [{ z: 1, y: 2 }, 3], c: null }))).toBe('{"a":[{"y":2,"z":1},3],"b":1,"c":null}');
  });

  it('says when the source and deployed chart versions differ, and only then', () => {
    expect(chartVersionBanner('0.2.2', '0.46.0-rc.0')).toBe('Chart version differs: source 0.2.2, deployed 0.46.0-rc.0');
    expect(chartVersionBanner('0.2.2', '0.2.2')).toBeUndefined();
    expect(chartVersionBanner(undefined, '0.2.2')).toBeUndefined();
    expect(chartVersionBanner('0.2.2', undefined)).toBeUndefined();
  });
});

describe('readChart', () => {
  it('reads name, version, appVersion, and description, and nothing from a bad file', async () => {
    const text = async () => 'name: demo\nversion: 0.2.2\nappVersion: 1.10\ndescription: A crew\n';
    expect(await readChart('/w/demo', text)).toEqual({ name: 'demo', version: '0.2.2', appVersion: '1.10', description: 'A crew' });
    expect(await readChart('/w/demo', async () => 'name: [1]\n')).toEqual({ name: undefined, version: undefined, appVersion: undefined, description: undefined });
    expect(await readChart('/w/demo', async () => '')).toEqual({ name: undefined, version: undefined, appVersion: undefined, description: undefined });
    expect(await readChart('/w/demo', async () => Promise.reject(new Error('ENOENT')))).toBeUndefined();
  });
});

const drift = { kind: 'Agent', name: 'coordinator', state: 'changed' as const, paths: ['spec.promptRefs'], live: live({ promptRefs: ['old'] }), rendered: rendered() };
const text = (docs: ManifestDocuments, uri: unknown) => docs.provideTextDocumentContent(uri as never);

describe('ManifestDocuments', () => {
  it('opens normalized live and source YAML side by side, with the chart version banner on top of both', async () => {
    const docs = new ManifestDocuments();
    const view = { namespace: 'crew-demo', drift, versions: { source: '0.2.2', deployed: '0.46.0-rc.0' } };
    await docs.showDrift(view);
    const [left, right, title] = recorded.executed[0].args as [Uri, Uri, string];
    expect(left.toString()).toBe(`${MANIFEST_SCHEME}:/live/crew-demo/Agent-coordinator.yaml`);
    expect(title).toBe('Agent/coordinator: live in crew-demo vs source (Chart version differs: source 0.2.2, deployed 0.46.0-rc.0)');
    for (const side of [left, right]) expect(text(docs, side).split('\n')[0]).toBe('# Chart version differs: source 0.2.2, deployed 0.46.0-rc.0');
    expect(text(docs, left)).toContain('- old');
    expect(text(docs, left)).not.toContain('resourceVersion');
    expect(text(docs, right)).toContain('- rules');
    expect(docs.viewOf(right as never)).toBe(view);
    await docs.showDrift({ namespace: 'ns', drift: { kind: 'Agent', name: 'a', state: 'missing', paths: [] } });
    const [l2, r2, t2] = recorded.executed[1].args as [Uri, Uri, string];
    expect(t2).toBe('Agent/a: live in ns vs source');
    expect(text(docs, l2)).toMatch(/^# Normalized: .*\n# not deployed\n$/);
    expect(text(docs, r2)).toMatch(/# not in the source\n$/);
    expect(text(docs, Uri.parse('crewforge-manifest:/nothing'))).toBe('');
    expect(docs.viewOf(Uri.parse('crewforge-manifest:/nothing') as never)).toBeUndefined();
  });

  it('shows the rendered object read-only with a link to its file, and opens the file when asked', async () => {
    const docs = new ManifestDocuments();
    recorded.infoAnswers.push('Open Source File');
    await docs.showSource({ namespace: 'crew-demo', drift, at: { file: '/w/demo/templates/agents.yaml', line: 20 } });
    const uri = 'crewforge-manifest:/rendered/crew-demo/Agent-coordinator.yaml';
    expect(recorded.shownDocuments).toEqual([`${uri} (yaml)`]);
    const shown = text(docs, Uri.parse(uri));
    expect(shown).toContain('# Edit it in file:///w/demo/templates/agents.yaml#L21');
    expect(shown).toContain('- rules');
    expect(recorded.executed.map((e) => e.id)).toEqual(['vscode.open']);
    expect((recorded.executed[0].args[1] as { selection: { startLine: number } }).selection.startLine).toBe(20);
  });

  it('shows a source view without a link when the file is unknown, and says when the source does not render the object', async () => {
    const docs = new ManifestDocuments();
    await docs.showSource({ namespace: 'ns', drift: { ...drift, rendered: undefined, state: 'extra' } });
    expect(text(docs, Uri.parse('crewforge-manifest:/rendered/ns/Agent-coordinator.yaml'))).toContain('The source does not render this object');
    expect(recorded.info).toEqual([]);
    recorded.infoAnswers.push(undefined);
    await docs.showSource({ namespace: 'ns', drift, at: { file: '/f.yaml', line: 0 } });
    expect(recorded.executed).toEqual([]);
  });
});

describe('YamlCommands', () => {
  const entry: SourceEntry = { source: { kind: 'helm', root: '/w/demo', label: 'demo' }, identity: { id: 'local:demo' }, crewName: 'demo', chart: { version: '0.2.2' } };
  const crew = { name: 'demo', namespace: 'crew-demo', ready: true, phase: 'Ready', labels: { 'helm.sh/chart': 'demo-0.46.0-rc.0' } };
  const resource: SourceNode = { kind: 'resource', entry, deployment: { namespace: 'crew-demo', crew, channel: 'helm', linked: true }, drift };
  let cluster: FakeCluster;
  let docs: ManifestDocuments;
  let liveDocs: LiveDocuments;
  let located: Located[] | Error;

  beforeEach(() => {
    cluster = seedCrew(new FakeCluster(), 'crew-demo');
    docs = new ManifestDocuments();
    liveDocs = new LiveDocuments(() => ({ source: '/k', context: 'lab', client: cluster as unknown as KubeClient }));
    located = [{ manifest: obj('Agent', 'other', 'crew-demo'), line: 0 }, { manifest: rendered(), file: '/w/demo/templates/agents.yaml', line: 20 }];
  });

  const commands = () =>
    new YamlCommands(docs, liveDocs, {
      located: async () => {
        if (located instanceof Error) throw located;
        return located;
      },
    });

  it('compares a resource with its chart versions and source location', async () => {
    await commands().compare(resource);
    const [, right, title] = recorded.executed[0].args as [Uri, Uri, string];
    expect(title).toContain('source 0.2.2, deployed 0.46.0-rc.0');
    expect(docs.viewOf(right as never)?.at).toEqual({ file: '/w/demo/templates/agents.yaml', line: 20 });
    await commands().compare(right as never);
    expect(recorded.executed).toHaveLength(2);
  });

  it('shows the source YAML of a resource or of the diff document, and nothing for anything else', async () => {
    await commands().showSource(resource);
    await commands().compare(resource);
    const [live] = recorded.executed[0].args as [Uri];
    await commands().showSource(live as never);
    await commands().showSource({ kind: 'message', text: 'x' });
    await commands().showSource(undefined);
    expect(recorded.shownDocuments).toEqual(['crewforge-manifest:/rendered/crew-demo/Agent-coordinator.yaml (yaml)', 'crewforge-manifest:/rendered/crew-demo/Agent-coordinator.yaml (yaml)']);
  });

  it('leaves out the location when the source cannot be located or does not render the object', async () => {
    located = new Error('helm failed');
    await commands().compare(resource);
    located = [];
    await commands().compare({ ...resource, drift: { ...drift, rendered: undefined } } as SourceNode);
    await commands().compare(resource);
    for (const call of recorded.executed) expect(docs.viewOf((call.args as Uri[])[1] as never)?.at).toBeUndefined();
  });

  it('shows live YAML for a resource, a crew, a leaf, the diff document, and a live document, normalized or raw', async () => {
    const yaml = commands();
    await yaml.showLive(resource);
    await yaml.showLive({ kind: 'crew', crew });
    await yaml.showLive({ kind: 'member', crew, view: { label: 'k8s', tooltip: '', icon: 'x', ref: { kind: 'Agent', name: 'k8s', namespace: 'crew-demo' } } } as never);
    await yaml.compare(resource);
    const [left] = recorded.executed[0].args as [Uri];
    await yaml.showLive(left as never, true);
    await yaml.showLive(Uri.parse('crewforge-live:/crew-demo/Agent/k8s.yaml') as never, true);
    await yaml.showLive(Uri.parse('crewforge-live:/unknown.yaml') as never, true);
    await yaml.showLive({ kind: 'member', crew, view: { label: 'tool', tooltip: '', icon: 'x' } } as never);
    await yaml.showLive({ kind: 'message', text: 'x' });
    await yaml.showLive(undefined);
    expect(recorded.shownDocuments).toEqual([
      'crewforge-live:/crew-demo/Agent/coordinator.yaml (yaml)',
      'crewforge-live:/crew-demo/Crew/demo.yaml (yaml)',
      'crewforge-live:/crew-demo/Agent/k8s.yaml (yaml)',
      'crewforge-live:/crew-demo/Agent/coordinator.raw.yaml (yaml)',
      'crewforge-live:/crew-demo/Agent/k8s.raw.yaml (yaml)',
    ]);
    await liveDocs.show({ kind: 'bundle', namespace: 'crew-demo', crew: 'demo' });
    await yaml.showLive(Uri.parse('crewforge-live:/crew-demo/demo.bundle.yaml') as never, true);
    expect(recorded.shownDocuments).toHaveLength(6);
  });
});
