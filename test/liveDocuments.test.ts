import { loadAll } from 'js-yaml';
import { beforeEach, describe, expect, it } from 'vitest';
import type { KubeClient } from '../src/k8s/request';
import { toLiveYaml, type Manifest } from '../src/source/manifests';
import { discoverKinds } from '../src/source/live';
import { LiveDocuments, livePath, liveUri } from '../src/views/liveDocuments';
import { NORMALIZED_NOTE } from '../src/source/normalize';
import { FakeCluster, seedCrew } from './fakeCluster';
import { recorded, resetFake, Uri } from './vscodeFake';

let cluster: FakeCluster;
let documents: LiveDocuments;

beforeEach(() => {
  resetFake();
  cluster = seedCrew(new FakeCluster());
  documents = new LiveDocuments(() => ({ source: '/k/config', context: 'lab', client: cluster as unknown as KubeClient }));
});

const text = (uri: string) => documents.provideTextDocumentContent(Uri.parse(uri) as never);

describe('livePath and liveUri', () => {
  it('finds Kubemoot kinds through discovery and Flux kinds by their groups', async () => {
    const kinds = await discoverKinds(cluster);
    expect(livePath({ kind: 'Agent', name: 'k8s', namespace: 'team-a' }, kinds)).toBe('/apis/kubemoot.ai/v1alpha1/namespaces/team-a/agents/k8s');
    expect(livePath({ kind: 'HelmRelease', name: 'lab', namespace: 'flux-system' }, kinds)).toBe('/apis/helm.toolkit.fluxcd.io/v2/namespaces/flux-system/helmreleases/lab');
    expect(livePath({ kind: 'Kustomization', name: 'apps', namespace: 'flux-system' }, kinds)).toBe('/apis/kustomize.toolkit.fluxcd.io/v1/namespaces/flux-system/kustomizations/apps');
    expect(() => livePath({ kind: 'Secret', name: 'x', namespace: 'n' }, kinds)).toThrow('cannot read Secret objects');
    expect(() => livePath({ kind: 'HelmRelease', name: 'x', namespace: 'Bad NS' }, kinds)).toThrow('not a valid Kubernetes name');
  });

  it('names documents by namespace, kind, and name, or as a crew bundle', () => {
    expect(liveUri({ kind: 'object', ref: { kind: 'Agent', name: 'k8s', namespace: 'team-a' } }).toString()).toBe('crewforge-live:/team-a/Agent/k8s.yaml');
    expect(liveUri({ kind: 'bundle', namespace: 'team-a', crew: 'lab-ops' }).toString()).toBe('crewforge-live:/team-a/lab-ops.bundle.yaml');
  });
});

describe('LiveDocuments', () => {
  it('opens one live object as read-only YAML, normalized by default and raw on request', async () => {
    await documents.show({ kind: 'object', ref: { kind: 'Crew', name: 'lab-ops', namespace: 'team-a' } });
    expect(recorded.shownDocuments).toEqual(['crewforge-live:/team-a/Crew/lab-ops.yaml (yaml)']);
    const yaml = await text('crewforge-live:/team-a/Crew/lab-ops.yaml');
    expect(yaml.split('\n').slice(0, 2)).toEqual([NORMALIZED_NOTE, '# Show Live YAML (raw) shows everything.']);
    const [crew] = loadAll(yaml) as Manifest[];
    expect(crew).toMatchObject({ apiVersion: 'kubemoot.ai/v1alpha1', kind: 'Crew', metadata: { name: 'lab-ops' } });
    expect(crew.status).toBeUndefined();
    expect(crew.metadata.managedFields).toBeUndefined();
    expect(crew.metadata.annotations).toBeUndefined();
    expect(crew.metadata.labels).toEqual({ 'app.kubernetes.io/instance': 'lab', 'app.kubernetes.io/managed-by': 'Helm' });
    const target = { kind: 'object' as const, ref: { kind: 'Crew', name: 'lab-ops', namespace: 'team-a' }, raw: true };
    await documents.show(target);
    expect(recorded.shownDocuments[1]).toBe('crewforge-live:/team-a/Crew/lab-ops.raw.yaml (yaml)');
    expect(documents.targetOf(Uri.parse('crewforge-live:/team-a/Crew/lab-ops.raw.yaml') as never)).toEqual(target);
    const [raw] = loadAll(await text('crewforge-live:/team-a/Crew/lab-ops.raw.yaml')) as Manifest[];
    expect(raw.metadata.managedFields).toEqual([{ manager: 'helm' }]);
    expect(raw).toMatchObject({ status: { ready: true }, metadata: { annotations: { 'meta.helm.sh/release-name': 'lab' } } });
  });

  it('fills in the kind and apiVersion when the API server leaves them out', async () => {
    await documents.show({ kind: 'object', ref: { kind: 'Agent', name: 'k8s', namespace: 'team-a' } });
    cluster.objects.find((o) => o.metadata.name === 'k8s')!.apiVersion = undefined as never;
    const [agent] = loadAll(await text('crewforge-live:/team-a/Agent/k8s.yaml')) as Manifest[];
    expect(agent).toMatchObject({ apiVersion: 'kubemoot.ai/v1alpha1', kind: 'Agent' });
  });

  it('opens a crew bundle: the Crew, Agents, PromptModules, and Skills as one stream', async () => {
    await documents.show({ kind: 'bundle', namespace: 'team-a', crew: 'lab-ops' });
    const objects = loadAll(await text('crewforge-live:/team-a/lab-ops.bundle.yaml')) as Manifest[];
    expect(objects.map((m) => `${m.kind}/${m.metadata.name}`)).toEqual(['Crew/lab-ops', 'Agent/coordinator', 'Agent/k8s', 'PromptModule/rules', 'PromptModule/shared', 'PromptModule/style', 'Skill/runbook']);
  });

  it('says what went wrong instead of failing, and asks to reopen an unknown document', async () => {
    await documents.show({ kind: 'object', ref: { kind: 'Agent', name: 'gone', namespace: 'team-a' } });
    expect(await text('crewforge-live:/team-a/Agent/gone.yaml')).toBe('# Cannot read it: agents "gone" not found\n');
    expect(await text('crewforge-live:/team-a/Agent/never.yaml')).toContain('open it again from the Crews view');
  });

  it('tells an open document to reload each time it is shown', async () => {
    const changed: string[] = [];
    documents.onDidChange((uri) => changed.push(uri.toString()));
    await documents.show({ kind: 'bundle', namespace: 'team-a', crew: 'lab-ops' });
    await documents.show({ kind: 'bundle', namespace: 'team-a', crew: 'lab-ops' });
    expect(changed).toEqual(['crewforge-live:/team-a/lab-ops.bundle.yaml', 'crewforge-live:/team-a/lab-ops.bundle.yaml']);
  });
});

describe('toLiveYaml', () => {
  it('keeps status and server metadata but drops managedFields and the last-applied copy', () => {
    const m: Manifest = {
      apiVersion: 'v1',
      kind: 'X',
      metadata: { name: 'x', uid: 'u', managedFields: [{}], annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{}' } },
      status: { ok: true },
    };
    const [out] = loadAll(toLiveYaml(m)) as Manifest[];
    expect(out).toEqual({ apiVersion: 'v1', kind: 'X', metadata: { name: 'x', uid: 'u' }, status: { ok: true } });
    const [kept] = loadAll(toLiveYaml({ ...m, metadata: { name: 'y', annotations: { a: 'b', 'kubectl.kubernetes.io/last-applied-configuration': '{}' } } })) as Manifest[];
    expect(kept.metadata.annotations).toEqual({ a: 'b' });
  });
});
