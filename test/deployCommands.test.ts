import { loadAll } from 'js-yaml';
import { beforeEach, describe, expect, it } from 'vitest';
import { DeployCommands } from '../src/deploy/commands';
import { nameProblem } from '../src/k8s/paths';
import type { KubeClient } from '../src/k8s/request';
import { ANNOTATIONS, type Deployment } from '../src/source/deployments';
import type { CrewSource } from '../src/source/discover';
import type { ResourceDrift } from '../src/source/drift';
import type { Manifest } from '../src/source/manifests';
import type { Exec, ExecOptions } from '../src/source/render';
import type { SourceEntry } from '../src/source/service';
import type { SourceTreeProvider } from '../src/views/sourceTree';
import { FakeCluster, obj } from './fakeCluster';
import { recorded, resetFake } from './vscodeFake';

const chart: CrewSource = { kind: 'helm', root: '/w/demo-crew', label: 'demo-crew' };
const bundle: CrewSource = { kind: 'bundle', root: '/w/demo/crew', label: 'crew' };
const entry = (source: CrewSource, crewName: string | undefined = 'demo'): SourceEntry => ({ source, identity: { id: `local:${source.label}` }, crewName });

const RENDERED = [
  'apiVersion: kubemoot.ai/v1alpha1\nkind: Crew\nmetadata:\n  name: demo\nspec: {}',
  'apiVersion: kubemoot.ai/v1alpha1\nkind: PromptModule\nmetadata:\n  name: rules\nspec: {}',
  'apiVersion: kubemoot.ai/v1alpha1\nkind: Agent\nmetadata:\n  name: helper\nspec: {}',
].join('\n---\n');

let cluster: FakeCluster;
let ran: { command: string; args: string[]; options?: ExecOptions }[];
let changes: number;
let failTools: boolean;

const exec: Exec = async (command, args, options) => {
  ran.push({ command, args, options });
  if (command === 'git') return { code: 128, stdout: '', stderr: '' };
  return failTools ? { code: 1, stdout: '', stderr: 'tool broke' } : { code: 0, stdout: `${command} done`, stderr: '' };
};

function commands(known: SourceEntry[] = [entry(chart)]): DeployCommands {
  const sources = { known } as unknown as SourceTreeProvider;
  const output = { appendLine: (l: string) => recorded.output.push(l), show: () => undefined } as never;
  return new DeployCommands(sources, { exec, readYamlFiles: async () => [{ file: 'a.yaml', text: RENDERED }] }, output, () => changes++, () => ({
    source: '/k/config',
    context: 'lab',
    client: cluster as unknown as KubeClient,
  }));
}

const tools = (name: string) => ran.filter((r) => r.command === name);
const pickChannel = (channel: string) => (items: { option: { channel: string } }[]) => items.find((i) => i.option.channel === channel);

function deploymentNode(channel: Deployment['channel'], extra: Partial<Deployment> = {}, drift?: ResourceDrift[]) {
  const deployment: Deployment = { namespace: 'team-a', crew: { name: 'demo', namespace: 'team-a', ready: true, phase: 'Ready' }, channel, linked: true, ...extra };
  return { kind: 'deployment' as const, entry: entry(channel === 'bundle' ? bundle : chart), deployment, drift };
}

beforeEach(() => {
  resetFake();
  cluster = new FakeCluster();
  ran = [];
  changes = 0;
  failTools = false;
});

describe('deploySource', () => {
  it('deploys a chart with helm into a new namespace, without questions', async () => {
    recorded.inputs.push('team-a');
    recorded.quickPicks.push(pickChannel('helm'));
    await commands().deploySource({ kind: 'source', entry: entry(chart) });
    expect(tools('helm')[0].args.slice(2)).toEqual(['upgrade', '--install', 'demo', '/w/demo-crew', '--namespace', 'team-a', '--create-namespace']);
    expect(recorded.warnings).toEqual([]);
    expect(recorded.info[0]).toBe('Deploying demo in team-a via helm: done. The operator reconciles it now.');
    expect(recorded.output).toEqual(['> Deploying demo in team-a via helm', 'helm done']);
    expect(changes).toBe(1);
  });

  it('asks before replacing a crew from another source, and stops on no', async () => {
    cluster.namespaces.add('team-a');
    cluster.add({ ...obj('Crew', 'demo', 'team-a'), metadata: { name: 'demo', namespace: 'team-a', annotations: { [ANNOTATIONS.source]: 'github.com/else//demo' } } });
    recorded.inputs.push('team-a', 'team-a');
    recorded.quickPicks.push(pickChannel('bundle'), pickChannel('bundle'));
    recorded.warningAnswers.push(undefined, 'Deploy anyway');
    const c = commands([entry(bundle)]);
    await c.deploySource({ kind: 'source', entry: entry(bundle) });
    expect(recorded.warnings[0]).toContain('came from github.com/else//demo');
    expect(tools('kubectl')).toHaveLength(0);
    await c.deploySource({ kind: 'source', entry: entry(bundle) });
    expect(tools('kubectl')).toHaveLength(1);
  });

  it('refuses a disabled channel and explains Flux', async () => {
    recorded.inputs.push('team-a', 'team-a');
    recorded.quickPicks.push(pickChannel('flux'), (items: { option: { channel: string } }[]) => items.find((i) => i.option.channel === 'helm'));
    const c = commands([entry(bundle)]);
    await c.deploySource({ kind: 'source', entry: entry(bundle) });
    expect(recorded.info[0]).toContain('HelmRelease');
    await c.deploySource({ kind: 'source', entry: entry(bundle) });
    expect(recorded.info[1]).toContain('not a Helm chart');
    expect(ran.filter((r) => r.command !== 'git')).toEqual([]);
  });

  it('shows the Flux path when Flux is picked for a crew it manages', async () => {
    cluster.namespaces.add('team-a');
    cluster.add({ ...obj('Crew', 'demo', 'team-a'), metadata: { name: 'demo', namespace: 'team-a', labels: { 'helm.toolkit.fluxcd.io/name': 'demo' } } });
    recorded.inputs.push('team-a');
    recorded.quickPicks.push(pickChannel('flux'));
    await commands().deploySource({ kind: 'source', entry: entry(chart) });
    expect(recorded.info[0]).toContain('Commit and push');
  });

  it('picks a source when none was clicked, and stops at any cancelled step', async () => {
    recorded.quickPicks.push(undefined);
    await commands([entry(chart), entry(bundle, undefined)]).deploySource();
    recorded.quickPicks.push((items: { entry: SourceEntry }[]) => items[0]);
    recorded.inputs.push(undefined);
    await commands().deploySource();
    recorded.inputs.push('team-a');
    recorded.quickPicks.push(undefined);
    await commands().deploySource({ kind: 'source', entry: entry(chart) });
    recorded.inputs.push('Bad Name');
    await commands().deploySource({ kind: 'source', entry: entry(chart) });
    await commands().deploySource({ kind: 'source', entry: entry(chart, undefined) });
    expect(ran.filter((r) => r.command !== 'git')).toEqual([]);
  });

  it('keeps the existing Helm release name on redeploy', async () => {
    cluster.namespaces.add('team-a');
    cluster.add({
      ...obj('Crew', 'demo', 'team-a'),
      metadata: { name: 'demo', namespace: 'team-a', labels: { 'app.kubernetes.io/managed-by': 'Helm' }, annotations: { 'meta.helm.sh/release-name': 'rel', [ANNOTATIONS.source]: 'local:demo-crew' } },
    });
    recorded.inputs.push('team-a');
    recorded.quickPicks.push(pickChannel('helm'));
    await commands().deploySource({ kind: 'source', entry: entry(chart) });
    expect(tools('helm')[0].args[4]).toBe('rel');
  });

  it('logs and rethrows a failed deploy, still refreshing', async () => {
    failTools = true;
    recorded.inputs.push('team-a');
    recorded.quickPicks.push(pickChannel('helm'));
    await expect(commands().deploySource({ kind: 'source', entry: entry(chart) })).rejects.toThrow('helm upgrade failed: tool broke');
    expect(recorded.output.at(-1)).toBe('helm upgrade failed: tool broke');
    expect(changes).toBe(1);
  });
});

describe('updateDeployment', () => {
  const drift = (state: ResourceDrift['state'], kind: string, name: string): ResourceDrift => ({ kind, name, state, paths: [] });

  it('applies only what differs for a bundle', async () => {
    await commands().updateDeployment(deploymentNode('bundle', {}, [drift('changed', 'PromptModule', 'rules'), drift('in-sync', 'Agent', 'helper'), drift('extra', 'Agent', 'old')]));
    const docs = loadAll(tools('kubectl')[0].options?.input ?? '') as Manifest[];
    expect(docs.map((d) => d.kind)).toEqual(['Crew', 'PromptModule']);
  });

  it('says when a bundle already matches, and upgrades a Helm release by its name', async () => {
    await commands().updateDeployment(deploymentNode('bundle', {}, [drift('in-sync', 'Crew', 'demo')]));
    expect(recorded.info[0]).toContain('already matches its source');
    await commands().updateDeployment(deploymentNode('helm', { release: 'rel' }));
    expect(tools('helm')[0].args[4]).toBe('rel');
  });

  it('confirms an unlinked deployment, explains Flux, and ignores other nodes', async () => {
    recorded.warningAnswers.push(undefined);
    await commands().updateDeployment(deploymentNode('helm', { linked: false }));
    expect(recorded.warnings[0]).toContain('does not name this source');
    await commands().updateDeployment(deploymentNode('flux', { crew: { name: 'demo', namespace: 'team-a', ready: true, phase: 'Ready', labels: { 'helm.toolkit.fluxcd.io/name': 'hr' } } }));
    expect(recorded.info[0]).toContain('the HelmRelease hr manages demo');
    await commands().updateDeployment({ kind: 'message', text: 'x' });
    await commands().updateDeployment();
    expect(ran.filter((r) => r.command !== 'git')).toEqual([]);
  });
});

describe('applyResource and removeDeployment', () => {
  it('applies one object of a bundle, and declines for other channels', async () => {
    const node = deploymentNode('bundle');
    await commands().applyResource({ kind: 'resource', entry: node.entry, deployment: node.deployment, drift: { kind: 'Agent', name: 'helper', state: 'missing', paths: [] } });
    expect((loadAll(tools('kubectl')[0].options?.input ?? '') as Manifest[]).map((d) => d.kind)).toEqual(['Crew', 'Agent']);
    const helm = deploymentNode('helm');
    await commands().applyResource({ kind: 'resource', entry: helm.entry, deployment: helm.deployment, drift: { kind: 'Agent', name: 'helper', state: 'missing', paths: [] } });
    expect(recorded.info[1]).toContain('came through helm');
    await commands().applyResource(node);
  });

  it('removes after confirmation, never for Flux', async () => {
    recorded.warningAnswers.push('Remove', undefined);
    await commands().removeDeployment(deploymentNode('helm', { release: 'rel' }));
    expect(tools('helm')[0].args.slice(2, 4)).toEqual(['uninstall', 'rel']);
    expect(recorded.warnings[0]).toContain('the namespace stays');
    await commands().removeDeployment(deploymentNode('bundle', { linked: false }));
    expect(recorded.warnings[1]).toContain('does not name this source');
    expect(tools('kubectl')).toHaveLength(0);
    await commands().removeDeployment(deploymentNode('flux'));
    expect(recorded.info.at(-1)).toContain('Flux manages demo');
    await commands().removeDeployment({ kind: 'message', text: 'x' });
  });

  it('warns that a crew managing its namespace takes the namespace with it', async () => {
    recorded.warningAnswers.push(undefined);
    const crew = { name: 'demo', namespace: 'team-a', ready: true, phase: 'Ready', annotations: { 'kubemoot.ai/manage-namespace': 'true' } };
    await commands().removeDeployment(deploymentNode('helm', { crew }));
    expect(recorded.warnings[0]).toContain('the operator deletes team-a and everything in it too');
  });
});

describe('removeUnsourced', () => {
  const live = (channel: Deployment['channel'], extra: Partial<Deployment> = {}): Deployment => ({
    namespace: 'team-a',
    crew: { name: 'demo', namespace: 'team-a', ready: true, phase: 'Ready' },
    channel,
    linked: false,
    ...extra,
  });

  it('uninstalls a Helm crew after a confirmation that names the crew and the release', async () => {
    recorded.warningAnswers.push('Remove');
    await commands().removeUnsourced(live('helm', { release: 'lab' }), []);
    expect(recorded.warnings[0]).toBe(
      "Remove the crew demo from team-a? CrewForge runs helm uninstall lab, which deletes what the release installed. Its agents stop, and the Kubemoot operator's finalizers clean up what it made for them; the namespace stays.",
    );
    expect(tools('helm')[0].args.slice(2)).toEqual(['uninstall', 'lab', '--namespace', 'team-a']);
    expect(changes).toBe(1);
  });

  it('deletes the listed Kubemoot objects of any other crew, through the API, after naming them', async () => {
    cluster.add(obj('Agent', 'helper', 'team-a'), obj('Crew', 'demo', 'team-a'));
    recorded.warningAnswers.push('Remove');
    await commands().removeUnsourced(live('bundle'), [obj('Agent', 'helper', 'team-a'), obj('PromptModule', 'gone', 'team-a'), obj('Crew', 'demo', 'team-a')]);
    expect(recorded.warnings[0]).toContain('CrewForge deletes these Kubemoot objects: Agent/helper, PromptModule/gone, Crew/demo.');
    expect(cluster.calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([
      '/apis/kubemoot.ai/v1alpha1/namespaces/team-a/agents/helper',
      '/apis/kubemoot.ai/v1alpha1/namespaces/team-a/promptmodules/gone',
      '/apis/kubemoot.ai/v1alpha1/namespaces/team-a/crews/demo',
    ]);
    expect(recorded.output).toEqual(['> Removing demo from team-a', 'deleted Agent/helper\nPromptModule/gone was already gone\ndeleted Crew/demo']);
    expect(ran).toEqual([]);
  });

  it('does nothing without confirmation, and only points a Flux crew at git', async () => {
    recorded.warningAnswers.push(undefined);
    await commands().removeUnsourced(live('bundle'), [obj('Crew', 'demo', 'team-a')]);
    await commands().removeUnsourced(live('flux'), []);
    expect(cluster.calls).toEqual([]);
    expect(recorded.info[0]).toContain('Flux manages demo');
  });
});

describe('nameProblem', () => {
  it('accepts a DNS label and explains anything else', () => {
    expect(nameProblem('namespace', ' otters-demo ')).toBeUndefined();
    expect(nameProblem('namespace', 'Otters')).toBe('namespace "Otters" is not a valid Kubernetes name');
  });
});
