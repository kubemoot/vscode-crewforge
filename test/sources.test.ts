import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { channelOf, deployedAtByRevision, stripDirty, deploymentDescription, deploymentsOf, historyLines, ANNOTATIONS } from '../src/source/deployments';
import { discoverSources, type CrewSource } from '../src/source/discover';
import { identify, normalizeRemote } from '../src/source/identity';
import { crewOf, isKubemoot, objectKey, parseManifests } from '../src/source/manifests';
import { normalizedYaml } from '../src/source/normalize';
import { byCodeUnits, execProgram, readText, readYamlFiles } from '../src/source/nodeDeps';
import { render, type Exec } from '../src/source/render';
import type { CrewSummary } from '../src/k8s/crews';

const ROOT = path.join(__dirname, 'fixtures', 'sources');

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

const files = walk(ROOT);
const charts = files.filter((f) => f.endsWith('Chart.yaml'));
const yamls = files.filter((f) => /\.ya?ml$/.test(f) && !f.endsWith('Chart.yaml'));
const chart: CrewSource = { kind: 'helm', root: path.join(ROOT, 'charts', 'demo-crew'), label: 'demo-crew' };
const bundle: CrewSource = { kind: 'bundle', root: path.join(ROOT, 'bundles', 'demo', 'crew'), label: 'crew' };

describe('manifests', () => {
  it('parses the documents that have a kind and a name', () => {
    const docs = parseManifests('---\n\n---\nkind: X\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\n');
    expect(docs.map(objectKey)).toEqual(['ConfigMap/c']);
  });

  it('finds the Kubemoot Crew and tells Kubemoot kinds apart', () => {
    const docs = parseManifests(fs.readFileSync(path.join(bundle.root, '02-crew.yaml'), 'utf8'));
    expect(crewOf(docs)?.metadata.name).toBe('demo');
    expect(isKubemoot(docs[0])).toBe(true);
    expect(isKubemoot({ apiVersion: 'v1', kind: 'Crew', metadata: { name: 'x' } })).toBe(false);
  });

  it('shows YAML without server bookkeeping', () => {
    const text = normalizedYaml({
      apiVersion: 'kubemoot.ai/v1alpha1',
      kind: 'Crew',
      metadata: { name: 'demo', uid: 'u', resourceVersion: '1', managedFields: [], annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{}' } },
    });
    expect(text).toContain('name: demo');
    expect(text).not.toMatch(/uid|resourceVersion|managedFields|annotations/);
    expect(normalizedYaml({ apiVersion: 'v1', kind: 'X', metadata: { name: 'a', annotations: { keep: 'me' } } })).toContain('keep: me');
    expect(normalizedYaml({ apiVersion: 'v1', kind: 'X', metadata: { name: 'a' } })).not.toContain('annotations');
  });
});

describe('readYamlFiles', () => {
  it('reads only the YAML files in a folder, in code-unit order whatever the locale', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-yaml-'));
    try {
      for (const name of ['b.yaml', 'a.yml', 'B.yaml', '_x.yaml', 'notes.txt']) fs.writeFileSync(path.join(dir, name), `name: ${name}\n`);
      const files = await readYamlFiles(dir);
      expect(files.map((f) => path.basename(f.file))).toEqual(['B.yaml', '_x.yaml', 'a.yml', 'b.yaml']);
      expect(files[0].text).toBe('name: B.yaml\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('orders by code units: negative, positive, or zero', () => {
    expect(byCodeUnits('B', 'a')).toBe(-1);
    expect(byCodeUnits('a', 'B')).toBe(1);
    expect(byCodeUnits('a', 'a')).toBe(0);
    expect(['10', '9', '1'].sort(byCodeUnits)).toEqual(['1', '10', '9']);
  });
});

describe('discoverSources', () => {
  it('finds crew charts and bundles, and nothing else', async () => {
    const sources = await discoverSources(charts, yamls, readText);
    expect(sources).toEqual([bundle, chart]);
  });

  it('skips a chart without a Crew template and a YAML file that does not parse', async () => {
    const read = async (f: string) => (f.endsWith('bad.yaml') ? 'apiVersion: kubemoot.ai/v1\nkind: Crew\n  : : :' : 'apiVersion: v1\nkind: ConfigMap\n');
    const sources = await discoverSources(['/w/c/Chart.yaml'], ['/w/c/templates/cm.yaml', '/w/b/bad.yaml'], read);
    expect(sources).toEqual([]);
  });
});

describe('render', () => {
  const deps = (exec: Exec) => ({ exec, readYamlFiles });

  it('renders a chart with helm template into the namespace, and names the release', async () => {
    const calls: string[][] = [];
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { code: 0, stderr: '', stdout: fs.readFileSync(path.join(bundle.root, '02-crew.yaml'), 'utf8') };
    };
    const out = await render(chart, { namespace: 'team-a', release: 'rel' }, deps(exec));
    expect(calls[0]).toEqual(['helm', 'template', 'rel', chart.root, '--namespace', 'team-a']);
    expect(out[0].metadata.namespace).toBe('team-a');
    await render(chart, { namespace: 'team-a' }, deps(exec));
    expect(calls[1][2]).toBe('demo-crew');
  });

  it('reports a helm failure with its message', async () => {
    const exec: Exec = async () => ({ code: 1, stdout: '', stderr: 'Error: parse error\n' });
    await expect(render(chart, { namespace: 'n' }, deps(exec))).rejects.toThrow('helm template failed for demo-crew: Error: parse error');
    const silent: Exec = async () => ({ code: 2, stdout: '', stderr: '' });
    await expect(render(chart, { namespace: 'n' }, deps(silent))).rejects.toThrow('exit 2');
  });

  it('renders a bundle into the namespace, renaming its Namespace and keeping cluster-scoped objects', async () => {
    const out = await render(bundle, { namespace: 'otters-demo' }, deps(execProgram));
    expect(out.map((m) => [m.kind, m.metadata.name, m.metadata.namespace])).toEqual([
      ['Namespace', 'otters-demo', undefined],
      ['Crew', 'demo', 'otters-demo'],
    ]);
    const clusterRole = await render(bundle, { namespace: 'n' }, {
      exec: execProgram,
      readYamlFiles: async () => [{ file: 'r.yaml', text: 'apiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRole\nmetadata:\n  name: r\n' }],
    });
    expect(clusterRole[0].metadata.namespace).toBeUndefined();
  });

  it('names the bundle file that does not parse', async () => {
    const bad = { exec: execProgram, readYamlFiles: async () => [{ file: '/x/04-agents.yaml', text: 'a: [' }] };
    await expect(render(bundle, { namespace: 'n' }, bad)).rejects.toThrow(/^04-agents.yaml: /);
  });

  it.skipIf(!hasHelm())('renders the fixture chart with the real helm', async () => {
    const out = await render(chart, { namespace: 'team-a' }, deps(execProgram));
    expect(out.map(objectKey)).toEqual(['Crew/demo', 'PromptModule/demo-rules']);
  });
});

function hasHelm(): boolean {
  return (process.env.PATH ?? '').split(path.delimiter).some((d) => fs.existsSync(path.join(d, 'helm')));
}

describe('execProgram', () => {
  it('returns output and exit codes without throwing', async () => {
    const ok = await execProgram(process.execPath, ['-e', 'process.stdout.write("hi")']);
    expect(ok).toEqual({ code: 0, stdout: 'hi', stderr: '' });
    const fail = await execProgram(process.execPath, ['-e', 'process.stderr.write("bad"); process.exit(3)']);
    expect(fail).toMatchObject({ code: 3, stderr: 'bad' });
    const missing = await execProgram('no-such-program-crewforge', []);
    expect(missing).toMatchObject({ code: 127, stderr: 'no-such-program-crewforge was not found on PATH' });
  });
});

describe('identify', () => {
  const answers = (map: Record<string, { code?: number; stdout?: string }>): Exec => async (_cmd, args) => {
    const hit = map[args.join(' ')] ?? { code: 1 };
    return { code: hit.code ?? 0, stdout: hit.stdout ?? '', stderr: '' };
  };

  it('names the source by repository and path, with its last commit and the developer', async () => {
    const exec = answers({
      'rev-parse --show-toplevel': { stdout: `${ROOT}\n` },
      'remote get-url origin': { stdout: 'git@github.com:kubemoot/crews.git\n' },
      'log -1 --format=%h -- .': { stdout: 'abc1234\n' },
      'status --porcelain -- .': { stdout: ' M templates/crew.yaml\n' },
      'config user.email': { stdout: 'dev@example.com\n' },
    });
    expect(await identify(chart, exec)).toEqual({ id: 'github.com/kubemoot/crews//charts/demo-crew', revision: 'abc1234-dirty', owner: 'dev@example.com' });
  });

  it('falls back when there is no remote, no commit, or no git at all', async () => {
    const noRemote = answers({ 'rev-parse --show-toplevel': { stdout: `${ROOT}\n` } });
    expect(await identify(chart, noRemote)).toEqual({ id: 'local:sources//charts/demo-crew', revision: undefined, owner: undefined });
    expect(await identify(chart, answers({}))).toEqual({ id: 'local:demo-crew' });
  });

  it('spells a remote one way however it was cloned', () => {
    expect(normalizeRemote('https://github.com/kubemoot/crews.git')).toBe('github.com/kubemoot/crews');
    expect(normalizeRemote('https://user:tok@github.com/kubemoot/crews/')).toBe('github.com/kubemoot/crews');
    expect(normalizeRemote('git@github.com:kubemoot/crews.git')).toBe('github.com/kubemoot/crews');
    expect(normalizeRemote('ssh://git@github.com/kubemoot/crews')).toBe('github.com/kubemoot/crews');
  });
});

describe('deployments', () => {
  const crew = (namespace: string, labels: Record<string, string> = {}, annotations: Record<string, string> = {}): CrewSummary => ({
    name: 'demo',
    namespace,
    ready: true,
    phase: 'Ready',
    labels,
    annotations,
  });

  it('reads the channel from Flux, Helm, and CrewForge marks', () => {
    expect(channelOf(crew('a', { 'helm.toolkit.fluxcd.io/name': 'x' }))).toBe('flux');
    expect(channelOf(crew('a', { 'kustomize.toolkit.fluxcd.io/name': 'x' }))).toBe('flux');
    expect(channelOf(crew('a', { 'app.kubernetes.io/managed-by': 'Helm' }))).toBe('helm');
    expect(channelOf(crew('a', {}, { [ANNOTATIONS.channel]: 'helm' }))).toBe('helm');
    expect(channelOf(crew('a'))).toBe('bundle');
    expect(channelOf({ name: 'demo', namespace: 'a', ready: true, phase: 'Ready' })).toBe('bundle');
  });

  it('lists every namespace a source is deployed to, linked when the Crew names the source', () => {
    const crews = [
      crew('zeta', {}, { [ANNOTATIONS.source]: 'repo//demo', [ANNOTATIONS.owner]: 'me', [ANNOTATIONS.revision]: 'abc' }),
      crew('alpha', { 'app.kubernetes.io/managed-by': 'Helm' }, { 'meta.helm.sh/release-name': 'rel' }),
      { ...crew('beta'), name: 'other' },
    ];
    const deployments = deploymentsOf('repo//demo', 'demo', crews);
    expect(deployments.map((d) => [d.namespace, d.channel, d.release, d.owner, d.revision, d.linked])).toEqual([
      ['alpha', 'helm', 'rel', undefined, undefined, false],
      ['zeta', 'bundle', undefined, 'me', 'abc', true],
    ]);
    expect(deploymentDescription(deployments[1], 'in sync')).toBe('bundle · Ready · in sync');
    expect(deploymentDescription(deployments[0])).toBe('helm · Ready · same name, other source?');
    expect(deploymentsOf('x', 'demo', [{ name: 'demo', namespace: 'n', ready: true, phase: 'Ready' }])[0].linked).toBe(false);
  });

  it('shows the operator revision record, newest first, and knows when each revision was deployed', () => {
    const revisions = [
      { revision: 'abc1234-dirty', channel: 'bundle', owner: 'me', deployedAt: '2026-09-27T10:00:00Z' },
      { crewVersion: '0.40.3', channel: 'flux', observedAt: '2026-09-26T09:00:00Z' },
      { revision: 'abc1234', deployedAt: '2026-09-25T08:00:00Z' },
      {},
    ];
    const d = deploymentsOf('x', 'demo', [{ ...crew('a'), revisions }])[0];
    expect(historyLines(d)).toEqual([
      'Deployed revisions:',
      '  abc1234-dirty via bundle by me (2026-09-27T10:00:00Z)',
      '  0.40.3 via flux (2026-09-26T09:00:00Z)',
      '  abc1234 (2026-09-25T08:00:00Z)',
      '  unknown (time unknown)',
    ]);
    expect(historyLines(d, 1)).toHaveLength(2);
    expect([...deployedAtByRevision(d)]).toEqual([['abc1234', '2026-09-27T10:00:00Z']]);
    const bare = deploymentsOf('x', 'demo', [crew('b')])[0];
    expect(historyLines(bare)).toEqual([]);
    expect(stripDirty('abc-dirty')).toBe('abc');
    expect(stripDirty('abc')).toBe('abc');
    expect(stripDirty(undefined)).toBeUndefined();
    expect(deployedAtByRevision({ ...bare, crew: { ...bare.crew, revisions: [{ revision: 'f00' }] } }).get('f00')).toBe('');
  });
});
