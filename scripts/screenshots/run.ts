/**
 * Regenerates the screenshots in the CrewForge docs from a real VS Code.
 *
 *   npm run screenshots [-- --out <dir>]
 *
 * It scaffolds a crew with `kmctl create --chart` into a throwaway git workspace, fakes a
 * cluster that has that crew deployed (with a fitness run in progress), starts VS Code with
 * CrewForge against a local fake API server, and lets suite.ts drive the editor and capture
 * each shot through VS Code's own debugging port. No real cluster, hostname, or person
 * appears in a picture. Needs `kmctl` 0.12.0 or later, `helm`, `git`, and a display
 * (WSLg, or `xvfb-run -a npm run screenshots` on a headless machine).
 *
 *   --out <dir>     where the PNG files go (default .vscode-test/screenshots/out)
 *   VSCODE_VERSION  the VS Code to download ("stable" by default)
 *   CREWFORGE_SHOTS_PORT  the debugging port VS Code listens on (9333 by default)
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import * as yaml from 'js-yaml';
import { startFakeApi } from '../../test/fakeApiServer';
import { FakeCluster, obj, seedCrew } from '../../test/fakeCluster';
import type { Manifest } from '../../src/source/manifests';

const repo = path.resolve(__dirname, '..', '..');
const CREW = 'helpdesk';
const NAMESPACE = 'crew-helpdesk';
const CONTEXT = 'kind-dev';
// Another program may hold the default port; CREWFORGE_SHOTS_PORT picks another.
const DEBUG_PORT = process.env.CREWFORGE_SHOTS_PORT ?? '9333';
const REPO_URL = 'https://git.example.org/team/crews.git';

function outDir(): string {
  const at = process.argv.indexOf('--out');
  return path.resolve(at > 0 ? process.argv[at + 1] : path.join(repo, '.vscode-test', 'screenshots', 'out'));
}

function run(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' });
}

/** A git workspace holding a crew chart scaffolded by kmctl, committed as it came. */
function scaffold(workspace: string): string {
  fs.mkdirSync(workspace, { recursive: true });
  run('kmctl', ['create', CREW, '--chart', '--members', '2', '--model-family', 'qwen', '--providers', 'ollama', '--no-input', '-o', workspace], workspace);
  const git = (...args: string[]) => run('git', ['-c', 'user.name=Docs', '-c', 'user.email=docs@example.org', ...args], workspace);
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', REPO_URL);
  git('add', '.');
  git('commit', '-q', '-m', 'Scaffold the helpdesk crew');
  fs.mkdirSync(path.join(workspace, 'notes'));
  fs.writeFileSync(path.join(workspace, 'notes', 'todo.md'), 'Ideas for the next crew.\n');
  return path.join(workspace, CREW);
}

/** The chart as a Helm install leaves it in the cluster: every rendered object in the namespace, the Crew marked as Helm's. */
function deployedCrew(chart: string): FakeCluster {
  const cluster = seedCrew(new FakeCluster());
  cluster.namespaces.add('team-a').add(NAMESPACE);
  const rendered = run('helm', ['template', CREW, chart, '--namespace', NAMESPACE], chart);
  for (const doc of yaml.loadAll(rendered) as Manifest[]) {
    if (!doc?.kind) continue;
    doc.metadata.namespace = NAMESPACE;
    if (doc.kind === 'Crew') markDeployed(doc);
    if (doc.kind === 'Agent') doc.status = { ready: true, phase: 'Running' };
    if (doc.kind === 'Model') doc.status = { ready: true, state: 'Available' };
    cluster.add(doc);
  }
  return cluster.add(...fitnessRuns(), ...sharedInfrastructure());
}

/** What the cluster shares with every crew: the ModelProvider the Models run on, and the consent-3 archetype. */
function sharedInfrastructure(): Manifest[] {
  const provider = obj('ModelProvider', 'ollama', 'kubemoot', { type: 'ollama', endpoint: 'http://ollama.kubemoot:11434' });
  provider.status = { ready: true, phase: 'Ready' };
  const archetype: Manifest = { apiVersion: 'kubemoot.ai/v1alpha1', kind: 'MootArchetype', metadata: { name: 'consent-3' }, spec: { phases: [{ name: 'triage' }, { name: 'mulling' }, { name: 'synthesis' }] } };
  return [provider, archetype];
}

function markDeployed(crew: Manifest): void {
  crew.metadata.labels = { ...crew.metadata.labels, 'helm.sh/chart': `${CREW}-0.1.0` };
  crew.metadata.annotations = {
    ...crew.metadata.annotations,
    'meta.helm.sh/release-name': CREW,
    'meta.helm.sh/release-namespace': NAMESPACE,
    'crewforge.kubemoot.ai/source': `git.example.org/team/crews//${CREW}`,
    'crewforge.kubemoot.ai/channel': 'helm',
    'crewforge.kubemoot.ai/owner': 'docs@example.org',
    'crewforge.kubemoot.ai/deployed-at': new Date(Date.now() - 20 * 60_000).toISOString(),
  };
  crew.status = { ready: true, phase: 'Ready', agentCount: 3, coordinatorRef: `${CREW}-coordinator` };
}

const SCENARIOS = ['smoke-hello', 'general-knowledge', 'honest-no-fabrication'];

/** A finished single run, and a suite in its second of two rounds of three scenarios. */
function fitnessRuns(): Manifest[] {
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const earlier = obj('CrewFitness', `${CREW}-smoke-0929`, NAMESPACE, { crewRef: CREW, testRef: 'smoke-hello' });
  earlier.metadata.creationTimestamp = ago(1500);
  earlier.status = { phase: 'Passed', passed: 4, failed: 0, errored: 0, startedAt: ago(1500), completedAt: ago(1498), durationMs: 96_000, assertions: [] };
  const suite = obj('CrewFitnessSuite', `${CREW}-starter-0930`, NAMESPACE, { crewRef: CREW, iterations: 2, scripts: SCENARIOS.map((testRef) => ({ testRef })) });
  suite.metadata.creationTimestamp = ago(9);
  suite.status = { phase: 'Running', iterationsTotal: 6, iterationsCompleted: 4, passed: 4, failed: 0, errored: 0, startedAt: ago(9) };
  const iterations = SCENARIOS.flatMap((testRef, i) => [0, 1].map((n) => ({ testRef, n, i })))
    .slice(0, 5)
    .map(({ testRef, n, i }) => {
      const run = obj('CrewFitness', `${CREW}-starter-0930-${testRef}-${n}`, NAMESPACE, { crewRef: CREW, testRef }, { 'kubemoot.ai/fitness-suite': `${CREW}-starter-0930` });
      const done = i * 2 + n < 4;
      run.status = done ? { phase: 'Passed', durationMs: 60_000 + i * 21_000 + n * 7_000, passed: 4, failed: 0 } : { phase: 'Running' };
      return run;
    });
  return [earlier, suite, ...iterations];
}

/** The server-sent events of one crew turn, spaced out so the answer carries a duration. */
async function streamTurn(res: http.ServerResponse): Promise<void> {
  const send = (event: object) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  send({ type: 'connected' });
  send({ type: 'thread_found', threadId: 'a3c1f0e2-7d4b-4c55-9d0a-2f6e1b8c9a10' });
  await wait(500);
  send({ type: 'phase', agent: `${CREW}-tooler-1`, status: 'triaging', gpu: 'gpu-a' });
  send({ type: 'phase', agent: `${CREW}-tooler-2`, status: 'triaging', gpu: 'gpu-b' });
  await wait(1500);
  send({ type: 'phase', agent: `${CREW}-tooler-1`, status: 'evaluating', gpu: 'gpu-a' });
  await wait(1500);
  send({ type: 'finding', agent: `${CREW}-tooler-1`, signal: 'agree', summary: 'Check whether the VPN client shows a certificate or a credential error before anything else.' });
  send({ type: 'finding', agent: `${CREW}-tooler-2`, signal: 'concern', summary: 'A recent client update can break the saved profile; confirm the version.' });
  await wait(1200);
  send({
    type: 'synthesis',
    content: [
      'Start with what the VPN client reports, then work outward:',
      '',
      '1. **Read the error.** A certificate or credential message points at the account or the profile, not the network.',
      '2. **Check the client version.** A recent update can invalidate the saved profile; re-importing it usually clears that.',
      '3. **Test the network.** If the client cannot reach the gateway at all, try another network before escalating.',
      '',
      'If steps 1 and 2 are clean, collect the client log and escalate with it.',
    ].join('\n'),
  });
  send({ type: 'done' });
  res.end();
}

/** The cluster's OpenAPI, as an operator that supports pausing and stopping a suite serves it. */
function openApi(): string {
  const doc = JSON.parse(fs.readFileSync(path.join(repo, 'test', 'fixtures', 'kubemoot-openapi.json'), 'utf8'));
  doc.components.schemas['ai.kubemoot.v1alpha1.CrewFitnessSuite'] = {
    type: 'object',
    'x-kubernetes-group-version-kind': [{ group: 'kubemoot.ai', version: 'v1alpha1', kind: 'CrewFitnessSuite' }],
    properties: { spec: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true, properties: { suspend: { type: 'boolean' }, cancel: { type: 'boolean' } } } },
  };
  const promptModule = JSON.parse(JSON.stringify(doc.components.schemas['ai.kubemoot.v1alpha1.Agent']));
  promptModule['x-kubernetes-group-version-kind'] = [{ group: 'kubemoot.ai', version: 'v1alpha1', kind: 'PromptModule' }];
  promptModule.properties.spec = { type: 'object', required: ['content'], properties: { content: { type: 'string' }, order: { type: 'integer' }, description: { type: 'string' } } };
  doc.components.schemas['ai.kubemoot.v1alpha1.PromptModule'] = promptModule;
  return JSON.stringify(doc);
}

/** Sits in front of the fake API server to serve the richer stream and the OpenAPI the shots need. */
async function startFront(target: string): Promise<{ url: string; close: () => Promise<void> }> {
  const upstream = new URL(target);
  const schema = openApi();
  const server = http.createServer((req, res) => {
    const route = (req.url ?? '').split('?')[0];
    if (route === '/openapi/v3/apis/kubemoot.ai/v1alpha1') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(schema);
      return;
    }
    if (route.endsWith(`/endpoints/${CREW}-discussion`)) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ subsets: [{ addresses: [{ ip: '10.0.0.8' }] }] }));
      return;
    }
    if (route.endsWith('/stream')) {
      void streamTurn(res);
      return;
    }
    const forward = http.request({ host: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers: req.headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    req.pipe(forward);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** A user profile whose settings give a clean, light, fixed-size window and point CrewForge at the fake API. */
function profile(scratch: string, kubeconfig: string): string {
  const userData = path.join(scratch, 'user');
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  const settings = {
    'crewforge.kubeconfig': kubeconfig,
    'workbench.colorTheme': 'Default Light Modern',
    'workbench.startupEditor': 'none',
    'workbench.tips.enabled': false,
    'workbench.layoutControl.enabled': false,
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
    'chat.disableAIFeatures': true,
    'window.commandCenter': false,
    'window.titleBarStyle': 'custom',
    'window.zoomLevel': 0,
    'editor.minimap.enabled': false,
    'editor.fontSize': 14,
    'breadcrumbs.enabled': false,
    'security.workspace.trust.enabled': false,
    'extensions.autoUpdate': false,
    'update.mode': 'none',
    'telemetry.telemetryLevel': 'off',
    'git.enabled': false,
  };
  fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify(settings, null, 2));
  return userData;
}

function rewriteServer(kubeconfig: string, from: string, to: string): void {
  fs.writeFileSync(kubeconfig, fs.readFileSync(kubeconfig, 'utf8').split(from).join(to));
}

/** Shrinks each picture with pngquant when it is installed. */
function optimize(dir: string): void {
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.png'))) {
    try {
      execFileSync('pngquant', ['--force', '--skip-if-larger', '--quality', '70-95', '--output', path.join(dir, f), path.join(dir, f)]);
    } catch {
      // pngquant missing, or it could not shrink this one: keep the original.
    }
  }
}

async function main(): Promise<void> {
  const out = outDir();
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const scratch = path.join(os.tmpdir(), 'crewforge-screenshots');
  fs.rmSync(scratch, { recursive: true, force: true });
  const workspace = path.join(scratch, 'crews');
  const chart = scaffold(workspace);
  const api = await startFakeApi({ cluster: deployedCrew(chart), context: CONTEXT, otherContexts: [{ name: 'kind-staging', server: 'http://127.0.0.1:1' }] });
  const front = await startFront(api.url);
  rewriteServer(api.kubeconfig, api.url, front.url);
  const userData = profile(scratch, api.kubeconfig);
  try {
    const vscodeExecutablePath = await downloadAndUnzipVSCode(process.env.VSCODE_VERSION ?? 'stable');
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: repo,
      extensionTestsPath: path.join(__dirname, 'suite.js'),
      launchArgs: [workspace, '--user-data-dir', userData, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-gpu', `--remote-debugging-port=${DEBUG_PORT}`],
      extensionTestsEnv: { CREWFORGE_SHOTS_OUT: out, CREWFORGE_SHOTS_PORT: DEBUG_PORT, CREWFORGE_SHOTS_CHART: chart, CREWFORGE_SHOTS_NAMESPACE: NAMESPACE, CREWFORGE_SHOTS_CREW: CREW },
    });
    optimize(out);
    console.log(`Screenshots written to ${out}`);
  } finally {
    await front.close();
    await api.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
