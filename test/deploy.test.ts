import { load, loadAll } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { Deployer, isDeployable, KubeTools, toDocuments, type DeployRequest } from '../src/deploy/deployer';
import { channelOptions, ownershipWarnings, type TargetState } from '../src/deploy/plan';
import { readTarget } from '../src/deploy/target';
import type { CrewSummary } from '../src/k8s/crews';
import { KubeError, type KubeTransport } from '../src/k8s/request';
import { ANNOTATIONS, type Deployment } from '../src/source/deployments';
import type { CrewSource } from '../src/source/discover';
import type { Manifest } from '../src/source/manifests';
import type { Exec, ExecOptions } from '../src/source/render';
import type { SourceEntry } from '../src/source/service';

const chart: CrewSource = { kind: 'helm', root: '/w/demo-crew', label: 'demo-crew' };
const bundle: CrewSource = { kind: 'bundle', root: '/w/demo/crew', label: 'crew' };
const me = { id: 'github.com/k/crews//demo-crew', owner: 'me@example.com', revision: 'abc1234' };

function crew(labels: Record<string, string> = {}, annotations: Record<string, string> = {}, name = 'demo'): CrewSummary {
  return { name, namespace: 'team-a', ready: true, phase: 'Ready', labels, annotations };
}

const target = (...crews: CrewSummary[]): TargetState => ({ namespace: 'team-a', exists: true, crews });
const enabled = (options: { channel: string; enabled: boolean }[]) => options.filter((o) => o.enabled).map((o) => o.channel);

describe('channelOptions', () => {
  it('offers helm and bundle into an empty namespace, never flux', () => {
    const options = channelOptions(chart, 'demo', target());
    expect(enabled(options)).toEqual(['helm', 'bundle']);
    expect(options.find((o) => o.channel === 'flux')?.reason).toContain('HelmRelease');
    expect(enabled(channelOptions(bundle, 'demo', target()))).toEqual(['bundle']);
    expect(channelOptions(bundle, 'demo', target()).find((o) => o.channel === 'helm')?.reason).toContain('not a Helm chart');
  });

  it('keeps a Flux-managed crew on git only', () => {
    const options = channelOptions(chart, 'demo', target(crew({ 'helm.toolkit.fluxcd.io/name': 'x' })));
    expect(enabled(options)).toEqual(['flux']);
    expect(options[1].reason).toBe('Flux manages demo in team-a; change it through git');
  });

  it('keeps a Helm release on Helm and a bundle on kubectl', () => {
    const helm = channelOptions(chart, 'demo', target(crew({ 'app.kubernetes.io/managed-by': 'Helm' })));
    expect(enabled(helm)).toEqual(['helm']);
    expect(helm[1].reason).toContain('a Helm release owns demo in team-a');
    expect(enabled(channelOptions(bundle, 'demo', target(crew({ 'app.kubernetes.io/managed-by': 'Helm' }))))).toEqual([]);
    const kubectl = channelOptions(chart, 'demo', target(crew()));
    expect(enabled(kubectl)).toEqual(['bundle']);
    expect(kubectl[1].reason).toContain('a bundle applied with kubectl owns demo');
    expect(channelOptions(bundle, 'demo', target(crew()))[1].reason).toContain('not a Helm chart');
  });

  it('ignores crews of other names when choosing', () => {
    expect(enabled(channelOptions(chart, 'demo', target(crew({ 'helm.toolkit.fluxcd.io/name': 'x' }, {}, 'other'))))).toEqual(['helm', 'bundle']);
  });
});

describe('ownershipWarnings', () => {
  it('has nothing to say about a fresh namespace or my own deployment', () => {
    expect(ownershipWarnings(me, 'demo', target())).toEqual([]);
    expect(ownershipWarnings(me, 'demo', target(crew({}, { [ANNOTATIONS.source]: me.id, [ANNOTATIONS.owner]: me.owner })))).toEqual([]);
    expect(ownershipWarnings({ id: me.id }, 'demo', target(crew({}, { [ANNOTATIONS.source]: me.id, [ANNOTATIONS.owner]: 'x' })))).toEqual([]);
  });

  it('warns before replacing another source, another developer, or a crew CrewForge did not deploy', () => {
    const theirs = crew({}, { [ANNOTATIONS.source]: 'github.com/other//demo', [ANNOTATIONS.owner]: 'you@example.com' });
    expect(ownershipWarnings(me, 'demo', target(theirs))).toEqual([
      'demo in team-a came from github.com/other//demo, not from github.com/k/crews//demo-crew.',
      'demo in team-a was deployed by you@example.com.',
    ]);
    expect(ownershipWarnings(me, 'demo', target(crew()))).toEqual(['demo in team-a was not deployed by CrewForge; its source is unknown and this deploy replaces it.']);
  });

  it('warns when the namespace holds other crews', () => {
    expect(ownershipWarnings(me, 'demo', target(crew({}, {}, 'a')))).toEqual(['team-a already holds the crew a.']);
    expect(ownershipWarnings(me, 'demo', target(crew({}, {}, 'a'), crew({}, {}, 'b')))).toEqual(['team-a already holds the crews a, b.']);
  });
});

/** A transport answering namespace and crew reads, recording PATCHes. */
class Api implements KubeTransport {
  patches: { path: string; body: unknown }[] = [];
  constructor(private readonly namespaceStatus: number, private readonly crews: unknown[] = []) {}
  async request(method: string, path: string, body?: unknown): Promise<string> {
    if (method === 'PATCH') {
      this.patches.push({ path, body });
      return '{}';
    }
    if (path.startsWith('/api/v1/namespaces/')) {
      if (this.namespaceStatus === 200) return '{}';
      throw new KubeError('nope', this.namespaceStatus);
    }
    return JSON.stringify({ items: this.crews });
  }
  stream(): Promise<void> {
    return Promise.resolve();
  }
}

describe('readTarget', () => {
  it('reads existence and the crews in the namespace', async () => {
    const crews = [{ metadata: { name: 'demo', namespace: 'team-a' }, status: { phase: 'Ready' } }];
    expect(await readTarget(new Api(200, crews), 'team-a')).toMatchObject({ namespace: 'team-a', exists: true, crews: [{ name: 'demo' }] });
    expect(await readTarget(new Api(404, crews), 'team-a')).toEqual({ namespace: 'team-a', exists: false, crews: [] });
    expect((await readTarget(new Api(403, crews), 'team-a')).exists).toBeUndefined();
  });

  it('rejects a bad name and passes other failures through', async () => {
    await expect(readTarget(new Api(200), 'Team A')).rejects.toThrow('not a valid Kubernetes name');
    await expect(readTarget(new Api(500), 'team-a')).rejects.toThrow('nope');
    const broken: KubeTransport = { request: () => Promise.reject(new Error('offline')), stream: () => Promise.resolve() };
    await expect(readTarget(broken, 'team-a')).rejects.toThrow('offline');
  });
});

interface Ran {
  command: string;
  args: string[];
  options?: ExecOptions;
}

const RENDERED = [
  'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: x',
  'apiVersion: kubemoot.ai/v1alpha1\nkind: Crew\nmetadata:\n  name: demo\n  annotations:\n    keep: me\nspec: {}',
  'apiVersion: kubemoot.ai/v1alpha1\nkind: PromptModule\nmetadata:\n  name: rules\nspec:\n  content: x',
  'apiVersion: kubemoot.ai/v1alpha1\nkind: Agent\nmetadata:\n  name: helper\nspec: {}',
].join('\n---\n');

function harness(results: Record<string, { code: number; stdout?: string; stderr?: string }> = {}) {
  const ran: Ran[] = [];
  const exec: Exec = async (command, args, options) => {
    ran.push({ command, args, options });
    if (command === 'git') return { code: 128, stdout: '', stderr: '' };
    const hit = results[command] ?? { code: 0, stdout: `${command} ok` };
    return { code: hit.code, stdout: hit.stdout ?? '', stderr: hit.stderr ?? '' };
  };
  const api = new Api(200);
  const deps = { exec, readYamlFiles: async () => [{ file: 'all.yaml', text: RENDERED }] };
  const deployer = new Deployer(new KubeTools(exec, '/k/config', 'lab'), api, deps);
  return { ran, api, deployer };
}

const entry = (source: CrewSource): SourceEntry => ({ source, identity: { id: 'local:x' }, crewName: 'demo' });
const request = (source: CrewSource, extra: Partial<DeployRequest> = {}): DeployRequest => ({
  entry: entry(source),
  identity: { id: `local:${source.label}` },
  namespace: 'team-a',
  channel: source.kind,
  ...extra,
});
const deployment = (channel: Deployment['channel'], release?: string): Deployment => ({ namespace: 'team-a', crew: crew(), channel, release, linked: true });

describe('Deployer', () => {
  it('installs a chart with helm into the namespace, then stamps the Crew', async () => {
    const { ran, api, deployer } = harness();
    const out = await deployer.deploy(request(chart));
    const helm = ran.find((r) => r.command === 'helm')!;
    expect(helm.args).toEqual(['--kube-context', 'lab', 'upgrade', '--install', 'demo', '/w/demo-crew', '--namespace', 'team-a', '--create-namespace']);
    expect(helm.options?.env).toEqual({ KUBECONFIG: '/k/config' });
    expect(out).toBe('helm ok');
    expect(api.patches[0].path).toBe('/apis/kubemoot.ai/v1alpha1/namespaces/team-a/crews/demo');
    const annotations = (api.patches[0].body as { metadata: { annotations: Record<string, string> } }).metadata.annotations;
    expect(annotations[ANNOTATIONS.source]).toBe('local:demo-crew');
    expect(annotations[ANNOTATIONS.channel]).toBe('helm');
    expect(Date.parse(annotations[ANNOTATIONS.deployedAt])).not.toBeNaN();
    expect(annotations[ANNOTATIONS.owner]).toBeUndefined();
    await deployer.deploy(request(chart, { entry: { ...entry(chart), crewName: undefined }, release: 'rel' }));
    expect(ran.filter((r) => r.command === 'helm')[1].args[4]).toBe('rel');
  });

  it('applies a bundle with kubectl server-side, with the Crew stamped, and only the changed objects on request', async () => {
    const { ran, deployer } = harness();
    await deployer.deploy(request(bundle));
    const apply = ran.find((r) => r.command === 'kubectl')!;
    expect(apply.args).toEqual(['--context', 'lab', 'apply', '--server-side', '--field-manager=crewforge', '--force-conflicts', '-f', '-']);
    const docs = loadAll(apply.options?.input ?? '') as Manifest[];
    expect(docs.map((d) => `${d.kind}/${d.metadata.name}/${d.metadata.namespace ?? ''}`)).toEqual(['Namespace/team-a/', 'Crew/demo/team-a', 'PromptModule/rules/team-a', 'Agent/helper/team-a']);
    expect(docs[1].metadata.annotations).toMatchObject({ keep: 'me', [ANNOTATIONS.channel]: 'bundle', [ANNOTATIONS.source]: 'local:crew' });
    await deployer.deploy(request(bundle, { only: new Set(['PromptModule/rules']) }));
    const partial = loadAll(ran.filter((r) => r.command === 'kubectl')[1].options?.input ?? '') as Manifest[];
    expect(partial.map((d) => d.kind)).toEqual(['Crew', 'PromptModule']);
  });

  it('removes through the channel that deployed, never deleting the namespace', async () => {
    const { ran, deployer } = harness();
    await deployer.remove(entry(chart), deployment('helm', 'rel'));
    expect(ran.find((r) => r.command === 'helm')?.args).toEqual(['--kube-context', 'lab', 'uninstall', 'rel', '--namespace', 'team-a']);
    await deployer.remove(entry(chart), deployment('helm'));
    expect(ran.filter((r) => r.command === 'helm')[1].args[3]).toBe('demo');
    await deployer.remove(entry(bundle), deployment('bundle'));
    const del = ran.find((r) => r.command === 'kubectl')!;
    expect(del.args).toEqual(['--context', 'lab', 'delete', '--ignore-not-found', '--wait=false', '-f', '-']);
    expect((loadAll(del.options?.input ?? '') as Manifest[]).map((d) => d.kind)).toEqual(['Crew', 'PromptModule', 'Agent']);
    await expect(deployer.remove(entry(chart), deployment('flux'))).rejects.toThrow('remove it from your GitOps repository');
  });

  it('reports a tool failure with its message', async () => {
    const { deployer } = harness({ helm: { code: 1, stderr: 'Error: UPGRADE FAILED\n' }, kubectl: { code: 1, stdout: 'denied' } });
    await expect(deployer.deploy(request(chart))).rejects.toThrow('helm upgrade failed: Error: UPGRADE FAILED');
    await expect(deployer.deploy(request(bundle))).rejects.toThrow('kubectl apply failed: denied');
    const silent = harness({ kubectl: { code: 5 } });
    await expect(silent.deployer.remove(entry(bundle), deployment('bundle'))).rejects.toThrow('kubectl delete failed: exit 5');
  });

  it('refuses Flux, which changes only through git', async () => {
    const { ran, deployer } = harness();
    expect(isDeployable('flux')).toBe(false);
    expect(isDeployable('bundle')).toBe(true);
    await expect(deployer.deploy(request(chart, { channel: 'flux' as never }))).rejects.toThrow('does not deploy through flux');
    expect(ran).toEqual([]);
  });

  it('writes objects as one YAML stream', () => {
    const text = toDocuments([{ apiVersion: 'v1', kind: 'A', metadata: { name: 'a' } }, { apiVersion: 'v1', kind: 'B', metadata: { name: 'b' } }]);
    expect(text.split('---\n').map((d) => (load(d) as Manifest).kind)).toEqual(['A', 'B']);
  });
});
